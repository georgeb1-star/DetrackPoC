// Row shapes mirroring the §4 schema (hand-written — a PoC doesn't need codegen).

export type Area = 'Domestic' | 'International' | 'Fulfilment' | 'Sortation'
export type ParcelStatus = 'pending' | 'delivered' | 'failed' | 'returned'
export type PodStatus = 'delivered' | 'failed'
export type PhotoType = 'label' | 'where_left'

/** A failed delivery is an attempt; the parcel goes terminal ('returned')
 *  after this many failures. */
export const MAX_DELIVERY_ATTEMPTS = 3

/** Where a POD's fix came from, most → least trustworthy. 'simulated' is
 *  legacy — old rows may carry it, but captures no longer produce one:
 *  the record gets a real fix or none at all. */
export type GpsSource = 'photo_exif' | 'device' | 'simulated'

/** A resolved GPS fix — always a real reading (EXIF or live device).
 *  accuracyM is null for EXIF fixes (cameras don't record accuracy). */
export interface Fix {
  lat: number
  lng: number
  accuracyM: number | null
  source: 'photo_exif' | 'device'
}

/** A delivery driver. id is text (e.g. 'drv_demo') — the value stamped onto
 *  pod_records.driver_id. */
export interface Driver {
  id: string
  name: string
}

/** A route is one driver's run. Parcels are allocated to a route; `areas` is
 *  the set of parcel areas this route covers, which drives auto-allocation. */
export interface Route {
  id: string
  name: string
  driver_id: string | null
  areas: Area[]
}

/** An imported manifest = a "job": a batch of parcels handed to us as a
 *  spreadsheet, each row carrying its own tracking number. */
export interface Manifest {
  id: string
  name: string
  reference: string | null
  source_filename: string | null
  imported_at: string
  created_at: string
}

/** A store or depot delivered to without a per-item manifest — the driver scans
 *  and captures items against the site. `kind` is store, depot, or both.
 *  Allocated to a route like parcels, so it lands on a driver's run. */
export interface Site {
  id: string
  name: string
  address_line: string | null
  postcode: string | null
  kind: 'store' | 'depot' | 'both'
  destination: GeoPoint | string | null
  route_id: string | null
}

export interface Parcel {
  id: string
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  /** PostGIS geography comes back as GeoJSON when selected via PostgREST */
  destination: GeoPoint | string | null
  area: Area
  status: ParcelStatus
  /** The run this parcel belongs to (date). Pending past this = rollover. */
  due_date: string
  /** Failed delivery attempts so far (see MAX_DELIVERY_ATTEMPTS) */
  attempts: number
  last_failure: string | null
  /** When the stop went terminal (delivered/returned). null while pending.
   *  Drives the run sheet's "completed today only" rule. */
  completed_at: string | null
  /** Route this parcel is allocated to. null = unallocated (dispatcher to-do). */
  route_id: string | null
  /** Manifest/job this parcel was imported on. null = seeded/manual. */
  manifest_id: string | null
  created_at: string
}

/** Rollover rule: still pending after its run date (derived, no nightly job). */
export function isRollover(p: Parcel, today = new Date()): boolean {
  return p.status === 'pending' && p.due_date < today.toISOString().slice(0, 10)
}

export interface PodRecord {
  id: string
  parcel_id: string | null
  tracking_scanned: string
  status: PodStatus
  failure_reason: string | null
  received_by: string | null
  captured_at: string
  synced_at: string | null
  location: GeoPoint | string | null
  gps_accuracy_m: number | null
  gps_simulated: boolean
  /** null = capture had no fix (real-GPS-only model) */
  gps_source: GpsSource | null
  /** Metres between the capture fix and the parcel's destination (geofence) */
  dest_distance_m: number | null
  signature_path: string | null
  driver_id: string
  created_at: string
}

export interface PodPhoto {
  id: string
  pod_id: string
  photo_type: PhotoType
  storage_path: string
  orig_kb: number | null
  compressed_kb: number | null
}

/** GeoJSON point as returned by PostGIS through PostgREST */
export interface GeoPoint {
  type: 'Point'
  /** [lng, lat] — GeoJSON axis order */
  coordinates: [number, number]
}
