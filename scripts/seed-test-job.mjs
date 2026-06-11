// Seed (or reset) a dedicated lifecycle test job: six parcels at the very
// start of the lifecycle — UNALLOCATED + awaiting_collection — with real
// destination coordinates so the geofence reads sensibly. Safe to re-run —
// it wipes the previous TJOB parcels and their events/PODs first, so the
// job always restarts from scratch.
//
//   local stack:   node scripts/seed-test-job.mjs
//   hosted (cloud) project — service_role key from dashboard → Settings → API:
//                  node scripts/seed-test-job.mjs <SUPABASE_URL> <SERVICE_ROLE_KEY>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const [argUrl, argKey] = process.argv.slice(2)

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => l.split('=', 2).map((s) => s.trim())),
)

// Service-role key (CLI arg → env var → .env → local CLI) — needed to wipe
// old events/PODs (RLS defines no delete policies, by design).
function serviceKey() {
  if (argKey) return argKey
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY
  const tries = [
    ['node_modules/@supabase/cli-windows-x64/bin/supabase.exe', ['status', '-o', 'env']],
    ['npx', ['supabase', 'status', '-o', 'env']],
  ]
  for (const [cmd, args] of tries) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })
      const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/SERVICE_ROLE_KEY="?([^"\r\n]+)"?/)
      if (m) return m[1].trim()
    } catch {
      /* try the next */
    }
  }
  return null
}
const SVC = serviceKey()
if (!SVC) {
  console.error('No service-role key. Set SUPABASE_SERVICE_ROLE_KEY (find it via `npx supabase status`).')
  process.exit(1)
}
const URL = argUrl ?? env.VITE_SUPABASE_URL
console.log(`target: ${URL}`)
const svc = createClient(URL, SVC, { auth: { persistSession: false } })

const JOB_NAME = 'Lifecycle test job'

// Two stops per region; lng/lat are the real locations of the addresses, so
// captures made nearby show a green geofence and remote ones get flagged.
const PARCELS = [
  ['TJOB-0001-GB', 'The Coffee Counter', '18 Bethnal Green Road, London', 'E1 6GH', 'Greater London', -0.0719, 51.5237],
  ['TJOB-0002-GB', 'Hailey Road Trade Supplies', 'Unit 2, Hailey Road, Erith', 'DA18 4AA', 'Greater London', 0.153, 51.4965],
  ['TJOB-0003-GB', 'Brighton Beach Books', '12 Marine Parade, Brighton', 'BN2 1TL', 'South East', -0.1313, 50.8198],
  ['TJOB-0004-GB', 'Maidstone Garden Centre', 'Larkspur Close, Maidstone', 'ME14 9QT', 'South East', 0.5304, 51.281],
  ['TJOB-0005-GB', 'Deansgate Electronics', '90 Deansgate, Manchester', 'M3 2GP', 'North West', -2.2487, 53.4794],
  ['TJOB-0006-GB', 'Mersey Wholefoods', '5 Dale Street, Liverpool', 'L2 2HF', 'North West', -2.989, 53.4084],
]

// 1. Wipe any previous run of this job so the lifecycle restarts cleanly
const { data: old } = await svc.from('parcels').select('id').like('tracking_number', 'TJOB-%')
const oldIds = (old ?? []).map((p) => p.id)
if (oldIds.length) {
  await svc.from('pod_records').delete().in('parcel_id', oldIds) // photos cascade
  await svc.from('parcel_events').delete().in('parcel_id', oldIds)
  await svc.from('parcels').delete().in('id', oldIds)
  console.log(`reset: removed ${oldIds.length} previous TJOB parcels (+ their events/PODs)`)
}

// 2. The job itself — reuse the row on re-run (same rule as the importer)
const { data: existing } = await svc.from('manifests').select('id').eq('name', JOB_NAME).maybeSingle()
let manifestId
if (existing) {
  manifestId = existing.id
  await svc.from('manifests').update({ imported_at: new Date().toISOString() }).eq('id', manifestId)
} else {
  const { data: m, error } = await svc
    .from('manifests')
    .insert({ name: JOB_NAME, source_filename: 'seed-test-job.mjs' })
    .select()
    .single()
  if (error) throw new Error(error.message)
  manifestId = m.id
}

// 3. Insert the parcels at the very start of the lifecycle: UNALLOCATED and
//    awaiting collection (status + due_date come from the column defaults).
//    The demo begins on the dispatch side — Allocate (or Auto-allocate by
//    area) hands them to the drivers, then the lifecycle scans follow.
const rows = PARCELS.map(([tracking, recipient, address, postcode, area, lng, lat]) => ({
  tracking_number: tracking,
  recipient_name: recipient,
  address_line: address,
  postcode,
  area,
  destination: `POINT(${lng} ${lat})`,
  manifest_id: manifestId,
  route_id: null,
}))
const { error: insErr } = await svc.from('parcels').insert(rows)
if (insErr) throw new Error(insErr.message)

console.log(`\n"${JOB_NAME}" seeded — 6 parcels, UNALLOCATED, at AWAITING COLLECTION:\n`)
for (const [tracking, recipient, , , area] of PARCELS) {
  console.log(`  ${tracking}  ${recipient.padEnd(28)} ${area}`)
}
console.log(
  '\nStart to finish: dispatch -> Allocate (auto or manual) -> driver: Scan label ->' +
    '\nCollect -> Warehouse -> Deliver. Re-run this script anytime to reset the job.',
)
