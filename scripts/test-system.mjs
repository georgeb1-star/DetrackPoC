// Comprehensive backend test suite: RLS isolation, lifecycle invariants,
// sync idempotency, the attempts model, and storage policies — exercised
// through supabase-js exactly the way the app talks to the backend.
// Run with the local stack up + auth seeded:
//   node scripts/test-system.mjs
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => l.split('=', 2).map((s) => s.trim())),
)
const URL = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY

const mk = () => createClient(URL, ANON, { auth: { persistSession: false } })
const anon = mk()
const admin = mk()
const sam = mk()
const priya = mk()

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function signIn(client, email) {
  const { error } = await client.auth.signInWithPassword({ email, password: 'citipost' })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
}

console.log('— auth —')
await signIn(admin, 'admin@citipost.test')
await signIn(sam, 'sam@citipost.test')
await signIn(priya, 'priya@citipost.test')
check('admin + sam + priya signed in', true)

// ── B1-B5: RLS isolation ────────────────────────────────────────────────────
console.log('— RLS isolation —')

{
  const { data } = await anon.from('parcels').select('id')
  check('B1 anonymous sees no parcels', (data ?? []).length === 0)
}

const { data: allParcels } = await admin.from('parcels').select('*')
const { data: routes } = await admin.from('routes').select('*')
const samRoutes = new Set(routes.filter((r) => r.driver_id === 'drv_demo').map((r) => r.id))
const priyaRoutes = new Set(routes.filter((r) => r.driver_id === 'drv_priya').map((r) => r.id))

{
  const { data } = await sam.from('parcels').select('*')
  const leaked = (data ?? []).filter((p) => !samRoutes.has(p.route_id))
  check('B2 sam sees only his route parcels', (data ?? []).length > 0 && leaked.length === 0,
    `${(data ?? []).length} rows, ${leaked.length} leaked`)
}

{
  const { error } = await sam.from('parcels').insert({
    tracking_number: `HACK-${Date.now()}`,
    recipient_name: 'x',
    address_line: 'x',
  })
  check('B3 sam cannot insert parcels', !!error)
}

const priyaParcel = allParcels.find((p) => priyaRoutes.has(p.route_id))
{
  await sam.from('parcels').update({ recipient_name: 'TAMPERED' }).eq('id', priyaParcel.id)
  const { data: after } = await admin.from('parcels').select('recipient_name').eq('id', priyaParcel.id).single()
  check("B4 sam cannot update another route's parcel", after.recipient_name !== 'TAMPERED')
}

{
  const { data } = await sam.from('manifests').select('id')
  const { error: insErr } = await sam.from('manifests').insert({ name: 'hack' })
  check('B5 manifests are admin-only for sam', (data ?? []).length === 0 && !!insErr)
}

// ── B6-B8: lifecycle invariants ─────────────────────────────────────────────
console.log('— lifecycle —')

const samParcel = allParcels.find((p) => samRoutes.has(p.route_id))
const POINT = 'POINT(0.16505 51.48132)'

async function insertEvent(client, parcelId, stage, driverId) {
  return client.from('parcel_events').upsert(
    {
      id: randomUUID(),
      parcel_id: parcelId,
      tracking_scanned: 'TEST',
      stage,
      captured_at: new Date().toISOString(),
      location: POINT,
      gps_accuracy_m: 9,
      gps_source: 'device',
      driver_id: driverId,
    },
    { onConflict: 'id' },
  )
}
// Mirror of events.ts advanceParcelStatus (forward-only rank guard)
const RANK = { awaiting_collection: 0, collected: 1, at_warehouse: 2, delivered: 3, returned: 3 }
async function advance(client, parcelId, to) {
  const { data } = await client.from('parcels').select('status').eq('id', parcelId).single()
  if (!data || RANK[to] <= RANK[data.status]) return
  await client.from('parcels').update({ status: to }).eq('id', parcelId)
}

{
  const { error } = await insertEvent(sam, samParcel.id, 'warehouse', 'drv_demo')
  await advance(sam, samParcel.id, 'at_warehouse')
  const { data } = await admin.from('parcels').select('status').eq('id', samParcel.id).single()
  check('B6a warehouse scan advances status to at_warehouse', !error && data.status === 'at_warehouse')
}
{
  await insertEvent(sam, samParcel.id, 'collection', 'drv_demo')
  await advance(sam, samParcel.id, 'collected')
  const { data } = await admin.from('parcels').select('status').eq('id', samParcel.id).single()
  check('B6b late collection scan cannot regress status', data.status === 'at_warehouse')
}
{
  const { error } = await insertEvent(sam, samParcel.id, 'collection', 'drv_priya')
  check("B7 sam cannot stamp another driver's id on events", !!error)
}
{
  const { data: samEvents } = await sam.from('parcel_events').select('id')
  const { data: priyaEvents } = await priya.from('parcel_events').select('id')
  check("B8 priya cannot read sam's events", (samEvents ?? []).length > 0 && (priyaEvents ?? []).length === 0)
}

// ── B9-B12: POD sync idempotency + attempts model ──────────────────────────
console.log('— POD sync + attempts —')

// Mirrors uploadPod's server writes (record upsert → photos upsert →
// derived-count attempts), so the data-model properties are tested with the
// exact same statements the app issues.
async function uploadFailedPod(client, podId, parcelId, reason) {
  const { data: rec, error } = await client
    .from('pod_records')
    .upsert(
      {
        id: podId,
        parcel_id: parcelId,
        tracking_scanned: 'TEST',
        status: 'failed',
        failure_reason: reason,
        captured_at: new Date().toISOString(),
        location: POINT,
        gps_accuracy_m: 9,
        gps_simulated: false,
        gps_source: 'device',
        driver_id: 'drv_demo',
      },
      { onConflict: 'id' },
    )
    .select('synced_at')
    .single()
  if (error) throw new Error(error.message)
  const { count } = await client
    .from('pod_records')
    .select('id', { count: 'exact', head: true })
    .eq('parcel_id', parcelId)
    .eq('status', 'failed')
  const attempts = count ?? 1
  const terminal = attempts >= 3
  await client
    .from('parcels')
    .update({
      attempts,
      last_failure: reason,
      ...(terminal
        ? { status: 'returned', completed_at: new Date().toISOString() }
        : { completed_at: null }),
    })
    .eq('id', parcelId)
  return rec.synced_at
}

const failTarget = allParcels.find((p) => samRoutes.has(p.route_id) && p.id !== samParcel.id) ?? samParcel
const pod1 = randomUUID()

{
  const t1 = await uploadFailedPod(sam, pod1, failTarget.id, 'No access')
  await new Promise((r) => setTimeout(r, 1100))
  const t2 = await uploadFailedPod(sam, pod1, failTarget.id, 'No access') // RETRY of same pod
  const { data: p } = await admin.from('parcels').select('attempts,status').eq('id', failTarget.id).single()
  check('B9 synced_at unchanged on retry (trust boundary)', t1 === t2, `${t1} vs ${t2}`)
  check('B10 retry of the same failed pod does not double-count attempts', p.attempts === 1, `attempts=${p.attempts}`)
}
{
  await uploadFailedPod(sam, randomUUID(), failTarget.id, 'Refused')
  const { data: p2 } = await admin.from('parcels').select('attempts,status').eq('id', failTarget.id).single()
  check('B11a second distinct attempt counts', p2.attempts === 2 && p2.status !== 'returned', `attempts=${p2.attempts}`)
  await uploadFailedPod(sam, randomUUID(), failTarget.id, 'Address not found')
  const { data: p3 } = await admin.from('parcels').select('attempts,status,completed_at').eq('id', failTarget.id).single()
  check('B11b third attempt goes terminal: returned + completed_at', p3.attempts === 3 && p3.status === 'returned' && p3.completed_at != null)
}
{
  const { error } = await sam.from('pod_records').insert({
    id: randomUUID(),
    parcel_id: failTarget.id,
    tracking_scanned: 'TEST',
    status: 'failed',
    failure_reason: null, // must be rejected by the DB check
    captured_at: new Date().toISOString(),
    driver_id: 'drv_demo',
  })
  check('B12 failed POD without a reason is rejected by the DB', !!error)
}

// ── B13-B15: photos + storage ───────────────────────────────────────────────
console.log('— photos + storage —')

{
  const photoRow = {
    pod_id: pod1,
    photo_type: 'label',
    storage_path: `${pod1}/label.jpg`,
    orig_kb: 100,
    compressed_kb: 50,
  }
  await sam.from('pod_photos').upsert([photoRow], { onConflict: 'pod_id,photo_type', ignoreDuplicates: true })
  await sam.from('pod_photos').upsert([photoRow], { onConflict: 'pod_id,photo_type', ignoreDuplicates: true })
  const { data } = await admin.from('pod_photos').select('id').eq('pod_id', pod1)
  check('B13 (pod_id, photo_type) stays unique across retries', (data ?? []).length === 1)
}
{
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3])], { type: 'image/jpeg' })
  const { error: upErr } = await sam.storage.from('pod-evidence').upload(`${pod1}/label.jpg`, blob, { upsert: true })
  const { error: anonErr } = await anon.storage.from('pod-evidence').upload(`anon-${Date.now()}.jpg`, blob)
  check('B14 driver can upload evidence; anonymous cannot', !upErr && !!anonErr, upErr?.message ?? '')
  const { data: signed } = await admin.storage.from('pod-evidence').createSignedUrls([`${pod1}/label.jpg`], 60)
  const url = signed?.[0]?.signedUrl
  const res = url ? await fetch(url) : { ok: false }
  check('B15 admin signed URL serves the object', !!url && res.ok)
}

// ── B16: delivered pipeline writes the lifecycle event ──────────────────────
console.log('— delivered event —')
{
  const podId = randomUUID()
  const target = samParcel
  await sam.from('pod_records').upsert(
    {
      id: podId, parcel_id: target.id, tracking_scanned: 'TEST', status: 'delivered',
      captured_at: new Date().toISOString(), location: POINT, gps_accuracy_m: 9,
      gps_simulated: false, gps_source: 'device', driver_id: 'drv_demo',
    },
    { onConflict: 'id' },
  )
  await sam.from('parcel_events').upsert(
    {
      id: podId, parcel_id: target.id, tracking_scanned: 'TEST', stage: 'delivered',
      captured_at: new Date().toISOString(), location: POINT, gps_accuracy_m: 9,
      gps_source: 'device', driver_id: 'drv_demo',
    },
    { onConflict: 'id' },
  )
  await sam.from('parcels').update({ status: 'delivered', completed_at: new Date().toISOString() }).eq('id', target.id)
  const { data: ev } = await admin.from('parcel_events').select('stage').eq('parcel_id', target.id).order('created_at')
  const stages = (ev ?? []).map((e) => e.stage)
  const { data: p } = await admin.from('parcels').select('status').eq('id', target.id).single()
  check('B16 timeline holds warehouse+collection+delivered; parcel delivered',
    stages.includes('warehouse') && stages.includes('collection') && stages.includes('delivered') && p.status === 'delivered',
    stages.join(','))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
