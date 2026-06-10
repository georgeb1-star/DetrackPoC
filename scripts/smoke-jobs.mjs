// Smoke test for the Jobs (manifest import + tracking export) round-trip.
// Proves the anon key can do exactly what JobsScreen does: create a manifest,
// upsert parcels (meta jsonb, idempotent on tracking_number), and run the
// export join. Self-cleaning. Usage: node scripts/smoke-jobs.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
// Dispatcher work is admin-only under RLS — sign in as the seeded admin first.
const auth = await supabase.auth.signInWithPassword({ email: 'admin@citipost.test', password: 'citipost' })
if (auth.error) {
  console.error('✗ admin sign-in failed:', auth.error.message, '(run scripts/seed-auth.mjs)')
  process.exit(1)
}
let failed = false
const fail = (m, e) => {
  console.error('✗ ' + m, e?.message ?? e ?? '')
  failed = true
}

const trk = ['SMOKE-MANIFEST-001', 'SMOKE-MANIFEST-002']

// 1. manifest insert
const { data: manifest, error: mErr } = await supabase
  .from('manifests')
  .insert({ name: 'SMOKE job', source_filename: 'smoke.xlsx' })
  .select()
  .single()
if (mErr) fail('manifest insert', mErr)
else console.log('✓ manifest created:', manifest.id)

if (manifest) {
  // 2. parcels upsert with meta jsonb + manifest_id
  const rows = trk.map((t, i) => ({
    tracking_number: t,
    recipient_name: `Smoke Recipient ${i + 1}`,
    address_line: '1 Test Street, Testville',
    postcode: 'AB1 2CD',
    area: 'Greater London',
    manifest_id: manifest.id,
    meta: { 'Weight (kg)': 1.2 + i, source: 'smoke' },
  }))
  const { data: up, error: upErr } = await supabase
    .from('parcels')
    .upsert(rows, { onConflict: 'tracking_number' })
    .select('id, tracking_number, manifest_id, meta')
  if (upErr) fail('parcels upsert', upErr)
  else console.log(`✓ upserted ${up.length} parcels; meta round-trip: ${JSON.stringify(up[0].meta)}`)

  // idempotency: re-import must not duplicate
  const again = await supabase.from('parcels').upsert(rows, { onConflict: 'tracking_number' }).select('id')
  if (again.error) fail('re-upsert', again.error)
  else if (again.data.length !== rows.length) fail('re-upsert duplicated rows', `got ${again.data.length}`)
  else console.log('✓ re-import upsert is idempotent (no duplicates)')

  // 3. a delivered POD with a location, so the export has an event to emit
  const podId = crypto.randomUUID()
  const parcelId = up?.[0]?.id
  const pod = await supabase.from('pod_records').insert({
    id: podId,
    parcel_id: parcelId,
    tracking_scanned: trk[0],
    status: 'delivered',
    received_by: 'Left with neighbour',
    captured_at: new Date().toISOString(),
    location: 'POINT(-2.2426 53.4808)',
    gps_source: 'device',
  })
  if (pod.error) fail('pod_record insert', pod.error)
  else console.log('✓ pod_record inserted (with location)')

  // 4. the export join query JobsScreen runs
  const { data: ev, error: evErr } = await supabase
    .from('pod_records')
    .select(
      'tracking_scanned,status,received_by,failure_reason,captured_at,location, parcel:parcels(tracking_number,area,postcode,manifest_id)',
    )
    .order('captured_at', { ascending: true })
  if (evErr) fail('export join query', evErr)
  else {
    const mine = ev.filter((r) => r.parcel?.manifest_id === manifest.id)
    if (!mine.length) fail('export join returned no events for the job')
    else console.log(`✓ export join OK (${mine.length} event); location hex: ${String(mine[0].location).slice(0, 18)}…`)
  }

  // cleanup (pod first — FK to parcels)
  await supabase.from('pod_records').delete().eq('id', podId)
  await supabase.from('parcels').delete().in('tracking_number', trk)
  await supabase.from('manifests').delete().eq('id', manifest.id)
  console.log('✓ cleaned up smoke rows')
}

process.exit(failed ? 1 : 0)
