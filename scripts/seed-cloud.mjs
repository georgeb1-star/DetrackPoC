// Seed a *hosted* Supabase project over REST (no DB password needed) — the
// same 8 parcels as supabase/seed.sql, with destinations as EWKT strings
// (PostGIS accepts WKT input through PostgREST). Idempotent: re-runs skip
// existing tracking numbers. Also probes the pod-evidence bucket.
// Usage: node scripts/seed-cloud.mjs <SUPABASE_URL> <ANON_KEY>
import { createClient } from '@supabase/supabase-js'

const [url, key] = process.argv.slice(2)
if (!url || !key) {
  console.error('usage: node scripts/seed-cloud.mjs <SUPABASE_URL> <ANON_KEY>')
  process.exit(1)
}
const supabase = createClient(url, key)

const point = (lng, lat) => `SRID=4326;POINT(${lng} ${lat})`
const parcels = [
  ['CP-849213-GB', 'Meridian Logistics', 'Unit 4, Hailey Road Industrial Estate, Erith', 'DA18 4AA', point(0.177, 51.484), 'Domestic'],
  ['CP-100002-GB', 'Patricia Holloway', '14 Larkspur Close, Maidstone', 'ME14 9QT', point(0.5394, 51.2879), 'Domestic'],
  ['CP-100003-GB', 'Dev & Sons Hardware', '88 Roman Road, Bethnal Green, London', 'E2 0QJ', point(-0.049, 51.5309), 'Domestic'],
  ['CP-200004-GB', 'Brightwell Imports Ltd', '22 Queen Street, Edinburgh', 'EH2 1JX', point(-3.199, 55.9533), 'International'],
  ['CP-200005-GB', 'Atlantique Wines (UK)', '8 Harbour View, Cardiff Bay, Cardiff', 'CF10 5BZ', point(-3.164, 51.464), 'International'],
  ['CP-300006-GB', 'Acme Home Goods — J. Mercer', '3 Foundry Lane, Holbeck, Leeds', 'LS11 9XE', point(-1.558, 53.789), 'Fulfilment'],
  ['CP-300007-GB', 'Tillys Toy Shop', '27 St Giles Street, Norwich', 'NR2 1JN', point(1.2923, 52.6288), 'Fulfilment'],
  ['CP-400008-GB', 'NN4 Regional Sort Hub', 'Unit 9, Saddlers Way, Northampton', 'NN4 7HD', point(-0.8932, 52.2151), 'Sortation'],
].map(([tracking_number, recipient_name, address_line, postcode, destination, area]) => ({
  tracking_number, recipient_name, address_line, postcode, destination, area,
}))

const { error } = await supabase
  .from('parcels')
  .upsert(parcels, { onConflict: 'tracking_number', ignoreDuplicates: true })
if (error) {
  console.error('✗ seed failed:', error.message)
  process.exit(1)
}

const { data, error: selErr } = await supabase
  .from('parcels')
  .select('tracking_number, recipient_name, area')
  .order('tracking_number')
if (selErr) {
  console.error('✗ verify failed:', selErr.message)
  process.exit(1)
}
console.log(`✓ ${data.length} parcels in cloud project:`)
for (const p of data) console.log(`    ${p.tracking_number}  ${p.area.padEnd(13)} ${p.recipient_name}`)

// Bucket probe: upload + public read, like the local smoke test
const probe = `setup-probe/${Date.now()}.txt`
const up = await supabase.storage.from('pod-evidence').upload(probe, new Blob(['probe']), { contentType: 'text/plain' })
if (up.error) {
  console.error('✗ pod-evidence bucket probe failed:', up.error.message)
  console.error('  (bucket or storage policies missing — re-run the storage section of cloud-setup.sql)')
  process.exit(1)
}
const pub = supabase.storage.from('pod-evidence').getPublicUrl(probe).data.publicUrl
const res = await fetch(pub)
console.log(res.ok ? '✓ pod-evidence bucket: upload + public read OK' : `✗ public read failed (${res.status})`)
process.exit(res.ok ? 0 : 1)
