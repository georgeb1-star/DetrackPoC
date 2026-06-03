import { ColourJson } from '../components/ColourJson'
import { useQueuedPod } from '../hooks/useSyncStatus'
import type { QueuedPod } from '../lib/db'
import { photoPath, signaturePath } from '../lib/pod'

/** Confirmation (§7): green banner with tick disc, the stamped photo, then
 *  the POD record in the dark navy JSON panel. Watches the local queue, so
 *  the record visibly flips from "queued offline" to "synced" the moment the
 *  sync worker gets it through. */
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
  const failed = pod.status === 'failed'
  const synced = pod.synced === 1
  const label = pod.photos.find((p) => p.type === 'label')

  const title = synced
    ? failed
      ? 'Failed delivery logged & synced'
      : 'Captured & synced'
    : failed
      ? 'Failed delivery logged & queued'
      : 'Captured & queued offline'
  const sub = synced
    ? `Uploaded — server trust stamp ${fmtTime(pod.syncedAt)}`
    : 'Will upload automatically when signal returns'

  // Mirrors the reference record shape; storage paths appear once they exist
  const display = {
    pod_id: pod.podId,
    parcel_ref: pod.parcelRef,
    tracking: pod.trackingScanned,
    status: pod.status,
    ...(failed ? { failure_reason: pod.failureReason } : {}),
    received_by: pod.receivedBy ?? (failed ? '—' : 'Signed for'),
    captured_at: pod.capturedAt,
    synced_at: pod.syncedAt,
    location: pod.location
      ? { lat: pod.location.lat, lng: pod.location.lng, accuracy_m: pod.location.accuracyM }
      : null,
    gps_source: pod.location?.source ?? 'device',
    gps_simulated: pod.location?.source === 'simulated',
    signature: pod.signature ? (synced ? signaturePath(pod.podId) : 'queued') : null,
    photos: pod.photos.map((p) => ({
      type: p.type,
      stored: synced ? photoPath(pod.podId, p.type) : 'pending-upload',
      orig_kb: p.origKb,
      compressed_kb: p.compressedKb,
    })),
    driver_id: 'drv_demo',
    device_queued: !synced,
  }

  return (
    <div className="px-[18px] pb-[22px] pt-4">
      <div className="mb-3.5 flex items-center gap-[11px] rounded-[13px] border border-[#cbe6d5] bg-[#eef6f0] px-3.5 py-[13px]">
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

      <div className="mb-[13px]">
        <img
          src={previewUrl}
          alt="Proof of delivery photo"
          className="block w-full rounded-[13px] border border-line"
        />
        {label && (
          <div className="mt-1.5 text-center text-[11.5px] text-muted">
            Compressed {label.origKb} KB → {label.compressedKb} KB before upload
          </div>
        )}
      </div>

      <ColourJson
        header={synced ? 'POD record · synced to Supabase' : 'POD record · saved to device'}
        value={display}
      />

      <button
        type="button"
        onClick={onReset}
        className="mx-auto mt-3.5 block text-[12.5px] text-navy-500 underline"
      >
        ↺ Back to today's stops
      </button>
    </div>
  )
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
