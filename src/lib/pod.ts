import { db, type QueuedPod } from './db'
import { EVIDENCE_BUCKET, supabase } from './supabase'
import { emitSync } from './syncEvents'
import { MAX_DELIVERY_ATTEMPTS, type Fix, type Parcel, type PhotoType, type PodStatus } from './types'

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
  destDistanceM: number | null
  signature: Blob | null
  /** Driver making the capture (the selected run in the driver app). */
  driverId: string
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
    destDistanceM: bundle.destDistanceM,
    photos: bundle.photos.map((p) => ({ type: p.type, blob: p.blob, origKb: p.origKb, compressedKb: p.compressedKb })),
    signature: bundle.signature,
    driverId: bundle.driverId,
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

/** A capture made against a SITE (store/depot) rather than a manifested parcel.
 *  The driver scans the item's barcode on the spot; there's no pre-loaded
 *  parcel, so the POD carries site_id + the scanned tracking and parcel_id is
 *  null (RLS makes parcel inserts admin-only, so we never fabricate one). */
export interface SiteCaptureBundle {
  siteId: string
  siteName: string
  trackingScanned: string
  status: PodStatus
  failureReason: string | null
  receivedBy: string
  capturedAt: Date
  photos: CapturedPhoto[]
  location: Fix | null
  destDistanceM: number | null
  signature: Blob | null
  driverId: string
}

/** Queue a site capture — same local-first path as queuePod (Dexie first). */
export async function queueSitePod(bundle: SiteCaptureBundle): Promise<QueuedPod> {
  const pod: QueuedPod = {
    podId: crypto.randomUUID(),
    parcelId: null,
    parcelRef: bundle.siteName, // display label on the receipt / queue
    trackingScanned: bundle.trackingScanned,
    status: bundle.status,
    failureReason: bundle.failureReason,
    receivedBy: bundle.receivedBy || null,
    capturedAt: bundle.capturedAt.toISOString(),
    location: bundle.location,
    destDistanceM: bundle.destDistanceM,
    photos: bundle.photos.map((p) => ({ type: p.type, blob: p.blob, origKb: p.origKb, compressedKb: p.compressedKb })),
    signature: bundle.signature,
    driverId: bundle.driverId,
    siteId: bundle.siteId,
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
        gps_simulated: false, // legacy column — captures are real-GPS-only now
        gps_source: pod.location?.source ?? null, // null = no fix at capture
        dest_distance_m: pod.destDistanceM,
        signature_path: pod.signature ? signaturePath(pod.podId) : null,
        // The signed-in driver. Under RLS the insert is rejected unless this
        // matches the caller's profile driver_id (or the caller is an admin).
        driver_id: pod.driverId,
        // Set for a capture against a site (store/depot) with no manifested
        // parcel; null for a normal parcel capture.
        site_id: pod.siteId ?? null,
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

  // 4. Reflect the outcome on the server-side stop list (lifecycle model).
  //    Delivered is terminal — and also a lifecycle stage, so a 'delivered'
  //    parcel_events row (id = the pod's id, idempotent) completes the
  //    scan-event timeline alongside the POD. Failed is an ATTEMPT: the
  //    parcel KEEPS its current lifecycle stage (so it re-appears and rolls
  //    over) until MAX_DELIVERY_ATTEMPTS, then goes terminal as 'returned'.
  //    Read-modify-write is acceptable for a single-driver PoC; production
  //    would use an RPC/transaction.
  if (pod.parcelId) {
    // completed_at stamps when the stop went terminal, so the run sheet can
    // show only stops finished today (older ones drop off, but stay in the DB).
    const completedAt = new Date().toISOString()
    if (pod.status === 'delivered') {
      const { error: evErr } = await supabase.from('parcel_events').upsert(
        {
          id: pod.podId, // same UUID as the POD — retries hit the same row
          parcel_id: pod.parcelId,
          tracking_scanned: pod.trackingScanned,
          stage: 'delivered',
          captured_at: pod.capturedAt,
          location: pod.location ? `POINT(${pod.location.lng} ${pod.location.lat})` : null,
          gps_accuracy_m: pod.location?.accuracyM ?? null,
          gps_source: pod.location?.source ?? null,
          driver_id: pod.driverId,
        },
        { onConflict: 'id' },
      )
      if (evErr) throw new Error(`delivered event insert failed: ${evErr.message}`)
      await supabase
        .from('parcels')
        .update({ status: 'delivered', completed_at: completedAt })
        .eq('id', pod.parcelId)
    } else {
      // Attempts are DERIVED from the failed POD rows rather than
      // incremented, so a sync retry of the same pod (idempotent upsert
      // above) can never double-count an attempt. Counting under the
      // driver's own RLS scope is fine — a parcel is worked by one route.
      const { count } = await supabase
        .from('pod_records')
        .select('id', { count: 'exact', head: true })
        .eq('parcel_id', pod.parcelId)
        .eq('status', 'failed')
      const attempts = count ?? 1 // includes the row upserted above
      const terminal = attempts >= MAX_DELIVERY_ATTEMPTS
      await supabase
        .from('parcels')
        .update({
          attempts,
          last_failure: pod.failureReason,
          // A failed attempt doesn't move the lifecycle — the parcel stays at
          // its current stage (collected / at_warehouse) until it goes
          // terminal as a return.
          ...(terminal ? { status: 'returned', completed_at: completedAt } : { completed_at: null }),
        })
        .eq('id', pod.parcelId)
    }
  }

  return (record as { synced_at: string | null } | null)?.synced_at ?? null
}

/** Public URL for an object in the evidence bucket (public in this PoC). */
export function evidenceUrl(path: string): string {
  return supabase.storage.from(EVIDENCE_BUCKET).getPublicUrl(path).data.publicUrl
}
