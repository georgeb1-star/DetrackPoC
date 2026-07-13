import Dexie, { type EntityTable } from 'dexie'
import type { Driver, Fix, Parcel, PhotoType, PodStatus, Route, Stage } from './types'

/** A capture as it sits in the local queue (§8): photo/signature blobs and
 *  all metadata land here FIRST — nothing blocks on the network. Synced items
 *  are kept (flag flipped, not deleted) so the UI can show history. */
export interface QueuedPod {
  /** Client-generated UUID — the idempotency key for every server write */
  podId: string
  parcelId: string | null
  parcelRef: string
  trackingScanned: string
  status: PodStatus
  failureReason: string | null
  receivedBy: string | null
  capturedAt: string // ISO, device clock (evidence time)
  location: Fix | null
  /** Metres from the parcel's destination at capture (geofence), if known */
  destDistanceM: number | null
  photos: { type: PhotoType; blob: Blob; origKb: number; compressedKb: number }[]
  signature: Blob | null
  /** Driver who made the capture — stamped onto pod_records.driver_id.
   *  Optional so pre-allocation queued items still upload (fall back to demo). */
  driverId?: string
  /** Set when the capture is against a SITE (store/depot) with no manifested
   *  parcel — written to pod_records.site_id, parcelId stays null. */
  siteId?: string | null
  /** 0 = queued, 1 = synced (numbers — Dexie can't index booleans) */
  synced: 0 | 1
  /** Server-issued trust stamp, copied back after upload */
  syncedAt: string | null
  queuedAt: string
  attempts: number
  lastError: string | null
}

/** A lifecycle stage scan (collection/warehouse) in the local queue — the
 *  quick-scan sibling of QueuedPod: no photos/signature, just barcode +
 *  timestamp + GPS + stage. Same local-first rules: queued offline, drained
 *  by the sync worker, kept (flag flipped) as history. The delivered stage
 *  rides the POD pipeline instead. */
export interface QueuedEvent {
  /** Client-generated UUID — the idempotency key for the server upsert */
  eventId: string
  parcelId: string
  parcelRef: string
  trackingScanned: string
  stage: Stage
  capturedAt: string // ISO, device clock at the scan (evidence time)
  location: Fix | null
  /** Driver who scanned — stamped onto parcel_events.driver_id (RLS-checked) */
  driverId?: string
  /** 0 = queued, 1 = synced (numbers — Dexie can't index booleans) */
  synced: 0 | 1
  syncedAt: string | null
  queuedAt: string
  attempts: number
  lastError: string | null
}

/** An ad-hoc collection scan in the local queue: a driver scans an item that
 *  was never pre-alerted, so there's no parcel to match. On sync the
 *  create_adhoc_parcel RPC turns each into a first-class parcel at 'collected'.
 *  Two ways in: at a DEPOT (siteId set — the RPC derives the route from it), or
 *  straight off the run's Scan-label sheet (routeId set — an unknown barcode
 *  scanned in Collect mode). One of siteId / routeId identifies the route; if
 *  both are null the RPC falls back to the driver's own single route.
 *  Same local-first rules as QueuedEvent — queued offline, drained by the sync
 *  worker, kept (flag flipped) as history. */
export interface QueuedAdhocScan {
  /** Client UUID — idempotency key; also becomes the parcel + collection event id */
  scanId: string
  trackingScanned: string
  /** Depot the item was collected at (depot path). Unindexed — safe to omit. */
  siteId?: string | null
  siteName?: string | null
  /** Route the ad-hoc parcel joins (Scan-label path). Unindexed — safe to omit. */
  routeId?: string | null
  capturedAt: string // ISO, device clock at the scan
  location: Fix | null
  driverId?: string
  synced: 0 | 1
  syncedAt: string | null
  queuedAt: string
  attempts: number
  lastError: string | null
}

export const db = new Dexie('epod') as Dexie & {
  pods: EntityTable<QueuedPod, 'podId'>
  events: EntityTable<QueuedEvent, 'eventId'>
  adhocScans: EntityTable<QueuedAdhocScan, 'scanId'>
  /** Read-through cache of the server stop list, so a cold start with no
   *  signal still shows the run sheet. The server stays the source of
   *  truth — every successful fetch replaces the cache. */
  parcels: EntityTable<Parcel, 'id'>
  /** Read-through caches of the fleet, so the driver app can still filter to
   *  a driver's run (and switch driver) on a cold offline start. */
  routes: EntityTable<Route, 'id'>
  drivers: EntityTable<Driver, 'id'>
}

db.version(1).stores({
  // Only fields we query on need indexing; blobs ride along unindexed
  pods: 'podId, synced, queuedAt',
})
db.version(2).stores({
  pods: 'podId, synced, queuedAt',
  parcels: 'id',
})
db.version(3).stores({
  pods: 'podId, synced, queuedAt',
  parcels: 'id',
  routes: 'id',
  drivers: 'id',
})
db.version(4).stores({
  pods: 'podId, synced, queuedAt',
  events: 'eventId, synced, queuedAt',
  parcels: 'id',
  routes: 'id',
  drivers: 'id',
})
db.version(5).stores({
  pods: 'podId, synced, queuedAt',
  events: 'eventId, synced, queuedAt',
  adhocScans: 'scanId, synced, queuedAt',
  parcels: 'id',
  routes: 'id',
  drivers: 'id',
})
