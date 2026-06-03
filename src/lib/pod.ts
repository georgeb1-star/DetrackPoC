import { db, type QueuedPod } from './db'
import { EVIDENCE_BUCKET, supabase } from './supabase'
import { emitSync } from './syncEvents'
import type { Fix, Parcel, PhotoType, PodStatus } from './types'

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
  location: Fix | null
  signature: Blob | null
}

/** Deterministic storage path — retries always hit the same object. */
export function photoPath(podId: string, type: PhotoType): string {
  return `${podId}/${type}.jpg`
}
export function signaturePath(podId: string): string {
  return `${podId}/signature.png`
}

/**
 * §8: a completed capture is written FIRST to IndexedDB — blobs and all —
 * and returns immediately. The sync worker uploads it when the network
 * allows. Nothing here touches the network.
 */
export async function queuePod(bundle: CaptureBundle): Promise<QueuedPod> {
  const pod: QueuedPod = {
    podId: crypto.randomUUID(),
    parcelId: bundle.parcel.id,
    parcelRef: bundle.parcel.tracking_number,
    trackingScanned: bundle.trackingScanned,
    status: bundle.status,
    failureReason: bundle.failureReason,
    receivedBy: bundle.receivedBy || null,
    capturedAt: bundle.capturedAt.toISOString(),
    location: bundle.location,
    photos: bundle.photos.map((p) => ({ type: p.type, blob: p.blob, origKb: p.origKb, compressedKb: p.compressedKb })),
    signature: bundle.signature,
    synced: 0,
    syncedAt: null,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  }
  await db.pods.add(pod)
  emitSync()
  return pod
}

/**
 * Push one queued POD to Supabase. Every step is idempotent on the
 * client-generated podId (storage upsert, on-conflict upserts), so a retry
 * after a partial failure never double-inserts.
 */
export async function uploadPod(pod: QueuedPod): Promise<string | null> {
  // 1. Evidence files first — a record without its photos is worthless.
  for (const photo of pod.photos) {
    const { error } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(photoPath(pod.podId, photo.type), photo.blob, {
        contentType: 'image/jpeg',
        upsert: true,
      })
    if (error) throw new Error(`photo upload failed: ${error.message}`)
  }

  if (pod.signature) {
    const { error } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(signaturePath(pod.podId), pod.signature, { contentType: 'image/png', upsert: true })
    if (error) throw new Error(`signature upload failed: ${error.message}`)
  }

  // 2. The POD record. synced_at is omitted: the DB default (now()) stamps
  //    the server-side receive time — the trust boundary. On a retry the
  //    conflict-update leaves the original synced_at untouched.
  const { data: record, error: recErr } = await supabase
    .from('pod_records')
    .upsert(
      {
        id: pod.podId,
        parcel_id: pod.parcelId,
        tracking_scanned: pod.trackingScanned,
        status: pod.status,
        failure_reason: pod.failureReason,
        received_by: pod.receivedBy,
        captured_at: pod.capturedAt,
        location: pod.location ? `POINT(${pod.location.lng} ${pod.location.lat})` : null,
        gps_accuracy_m: pod.location?.accuracyM ?? null,
        gps_simulated: pod.location?.source === 'simulated',
        gps_source: pod.location?.source ?? 'device',
        signature_path: pod.signature ? signaturePath(pod.podId) : null,
        driver_id: 'drv_demo',
      },
      { onConflict: 'id' },
    )
    .select('synced_at')
    .single()
  if (recErr) throw new Error(`pod insert failed: ${recErr.message}`)

  // 3. Photo metadata rows — unique (pod_id, photo_type) makes this a no-op
  //    on retry.
  if (pod.photos.length) {
    const { error: phErr } = await supabase.from('pod_photos').upsert(
      pod.photos.map((p) => ({
        pod_id: pod.podId,
        photo_type: p.type,
        storage_path: photoPath(pod.podId, p.type),
        orig_kb: p.origKb,
        compressed_kb: p.compressedKb,
      })),
      { onConflict: 'pod_id,photo_type', ignoreDuplicates: true },
    )
    if (phErr) throw new Error(`photo metadata insert failed: ${phErr.message}`)
  }

  // 4. Reflect the outcome on the server-side stop list.
  if (pod.parcelId) {
    await supabase.from('parcels').update({ status: pod.status }).eq('id', pod.parcelId)
  }

  return (record as { synced_at: string | null } | null)?.synced_at ?? null
}

/** Public URL for an object in the evidence bucket (public in this PoC). */
export function evidenceUrl(path: string): string {
  return supabase.storage.from(EVIDENCE_BUCKET).getPublicUrl(path).data.publicUrl
}
