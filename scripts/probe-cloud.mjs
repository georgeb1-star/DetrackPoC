// One-off: probe which schema updates the HOSTED project actually has.
import { createClient } from '@supabase/supabase-js'

const [url, anonKey] = process.argv.slice(2)
const supabase = createClient(url, anonKey, { auth: { persistSession: false } })
await supabase.auth.signInWithPassword({ email: 'admin@citipost.test', password: 'citipost' })

const { error: evErr } = await supabase.from('parcel_events').select('id').limit(1)
console.log('parcel_events table:', evErr ? `MISSING (${evErr.message})` : 'OK')

const { error: rpcErr } = await supabase.rpc('advance_parcel_status', {
  p_id: '00000000-0000-0000-0000-000000000000',
  p_to: 'collected',
})
console.log('advance_parcel_status RPC:', rpcErr ? `MISSING (${rpcErr.message})` : 'OK')

const { error: rpc2Err } = await supabase.rpc('apply_failed_attempt', {
  p_id: '00000000-0000-0000-0000-000000000000',
  p_reason: 'probe',
  p_max: 3,
})
console.log('apply_failed_attempt RPC:', rpc2Err ? `MISSING (${rpc2Err.message})` : 'OK')

const { data: areas } = await supabase.from('parcels').select('area').limit(50)
const distinct = [...new Set((areas ?? []).map((a) => a.area))]
console.log('areas in use:', distinct.join(', '))
