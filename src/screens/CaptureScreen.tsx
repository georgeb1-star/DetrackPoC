import exifr from 'exifr'
import { useRef, useState } from 'react'
import { SignatureBox, type SignatureHandle } from '../components/SignatureBox'
import { TopBar } from '../components/TopBar'
import { useGeolocation } from '../hooks/useGeolocation'
import type { QueuedPod } from '../lib/db'
import { queuePod, type CapturedPhoto } from '../lib/pod'
import { stampAndCompress, type StampedPhoto } from '../lib/stamp'
import { syncNow } from '../lib/syncWorker'
import type { Fix, Parcel, PodStatus } from '../lib/types'

const FAILURE_PRESETS = ['No access', 'Refused', 'Address not found', 'Other…'] as const

/** Capture screen (§6.2): the full §5 evidence bundle, one-handed. Photos are
 *  stamped + compressed on capture; GPS falls back to a simulated fix;
 *  signature is optional. Completion writes to the local queue (§8) and
 *  returns instantly — the sync worker uploads in the background. */
export function CaptureScreen({
  parcel,
  trackingScanned,
  eyebrow,
  onComplete,
  onBack,
}: {
  parcel: Parcel
  trackingScanned: string
  /** e.g. "Stop 2 of 7 · Domestic" or "Rollover · Domestic" */
  eyebrow: string
  onComplete: (pod: QueuedPod, previewUrl: string) => void
  onBack: () => void
}) {
  const { fix, getFix } = useGeolocation()
  const [labelPhoto, setLabelPhoto] = useState<StampedPhoto | null>(null)
  const [wherePhoto, setWherePhoto] = useState<StampedPhoto | null>(null)
  const [capturedAt, setCapturedAt] = useState<Date | null>(null)
  const [receivedBy, setReceivedBy] = useState('')
  const [outcome, setOutcome] = useState<PodStatus>('delivered')
  const [failurePreset, setFailurePreset] = useState('')
  const [failureOther, setFailureOther] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sigRef = useRef<SignatureHandle>(null)
  // The fix actually burned into the label photo — the record must match the image
  const [usedFix, setUsedFix] = useState<Fix | null>(null)
  const barRef = useRef<HTMLSpanElement>(null)

  async function takePhoto(file: File, slot: 'label' | 'where_left') {
    try {
      const takenAt = new Date() // evidence time = device clock at the shutter (§5)
      // GPS provenance ladder: prefer the fix the camera embedded in the
      // photo itself (EXIF), then live device GPS, then the simulated demo
      // fix. Browsers often strip EXIF location for privacy, so the fallback
      // path is the common one.
      const exif = await exifr.gps(file).catch(() => undefined)
      const gpsFix: Fix =
        exif && Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
          ? {
              lat: +exif.latitude.toFixed(5),
              lng: +exif.longitude.toFixed(5),
              accuracyM: null, // cameras don't record accuracy in EXIF
              source: 'photo_exif',
            }
          : await getFix() // awaits the in-flight acquisition if needed
      const stamped = await stampAndCompress(file, parcel.tracking_number, takenAt, gpsFix)
      if (slot === 'label') {
        setLabelPhoto(stamped)
        setCapturedAt((prev) => prev ?? takenAt)
        setUsedFix(gpsFix)
      } else {
        setWherePhoto(stamped)
      }
    } catch (e) {
      setError(`Photo processing failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const failureReason = failurePreset === 'Other…' ? failureOther.trim() : failurePreset
  const canComplete =
    !!labelPhoto && !submitting && (outcome === 'delivered' || failureReason.length > 0)

  async function complete() {
    if (!labelPhoto || !capturedAt) return
    setSubmitting(true)
    setError(null)
    if (barRef.current) barRef.current.style.width = '100%'

    const photos: CapturedPhoto[] = [
      { type: 'label', blob: labelPhoto.blob, origKb: labelPhoto.origKb, compressedKb: labelPhoto.compressedKb },
    ]
    if (wherePhoto) {
      photos.push({ type: 'where_left', blob: wherePhoto.blob, origKb: wherePhoto.origKb, compressedKb: wherePhoto.compressedKb })
    }

    try {
      const gpsFix = usedFix ?? (await getFix())
      const signature = (await sigRef.current?.getBlob()) ?? null
      // Local-first (§8): this is an IndexedDB write — instant, works with
      // zero signal. The driver sees "queued" immediately.
      const pod = await queuePod({
        parcel,
        trackingScanned,
        status: outcome,
        failureReason: outcome === 'failed' ? failureReason : null,
        receivedBy: receivedBy.trim(),
        capturedAt,
        photos,
        location: gpsFix,
        signature,
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
    <>
      <TopBar
        eyebrow={eyebrow}
        title={parcel.tracking_number}
        mono={`‖▌║▌‖║▌║‖ ${trackingScanned.replace(/-/g, ' ')}`}
        onBack={onBack}
      />

      <div className="border-b border-line bg-white px-[18px] py-3.5">
        <div className="text-[15px] font-semibold">{parcel.recipient_name}</div>
        <div className="mt-0.5 text-[13px] leading-[1.45] text-muted">
          {parcel.address_line}
          {parcel.postcode ? `, ${parcel.postcode}` : ''}
        </div>
      </div>

      <div className="px-[18px] pb-5 pt-4">
        <p className="section-label mb-[9px]">Capture label</p>
        <PhotoZone
          photo={labelPhoto}
          prompt="Tap to photograph the label"
          sub="Timestamp + GPS are burned into the image"
          onPhoto={(f) => void takePhoto(f, 'label')}
          onRetake={() => setLabelPhoto(null)}
        />

        <div className="mt-3">
          <PhotoZone
            photo={wherePhoto}
            prompt="Add photo of where it was left"
            sub="Optional"
            compact
            onPhoto={(f) => void takePhoto(f, 'where_left')}
            onRetake={() => setWherePhoto(null)}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-[9px]">
          <Chip
            k="Timestamp"
            v={capturedAt?.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) ?? '—'}
            pending={!capturedAt}
          />
          {/* Shows the fix that will go on the record: the photo's EXIF fix
              once a photo is taken, otherwise the live device fix. Gold +
              "(simulated)" when it's the fallback (§7). */}
          {(() => {
            const shown = usedFix ?? fix
            const k =
              shown?.source === 'photo_exif'
                ? 'GPS location (from photo)'
                : shown?.source === 'simulated'
                  ? 'GPS location (simulated)'
                  : 'GPS location'
            return (
              <Chip
                k={k}
                v={shown ? `${shown.lat.toFixed(5)}, ${shown.lng.toFixed(5)}` : 'acquiring…'}
                pending={!shown}
                sim={shown?.source === 'simulated'}
              />
            )
          })()}
        </div>

        <Field label="Received by">
          <input
            value={receivedBy}
            onChange={(e) => setReceivedBy(e.target.value)}
            placeholder={'Name, or "left in porch"'}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="Outcome">
          <div className="flex gap-2">
            <SegButton active={outcome === 'delivered'} colour="ok" onClick={() => setOutcome('delivered')}>
              Delivered
            </SegButton>
            <SegButton active={outcome === 'failed'} colour="fail" onClick={() => setOutcome('failed')}>
              Failed
            </SegButton>
          </div>
        </Field>

        {outcome === 'failed' && (
          <Field label="Failure reason (required)">
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
          </Field>
        )}

        <Field label="Signature (optional)">
          <SignatureBox handleRef={sigRef} />
        </Field>

        {error && (
          <div className="mt-3.5 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
            {error}
          </div>
        )}

        <button
          type="button"
          disabled={!canComplete}
          onClick={complete}
          className="relative mt-[18px] w-full overflow-hidden rounded-[13px] bg-navy p-[15px] font-serif text-base tracking-[0.3px] text-white transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'Saving…' : 'Complete delivery'}
          <span
            ref={barRef}
            className="absolute bottom-0 left-0 h-[3px] w-0 bg-gold transition-[width] duration-200"
          />
        </button>
      </div>
    </>
  )
}

const INPUT_CLASS =
  'w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink ' +
  'focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10'

/** Dashed capture zone → solid-bordered photo with a translucent Retake pill (§7). */
function PhotoZone({
  photo,
  prompt,
  sub,
  compact = false,
  onPhoto,
  onRetake,
}: {
  photo: StampedPhoto | null
  prompt: string
  sub: string
  compact?: boolean
  onPhoto: (file: File) => void
  onRetake: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <label
      className={`relative flex w-full cursor-pointer flex-col items-center justify-center gap-2.5 overflow-hidden rounded-2xl border-2 bg-white p-3.5 text-center text-navy transition active:scale-[0.99] ${
        photo ? 'border-solid border-navy aspect-[4/3]' : compact ? 'border-dashed border-navy-500/60 py-4' : 'border-dashed border-navy-500 aspect-[4/3]'
      }`}
    >
      {photo ? (
        <>
          <img src={photo.url} alt="captured" className="absolute inset-0 h-full w-full object-cover" />
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              if (inputRef.current) inputRef.current.value = ''
              onRetake()
            }}
            className="absolute right-2.5 top-2.5 z-[3] rounded-[20px] bg-navy/80 px-3 py-[7px] text-[11.5px] font-semibold text-white backdrop-blur-sm"
          >
            Retake
          </button>
        </>
      ) : (
        <>
          {!compact && (
            <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-navy">
              <CameraIcon />
            </span>
          )}
          <span className={`font-semibold ${compact ? 'text-[13px]' : 'text-sm'}`}>{prompt}</span>
          <span className="text-xs text-muted">{sub}</span>
        </>
      )}
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
    </label>
  )
}

function Chip({ k, v, pending = false, sim = false }: { k: string; v: string; pending?: boolean; sim?: boolean }) {
  return (
    <div className="rounded-[11px] border border-line bg-white px-[11px] py-[9px]">
      <div className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">{k}</div>
      <div
        className={`mt-[3px] text-[13px] tabular-nums ${
          pending ? 'font-medium text-muted' : sim ? 'font-semibold text-gold' : 'font-semibold'
        }`}
      >
        {v}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3.5">
      <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">
        {label}
      </label>
      {children}
    </div>
  )
}

function SegButton({
  active,
  colour,
  onClick,
  children,
}: {
  active: boolean
  colour: 'ok' | 'fail'
  onClick: () => void
  children: React.ReactNode
}) {
  const activeClass = colour === 'ok' ? 'bg-ok border-ok text-white' : 'bg-fail border-fail text-white'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-[11px] border p-[11px] text-[13.5px] font-semibold transition ${
        active ? activeClass : 'border-line bg-white text-muted'
      }`}
    >
      {children}
    </button>
  )
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 stroke-gold-soft" fill="none" strokeWidth="1.7" aria-hidden>
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="13" cy="12.5" r="3.5" />
    </svg>
  )
}
