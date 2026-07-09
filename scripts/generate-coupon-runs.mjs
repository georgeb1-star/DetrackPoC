// Phase 3 — RECURRING coupon runs. The coupon service runs Mon–Fri (confirmed
// 2026-07-09); rather than re-import or re-allocate each day, this regenerates
// the run as a fresh batch of dated parcels — the "auto-refresh daily" ask from
// the 8 Jul demo.
//
// It is SELF-CONTAINED: the template (the shop list) is read back from the
// parcels already in the DB (meta.source = 'coupon-pilot'), deduped to one stop
// per shop. So it depends on no external file and can run unattended.
//
//   node scripts/generate-coupon-runs.mjs <URL> <SERVICE_KEY|ANON_KEY>
//   env: DAYS=5 (how many upcoming service days), WEEKDAYS=1,2,3,4,5 (ISO Mon..Sun),
//        FROM=YYYY-MM-DD (default today), SEED_STATUS=awaiting_collection
//
// Idempotent: only MISSING parcels are inserted (ON CONFLICT DO NOTHING), so a
// day already generated — or a run partway through delivery — is never touched.
//
// Tracking numbers: each stop has a stable base (CPN-{CUST}-{SHOP}); a run adds
// the date (…-YYMMDD). When Audrius's real barcode arrives this base becomes the
// alias the scan resolves to. TRUE unattended scheduling: either port this to a
// pg_cron SQL function, or run it from a daily scheduled task / CI cron.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const DAYS = Number(process.env.DAYS || 5)
const WEEKDAYS = (process.env.WEEKDAYS || '1,2,3,4,5').split(',').map(Number) // ISO 1=Mon..7=Sun (coupons run Mon–Fri)
const FROM = process.env.FROM || new Date().toISOString().slice(0, 10)
const SEED_STATUS = process.env.SEED_STATUS || 'awaiting_collection' // full collect→warehouse→deliver lifecycle

/** The next `count` dates on/after `fromISO` whose ISO weekday is in `weekdays`. */
function serviceDates(fromISO, weekdays, count) {
  const out = []
  const d = new Date(fromISO + 'T00:00:00Z')
  while (out.length < count) {
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
    if (weekdays.includes(dow)) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

async function main() {
  const env = Object.fromEntries(
    (() => { try { return readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')) } catch { return [] } })()
      .map((l) => l.split('=', 2).map((s) => s.trim())),
  )
  const URL = positionals[0] || process.env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const KEY = positionals[1] || process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!URL || !KEY) { console.error('Need <URL> <KEY> (or SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).'); process.exitCode = 1; return }

  const db = createClient(URL, KEY, { auth: { persistSession: false } })
  const { error: authErr } = await db.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL || 'admin@citipost.test',
    password: process.env.ADMIN_PASSWORD || 'citipost',
  })
  console.log(authErr ? `(admin sign-in skipped: ${authErr.message} — assuming service_role key)` : 'Signed in as admin')

  // 1. Read the template: every coupon parcel, deduped to one stop per shop.
  const { data: tmplRows, error: tErr } = await db.from('parcels')
    .select('tracking_number,recipient_name,address_line,postcode,destination,delivery_area,collection_area,sender_name,sender_address_line,sender_postcode,route_id,meta')
    .eq('meta->>source', 'coupon-pilot')
  if (tErr) { console.error('template read failed:', tErr.message); process.exitCode = 1; return }
  const stops = new Map() // base tracking (CPN-{CUST}-{SHOP}) -> template fields
  for (const r of tmplRows) {
    const base = r.tracking_number.replace(/-\d{6}$/, '')
    if (!stops.has(base)) stops.set(base, r)
  }
  console.log(`Template: ${stops.size} stops (from ${tmplRows.length} parcels).`)
  if (stops.size === 0) { console.error('No coupon template found — run seed-coupon-pilot.mjs first.'); process.exitCode = 1; return }

  // 2. For each upcoming service day, ensure that day's parcels exist.
  const dates = serviceDates(FROM, WEEKDAYS, DAYS)
  console.log(`Service days (${WEEKDAYS.join('/')}), next ${DAYS} from ${FROM}: ${dates.join(', ')}\n`)
  for (const date of dates) {
    const yymmdd = date.slice(2).replace(/-/g, '')
    // manifest per run date (reuse if present)
    const name = `Coupons ${date}`
    let manifestId
    const { data: existing } = await db.from('manifests').select('id').eq('name', name).maybeSingle()
    if (existing) manifestId = existing.id
    else {
      const { data, error } = await db.from('manifests').insert({ name, reference: 'coupon-pilot', source_filename: 'generate-coupon-runs.mjs' }).select('id').single()
      if (error) { console.error(`manifest ${name}:`, error.message); process.exitCode = 1; return }
      manifestId = data.id
    }
    const rows = [...stops].map(([base, t]) => ({
      tracking_number: `${base}-${yymmdd}`,
      recipient_name: t.recipient_name, address_line: t.address_line, postcode: t.postcode,
      destination: t.destination, delivery_area: t.delivery_area, collection_area: t.collection_area,
      sender_name: t.sender_name, sender_address_line: t.sender_address_line, sender_postcode: t.sender_postcode,
      status: SEED_STATUS, due_date: date, route_id: t.route_id, manifest_id: manifestId, meta: t.meta,
    }))
    // ON CONFLICT DO NOTHING — never disturb an existing/in-progress run.
    const { data: inserted, error } = await db.from('parcels')
      .upsert(rows, { onConflict: 'tracking_number', ignoreDuplicates: true }).select('id')
    if (error) { console.error(`parcels ${date}:`, error.message); process.exitCode = 1; return }
    console.log(`  ${date}: ${inserted.length} new parcel(s), ${rows.length - inserted.length} already present`)
  }
  console.log('\nDone. Re-run any time — only missing runs get created.')
}

await main()
