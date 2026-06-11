// One-off: seed the lifecycle test job into the HOSTED project as the admin
// user (RLS allows admin parcel/manifest writes — no service key needed).
import { createClient } from '@supabase/supabase-js'

const [url, anonKey] = process.argv.slice(2)
const supabase = createClient(url, anonKey, { auth: { persistSession: false } })
const { error: authErr } = await supabase.auth.signInWithPassword({
  email: 'admin@citipost.test',
  password: 'citipost',
})
if (authErr) {
  console.error('admin sign-in failed:', authErr.message)
  process.exit(1)
}

const JOB_NAME = 'Lifecycle test job'
const PARCELS = [
  ['TJOB-0001-GB', 'The Coffee Counter', '18 Bethnal Green Road, London', 'E1 6GH', 'Greater London', -0.0719, 51.5237],
  ['TJOB-0003-GB', 'Brighton Beach Books', '12 Marine Parade, Brighton', 'BN2 1TL', 'South East', -0.1313, 50.8198],
  ['TJOB-0004-GB', 'Maidstone Garden Centre', 'Larkspur Close, Maidstone', 'ME14 9QT', 'South East', 0.5304, 51.281],
  ['TJOB-0005-GB', 'Deansgate Electronics', '90 Deansgate, Manchester', 'M3 2GP', 'North West', -2.2487, 53.4794],
  ['TJOB-0006-GB', 'Mersey Wholefoods', '5 Dale Street, Liverpool', 'L2 2HF', 'North West', -2.989, 53.4084],
]

// Reuse the job row if it already exists (same rule as the importer)
const { data: existing } = await supabase.from('manifests').select('id').eq('name', JOB_NAME).maybeSingle()
let manifestId
if (existing) {
  manifestId = existing.id
  await supabase.from('manifests').update({ imported_at: new Date().toISOString() }).eq('id', manifestId)
} else {
  const { data: m, error } = await supabase
    .from('manifests')
    .insert({ name: JOB_NAME, source_filename: 'seed-test-job.mjs' })
    .select()
    .single()
  if (error) {
    console.error('manifest insert failed:', error.message)
    process.exit(1)
  }
  manifestId = m.id
}

// Upsert the parcels UNALLOCATED at the lifecycle start. On re-run this
// re-attaches them to the job but leaves status/route as they are (a true
// reset on cloud needs the service key — RLS has no delete policies).
const rows = PARCELS.map(([tracking_number, recipient_name, address_line, postcode, area, lng, lat]) => ({
  tracking_number,
  recipient_name,
  address_line,
  postcode,
  area,
  destination: `SRID=4326;POINT(${lng} ${lat})`,
  manifest_id: manifestId,
  route_id: null,
}))
const { error: insErr } = await supabase.from('parcels').upsert(rows, { onConflict: 'tracking_number' })
if (insErr) {
  console.error('parcel upsert failed:', insErr.message)
  process.exit(1)
}

const { data: check } = await supabase
  .from('parcels')
  .select('tracking_number,status,route_id,area')
  .like('tracking_number', 'TJOB-%')
  .order('tracking_number')
console.log(`"${JOB_NAME}" seeded on ${url}:`)
for (const p of check ?? []) {
  console.log(`  ${p.tracking_number}  ${p.status.padEnd(20)} ${p.route_id ? 'ALLOCATED' : 'unallocated'}  ${p.area}`)
}
