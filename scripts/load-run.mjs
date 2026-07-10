// Load a REAL coupon run from a Citipost EPOD trial CSV (the per-run manifest
// with real CarrierBarcode label IDs). One parcel per shop:
//   tracking_number = CarrierBarcode  (the value the driver scans)
//   due_date        = Inshopdate       (the run date)
//   route           = RouteName        (matched to the route by name)
//   status          = awaiting_collection (full collect→warehouse→deliver)
// Postcodes are geocoded (postcodes.io) for the GPS geofence. Idempotent
// (upsert on tracking_number). This is the real go-live path — Audrius sends a
// file per run, run this to load it.
//
//   node scripts/load-run.mjs <URL> <KEY>     (RUN_CSV env overrides the file)

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const RUN_CSV = process.env.RUN_CSV || 'C:/Users/GBunton/Downloads/Epod Trial data 10.07.26.csv'
const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'))

/** Quote-aware CSV → array of rows of cells (handles commas inside "quoted" fields). */
function csvRows(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const postcodeArea = (pc) => ((pc || '').trim().toUpperCase().match(/^[A-Z]{1,2}/) ?? [''])[0]

// The feed's column order (used when a file arrives WITHOUT a header row).
const CANON = ['Shop', 'CustomerName', 'Address1', 'PostCode', 'AddressID', 'Carrier', 'RouteName', 'DropCode', 'CarrierBarcode', 'Inshopdate']

/** Normalise a date to YYYY-MM-DD (accepts DD/MM/YYYY and ISO). */
const isoDate = (s) => {
  s = (s || '').trim()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s
}

async function geocode(pcs) {
  const uniq = [...new Set(pcs.map((p) => p.trim().toUpperCase()).filter(Boolean))]
  const out = new Map()
  for (let i = 0; i < uniq.length; i += 100) {
    const res = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postcodes: uniq.slice(i, i + 100) }),
    })
    if (!res.ok) throw new Error(`postcodes.io ${res.status}`)
    const b = await res.json()
    for (const it of b.result) if (it.result) out.set(it.query.trim().toUpperCase(), { lng: it.result.longitude, lat: it.result.latitude })
  }
  return out
}

async function main() {
  const arr = csvRows(readFileSync(RUN_CSV, 'utf8').replace(/^﻿/, '').trim())
  // Header row is optional — some exports omit it. Detect a header by known
  // column names; otherwise assume the canonical column order.
  const first = arr[0].map((h) => h.trim())
  const hasHeader = first.some((h) => /^(Shop|CarrierBarcode|CustomerName|RouteName|Inshopdate)$/i.test(h))
  const hdr = hasHeader ? first : CANON
  const idx = Object.fromEntries(hdr.map((h, i) => [h, i]))
  const rows = (hasHeader ? arr.slice(1) : arr).filter((r) => r.some((c) => c.trim() !== ''))
  const get = (r, name) => (r[idx[name]] ?? '').trim()
  console.log(`Parsed ${rows.length} rows from ${RUN_CSV} (${hasHeader ? 'with header' : 'no header — assumed canonical order'})`)

  // Guard: barcodes must be plain digits. Excel silently turns a 17-digit
  // barcode into scientific notation ("7.61007E+16") on a CSV round-trip, which
  // destroys it — refuse rather than load junk that won't scan.
  const bad = rows.map((r) => get(r, 'CarrierBarcode')).filter((b) => b && !/^\d{6,}$/.test(b))
  if (bad.length) {
    console.error(`ABORT: ${bad.length}/${rows.length} barcodes are not plain digits (e.g. "${bad[0]}"). The CarrierBarcode column looks Excel-corrupted (scientific notation) — re-export it with that column formatted as TEXT so the full 17 digits survive.`)
    process.exitCode = 1
    return
  }

  const geo = await geocode(rows.map((r) => get(r, 'PostCode')))

  const env = Object.fromEntries(
    (() => { try { return readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')) } catch { return [] } })()
      .map((l) => l.split('=', 2).map((s) => s.trim())),
  )
  const URL = positionals[0] || process.env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const KEY = positionals[1] || process.env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!URL || !KEY) { console.error('Need <URL> <KEY>.'); process.exitCode = 1; return }
  const db = createClient(URL, KEY, { auth: { persistSession: false } })
  const { error: authErr } = await db.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL || 'admin@citipost.test', password: process.env.ADMIN_PASSWORD || 'citipost',
  })
  console.log(authErr ? `(admin sign-in skipped: ${authErr.message})` : 'Signed in as admin')

  const { data: routes } = await db.from('routes').select('id,name')
  const routeByName = new Map((routes || []).map((r) => [r.name.toLowerCase(), r.id]))

  const runDate = isoDate(get(rows[0], 'Inshopdate'))
  const name = `Coupons ${runDate}`
  let manifestId
  const { data: ex } = await db.from('manifests').select('id').eq('name', name).maybeSingle()
  if (ex) { manifestId = ex.id; await db.from('manifests').update({ imported_at: new Date().toISOString(), source_filename: RUN_CSV }).eq('id', manifestId) }
  else {
    const { data, error } = await db.from('manifests').insert({ name, reference: 'coupon', source_filename: RUN_CSV }).select('id').single()
    if (error) throw new Error(`manifest: ${error.message}`)
    manifestId = data.id
  }

  const byRoute = {}, misses = [], unroutedNames = new Set()
  const parcels = rows.map((r) => {
    const shop = get(r, 'Shop'), cust = get(r, 'CustomerName'), pc = get(r, 'PostCode'), rn = get(r, 'RouteName')
    const fix = geo.get(pc.toUpperCase())
    if (!fix && pc) misses.push(`${cust} ${shop} (${pc})`)
    const rid = routeByName.get(rn.toLowerCase()) ?? null
    if (!rid) unroutedNames.add(rn)
    byRoute[rn] = (byRoute[rn] || 0) + 1
    return {
      tracking_number: get(r, 'CarrierBarcode'),
      recipient_name: `${cust} (${shop})`,
      address_line: get(r, 'Address1'),
      postcode: pc || null,
      destination: fix ? `SRID=4326;POINT(${fix.lng} ${fix.lat})` : null,
      delivery_area: postcodeArea(pc),
      collection_area: postcodeArea(pc),
      status: 'awaiting_collection',
      due_date: isoDate(get(r, 'Inshopdate')) || runDate,
      route_id: rid,
      manifest_id: manifestId,
      meta: {
        source: 'coupon', shop, customer: cust, address_id: get(r, 'AddressID'),
        drop_code: get(r, 'DropCode'), carrier: get(r, 'Carrier'), route_name: rn,
        barcode: get(r, 'CarrierBarcode'), inshopdate: get(r, 'Inshopdate'),
      },
    }
  })
  console.log(`Run ${runDate} · by route: ${JSON.stringify(byRoute)} · geocoded ${geo.size} · ${misses.length} miss(es)`)
  if (unroutedNames.size) console.log(`WARN: no route matches for: ${[...unroutedNames].join(', ')} — those parcels are unallocated`)

  const { error } = await db.from('parcels').upsert(parcels, { onConflict: 'tracking_number' })
  if (error) throw new Error(`parcels: ${error.message}`)
  console.log(`Loaded ${parcels.length} parcels for "${name}" (tracking = real CarrierBarcode).`)
}
await main()
