import exifr from 'exifr'
import { useMemo, useRef, useState } from 'react'
import { SignatureBox, type SignatureHandle } from '../components/SignatureBox'
import { NO_FIX_NOTES, useGeolocation } from '../hooks/useGeolocation'
import { useSyncStatus } from '../hooks/useSyncStatus'
import type { QueuedPod } from '../lib/db'
import { haversineM, parseEwkbPoint } from '../lib/geo'
import { queuePod, type CapturedPhoto } from '../lib/pod'
import { stampAndCompress, type StampedPhoto } from '../lib/stamp'
import { syncNow } from '../lib/syncWorker'
import type { Fix, Parcel, PodStatus } from '../lib/types'

const FAILURE_PRESETS = ['No access', 'Refused', 'Address not found', 'Other…'] as const

/** Proof-of-delivery capture for a specific job (§6.2), kept deliberately
 *  simple for the driver: choose an outcome, photograph the parcel, sign.
 *  GPS is acquired on mount and read fresh at the shutter (real-or-nothing),
 *  stamped into the photo and stored on the record — and the photo card shows
 *  the live fix so a blocked permission is fixable BEFORE the shot, not a
 *  surprise after. Completion writes to the local queue and returns
 *  instantly; the sync worker uploads in the background. */
export function CaptureScreen({
  parcel,
  trackingScanned,
  driverId,
  eyebrow,
  onComplete,
  onBack,
}: {
  parcel: Parcel
  trackingScanned: string
  /** The signed-in driver — stamped onto the POD record. */
  driverId: string
  /** e.g. "Stop 2 of 7 · Domestic" or "Rollover · Domestic" */
  eyebrow: string
  onComplete: (pod: QueuedPod, previewUrl: string) => void
  onBack: () => void
}) {
  // GPS warms up on mount (surfacing the permission prompt early) and is
  // read fresh at the shutter; the photo card shows the live state.
  const { fix, noFixReason, acquiring, getFix, retry } = useGeolocation()
  const { online } = useSyncStatus()
  const [labelPhoto, setLabelPhoto] = useState<StampedPhoto | null>(null)
  const [capturedAt, setCapturedAt] = useState<Date | null>(null)
  const [outcome, setOutcome] = useState<PodStatus>('delivered')
  const [failurePreset, setFailurePreset] = useState('')
  const [failureOther, setFailureOther] = useState('')
  const [signed, setSigned] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sigRef = useRef<SignatureHandle>(null)
  // The fix burned into the photo — the record must match the image. null =
  // photo taken with no fix, so the record stays fix-less too.
  const [usedFix, setUsedFix] = useState<Fix | null | undefined>(undefined)
  const barRef = useRef<HTMLSpanElement>(null)
  // Geofence: where this parcel *should* be delivered (EWKB from PostgREST).
  // Still computed + stored at completion, just not shown.
  const destination = useMemo(() => parseEwkbPoint(parcel.destination), [parcel.destination])

  async function takePhoto(file: File) {
    try {
      const takenAt = new Date() // evidence time = device clock at the shutter (§5)
      // GPS provenance ladder: prefer the fix the camera embedded in the photo
      // itself (EXIF), then a fresh live device fix at the shutter. No fix at
      // all → null, never a fabricated point.
      const exif = await exifr.gps(file).catch(() => undefined)
      const gpsFix: Fix | null =
        exif && Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
          ? {
              lat: +exif.latitude.toFixed(5),
              lng: +exif.longitude.toFixed(5),
              accuracyM: null,
              source: 'photo_exif',
            }
          : await getFix()
      const stamped = await stampAndCompress(file, parcel.tracking_number, takenAt, gpsFix)
      setLabelPhoto(stamped)
      setCapturedAt((prev) => prev ?? takenAt)
      setUsedFix(gpsFix)
    } catch (e) {
      setError(`Photo processing failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const failureReason = failurePreset === 'Other…' ? failureOther.trim() : failurePreset
  const canComplete =
    !!labelPhoto && !submitting && (outcome === 'delivered' || failureReason.length > 0)

  const checklist =
    outcome === 'delivered'
      ? [
          { label: 'Photo evidence', done: !!labelPhoto },
          { label: 'Signature', done: signed, optional: true },
        ]
      : [
          { label: 'Failure reason', done: failureReason.length > 0 },
          { label: 'Photo evidence', done: !!labelPhoto },
          { label: 'Signature', done: signed, optional: true },
        ]

  async function complete() {
    if (!labelPhoto || !capturedAt) return
    setSubmitting(true)
    setError(null)
    if (barRef.current) barRef.current.style.width = '100%'

    const photos: CapturedPhoto[] = [
      { type: 'label', blob: labelPhoto.blob, origKb: labelPhoto.origKb, compressedKb: labelPhoto.compressedKb },
    ]

    try {
      // undefined = label photo somehow never set it — take a live reading.
      // null = the photo was stamped without a fix; the record honours that.
      const gpsFix = usedFix !== undefined ? usedFix : await getFix()
      const signature = (await sigRef.current?.getBlob()) ?? null
      const pod = await queuePod({
        parcel,
        trackingScanned,
        status: outcome,
        failureReason: outcome === 'failed' ? failureReason : null,
        receivedBy: '',
        capturedAt,
        photos,
        location: gpsFix,
        destDistanceM: destination && gpsFix ? Math.round(haversineM(gpsFix, destination)) : null,
        signature,
        driverId,
      })
      void syncNow() // fire-and-forget — drains now if we happen to be online
      onComplete(pod, labelPhoto.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
      if (barRef.current) barRef.current.style.width = '0'
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {/* App bar — brand, the job, connection status */}
      <header className="gold-underline sticky top-0 z-30 bg-navy text-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 pb-3 pt-[max(10px,env(safe-area-inset-top))] sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to today's stops"
              className="-ml-1 grid h-9 w-9 flex-none place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              <ChevronLeft />
            </button>
            <span
              aria-hidden
              className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-gradient-to-br from-gold-soft to-gold text-navy shadow-[inset_0_1px_0_rgba(255,255,255,.35)]"
            >
              <ParcelGlyph />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[10px] font-bold uppercase tracking-[0.22em] text-gold-soft">
                Citipost · Proof of delivery
              </p>
              <h1 className="truncate font-serif text-[19px] leading-tight sm:text-[21px]">
                {parcel.tracking_number}
              </h1>
            </div>
          </div>
          <StatusPill online={online} />
        </div>
      </header>

      {/* Workspace */}
      <main className="mx-auto w-full max-w-5xl px-4 pb-12 pt-5 sm:px-6 lg:px-8 lg:pt-8">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          {/* Left — outcome + photo */}
          <div className="grid gap-5">
            <Card step="01" title="Delivery" state={outcome === 'delivered' || failureReason ? 'done' : 'required'}>
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold">{parcel.recipient_name}</div>
                  <div className="text-[13px] leading-[1.45] text-muted">
                    {parcel.address_line}
                    {parcel.postcode ? `, ${parcel.postcode}` : ''}
                  </div>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-gold">{eyebrow}</span>
              </div>

              <div className="flex gap-2.5">
                <SegButton active={outcome === 'delivered'} tone="ok" onClick={() => setOutcome('delivered')}>
                  Delivered
                </SegButton>
                <SegButton active={outcome === 'failed'} tone="fail" onClick={() => setOutcome('failed')}>
                  Couldn’t deliver
                </SegButton>
              </div>

              {outcome === 'failed' && (
                <div className="mt-3">
                  <FieldLabel>Reason (required)</FieldLabel>
                  <select
                    value={failurePreset}
                    onChange={(e) => setFailurePreset(e.target.value)}
                    className={INPUT_CLASS}
                  >
                    <option value="" disabled>
                      Select a reason…
                    </option>
                    {FAILURE_PRESETS.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  {failurePreset === 'Other…' && (
                    <input
                      value={failureOther}
                      onChange={(e) => setFailureOther(e.target.value)}
                      placeholder="Describe the failure"
                      className={`${INPUT_CLASS} mt-2`}
                    />
                  )}
                </div>
              )}
            </Card>

            <Card step="02" title="Photo evidence" state={labelPhoto ? 'done' : 'required'}>
              <PhotoZone
                photo={labelPhoto}
                onPhoto={(f) => void takePhoto(f)}
                onRetake={() => {
                  setLabelPhoto(null)
                  setUsedFix(undefined)
                }}
              />

              {/* GPS — the fix that will go on the record: once a photo
                  exists, the fix burned into it (even if that's none);
                  before that, the live reading. Real-or-nothing. */}
              {(() => {
                const shown = usedFix !== undefined ? usedFix : fix
                const pending = usedFix === undefined && acquiring
                return (
                  <div className="mt-3 rounded-xl bg-paper px-4 py-2.5 ring-1 ring-inset ring-navy/10">
                    <div className="flex min-h-[32px] items-center justify-between gap-3">
                      {pending ? (
                        <span className="flex items-center gap-2.5 text-[13px] font-medium text-muted">
                          <span className="h-4 w-4 flex-none animate-spin rounded-full border-2 border-navy/20 border-t-navy" />
                          Acquiring GPS…
                        </span>
                      ) : shown ? (
                        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] font-semibold text-ok">
                          <span className="font-mono tracking-[0.02em]">
                            {shown.lat.toFixed(5)}, {shown.lng.toFixed(5)}
                            {shown.accuracyM != null ? ` ±${shown.accuracyM}m` : ''}
                          </span>
                          {labelPhoto && (
                            <span className="rounded-full bg-ok/10 px-2.5 py-0.5 text-[11px] font-semibold text-ok">
                              {shown.source === 'photo_exif' ? 'from the photo' : 'stamped in photo'}
                            </span>
                          )}
                        </span>
                      ) : (
                        <>
                          <span className="text-[13px] font-semibold leading-snug text-fail">
                            {usedFix === null
                              ? 'Photo taken with no GPS — the record will hold no location.'
                              : 'No GPS fix — the photo will record no location.'}
                          </span>
                          {usedFix !== null && (
                            <button
                              type="button"
                              onClick={retry}
                              className="flex-none text-[13px] font-bold text-navy-500 underline"
                            >
                              Retry
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {!pending && !shown && usedFix !== null && noFixReason && (
                      <p className="mt-1 border-t border-navy/10 pt-1.5 text-[12px] leading-snug text-muted">
                        {NO_FIX_NOTES[noFixReason]}
                      </p>
                    )}
                  </div>
                )
              })()}

              {/* GPS recovered after a fix-less photo: the stamp is the truth,
                  so the only way to get the position on record is a re-shoot */}
              {usedFix === null && fix && (
                <p className="mt-3 rounded-xl border border-gold/40 bg-gold/10 px-4 py-3 text-[13px] leading-snug text-[#8a6d1a]">
                  GPS is working now, but the photo was taken without a fix — tap{' '}
                  <span className="font-semibold">Retake</span> to stamp your position in.
                </p>
              )}
            </Card>
          </div>

          {/* Right rail — signature + completion (sticky on laptop) */}
          <div className="grid gap-5 lg:sticky lg:top-24">
            <Card step="03" title="Signature" state={signed ? 'done' : 'optional'}>
              <SignatureBox handleRef={sigRef} onSignedChange={setSigned} />
            </Card>

            <section className="rounded-2xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(16,25,46,.05),0_12px_32px_-16px_rgba(16,25,46,.18)]">
              <ul className="grid gap-2.5">
                {checklist.map((item) => (
                  <li key={item.label} className="flex items-center gap-3 text-[14px]">
                    <CheckDisc done={item.done} />
                    <span className={item.done ? 'font-medium text-ink' : 'text-muted'}>
                      {item.label}
                      {item.optional && <span className="text-muted"> · optional</span>}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="my-4 h-px bg-line" />

              {error && (
                <p className="mb-3 rounded-xl border border-fail/30 bg-fail/[0.08] px-4 py-3 text-[13px] text-fail">
                  {error}
                </p>
              )}

              <button
                type="button"
                disabled={!canComplete}
                onClick={() => void complete()}
                className="relative flex h-[54px] w-full items-center justify-center overflow-hidden rounded-xl bg-navy font-serif text-[17px] tracking-[0.02em] text-white shadow-[0_10px_24px_-10px_rgba(14,28,56,.5)] transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                {submitting ? 'Saving…' : outcome === 'failed' ? 'Log failed delivery' : 'Confirm delivery'}
                <span
                  ref={barRef}
                  className="absolute bottom-0 left-0 h-[3px] w-0 bg-gold transition-[width] duration-200"
                />
              </button>

              <p className="mt-3 text-center text-[12px] leading-relaxed text-muted">
                {online
                  ? 'Saved on this device and synced to dispatch.'
                  : 'Works offline — saved on this device and synced automatically when signal returns.'}
              </p>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}

const INPUT_CLASS =
  'h-12 w-full rounded-xl border border-line bg-paper px-3.5 text-[15px] text-ink outline-none ' +
  'transition placeholder:text-muted focus:border-navy-500 focus:bg-white focus:ring-[3px] focus:ring-navy-500/15'

/** A numbered card with a status pill (done / required / optional). */
function Card({
  step,
  title,
  state,
  children,
}: {
  step: string
  title: string
  state: 'done' | 'required' | 'optional'
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(16,25,46,.05),0_12px_32px_-16px_rgba(16,25,46,.18)]">
      <header className="flex min-h-[52px] items-center justify-between gap-3 border-b border-line px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="font-mono text-[11px] font-bold text-gold">
            {step}
          </span>
          <h2 className="text-[12.5px] font-bold uppercase tracking-[0.14em] text-navy-500">{title}</h2>
        </div>
        {state === 'done' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-ok">
            <TickGlyph /> Done
          </span>
        ) : (
          <span className="rounded-full bg-navy/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            {state}
          </span>
        )}
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[11.5px] font-bold uppercase tracking-[0.12em] text-muted">
      {children}
    </label>
  )
}

/** Big dashed capture target (click or drop) → the photo with a Retake pill.
 *  One-tap simple: the whole zone opens the camera. */
function PhotoZone({
  photo,
  onPhoto,
  onRetake,
}: {
  photo: StampedPhoto | null
  onPhoto: (file: File) => void
  onRetake: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  if (photo) {
    return (
      <div className="relative aspect-[16/10] overflow-hidden rounded-xl">
        <img src={photo.url} alt="Delivery evidence" className="absolute inset-0 h-full w-full object-cover" />
        <button
          type="button"
          onClick={() => {
            if (inputRef.current) inputRef.current.value = ''
            onRetake()
          }}
          className="absolute right-3 top-3 h-10 rounded-full bg-navy/85 px-4 text-[13px] font-semibold text-white backdrop-blur-sm transition hover:bg-navy"
        >
          Retake
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onPhoto(file)
          }}
        />
      </div>
    )
  }

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files?.[0]
        if (file) onPhoto(file)
      }}
      className={`flex aspect-[16/10] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-paper text-center transition hover:border-navy-500/60 hover:bg-[#f0eee7] active:scale-[0.995] ${
        dragOver ? 'border-gold bg-gold/5' : 'border-navy-500/30'
      }`}
    >
      <span className="grid h-16 w-16 place-items-center rounded-full bg-navy">
        <CameraGlyph />
      </span>
      <span className="text-[16px] font-semibold text-navy">Photograph the parcel</span>
      <span className="text-[13px] text-muted">
        Tap to open the camera<span className="hidden sm:inline"> · or drop an image here</span>
      </span>
      {/* the input that makes the label tappable — without it only drag-drop worked */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onPhoto(file)
        }}
      />
    </label>
  )
}

function SegButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean
  tone: 'ok' | 'fail'
  onClick: () => void
  children: React.ReactNode
}) {
  const activeClass = tone === 'ok' ? 'border-ok bg-ok text-white' : 'border-fail bg-fail text-white'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-12 flex-1 rounded-xl border text-[14.5px] font-semibold transition ${
        active ? activeClass : 'border-line bg-white text-muted hover:border-navy-500/40'
      }`}
    >
      {children}
    </button>
  )
}

function StatusPill({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex h-9 flex-none items-center gap-2 rounded-full border px-3.5 text-[11px] font-bold uppercase tracking-[0.12em] ${
        online ? 'border-ok/40 bg-ok/10 text-ok' : 'border-gold/40 bg-gold/10 text-gold-soft'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'bg-ok' : 'animate-pulse bg-gold'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

function CheckDisc({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid h-6 w-6 flex-none place-items-center rounded-full transition ${
        done ? 'bg-ok text-white' : 'bg-white text-transparent ring-1 ring-inset ring-navy/25'
      }`}
    >
      <TickGlyph />
    </span>
  )
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function CameraGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 stroke-gold-soft" fill="none" strokeWidth="1.7" aria-hidden>
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="13" cy="12.5" r="3.5" />
    </svg>
  )
}

function TickGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 12.5 10 18 19.5 6.5" />
    </svg>
  )
}

function ParcelGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </svg>
  )
}
