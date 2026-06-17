import type { Area } from './types'
import type { ParcelInput } from './manifest'

/** The shipment columns the enrich-shipments Edge Function returns (a subset of
 *  Lens's public.shipments — only what we need to build a parcel). */
export interface ShipmentRow {
  tracking_number: string
  recipient_full_name: string | null
  recipient_company: string | null
  recipient_address1: string | null
  recipient_address2: string | null
  recipient_address3: string | null
  recipient_city: string | null
  recipient_county: string | null
  recipient_postcode: string | null
}

/** GWOptical splits the address across several columns; ePOD stores one line.
 *  Join the non-empty parts in postal order. */
export function composeAddressLine(row: ShipmentRow): string {
  return [
    row.recipient_address1, row.recipient_address2, row.recipient_address3,
    row.recipient_city, row.recipient_county,
  ]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

/** Prefer a person's name, then the company, then a clear placeholder. */
export function composeRecipient(row: ShipmentRow): string {
  return (row.recipient_full_name ?? '').trim()
    || (row.recipient_company ?? '').trim()
    || '(no name)'
}

// Postcode outward-code → ePOD area. USER-AUTHORED domain map — refine the rules
// freely; anything not listed (incl. blank) falls back to 'Other', which is the
// safe "needs review" bucket. Keys are the leading letters of the outward code.
const POSTCODE_AREA: Record<string, Area> = {
  SE: 'South London',
  SW: 'South London', // south-west — move to 'West London' if you prefer
  N: 'North London',
  NW: 'North London', // north-west — move to 'West London' if you prefer
  W: 'West London',
  WC: 'Central London',
  EC: 'Central London',
  // Kent
  BR: 'Kent', DA: 'Kent', ME: 'Kent', CT: 'Kent', TN: 'Kent',
  // Surrey
  KT: 'Surrey', SM: 'Surrey', CR: 'Surrey', GU: 'Surrey', RH: 'Surrey',
  // 'E' (East London) and everything else intentionally → 'Other'.
}

/** Map a UK postcode to one of ePOD's areas via its outward-code letters.
 *  Unmatched / missing → 'Other'. Matches the 2-letter prefix first (WC, EC,
 *  NW, SE, …) then the 1-letter (N, W, …). */
export function deriveArea(postcode: string | null | undefined): Area {
  const pc = (postcode ?? '').trim().toUpperCase()
  if (!pc) return 'Other'
  const letters = (pc.match(/^[A-Z]{1,2}/) ?? [''])[0]
  if (letters.length === 2 && POSTCODE_AREA[letters]) return POSTCODE_AREA[letters]
  const one = letters.slice(0, 1)
  return POSTCODE_AREA[letters] ?? POSTCODE_AREA[one] ?? 'Other'
}

/** A matched shipment row → the ParcelInput the importer/commit path expects.
 *  The raw row is stashed in meta for traceability. */
export function shipmentToParcelInput(row: ShipmentRow): ParcelInput {
  return {
    tracking_number: row.tracking_number,
    recipient_name: composeRecipient(row),
    address_line: composeAddressLine(row),
    postcode: (row.recipient_postcode ?? '').trim() || null,
    area: deriveArea(row.recipient_postcode),
    meta: { ...(row as unknown as Record<string, string>) },
  }
}
