import { useEffect, useMemo } from 'react'
import { useQueuedPod, useQueuedPodByParcel } from '../hooks/useSyncStatus'
import type { QueuedPod } from '../lib/db'
import { fmtDistance } from '../lib/geo'
import { STATUS_LABEL, type Parcel } from '../lib/types'

/** Confirmation: green banner, the stamped photo, then a human-readable
 *  delivery receipt — the proof a driver actually needs (the raw POD JSON is
 *  dispatcher/debug material and isn't shown here). Watches the local queue so
 *  everything flips live from queued to synced. Two columns on laptop
 *  (proof | receipt), a single flow on mobile. */
export function ResultScreen({
  pod: initialPod,
  previewUrl,
  onReset,
}: {
  pod: QueuedPod
  /** The fresh-capture object URL. Absent when re-opening a completed stop —
   *  the proof photo is then derived from the stored label blob below. */
  previewUrl?: string
  onReset: () => void
}) {
  const pod = useQueuedPod(initialPod.podId) ?? initialPod
  const failed = pod.status === 'failed'
  const synced = pod.synced === 1
  const label = pod.photos.find((p) => p.type === 'label')
  const where = pod.photos.find((p) => p.type === 'where_left')
  // Proof photo: the in-memory URL from a fresh capture, or — when re-opening a
  // completed stop — one made from the stored label blob (revoked on unmount so
  // repeated visits don't leak object URLs).
  const derivedPhotoUrl = useMemo(
    () => (!previewUrl && label?.blob ? URL.createObjectURL(label.blob) : null),
    [previewUrl, label?.blob],
  )
  useEffect(
    () => () => {
      if (derivedPhotoUrl) URL.revokeObjectURL(derivedPhotoUrl)
    },
    [derivedPhotoUrl],
  )
  const photoSrc = previewUrl ?? derivedPhotoUrl
  const signatureUrl = useMemo(
    () => (pod.signature ? URL.createObjectURL(pod.signature) : null),
    [pod.signature],
  )
  useEffect(
    () => () => {
      if (signatureUrl) URL.revokeObjectURL(signatureUrl)
    },
    [signatureUrl],
  )

  const title = synced
    ? failed
      ? 'Failed delivery logged'
      : 'Delivery complete'
    : failed
      ? 'Failed delivery saved to device'
      : 'Delivery saved to device'
  const sub = synced
    ? `Synced to dispatch at ${fmtTime(pod.syncedAt)}`
    : 'Will upload automatically when signal returns'

  const gpsNote = pod.location?.source === 'photo_exif' ? ' · from photo' : ''

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 lg:px-8 lg:py-7">
      <div
        className={`mb-5 flex items-center gap-[11px] rounded-[13px] border px-3.5 py-[13px] ${
          failed ? 'border-fail/30 bg-fail/[0.06]' : 'border-[#c2e9d8] bg-[#edf7f2]'
        }`}
      >
        <span
          className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full ${
            failed ? 'bg-fail' : 'bg-ok'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] stroke-white" fill="none" strokeWidth="2.4">
            {failed ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 12.5l5 5L20 6.5" />}
          </svg>
        </span>
        <div>
          <div className={`text-[13.5px] font-bold ${failed ? 'text-fail' : 'text-[#0b7a4b]'}`}>{title}</div>
          <div className={`mt-px text-xs ${failed ? 'text-fail/80' : 'text-[#3b7d5f]'}`}>{sub}</div>
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-8">
        {/* Proof photo */}
        <div>
          <p className="section-label mb-[9px]">Proof photo</p>
          {photoSrc ? (
            <img
              src={photoSrc}
              alt="Proof of delivery photo"
              className="block w-full rounded-[13px] border border-line"
            />
          ) : (
            <div className="grid aspect-[16/10] w-full place-items-center rounded-[13px] border border-dashed border-line bg-paper text-[13px] text-muted">
              Photo not available on this device
            </div>
          )}
        </div>

        {/* Receipt + actions */}
        <div className="mt-6 lg:mt-0">
          {/* Delivery receipt — what a driver/customer actually needs to see */}
          <p className="section-label mb-[9px]">Delivery summary</p>
          <div className="overflow-hidden rounded-[13px] border border-line bg-white">
            {/* Branded receipt header — a POD slip carries the company mark */}
            <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <img src="/i2i-logo.png" alt="Insight 2 Innovate · Citipost" className="h-6 w-auto" />
              <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">
                Proof of delivery
              </span>
            </div>
            <Row k="Parcel">
              <span className="font-serif text-[14px]">{pod.parcelRef}</span>
            </Row>
            <Row k="Outcome">
              <span className={failed ? 'font-bold text-fail' : 'font-bold text-ok'}>
                {failed ? 'Failed' : 'Delivered'}
              </span>
              {failed && pod.failureReason ? (
                <span className="text-muted"> — {pod.failureReason}</span>
              ) : null}
            </Row>
            <Row k="Received by">{pod.receivedBy ?? '—'}</Row>
            <Row k="Time (device)">{fmtDateTime(pod.capturedAt)}</Row>
            <Row k="Synced (server)">
              {synced ? (
                fmtDateTime(pod.syncedAt)
              ) : (
                <span className="text-gold">Queued on device</span>
              )}
            </Row>
            <Row k={`Location${gpsNote}`}>
              {pod.location ? (
                <a
                  href={`https://www.openstreetmap.org/?mlat=${pod.location.lat}&mlon=${pod.location.lng}#map=17/${pod.location.lat}/${pod.location.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-navy-500 underline"
                >
                  {pod.location.lat.toFixed(5)}, {pod.location.lng.toFixed(5)}
                  {pod.location.accuracyM != null ? ` ±${pod.location.accuracyM}m` : ''}
                </a>
              ) : (
                <span className="text-fail">Not recorded</span>
              )}
            </Row>
            <Row k="From address">
              {pod.destDistanceM == null ? (
                '—'
              ) : (
                <span
                  className={
                    pod.destDistanceM <= 250 ? 'text-ok' : pod.destDistanceM <= 1000 ? 'text-gold' : 'text-fail'
                  }
                >
                  {fmtDistance(pod.destDistanceM)}
                </span>
              )}
            </Row>
            <Row k="Photos">
              {label ? `Label ${label.compressedKb} KB` : '—'}
              {where ? ` · Where left ${where.compressedKb} KB` : ''}
            </Row>
            {signatureUrl && (
              <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">
                  Signature
                </span>
                <img src={signatureUrl} alt="signature" className="h-10 rounded-[6px] border border-line px-1" />
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onReset}
            className="mt-4 w-full rounded-[13px] bg-navy p-[15px] font-serif text-base tracking-[0.3px] text-white transition hover:bg-navy-600 active:translate-y-px"
          >
            Back to today's stops
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line px-3.5 py-2.5 last:border-b-0">
      <span className="flex-none text-[10px] font-bold uppercase tracking-[0.6px] text-muted">{k}</span>
      <span className="min-w-0 text-right text-[13px] font-medium tabular-nums">{children}</span>
    </div>
  )
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Read-only receipt for a stop that's already finished. Re-opening a completed
 *  stop routes here instead of the capture screen, so the driver sees the proof
 *  they captured (reassurance) and CANNOT re-capture — which would otherwise
 *  mint a second POD for the same parcel. The proof is read from the local
 *  queue by parcel; if it isn't there (captured on another device, or cache
 *  cleared) we show a minimal status card rather than a blank screen. */
export function StopReceipt({ parcel, onReset }: { parcel: Parcel; onReset: () => void }) {
  const { pod, loading } = useQueuedPodByParcel(parcel.id)

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center px-4 py-16 text-[13px] text-muted">
        <span className="mr-2.5 h-4 w-4 animate-spin rounded-full border-2 border-navy/20 border-t-navy" />
        Loading proof…
      </div>
    )
  }
  if (!pod) return <NoLocalProof parcel={parcel} onReset={onReset} />
  return <ResultScreen pod={pod} onReset={onReset} />
}

/** Fallback when a completed stop has no proof on THIS device. The full
 *  evidence still lives server-side (dispatcher portal); here we just confirm
 *  the outcome read-only, never dropping the driver into a capture form. */
function NoLocalProof({ parcel, onReset }: { parcel: Parcel; onReset: () => void }) {
  const returned = parcel.status === 'returned'
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 lg:px-8 lg:py-7">
      <div
        className={`mb-5 flex items-center gap-[11px] rounded-[13px] border px-3.5 py-[13px] ${
          returned ? 'border-fail/30 bg-fail/[0.06]' : 'border-[#c2e9d8] bg-[#edf7f2]'
        }`}
      >
        <span
          className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full ${
            returned ? 'bg-fail' : 'bg-ok'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] stroke-white" fill="none" strokeWidth="2.4">
            {returned ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 12.5l5 5L20 6.5" />}
          </svg>
        </span>
        <div>
          <div className={`text-[13.5px] font-bold ${returned ? 'text-fail' : 'text-[#0b7a4b]'}`}>
            {STATUS_LABEL[parcel.status]}
          </div>
          <div className={`mt-px text-xs ${returned ? 'text-fail/80' : 'text-[#3b7d5f]'}`}>
            {parcel.completed_at ? `Completed ${fmtDateTime(parcel.completed_at)}` : 'This stop is finished'}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[13px] border border-line bg-white">
        <Row k="Parcel">
          <span className="font-serif text-[14px]">{parcel.tracking_number}</span>
        </Row>
        <Row k="Recipient">{parcel.recipient_name}</Row>
        <Row k="Address">
          {parcel.address_line}
          {parcel.postcode ? `, ${parcel.postcode}` : ''}
        </Row>
        <Row k="Status">
          <span className={returned ? 'font-bold text-fail' : 'font-bold text-ok'}>
            {STATUS_LABEL[parcel.status]}
          </span>
        </Row>
      </div>

      <p className="mt-3 text-center text-[12px] leading-relaxed text-muted">
        The proof for this stop was captured on another device. View the full
        evidence — photo, signature and GPS — in the dispatcher portal.
      </p>

      <button
        type="button"
        onClick={onReset}
        className="mt-4 w-full rounded-[13px] bg-navy p-[15px] font-serif text-base tracking-[0.3px] text-white transition hover:bg-navy-600 active:translate-y-px"
      >
        Back to today's stops
      </button>
    </div>
  )
}
