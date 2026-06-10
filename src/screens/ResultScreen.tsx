import { useMemo, useState } from 'react'
import { ColourJson } from '../components/ColourJson'
import { useQueuedPod } from '../hooks/useSyncStatus'
import type { QueuedPod } from '../lib/db'
import { fmtDistance } from '../lib/geo'
import { photoPath, signaturePath } from '../lib/pod'

/** Confirmation: green banner, the stamped photo, then a human-readable
 *  delivery receipt. The raw record JSON lives behind a collapsed
 *  "technical record" toggle — demo material, not driver UI. Watches the
 *  local queue so everything flips live from queued to synced. Two columns
 *  on laptop (proof | receipt), a single flow on mobile. */
export function ResultScreen({
  pod: initialPod,
  previewUrl,
  onReset,
}: {
  pod: QueuedPod
  previewUrl: string
  onReset: () => void
}) {
  const pod = useQueuedPod(initialPod.podId) ?? initialPod
  const [showTech, setShowTech] = useState(false)
  const failed = pod.status === 'failed'
  const synced = pod.synced === 1
  const label = pod.photos.find((p) => p.type === 'label')
  const where = pod.photos.find((p) => p.type === 'where_left')
  const signatureUrl = useMemo(
    () => (pod.signature ? URL.createObjectURL(pod.signature) : null),
    [pod.signature],
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
      <div className="mb-5 flex items-center gap-[11px] rounded-[13px] border border-[#cbe6d5] bg-[#eef6f0] px-3.5 py-[13px]">
        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full bg-ok">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] stroke-white" fill="none" strokeWidth="2.4">
            <path d="M4 12.5l5 5L20 6.5" />
          </svg>
        </span>
        <div>
          <div className="text-[13.5px] font-bold text-[#1d6840]">{title}</div>
          <div className="mt-px text-xs text-[#3f7a59]">{sub}</div>
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-8">
        {/* Proof photo */}
        <div>
          <p className="section-label mb-[9px]">Proof photo</p>
          <img
            src={previewUrl}
            alt="Proof of delivery photo"
            className="block w-full rounded-[13px] border border-line"
          />
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

          {/* The raw record, for demos and debugging — collapsed by default */}
          <button
            type="button"
            onClick={() => setShowTech((s) => !s)}
            className="mx-auto mt-3.5 block text-[11.5px] text-muted underline"
          >
            {showTech ? 'Hide technical record' : 'View technical record'}
          </button>
          {showTech && (
            <div className="mt-2.5">
              <ColourJson
                header={synced ? 'POD record · synced to Supabase' : 'POD record · saved to device'}
                value={buildTechRecord(pod, synced)}
              />
            </div>
          )}

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

function buildTechRecord(pod: QueuedPod, synced: boolean) {
  return {
    pod_id: pod.podId,
    parcel_ref: pod.parcelRef,
    tracking: pod.trackingScanned,
    status: pod.status,
    ...(pod.status === 'failed' ? { failure_reason: pod.failureReason } : {}),
    received_by: pod.receivedBy,
    captured_at: pod.capturedAt,
    synced_at: pod.syncedAt,
    location: pod.location
      ? { lat: pod.location.lat, lng: pod.location.lng, accuracy_m: pod.location.accuracyM }
      : null,
    gps_source: pod.location?.source ?? null,
    dest_distance_m: pod.destDistanceM,
    signature: pod.signature ? (synced ? signaturePath(pod.podId) : 'queued') : null,
    photos: pod.photos.map((p) => ({
      type: p.type,
      stored: synced ? photoPath(pod.podId, p.type) : 'pending-upload',
      orig_kb: p.origKb,
      compressed_kb: p.compressedKb,
    })),
    driver_id: pod.driverId ?? null,
    device_queued: !synced,
  }
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
