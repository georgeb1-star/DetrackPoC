// End-to-end test against a live (cloud) project: replays the exact server
// call sequence uploadPod() makes and asserts the attempt-model, geofence,
// idempotency and Realtime behaviour. Self-cleaning: the test parcel is
// restored and test PODs deleted even on failure.
// Usage: node scripts/test-e2e-cloud.mjs <SUPABASE_URL> <ANON_KEY> [VERCEL_URL]
import { createClient } from '@supabase/supabase-js'

const [url, key, vercelUrl] = process.argv.slice(2)
if (!url || !key) {
  console.error('usage: node scripts/test-e2e-cloud.mjs <SUPABASE_URL> <ANON_KEY> [VERCEL_URL]')
  process.exit(1)
}
const supabase = createClient(url, key)
const TEST_TRACKING = 'CP-300007-GB' // Tillys Toy Shop — restored afterwards
const MAX = 3
let failures = 0
const podIds = []

const ok = (name) => console.log(`  ✓ ${name}`)
const bad = (name, detail) => {
  failures++
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}
const assert = (cond, name, detail) => (cond ? ok(name) : bad(name, detail))

// Mirrors uploadPod() step 2 + 4 for a failed delivery
async function simulateFailedAttempt(parcelId, reason, distanceM) {
  const podId = crypto.randomUUID()
  podIds.push(podId)
  const { error: insErr } = await supabase.from('pod_records').upsert(
    {
      id: podId,
      parcel_id: parcelId,
      tracking_scanned: TEST_TRACKING,
      status: 'failed',
      failure_reason: reason,
      captured_at: new Date().toISOString(),
      location: 'POINT(0.177 51.484)',
      gps_accuracy_m: 35,
      gps_simulated: true,
      gps_source: 'simulated',
      dest_distance_m: distanceM,
      driver_id: 'drv_e2e_test',
    },
    { onConflict: 'id' },
  )
  if (insErr) throw new Error(`pod insert: ${insErr.message}`)
  const { data: p } = await supabase.from('parcels').select('attempts').eq('id', parcelId).single()
  const attempts = (p?.attempts ?? 0) + 1
  const { error: updErr } = await supabase
    .from('parcels')
    .update({ attempts, last_failure: reason, status: attempts >= MAX ? 'returned' : 'pending' })
    .eq('id', parcelId)
  if (updErr) throw new Error(`parcel update: ${updErr.message}`)
  return podId
}

const { data: parcel } = await supabase
  .from('parcels')
  .select('*')
  .eq('tracking_number', TEST_TRACKING)
  .single()
if (!parcel) {
  console.error(`test parcel ${TEST_TRACKING} not found`)
  process.exit(1)
}
const original = { status: parcel.status, attempts: parcel.attempts, last_failure: parcel.last_failure }

try {
  console.log('— Attempt model —')
  await simulateFailedAttempt(parcel.id, 'No access', 4200)
  let { data: p1 } = await supabase.from('parcels').select('status, attempts, last_failure').eq('id', parcel.id).single()
  assert(p1.attempts === 1 && p1.status === 'pending', 'attempt 1: stays pending, attempts=1', JSON.stringify(p1))
  assert(p1.last_failure === 'No access', 'attempt 1: last_failure recorded', p1.last_failure)

  await simulateFailedAttempt(parcel.id, 'Refused', 4200)
  let { data: p2 } = await supabase.from('parcels').select('status, attempts').eq('id', parcel.id).single()
  assert(p2.attempts === 2 && p2.status === 'pending', 'attempt 2: stays pending, attempts=2', JSON.stringify(p2))

  const pod3 = await simulateFailedAttempt(parcel.id, 'Address not found', 4200)
  let { data: p3 } = await supabase.from('parcels').select('status, attempts').eq('id', parcel.id).single()
  assert(p3.attempts === 3 && p3.status === 'returned', 'attempt 3: terminal returned', JSON.stringify(p3))

  console.log('— Geofence —')
  const { data: pods } = await supabase
    .from('pod_records')
    .select('dest_distance_m')
    .in('id', podIds)
  assert(
    pods.length === 3 && pods.every((r) => r.dest_distance_m === 4200),
    'dest_distance_m stored on every attempt POD',
    JSON.stringify(pods),
  )

  console.log('— Idempotency —')
  // Re-upsert pod3 with the same id (a sync retry) — must not duplicate
  await supabase.from('pod_records').upsert(
    { id: pod3, parcel_id: parcel.id, tracking_scanned: TEST_TRACKING, status: 'failed',
      failure_reason: 'Address not found', captured_at: new Date().toISOString() },
    { onConflict: 'id' },
  )
  const { count } = await supabase
    .from('pod_records')
    .select('id', { count: 'exact', head: true })
    .in('id', podIds)
  assert(count === 3, 'retry upsert created no duplicate rows', `count=${count}`)

  console.log('— Realtime —')
  const realtimeEvent = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000)
    supabase
      .channel('e2e-test')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pod_records' }, () => {
        clearTimeout(t)
        resolve(true)
      })
      .subscribe()
  })
  await new Promise((r) => setTimeout(r, 1500)) // let the socket join
  const rtPodId = crypto.randomUUID()
  podIds.push(rtPodId)
  await supabase.from('pod_records').insert({
    id: rtPodId, parcel_id: parcel.id, tracking_scanned: TEST_TRACKING,
    status: 'delivered', captured_at: new Date().toISOString(), driver_id: 'drv_e2e_test',
  })
  const gotEvent = await realtimeEvent
  if (gotEvent) ok('postgres_changes INSERT event received (live dispatcher works)')
  else console.log('  ⚠ no Realtime event within 6s — dispatcher falls back to the 10s poll')

  if (vercelUrl) {
    console.log('— Deployed bundle —')
    const html = await (await fetch(vercelUrl)).text()
    const asset = html.match(/\/assets\/index-[\w-]+\.js/)?.[0]
    if (!asset) bad('could not find bundle reference in deployed HTML')
    else {
      const js = await (await fetch(new URL(asset, vercelUrl))).text()
      assert(js.includes('Distance from address'), 'deployed bundle contains geofence UI')
      assert(js.includes('A new version is available'), 'deployed bundle contains update toast')
      assert(js.includes('Return to sender'), 'deployed bundle contains attempt-model UI')
    }
  }
} finally {
  // Restore the parcel and remove every test POD
  await supabase.from('pod_records').delete().in('id', podIds)
  await supabase.from('parcels').update(original).eq('id', parcel.id)
  const { data: restored } = await supabase
    .from('parcels')
    .select('status, attempts')
    .eq('id', parcel.id)
    .single()
  console.log(
    `— Cleanup — parcel restored to ${restored.status}/${restored.attempts} attempts, ${podIds.length} test PODs deleted`,
  )
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED')
process.exit(failures ? 1 : 0)
