// End-to-end test of the manifest (job) import path — the same code the Jobs
// screen runs. Node 24 type-stripping lets us import src/lib/manifest.ts
// directly, so the parser/mapper under test is the real one, not a copy.
//
//  1. Build an .xlsx in memory with messy carrier-style headers, a title row,
//     a junk area, a duplicate tracking number and a row missing its address.
//  2. parseManifestFile → autoMap → buildParcelInputs: assert the mapping and
//     that the two bad rows are reported, not imported.
//  3. As admin, commit exactly like JobsScreen.importJob: insert manifests row,
//     upsert parcels (onConflict tracking_number).
//  4. Assert DB invariants: status defaults to awaiting_collection, due_date
//     today, meta jsonb kept, parcels arrive unallocated.
//  5. Allocate one to Sam's route + advance its status, re-import the same
//     file: no duplicates, route_id/status survive (the upsert must not reset
//     a parcel mid-lifecycle).
//  6. RLS: Sam only sees the parcel once it's on his route.
//  7. Clean up (admin deletes the test parcels + manifest).
//
// Run with the local stack up + auth seeded: node scripts/test-manifest.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { autoMap, buildParcelInputs, parseManifestFile } from '../src/lib/manifest.ts'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const mk = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const signIn = async (c, email) => {
  const { error } = await c.auth.signInWithPassword({ email, password: 'citipost' })
  if (error) throw new Error(`sign in ${email}: ${error.message}`)
}

// ---------- 1. a realistic, slightly hostile spreadsheet ----------
const XLSX = await import('xlsx')
const aoa = [
  ['CITIPOST DAILY MANIFEST'], // title row the parser must skip
  // note the UNNAMED column between Region and Service Level — columns after
  // it must not shift onto the wrong header
  ['Consignment No', 'Customer Name', 'Delivery Address 1', 'Post Code', 'Region', '', 'Service Level'],
  ['TEST-MAN-001', 'Import Test One', '1 Test Way, London', 'N1 1AA', 'Greater London', 'X', 'Next day'],
  ['TEST-MAN-002', 'Import Test Two', '2 Test Way, Manchester', 'M1 1AA', 'north west', '', '48h'], // case-insensitive area
  ['TEST-MAN-003', 'Import Test Three', '3 Test Way, Nowhere', 'XX1 1XX', 'Outer Mongolia', '', '48h'], // junk area → default
  ['TEST-MAN-001', 'Duplicate Row', '1 Test Way, London', 'N1 1AA', 'Greater London', '', ''], // dupe tracking
  ['TEST-MAN-004', 'Missing Address', '', 'L1 1AA', 'North West', '', ''], // missing required field
]
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Manifest')
const xlsxBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
const file = new File([xlsxBuf], 'test-manifest.xlsx')

// ---------- 2. parse + map with the app's own code ----------
console.log('Parse & map (src/lib/manifest.ts)')
const parsed = await parseManifestFile(file)
check('title row skipped, 7 headers found', parsed.headers.length === 7, parsed.headers.join('|'))
check('unnamed column kept positional as Column 6', parsed.headers[5] === 'Column 6', parsed.headers[5])
check('5 data rows parsed', parsed.rows.length === 5, String(parsed.rows.length))

const mapping = autoMap(parsed.headers)
check('tracking ← Consignment No', mapping.tracking_number === 'Consignment No', JSON.stringify(mapping))
check('recipient ← Customer Name', mapping.recipient_name === 'Customer Name')
check('address ← Delivery Address 1', mapping.address_line === 'Delivery Address 1')
check('postcode ← Post Code', mapping.postcode === 'Post Code')
check('area ← Region', mapping.area === 'Region')

const { parcels: inputs, errors } = buildParcelInputs(parsed.rows, mapping)
check('3 importable parcels', inputs.length === 3, String(inputs.length))
check('duplicate + missing-address rejected with reasons', errors.length === 2,
  JSON.stringify(errors))
check('area matched case-insensitively', inputs[1]?.area === 'North West', inputs[1]?.area)
check('junk area falls back to Greater London', inputs[2]?.area === 'Greater London', inputs[2]?.area)
check('extra columns kept in meta, no shift past the unnamed column',
  inputs[0]?.meta['Service Level'] === 'Next day' && inputs[0]?.meta['Column 6'] === 'X',
  JSON.stringify(inputs[0]?.meta))

// ---------- 3. commit exactly like JobsScreen.importJob ----------
console.log('Commit as admin (manifests insert + parcels upsert)')
const admin = mk()
await signIn(admin, 'admin@citipost.test')
const { data: job, error: mErr } = await admin
  .from('manifests')
  .insert({ name: 'TEST import job', source_filename: 'test-manifest.xlsx' })
  .select()
  .single()
check('manifests row created', !mErr && !!job, mErr?.message)

const rows = inputs.map((p) => ({ ...p, manifest_id: job.id }))
const { error: upErr } = await admin.from('parcels').upsert(rows, { onConflict: 'tracking_number' })
check('parcels upsert OK (meta jsonb accepted)', !upErr, upErr?.message)

// ---------- 4. DB invariants on the imported rows ----------
const fetchTest = () => admin.from('parcels')
  .select('id, tracking_number, status, due_date, route_id, area, meta')
  .like('tracking_number', 'TEST-MAN-%')
  .order('tracking_number')
let { data: dbRows } = await fetchTest()
const today = new Date().toISOString().slice(0, 10)
check('3 rows in DB (no extras)', dbRows?.length === 3, String(dbRows?.length))
check('status defaults to awaiting_collection', dbRows?.every((r) => r.status === 'awaiting_collection'),
  dbRows?.map((r) => r.status).join(','))
check('due_date defaults to today (joins today’s run)', dbRows?.every((r) => r.due_date === today),
  dbRows?.map((r) => r.due_date).join(','))
check('imported parcels arrive unallocated', dbRows?.every((r) => r.route_id === null))
check('meta survives round-trip', dbRows?.[0]?.meta?.['Service Level'] === 'Next day')

// ---------- 5. re-import must not duplicate or reset live parcels ----------
console.log('Re-import (upsert) semantics')
const { data: samRoute } = await admin.from('routes').select('id').eq('driver_id', 'drv_demo').single()
await admin.from('parcels').update({ route_id: samRoute.id, status: 'collected' })
  .eq('tracking_number', 'TEST-MAN-001')
const { error: reErr } = await admin.from('parcels').upsert(rows, { onConflict: 'tracking_number' })
check('re-import upsert OK', !reErr, reErr?.message)
;({ data: dbRows } = await fetchTest())
const p1 = dbRows?.find((r) => r.tracking_number === 'TEST-MAN-001')
check('still 3 rows after re-import (no duplicates)', dbRows?.length === 3, String(dbRows?.length))
check('re-import preserves allocation (route_id kept)', p1?.route_id === samRoute.id)
check('re-import preserves lifecycle status (collected kept)', p1?.status === 'collected', p1?.status)

// ---------- 6. driver visibility through RLS ----------
console.log('Driver visibility (RLS)')
const sam = mk()
await signIn(sam, 'sam@citipost.test')
const { data: samSees } = await sam.from('parcels').select('tracking_number').like('tracking_number', 'TEST-MAN-%')
check('Sam sees only the allocated import (TEST-MAN-001)',
  samSees?.length === 1 && samSees[0].tracking_number === 'TEST-MAN-001',
  JSON.stringify(samSees))

// ---------- 7. cleanup ----------
await admin.from('parcels').delete().like('tracking_number', 'TEST-MAN-%')
await admin.from('manifests').delete().eq('id', job.id)
const { data: leftover } = await fetchTest()
check('cleanup: test rows removed', (leftover ?? []).length === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
