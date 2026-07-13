import { db, type QueuedAdhocScan } from './db'
import { supabase } from './supabase'
import { emitSync } from './syncEvents'
import type { Fix } from './types'

/** Everything an ad-hoc collection scan captures. Identify the route it joins
 *  by EITHER a depot `siteId` (depot path) OR a `routeId` (Scan-label path);
 *  leave both unset to let the RPC use the driver's own single route. */
export interface AdhocScan {
  trackingScanned: string
  siteId?: string | null
  siteName?: string | null
  routeId?: string | null
  capturedAt: Date
  location: Fix | null
  driverId: string
}

/**
 * Local-first, like queueEvent/queuePod: the scan lands in IndexedDB and returns
 * immediately — the driver can keep scanning offline. The sync worker turns each
 * into a parcel via the create_adhoc_parcel RPC when the network allows.
 */
export async function queueAdhocScan(scan: AdhocScan): Promise<QueuedAdhocScan> {
  const item: QueuedAdhocScan = {
    scanId: crypto.randomUUID(),
    trackingScanned: scan.trackingScanned,
    siteId: scan.siteId ?? null,
    siteName: scan.siteName ?? null,
    routeId: scan.routeId ?? null,
    capturedAt: scan.capturedAt.toISOString(),
    location: scan.location,
    driverId: scan.driverId,
    synced: 0,
    syncedAt: null,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  }
  await db.adhocScans.add(item)
  emitSync()
  return item
}

/**
 * Turn one queued ad-hoc scan into a collected parcel. Idempotent on the client
 * UUID (the RPC upserts the parcel on tracking_number and the event on id), so a
 * retry never duplicates. The RPC validates the driver runs the resolved route
 * (from the depot site, the passed route, or their own single route).
 */
export async function uploadAdhocScan(scan: QueuedAdhocScan): Promise<void> {
  const { error } = await supabase.rpc('create_adhoc_parcel', {
    p_id: scan.scanId,
    p_tracking: scan.trackingScanned,
    p_site_id: scan.siteId ?? null,
    p_route_id: scan.routeId ?? null,
    p_captured_at: scan.capturedAt,
    p_lng: scan.location?.lng ?? null,
    p_lat: scan.location?.lat ?? null,
    p_accuracy_m: scan.location?.accuracyM ?? null,
    p_gps_source: scan.location?.source ?? null,
  })
  if (error) throw new Error(`ad-hoc collect failed: ${error.message}`)
}
