import { AREAS, type Area } from './types'

/** Manifest import (job intake). A parcel manifest is a spreadsheet where each
 *  row is one parcel and carries its own tracking number. We don't know the
 *  exact column names a client will send, so the importer auto-maps headers to
 *  our fields by synonym and lets the dispatcher correct the mapping before
 *  committing. SheetJS is dynamically imported so it stays out of the main
 *  chunk (it's only needed on the dispatcher's import screen). */

/** Parcel fields a manifest can populate. tracking/recipient/address are
 *  required; postcode/area are optional (area defaults to Other). */
export type ManifestField =
  | 'tracking_number'
  | 'recipient_name'
  | 'address_line'
  | 'postcode'
  | 'area'

export const MANIFEST_FIELDS: { key: ManifestField; label: string; required: boolean }[] = [
  { key: 'tracking_number', label: 'Tracking number', required: true },
  { key: 'recipient_name', label: 'Recipient', required: true },
  { key: 'address_line', label: 'Address', required: true },
  { key: 'postcode', label: 'Postcode', required: false },
  { key: 'area', label: 'Area', required: false },
]

/** Header synonyms (normalised: lowercased, non-alphanumerics stripped). First
 *  exact match wins, then a contains-match, so "Tracking No." or "Delivery
 *  Address 1" still land. */
const SYNONYMS: Record<ManifestField, string[]> = {
  tracking_number: [
    'trackingnumber', 'trackingno', 'tracking', 'trackingref', 'barcode',
    'consignment', 'consignmentno', 'waybill', 'parcelid', 'itemid', 'parcelnumber',
  ],
  recipient_name: [
    'recipient', 'recipientname', 'name', 'customer', 'customername', 'deliverto',
    'addressee', 'contact', 'contactname', 'company',
  ],
  address_line: [
    'address', 'addressline', 'addressline1', 'address1', 'street', 'deliveryaddress',
    'addr',
  ],
  postcode: ['postcode', 'postalcode', 'zip', 'zipcode', 'postzip'],
  area: ['area', 'region', 'zone', 'depot', 'round', 'sector', 'service'],
}

export interface ParsedManifest {
  headers: string[]
  rows: Record<string, string>[]
}

export type ColumnMapping = Partial<Record<ManifestField, string>>

export interface ParcelInput {
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  area: Area
  meta: Record<string, string>
}

export interface MappedRows {
  parcels: ParcelInput[]
  /** 0-based row indexes that couldn't be imported, with why. */
  errors: { index: number; reason: string }[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Best-guess header → field mapping. Each header is used at most once. */
export function autoMap(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {}
  const used = new Set<string>()
  const normed = headers.map((h) => ({ raw: h, n: norm(h) }))

  for (const { key } of MANIFEST_FIELDS) {
    const syns = SYNONYMS[key]
    // exact normalised match first…
    let hit = normed.find((h) => !used.has(h.raw) && syns.includes(h.n))
    // …then contains (either direction), so "trackingnumberbarcode" or "addr1" match
    if (!hit) hit = normed.find((h) => !used.has(h.raw) && syns.some((s) => h.n.includes(s)))
    if (hit) {
      mapping[key] = hit.raw
      used.add(hit.raw)
    }
  }
  return mapping
}

function toArea(value: string): Area {
  const found = AREAS.find((a) => a.toLowerCase() === value.trim().toLowerCase())
  return found ?? 'Other'
}

/** Read the first sheet of an .xlsx into headers + row objects. Tolerates a
 *  leading title/banner row: the header row is chosen by SCORE (how many
 *  manifest fields the row's cells would auto-map, tracking number weighted
 *  since every parcel manifest must have one), not "first non-empty" — a title
 *  line maps nothing, so it loses to the real header below it. */
export async function parseManifestFile(file: File): Promise<ParsedManifest> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return { headers: [], rows: [] }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: '' })

  let headerRowIdx = -1
  let best = 0
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    const cells = (aoa[i] as unknown[]).map((c) => String(c ?? '').trim())
    if (!cells.some(Boolean)) continue
    if (headerRowIdx === -1) headerRowIdx = i // fallback: first non-empty row
    const m = autoMap(cells.filter(Boolean))
    const score = Object.keys(m).length + (m.tracking_number ? 2 : 0)
    if (score > best) {
      best = score
      headerRowIdx = i
    }
  }
  if (headerRowIdx === -1) return { headers: [], rows: [] }

  // Positional headers: an unnamed column keeps its slot (as "Column N") so
  // the columns after it don't shift onto the wrong header.
  const headers = (aoa[headerRowIdx] as unknown[]).map(
    (h, i) => String(h ?? '').trim() || `Column ${i + 1}`,
  )
  const rows: Record<string, string>[] = []
  for (let i = headerRowIdx + 1; i < aoa.length; i++) {
    const r = aoa[i] as unknown[]
    if (!r || !r.some((c) => String(c).trim() !== '')) continue
    const obj: Record<string, string> = {}
    headers.forEach((h, c) => {
      obj[h] = r[c] == null ? '' : String(r[c]).trim()
    })
    rows.push(obj)
  }
  return { headers, rows }
}

/** Apply a column mapping to parsed rows → parcel inserts, collecting rows that
 *  fail validation (missing required field, or a tracking number repeated
 *  earlier in the same file). */
export function buildParcelInputs(rows: Record<string, string>[], mapping: ColumnMapping): MappedRows {
  const parcels: ParcelInput[] = []
  const errors: { index: number; reason: string }[] = []
  const seen = new Set<string>()

  rows.forEach((row, index) => {
    const get = (f: ManifestField) => {
      const h = mapping[f]
      return h ? (row[h] ?? '').trim() : ''
    }
    const tracking_number = get('tracking_number')
    const recipient_name = get('recipient_name')
    const address_line = get('address_line')

    const missing: string[] = []
    if (!tracking_number) missing.push('tracking number')
    if (!recipient_name) missing.push('recipient')
    if (!address_line) missing.push('address')
    if (missing.length) {
      errors.push({ index, reason: `missing ${missing.join(', ')}` })
      return
    }
    const key = tracking_number.toUpperCase()
    if (seen.has(key)) {
      errors.push({ index, reason: `duplicate tracking number ${tracking_number}` })
      return
    }
    seen.add(key)

    parcels.push({
      tracking_number,
      recipient_name,
      address_line,
      postcode: get('postcode') || null,
      area: toArea(get('area')),
      meta: row,
    })
  })

  return { parcels, errors }
}
