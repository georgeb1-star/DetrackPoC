import exifr from 'exifr'
import { useMemo, useRef, useState } from 'react'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { SignatureBox, type SignatureHandle } from '../components/SignatureBox'
import { TopBar } from '../components/TopBar'
import { useGeolocation } from '../hooks/useGeolocation'
import { fmtDistance, haversineM, parseEwkbPoint } from '../lib/geo'
import { queueSitePod, type CapturedPhoto } from '../lib/pod'
import { stampAndCompress, type StampedPhoto } from '../lib/stamp'
import { syncNow } from '../lib/syncWorker'
import type { Fix, PodStatus, Site } from '../lib/types'

const KIND_LABEL: Record<Site['kind'], string> = { store: 'Store', depot: 'Depot', both: 'Store & depot' }
const FAILURE_PRESETS = ['Refused', 'Closed', 'Wrong site', 'Other…'] as const

/** Scan-and-capture against a SITE (store/depot) — the no-manifest path. The
 *  driver scans an item's barcode on the spot, captures proof (photo stamped
 *  with time + GPS, optional signature), and it's queued as a POD tagged to the
 *  site (no parcel). Then it loops back to scan the next item. Same evidence
 *  bundle and real-or-nothing GPS as the parcel capture. */
export function SiteCaptureScreen({
  site,
  driverId,
  onBack,
}: {
  site: Site
  driverId: string
  onBack: () => void
}) {
  const { fix, noFixReason, acquiring, getFix, retry } = useGeolocation()
  const [tracking, setTracking] = useState<string | null>(null) // the item being captured
  const [typed, setTyped] = useState('')
  const [photo, setPhoto] = useState<StampedPhoto | null>(null)
  const [capturedAt, setCapturedAt] = useState<Date | null>(null)
  const [usedFix, setUsedFix] = useState<Fix | null | undefined>(undefined)
  const [receivedBy, setReceivedBy] = useState('')
  const [outcome, setOutcome] = useState<PodStatus>('delivered')
  const [failurePreset, setFailurePreset] = useState('')
  const [failureOther, setFailureOther] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState(0) // items captured at this site this visit
  const sigRef = useRef<SignatureHandle>(null)
  const lastScanRef = useRef({ v: '', t: 0 })
  const destination = useMemo(() => parseEwkbPoint(site.destination), [site.destination])

  const failureReason = failurePreset === 'Other…' ? failureOther.trim() : failurePreset

  function pickItem(raw: string, source: 'scan' | 'type') {
    const v = raw.trim().toUpperCase()
    if (!v) return
    if (source === 'scan') {
      // throttle repeat frames from the camera
      const now = Date.now()
      if (lastScanRef.current.v === v && now - lastScanRef.current.t < 2500) return
      lastScanRef.current = { v, t: now }
    }
    navigator.vibrate?.(60)
    setTracking(v)
    setTyped('')
  }

  async function takePhoto(file: File) {
    try {
      const takenAt = new Date()
      // EXIF-first GPS, then a live device fix at the shutter (matches the
      // parcel capture); no fix → null, never fabricated.
      const exif = await exifr.gps(file).catch(() => undefined)
      const gpsFix: Fix | null =
        exif && Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
          ? { lat: +exif.latitude.toFixed(5), lng: +exif.longitude.toFixed(5), accuracyM: null, source: 'photo_exif' }
          : await getFix()
      const stamped = await stampAndCompress(file, tracking ?? site.name, takenAt, gpsFix)
      setPhoto(stamped)
      setCapturedAt(takenAt)
      setUsedFix(gpsFix)
    } catch (e) {
      setError(`Photo processing failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function cancelItem() {
    setTracking(null)
    setPhoto(null)
    setCapturedAt(null)
    setUsedFix(undefined)
    setReceivedBy('')
    setOutcome('delivered')
    setFailurePreset('')
    setFailureOther('')
  }

  const canComplete = !!tracking && !!photo && !submitting && (outcome === 'delivered' || failureReason.length > 0)

  async function complete() {
    if (!tracking || !photo || !capturedAt) return
    setSubmitting(true)
    setError(null)
    try {
      const gpsFix = usedFix !== undefined ? usedFix : await getFix()
      const signature = (await sigRef.current?.getBlob()) ?? null
      const photos: CapturedPhoto[] = [
        { type: 'label', blob: photo.blob, origKb: photo.origKb, compressedKb: photo.compressedKb },
      ]
      await queueSitePod({
        siteId: site.id,
        siteName: site.name,
        trackingScanned: tracking,
        status: outcome,
        failureReason: outcome === 'failed' ? failureReason : null,
        receivedBy: receivedBy.trim(),
        capturedAt,
        photos,
        location: gpsFix,
        destDistanceM: destination && gpsFix ? Math.round(haversineM(gpsFix, destination)) : null,
        signature,
        driverId,
      })
      void syncNow()
      setCount((c) => c + 1)
      cancelItem() // back to scanning the next item
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSubmitting(false)
  }

  const shownFix = usedFix !== undefined ? usedFix : fix
  const dist = shownFix && destination ? haversineM(shownFix, destination) : null

  return (
    <>
      <TopBar
        eyebrow={`Citipost · ${KIND_LABEL[site.kind]}`}
        title={site.name}
        mono={`${count} item${count === 1 ? '' : 's'} captured`}
        onBack={onBack}
        insetTop
      />

      <div className="mx-auto w-full max-w-2xl px-4 py-5 lg:px-8 lg:py-7">
        <div className="mb-5 rounded-2xl border border-line bg-white px-4 py-3.5">
          <div className="text-[15px] font-semibold">{site.name}</div>
          <div className="mt-0.5 text-[13px] leading-[1.45] text-muted">
            {site.address_line || 'No address on file'}
            {site.postcode ? `, ${site.postcode}` : ''}
          </div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.6px] text-gold">No manifest · scan to capture</div>
        </div>

        {error && (
          <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{error}</div>
        )}

        {!tracking ? (
          /* Step 1 — scan / enter an item barcode */
          <div>
            <p className="section-label mb-2">Scan an item</p>
            <BarcodeScanner onDecode={(v) => pickItem(v, 'scan')} />
            <p className="section-label mb-2 mt-4">Or type the barcode</p>
            <div className="flex gap-2">
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && pickItem(typed, 'type')}
                placeholder="Item barcode"
                className="min-w-0 flex-1 rounded-[11px] border border-line bg-white px-3 py-[11px] font-mono text-sm uppercase tracking-[1px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
              />
              <button
                type="button"
                onClick={() => pickItem(typed, 'type')}
                className="flex-none rounded-[11px] bg-navy px-4 font-serif text-[15px] text-white"
              >
                Capture
              </button>
            </div>
            {count > 0 && (
              <p className="mt-4 text-center text-[12.5px] text-muted">
                {count} item{count === 1 ? '' : 's'} captured at {site.name}.
              </p>
            )}
            <button
              type="button"
              onClick={onBack}
              className="mt-4 w-full rounded-[11px] border border-line bg-white p-[12px] text-[13.5px] font-semibold text-muted"
            >
              Done at this site
            </button>
          </div>
        ) : (
          /* Step 2 — capture proof for the scanned item */
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="font-mono text-[13px] tracking-[1px] text-navy-500">{tracking}</div>
              <button type="button" onClick={cancelItem} className="text-[12px] font-semibold text-muted underline">
                Scan a different item
              </button>
            </div>

            <PhotoZone photo={photo} onPhoto={(f) => void takePhoto(f)} onRetake={() => setPhoto(null)} />

            <div className="mt-3 grid grid-cols-2 gap-[9px]">
              <Chip
                k="Timestamp"
                v={capturedAt?.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) ?? '—'}
                pending={!capturedAt}
              />
              <Chip
                k={shownFix?.source === 'photo_exif' ? 'GPS (from photo)' : 'GPS location'}
                v={
                  shownFix
                    ? `${shownFix.lat.toFixed(5)}, ${shownFix.lng.toFixed(5)}`
                    : usedFix === undefined && acquiring
                      ? 'acquiring…'
                      : 'no fix'
                }
                pending={usedFix === undefined && acquiring}
                fail={!shownFix && !(usedFix === undefined && acquiring)}
              />
            </div>
            {dist != null && (
              <div className="mt-2 text-[11.5px] text-muted">
                {fmtDistance(dist)} from the site's pin
              </div>
            )}
            {!shownFix && noFixReason && (
              <button type="button" onClick={retry} className="mt-2 text-[12px] font-semibold text-navy-500 underline">
                Retry GPS
              </button>
            )}

            <div className="mt-4">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">
                Received by (optional)
              </label>
              <input
                value={receivedBy}
                onChange={(e) => setReceivedBy(e.target.value)}
                placeholder={'Name, or "left at goods-in"'}
                className="w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
              />
            </div>

            <div className="mt-3.5">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">Outcome</label>
              <div className="flex gap-2">
                <SegButton active={outcome === 'delivered'} colour="ok" onClick={() => setOutcome('delivered')}>
                  Delivered
                </SegButton>
                <SegButton active={outcome === 'failed'} colour="fail" onClick={() => setOutcome('failed')}>
                  Failed
                </SegButton>
              </div>
            </div>

            {outcome === 'failed' && (
              <div className="mt-3">
                <select
                  value={failurePreset}
                  onChange={(e) => setFailurePreset(e.target.value)}
                  className="w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink focus:border-navy-500 focus:outline-none"
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
                    className="mt-2 w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink focus:border-navy-500 focus:outline-none"
                  />
                )}
              </div>
            )}

            <div className="mt-3.5">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">
                Signature (optional)
              </label>
              <SignatureBox handleRef={sigRef} />
            </div>

            <button
              type="button"
              disabled={!canComplete}
              onClick={() => void complete()}
              className="mt-[18px] w-full rounded-[13px] bg-navy p-[15px] font-serif text-base tracking-[0.3px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Saving…' : 'Capture item & scan next'}
            </button>
          </div>
        )}
      </div>
    </>
  )
}

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
  return (
    <label
      className={`relative flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 bg-white p-3.5 text-center text-navy transition active:scale-[0.99] ${
        photo ? 'border-solid border-navy' : 'border-dashed border-navy-500'
      }`}
    >
      {photo ? (
        <>
          <img src={photo.url} alt="captured item" className="absolute inset-0 h-full w-full object-cover" />
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
          <span className="text-sm font-semibold">Tap to photograph the item</span>
          <span className="text-xs text-muted">Time + GPS are burned into the image</span>
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

function Chip({ k, v, pending = false, fail = false }: { k: string; v: string; pending?: boolean; fail?: boolean }) {
  return (
    <div className="rounded-[11px] border border-line bg-white px-[11px] py-[9px]">
      <div className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">{k}</div>
      <div className={`mt-[3px] text-[13px] tabular-nums ${pending ? 'font-medium text-muted' : fail ? 'font-semibold text-fail' : 'font-semibold'}`}>
        {v}
      </div>
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
      className={`flex-1 rounded-[11px] border p-[11px] text-[13.5px] font-semibold transition ${active ? activeClass : 'border-line bg-white text-muted'}`}
    >
      {children}
    </button>
  )
}
