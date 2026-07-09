/** Browser-side manifest import: parse a coupon-style CSV or .xlsx the client
 *  sends (Shop / Customer / Address1 / PostCode / Branch …), geocode the
 *  postcodes via postcodes.io, and build parcel rows ready to commit. The
 *  dispatcher's Import card (JobsScreen) drives this — no script needed. Mirrors
 *  scripts/seed-coupon-pilot.mjs so a UI import lands identical parcels. */

export interface ManifestRow {
  [column: string]: string
}

// ── CSV ──────────────────────────────────────────────────────────────────────
/** Split CSV text into rows of cells, honouring quoted fields and "" escapes. */
function csvToArrays(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function rowsFromArrays(arrays: string[][]): ManifestRow[] {
  if (arrays.length < 2) return []
  const header = arrays[0].map((h) => h.trim())
  return arrays
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const o: ManifestRow = {}
      header.forEach((h, i) => { if (h) o[h] = (r[i] ?? '').trim() })
      return o
    })
}

// ── XLSX (zip + shared strings + first sheet), all in-browser ────────────────
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  // deflate-raw is what xlsx zip entries use; DecompressionStream ships in
  // Chromium (the dispatcher's browser) so we need no zip/xlsx dependency.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function unzipEntry(buf: Uint8Array, wantName: string): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = buf.length - 22
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a valid .xlsx (no zip end record)')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt .xlsx central directory')
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    if (name === wantName) {
      const lNameLen = dv.getUint16(localOff + 26, true)
      const lExtraLen = dv.getUint16(localOff + 28, true)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      return method === 0 ? raw : inflateRaw(raw)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`.xlsx entry not found: ${wantName}`)
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Parse the first worksheet into header-keyed rows (shared/inline strings + numbers). */
function parseSheetXml(sharedXml: string, sheetXml: string): ManifestRow[] {
  const shared: string[] = []
  for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')
    shared.push(unescapeXml(text))
  }
  const colToNum = (c: string) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)
  const arrays: string[][] = []
  for (const rm of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    const cellRe = /<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is>([\s\S]*?)<\/is>)?<\/c>/g
    let c: RegExpExecArray | null
    while ((c = cellRe.exec(rm[1]))) {
      const col = colToNum(c[1]) - 1
      let val = c[3]
      if (c[2] === 's') val = shared[Number(val)]
      else if (c[2] === 'inlineStr') val = unescapeXml([...(c[4] || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
      else if (val !== undefined) val = unescapeXml(val)
      cells[col] = val ?? ''
    }
    arrays.push(cells)
  }
  return rowsFromArrays(arrays)
}

async function parseXlsx(ab: ArrayBuffer): Promise<ManifestRow[]> {
  const buf = new Uint8Array(ab)
  const dec = new TextDecoder()
  const sharedXml = await unzipEntry(buf, 'xl/sharedStrings.xml').then((u) => dec.decode(u)).catch(() => '')
  const sheetXml = dec.decode(await unzipEntry(buf, 'xl/worksheets/sheet1.xml'))
  return parseSheetXml(sharedXml, sheetXml)
}

/** Parse a picked .csv or .xlsx File into header-keyed rows. */
export async function parseManifestFile(file: File): Promise<ManifestRow[]> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx')) return parseXlsx(await file.arrayBuffer())
  return rowsFromArrays(csvToArrays(await file.text())) // .csv (and a tolerant fallback)
}

// ── mapping + geocoding ──────────────────────────────────────────────────────
/** UK outward prefix — matches src/lib/enrich.postcodeArea. */
export const postcodeArea = (pc: string | null | undefined) =>
  ((pc ?? '').trim().toUpperCase().match(/^[A-Z]{1,2}/) ?? [''])[0]

/** Case-insensitive column lookup with fallbacks (sheets vary in header casing). */
function col(row: ManifestRow, ...names: string[]): string {
  const keys = Object.keys(row)
  for (const n of names) {
    const k = keys.find((k) => k.toLowerCase() === n.toLowerCase())
    if (k && row[k]) return row[k]
  }
  return ''
}

/** The postcode of each row (for geocoding up front, before drafts are built). */
export function manifestPostcodes(rows: ManifestRow[]): string[] {
  return rows.map((r) => col(r, 'PostCode', 'Postcode', 'Post Code')).filter(Boolean)
}

const CUST_CODE: Record<string, string> = { 'WILLIAM HILL': 'WH', LADBROKES: 'LAD', CORAL: 'COR' }

export interface ManifestDraft {
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  destination: string | null
  delivery_area: string
  collection_area: string
  status: string
  due_date: string
  route_id: string | null
  branch: string
  meta: Record<string, unknown>
}

/** Geocode postcodes to lng/lat via postcodes.io (bulk, 100/request). */
export async function geocode(postcodes: string[]): Promise<Map<string, { lng: number; lat: number }>> {
  const uniq = [...new Set(postcodes.map((p) => p.trim().toUpperCase()).filter(Boolean))]
  const out = new Map<string, { lng: number; lat: number }>()
  for (let i = 0; i < uniq.length; i += 100) {
    const res = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postcodes: uniq.slice(i, i + 100) }),
    })
    if (!res.ok) throw new Error(`postcodes.io ${res.status}`)
    const body = await res.json()
    for (const item of body.result) {
      if (item.result) out.set(item.query.trim().toUpperCase(), { lng: item.result.longitude, lat: item.result.latitude })
    }
  }
  return out
}

/** Turn parsed rows + a geocode map into parcel drafts. `routeByName` maps a
 *  lower-cased branch/route name to its route id (for allocation on import);
 *  unmatched branches leave the parcel unallocated. `date` is the run (due_date);
 *  its YYMMDD goes into the interim tracking number when the sheet has no barcode. */
export function buildDrafts(
  rows: ManifestRow[],
  opts: { date: string; geo: Map<string, { lng: number; lat: number }>; routeByName: Map<string, string> },
): { drafts: ManifestDraft[]; misses: string[] } {
  const misses: string[] = []
  const drafts = rows.map((r) => {
    const customer = col(r, 'CustomerName', 'Customer')
    const shop = col(r, 'Shop', 'Shop No', 'Store')
    const branch = col(r, 'RouteName', 'Branch (route)', 'Branch', 'Route').toUpperCase()
    const postcode = col(r, 'PostCode', 'Postcode', 'Post Code') || null
    const address = col(r, 'Address1', 'Address', 'Address Line 1')
    // The real Citipost feed carries CarrierBarcode (the label ID the driver
    // scans) and Inshopdate (the run date). Fall back to an interim CPN code +
    // the chosen run date only when the sheet has neither.
    const barcode = col(r, 'CarrierBarcode', 'Barcode', 'Tracking Number', 'Tracking')
    const due = col(r, 'Inshopdate', 'In-shop date', 'Date') || opts.date
    const cust = CUST_CODE[customer.toUpperCase()] || (customer ? customer.slice(0, 3).toUpperCase() : 'OTH')
    const pcKey = (postcode ?? '').trim().toUpperCase()
    const fix = opts.geo.get(pcKey)
    if (!fix && postcode) misses.push(`${customer || shop} (${postcode})`)
    return {
      tracking_number: barcode || `CPN-${cust}-${shop || 'X'}-${due.slice(2).replace(/-/g, '')}`,
      recipient_name: customer ? `${customer}${shop ? ` (${shop})` : ''}` : (col(r, 'Name', 'Recipient') || 'Recipient'),
      address_line: address,
      postcode,
      destination: fix ? `SRID=4326;POINT(${fix.lng} ${fix.lat})` : null,
      delivery_area: postcodeArea(postcode),
      collection_area: postcodeArea(postcode),
      status: 'awaiting_collection',
      due_date: due,
      route_id: opts.routeByName.get(branch.toLowerCase()) ?? null,
      branch,
      meta: {
        source: 'coupon', shop, customer, branch, address_id: col(r, 'AddressID', 'ID'),
        drop_code: col(r, 'DropCode', 'Drop Code'), carrier: col(r, 'Carrier'),
      },
    }
  })
  return { drafts, misses }
}
