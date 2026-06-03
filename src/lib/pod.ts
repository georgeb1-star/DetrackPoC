import { EVIDENCE_BUCKET, supabase } from './supabase'
import type { Parcel, PhotoType, PodRecord, PodStatus } from './types'

export interface CapturedPhoto {
  type: PhotoType
  blob: Blob
  origKb: number
  compressedKb: number
}

/** Everything gathered on the capture screen (§5 evidence bundle). */
export interface CaptureBundle {
  parcel: Parcel
  trackingScanned: string
  status: PodStatus
  failureReason: string | null
  receivedBy: string
  capturedAt: Date
  photos: CapturedPhoto[]
  // GPS + signature join the bundle in Checkpoint 4
  location: { lat: number; lng: number; accuracyM: number; simulated: boolean } | null
  signature: Blob | null
}

export interface CompletedPod {
  record: PodRecord
  photoPaths: { type: PhotoType; path: string; origKb: number; compressedKb: number }[]
  /** The fix as captured — PostGIS returns geography as WKB, so the bundle's
   *  plain lat/lng is what the confirmation JSON displays */
  location: CaptureBundle['location']
}

/**
 * Checkpoint-3 path: upload + insert straight to Supabase (no queue yet —
 * Checkpoint 6 puts Dexie in front of this). The pod id is generated
 * client-side so the eventual sync worker can retry idempotently.
 */
export async function completePodOnline(bundle: CaptureBundle): Promise<CompletedPod> {
  const podId = crypto.randomUUID()

  // 1. Evidence files first — a record without its photos is worthless.
  const photoPaths: CompletedPod['photoPaths'] = []
  for (const photo of bundle.photos) {
    const path = `${podId}/${photo.type}.jpg`
    const { error } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(path, photo.blob, { contentType: 'image/jpeg', upsert: true })
    if (error) throw new Error(`photo upload failed: ${error.message}`)
    photoPaths.push({ type: photo.type, path, origKb: photo.origKb, compressedKb: photo.compressedKb })
  }

  let signaturePath: string | null = null
  if (bundle.signature) {
    signaturePath = `${podId}/signature.png`
    const { error } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(signaturePath, bundle.signature, { contentType: 'image/png', upsert: true })
    if (error) throw new Error(`signature upload failed: ${error.message}`)
  }

  // 2. The POD record. synced_at is deliberately omitted — the DB default
  //    (now()) stamps the server-side receive time, the trust boundary.
  const { data: record, error: recErr } = await supabase
    .from('pod_records')
    .upsert(
      {
        id: podId,
        parcel_id: bundle.parcel.id,
        tracking_scanned: bundle.trackingScanned,
        status: bundle.status,
        failure_reason: bundle.failureReason,
        received_by: bundle.receivedBy || null,
        captured_at: bundle.capturedAt.toISOString(),
        location: bundle.location
          ? `POINT(${bundle.location.lng} ${bundle.location.lat})`
          : null,
        gps_accuracy_m: bundle.location?.accuracyM ?? null,
        gps_simulated: bundle.location?.simulated ?? false,
        signature_path: signaturePath,
        driver_id: 'drv_demo',
      },
      { onConflict: 'id' },
    )
    .select()
    .single()
  if (recErr) throw new Error(`pod insert failed: ${recErr.message}`)

  // 3. Photo metadata rows.
  if (photoPaths.length) {
    const { error: phErr } = await supabase.from('pod_photos').upsert(
      photoPaths.map((p) => ({
        // Deterministic per pod+type so retries never duplicate rows
        pod_id: podId,
        photo_type: p.type,
        storage_path: p.path,
        orig_kb: p.origKb,
        compressed_kb: p.compressedKb,
      })),
      { onConflict: 'pod_id,photo_type', ignoreDuplicates: true },
    )
    if (phErr) throw new Error(`photo metadata insert failed: ${phErr.message}`)
  }

  // 4. Reflect the outcome on the stop list.
  await supabase.from('parcels').update({ status: bundle.status }).eq('id', bundle.parcel.id)

  return { record: record as PodRecord, photoPaths, location: bundle.location }
}

/** Public URL for an object in the evidence bucket (bucket is public in this PoC). */
export function evidenceUrl(path: string): string {
  return supabase.storage.from(EVIDENCE_BUCKET).getPublicUrl(path).data.publicUrl
}
