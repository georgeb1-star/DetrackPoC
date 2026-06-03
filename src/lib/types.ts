// Row shapes mirroring the §4 schema (hand-written — a PoC doesn't need codegen).

export type Area = 'Domestic' | 'International' | 'Fulfilment' | 'Sortation'
export type ParcelStatus = 'pending' | 'delivered' | 'failed'
export type PodStatus = 'delivered' | 'failed'
export type PhotoType = 'label' | 'where_left'

/** Where a POD's fix came from, most → least trustworthy */
export type GpsSource = 'photo_exif' | 'device' | 'simulated'

/** A resolved GPS fix. accuracyM is null for EXIF fixes (cameras don't
 *  record accuracy). */
export interface Fix {
  lat: number
  lng: number
  accuracyM: number | null
  source: GpsSource
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
  gps_source: GpsSource
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
