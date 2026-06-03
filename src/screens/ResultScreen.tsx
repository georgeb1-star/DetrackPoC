import { ColourJson } from '../components/ColourJson'
import type { CompletedPod } from '../lib/pod'

/** Confirmation (§7): green banner with tick disc, the captured photo, then
 *  the POD record in the dark navy JSON panel. */
export function ResultScreen({
  result,
  previewUrl,
  onReset,
}: {
  result: CompletedPod
  previewUrl: string
  onReset: () => void
}) {
  const { record, photoPaths } = result
  const failed = record.status === 'failed'
  const label = photoPaths.find((p) => p.type === 'label')

  // Confirmation JSON mirrors the reference record shape
  const display = {
    pod_id: record.id,
    parcel_id: record.parcel_id,
    tracking: record.tracking_scanned,
    status: record.status,
    ...(failed ? { failure_reason: record.failure_reason } : {}),
    received_by: record.received_by ?? (failed ? '—' : 'Signed for'),
    captured_at: record.captured_at,
    synced_at: record.synced_at,
    location: result.location
      ? { lat: result.location.lat, lng: result.location.lng, accuracy_m: result.location.accuracyM }
      : null,
    gps_simulated: record.gps_simulated,
    signature: record.signature_path,
    photos: photoPaths.map((p) => ({
      type: p.type,
      stored: p.path,
      orig_kb: p.origKb,
      compressed_kb: p.compressedKb,
    })),
    driver_id: record.driver_id,
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
          <div className="text-[13.5px] font-bold text-[#1d6840]">
            {failed ? 'Failed delivery logged & synced' : 'Captured & synced'}
          </div>
          <div className="mt-px text-xs text-[#3f7a59]">
            Uploaded to dispatch — server set the synced_at trust stamp
          </div>
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

      <ColourJson header="POD record · synced to Supabase" value={display} />

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
