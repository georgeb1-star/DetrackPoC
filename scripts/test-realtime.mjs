// Focused Realtime check: wait for the channel to be fully SUBSCRIBED before
// inserting, then expect the INSERT event. Self-cleaning.
// Usage: node scripts/test-realtime.mjs <SUPABASE_URL> <ANON_KEY>
import { createClient } from '@supabase/supabase-js'

const [url, key] = process.argv.slice(2)
const supabase = createClient(url, key)

const subscribed = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 10000)
  const ch = supabase
    .channel('rt-check')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pod_records' }, (payload) => {
      console.log(`✓ INSERT event received for ${payload.new.id}`)
      clearTimeout(t)
      resolve('event')
    })
    .subscribe((status, err) => {
      console.log(`channel status: ${status}${err ? ` (${err.message})` : ''}`)
      if (status === 'SUBSCRIBED') resolve(ch)
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(t)
        resolve(false)
      }
    })
})

if (!subscribed) {
  console.error('✗ could not subscribe — Realtime unavailable; dispatcher poll fallback applies')
  process.exit(1)
}

const id = crypto.randomUUID()
const gotEvent = new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 8000)
  supabase
    .channel('rt-check-2')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pod_records' }, () => {
      clearTimeout(t)
      resolve(true)
    })
    .subscribe()
})
await new Promise((r) => setTimeout(r, 2000))
await supabase.from('pod_records').insert({
  id,
  tracking_scanned: 'RT-TEST',
  status: 'delivered',
  captured_at: new Date().toISOString(),
  driver_id: 'drv_rt_test',
})
const result = await gotEvent
await supabase.from('pod_records').delete().eq('id', id)
console.log(result ? '✓ Realtime delivers INSERT events — live dispatcher confirmed' : '✗ no event within 8s — check publication')
process.exit(result ? 0 : 1)
