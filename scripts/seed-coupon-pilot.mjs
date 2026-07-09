// Seed the COUPON-DELIVERY PILOT (Bromley & Woolwich routes) from Paul's test
// spreadsheet into the hosted project. This is the pilot's data path.
//
// Why a bespoke importer: parcels normally enter ePOD via GWOptical
// tracking-number *enrichment* (src/lib/enrich*.ts), which looks addresses up
// in Lens's shipments DB. Coupon packs aren't in that DB and don't carry a
// known barcode yet, so that path can't be used. This script is the .xlsx
// manifest importer the schema always described (cloud-setup.sql) but the app
// never grew.
//
// What it does, idempotently (safe to re-run):
//   1. Parse the .xlsx (self-contained — a tiny built-in unzip + XML reader,
//      no new dependency).
//   2. Geocode every postcode via postcodes.io so the GPS geofence reads
//      sensibly (the sheet has postcodes only, no coordinates).
//   3. Provision the two drivers + two routes (delivery areas from the shops).
//   4. Upsert one parcel per shop for the target run date.
//
// INTERIM BARCODE: until Audrius supplies the coupon-pack barcode makeup, the
// scannable tracking number is a deterministic stand-in:
//   CPN-{CUST}-{SHOP}-{YYMMDD}   e.g. CPN-WH-290637-260708
// When the real format lands: if each pack's barcode is unique-per-drop it
// becomes tracking_number directly; if it's a fixed per-shop code, add a
// barcode->shop alias and resolve to that day's parcel. Either way the rest of
// the pipeline is unchanged. Generate labels for these codes to scan in test.
//
// Re-running RESETS the run (parcels go back to the seed status) — use it to
// (re)load data, not mid-run.
//
// Usage:
//   node scripts/seed-coupon-pilot.mjs --dry-run          # parse + geocode, no DB writes
//   node scripts/seed-coupon-pilot.mjs <URL> <SERVICE_KEY> # hosted seed
//   (or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; --file=<path> overrides the sheet)

import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const fileArg = argv.find((a) => a.startsWith('--file='))?.slice('--file='.length)
const positionals = argv.filter((a) => !a.startsWith('--'))
const XLSX_PATH = fileArg || process.env.COUPON_XLSX
  || 'C:/Users/GBunton/Downloads/Driver App test data 8 July.xlsx'

// The run this seed populates. Coupons run MON/WED/FRI; default to today so the
// data is the live run for a demo. YYMMDD of this date goes into the barcode.
const RUN_DATE = process.env.RUN_DATE || new Date().toISOString().slice(0, 10) // yyyy-mm-dd
const YYMMDD = RUN_DATE.slice(2).replace(/-/g, '')

// Seed status. Confirmed 2026-07-09: coupon packs are scanned at EACH stage,
// so runs start at 'awaiting_collection' and walk the full collect -> warehouse
// -> deliver lifecycle. (Set 'at_warehouse' for a delivery-only run.)
const SEED_STATUS = process.env.SEED_STATUS || 'awaiting_collection'

// Route + driver definitions, keyed on the sheet's Branch column.
const CUST_CODE = { 'WILLIAM HILL': 'WH', LADBROKES: 'LAD', CORAL: 'COR' }
const DRIVERS = {
  BROMLEY: { driver_id: 'drv_peter_garland', driver_name: 'Peter Garland', route: 'Bromley' },
  WOOLWICH: { driver_id: 'drv_dean_ward', driver_name: 'Dean Ward', route: 'Woolwich' },
}

// ── minimal .xlsx reader (zip container + shared strings + one sheet) ────────
/** Extract one entry from a ZIP buffer by name. Reads the central directory for
 *  the real sizes/offset (local headers may carry zeroed sizes), then inflates
 *  the DEFLATE stream (method 8) or returns stored bytes (method 0). */
function unzipEntry(buf, wantName) {
  // End Of Central Directory: signature 0x06054b50, scanned from the tail.
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip (no EOCD)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) // central directory offset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central dir entry')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === wantName) {
      // Local header: data starts after its own (possibly different) name/extra.
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      return method === 0 ? raw : zlib.inflateRawSync(raw)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`entry not found: ${wantName}`)
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Parse the sheet into an array of row objects keyed by the header names in
 *  row 1. Handles shared strings (t="s"), inline strings and numbers. */
function parseSheet(xlsxBuf) {
  const shared = []
  const ssXml = unzipEntry(xlsxBuf, 'xl/sharedStrings.xml').toString('utf8')
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')
    shared.push(unescapeXml(text))
  }
  const sheet = unzipEntry(xlsxBuf, 'xl/worksheets/sheet1.xml').toString('utf8')
  const colToNum = (c) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)
  const rows = []
  for (const rm of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {}
    const cellRe = /<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is>([\s\S]*?)<\/is>)?<\/c>/g
    let c
    while ((c = cellRe.exec(rm[2]))) {
      const col = colToNum(c[1])
      let val = c[3]
      if (c[2] === 's') val = shared[+val]
      else if (c[2] === 'inlineStr') val = unescapeXml([...(c[4] || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
      else if (val !== undefined) val = unescapeXml(val)
      if (val !== undefined) cells[col] = val
    }
    rows.push({ r: +rm[1], cells })
  }
  rows.sort((a, b) => a.r - b.r)
  const header = rows.shift()
  const cols = {} // header name -> column number
  for (const [num, name] of Object.entries(header.cells)) cols[name.trim()] = +num
  return rows
    .filter((row) => Object.keys(row.cells).length > 0)
    .map((row) => {
      const o = {}
      for (const [name, num] of Object.entries(cols)) o[name] = (row.cells[num] ?? '').toString().trim()
      return o
    })
}

// ── postcode -> area (UK outward prefix), matching src/lib/enrich.postcodeArea ─
const postcodeArea = (pc) => ((pc || '').trim().toUpperCase().match(/^[A-Z]{1,2}/) ?? [''])[0]

// ── geocode via postcodes.io (bulk, 100/request) ────────────────────────────
async function geocode(postcodes) {
  const uniq = [...new Set(postcodes.map((p) => p.trim().toUpperCase()).filter(Boolean))]
  const out = new Map() // UPPERCASE postcode -> { lng, lat }
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100)
    const res = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postcodes: chunk }),
    })
    if (!res.ok) throw new Error(`postcodes.io ${res.status}`)
    const body = await res.json()
    for (const item of body.result) {
      if (item.result) out.set(item.query.trim().toUpperCase(), { lng: item.result.longitude, lat: item.result.latitude })
    }
  }
  return out
}

// ── build the parcel plan from the sheet ─────────────────────────────────────
function buildRows(sheet, geo) {
  const misses = []
  const rows = sheet.map((s) => {
    const branch = (s['Branch (route)'] || s.Branch || '').trim().toUpperCase()
    const def = DRIVERS[branch]
    const cust = CUST_CODE[(s.Customer || '').trim().toUpperCase()] || 'OTH'
    const pcKey = (s.PostCode || '').trim().toUpperCase()
    const fix = geo.get(pcKey)
    if (!fix) misses.push(`${s.Customer} ${s.Shop} (${s.PostCode || 'no postcode'})`)
    return {
      branch,
      route: def?.route ?? null,
      tracking_number: `CPN-${cust}-${s.Shop}-${YYMMDD}`,
      recipient_name: `${s.Customer} (${s.Shop})`,
      address_line: s.Address1,
      postcode: s.PostCode || null,
      destination: fix ? `SRID=4326;POINT(${fix.lng} ${fix.lat})` : null,
      delivery_area: postcodeArea(s.PostCode),
      collection_area: postcodeArea(s.PostCode), // delivery-only: mirror so auto-allocate stays consistent
      sender_name: null,
      sender_address_line: null,
      sender_postcode: null,
      status: SEED_STATUS,
      due_date: RUN_DATE,
      meta: { shop: s.Shop, customer: s.Customer, ventra_id: s.ID, drop_code: s.DropCode, branch, carrier: s.Carrier, source: 'coupon-pilot' },
    }
  })
  return { rows, misses }
}

// ── main ─────────────────────────────────────────────────────────────────────
// Wrapped so early exits are plain `return`s: calling process.exit() while
// fetch's keep-alive sockets are still closing trips a libuv teardown assertion
// on Windows. Setting process.exitCode and letting the loop drain avoids it.
async function main() {
const xlsxBuf = readFileSync(XLSX_PATH)
const sheet = parseSheet(xlsxBuf)
console.log(`Parsed ${sheet.length} shops from ${XLSX_PATH}`)

console.log('Geocoding postcodes via postcodes.io …')
const geo = await geocode(sheet.map((s) => s.PostCode))
const { rows, misses } = buildRows(sheet, geo)

// Per-route summary + delivery areas (drive the routes' delivery_areas[]).
const byBranch = {}
for (const r of rows) {
  const b = (byBranch[r.branch] ??= { count: 0, areas: new Set(), unknownBranch: !DRIVERS[r.branch] })
  b.count++
  if (r.delivery_area) b.areas.add(r.delivery_area)
}
console.log('\nRun date:', RUN_DATE, '| seed status:', SEED_STATUS)
console.log('Routes:')
for (const [branch, info] of Object.entries(byBranch)) {
  const d = DRIVERS[branch]
  console.log(`  ${branch.padEnd(9)} -> route "${d?.route ?? '??'}" / ${d?.driver_name ?? '?? UNKNOWN BRANCH'}  · ${info.count} shops · areas [${[...info.areas].sort().join(', ')}]`)
}
console.log(`Geocoded ${geo.size}/${new Set(sheet.map((s) => (s.PostCode || '').toUpperCase())).size} postcodes.` + (misses.length ? ` MISSES (${misses.length}): ${misses.join('; ')}` : ' No misses.'))
console.log('\nSample parcels:')
for (const r of [rows[0], rows[1], rows[rows.length - 1]]) {
  console.log(`  ${r.tracking_number.padEnd(24)} ${r.recipient_name.padEnd(24)} ${(r.address_line || '').slice(0, 28).padEnd(28)} ${r.postcode ?? ''}  ${r.destination ? 'geo✓' : 'NO GEO'}`)
}

const unknownBranches = Object.entries(byBranch).filter(([, i]) => i.unknownBranch).map(([b]) => b)
if (unknownBranches.length) {
  console.error(`\nERROR: sheet has branches not mapped to a driver/route: ${unknownBranches.join(', ')}. Add them to DRIVERS.`)
  process.exitCode = 1
  return
}

if (DRY) {
  console.log('\n[dry-run] No DB writes. Re-run with <URL> <SERVICE_KEY> to seed.')
  return
}

// ── DB writes ────────────────────────────────────────────────────────────────
const { createClient } = await import('@supabase/supabase-js')
const env = Object.fromEntries(
  (() => { try { return readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')) } catch { return [] } })()
    .map((l) => l.split('=', 2).map((s) => s.trim())),
)
const URL = positionals[0] || process.env.SUPABASE_URL || env.VITE_SUPABASE_URL
const KEY = positionals[1] || process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('\nNeed a target: pass <URL> <SERVICE_ROLE_KEY>, or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.')
  process.exitCode = 1
  return
}
console.log(`\nTarget: ${URL}`)
const db = createClient(URL, KEY, { auth: { persistSession: false } })

// Recommended hosted path: pass the ANON key (public, no secret) and sign in as
// an admin so RLS admin-write policies apply — same as seed-cloud-job.mjs. With
// a service_role key RLS is bypassed and this is unnecessary; we try and, on
// failure, assume a service_role key and carry on.
const adminEmail = process.env.ADMIN_EMAIL || 'admin@citipost.test'
const adminPassword = process.env.ADMIN_PASSWORD || 'citipost'
const { error: authErr } = await db.auth.signInWithPassword({ email: adminEmail, password: adminPassword })
console.log(authErr ? `(admin sign-in skipped: ${authErr.message} — assuming service_role key)` : `Signed in as ${adminEmail}`)

// 1. Drivers (deterministic ids -> idempotent).
const driverRows = Object.values(DRIVERS).map((d) => ({ id: d.driver_id, name: d.driver_name }))
{ const { error } = await db.from('drivers').upsert(driverRows, { onConflict: 'id' }); if (error) throw new Error(`drivers: ${error.message}`) }

// 2. Routes (name is unique -> idempotent). delivery/collection areas from the shops.
const routeIds = {}
for (const [branch, def] of Object.entries(DRIVERS)) {
  const areas = [...(byBranch[branch]?.areas ?? [])].sort()
  const { data, error } = await db.from('routes')
    .upsert({ name: def.route, driver_id: def.driver_id, delivery_areas: areas, collection_areas: areas }, { onConflict: 'name' })
    .select('id').single()
  if (error) throw new Error(`route ${def.route}: ${error.message}`)
  routeIds[branch] = data.id
}

// 3. Manifest (one per run date; reuse on re-run).
const manifestName = `Coupons ${RUN_DATE}`
let manifestId
{
  const { data: existing } = await db.from('manifests').select('id').eq('name', manifestName).maybeSingle()
  if (existing) {
    manifestId = existing.id
    await db.from('manifests').update({ imported_at: new Date().toISOString(), source_filename: XLSX_PATH }).eq('id', manifestId)
  } else {
    const { data, error } = await db.from('manifests').insert({ name: manifestName, reference: 'coupon-pilot', source_filename: XLSX_PATH }).select('id').single()
    if (error) throw new Error(`manifest: ${error.message}`)
    manifestId = data.id
  }
}

// 4. Parcels — one per shop, allocated to its branch's route.
const parcelRows = rows.map(({ branch, route, ...p }) => ({ ...p, route_id: routeIds[branch], manifest_id: manifestId }))
{ const { error } = await db.from('parcels').upsert(parcelRows, { onConflict: 'tracking_number' }); if (error) throw new Error(`parcels: ${error.message}`) }

console.log(`\nSeeded: ${driverRows.length} drivers, ${Object.keys(routeIds).length} routes, manifest "${manifestName}", ${parcelRows.length} parcels.`)
console.log('Next: assign login accounts to the drivers (scripts/seed-auth.mjs) and open the dispatcher to see both runs.')
}

await main()
