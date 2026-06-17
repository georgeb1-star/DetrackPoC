// enrich-shipments — admin-gated, server-side reader of Lens's GWOptical mirror.
//
// Why: Lens's public.shipments holds the delivery address per tracking number,
// but it's RLS-locked and lives in a SEPARATE Supabase project, so the browser
// can't read it. This function verifies the caller is an ePOD admin (same gate
// as functions/admin), then reads via a dedicated read-only role (LENS_DB_URL)
// from public.epod_shipment_lookup — a Lens-side view (owner-evaluated, so it
// clears the base table's RLS) exposing only the columns we need, scoped so the
// role can read nothing else. It does NO shaping — client maps via src/lib/enrich.ts.
//
// Auto-injected env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Secret to set:      LENS_DB_URL  (read-only pooler URI for the Lens project).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0'
import postgres from 'https://deno.land/x/postgresjs@v3.4.5/mod.js'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const MAX_BATCH = 1000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const lensUrl = Deno.env.get('LENS_DB_URL')
  if (!lensUrl) return json({ error: 'Address source not configured' }, 500)

  // --- Gate: caller must be a signed-in admin (same as functions/admin) ---
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Not authenticated' }, 401)
  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', userData.user.id).maybeSingle()
  if (profile?.role !== 'admin') return json({ error: 'Admins only' }, 403)

  // --- Parse + normalise the input list ---
  let body: { tracking_numbers?: unknown }
  try { body = await req.json() } catch { return json({ error: 'Bad JSON body' }, 400) }
  const raw = Array.isArray(body.tracking_numbers) ? body.tracking_numbers : []
  const seen = new Set<string>()
  const submitted: string[] = []
  for (const v of raw) {
    const tn = String(v ?? '').trim()
    if (!tn) continue
    const key = tn.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    submitted.push(tn)
  }
  if (submitted.length === 0) return json({ error: 'No tracking numbers provided' }, 400)
  if (submitted.length > MAX_BATCH) return json({ error: `Too many at once (max ${MAX_BATCH})` }, 400)

  // --- Read Lens (read-only role); return raw matched rows + the misses ---
  // epod_shipment_lookup is the ONLY object epod_reader can read: a view scoped
  // to the 9 recipient columns AND `where is_deleted = false` (no soft-deleted
  // PII). That row/column scoping is defined and version-controlled in
  // supabase/lens-epod-reader.sql — change it there, never by widening this query.
  const sql = postgres(lensUrl, { prepare: false, max: 1, idle_timeout: 5 })
  try {
    const rows = await sql`
      select tracking_number, recipient_full_name, recipient_company,
             recipient_address1, recipient_address2, recipient_address3,
             recipient_city, recipient_county, recipient_postcode
      from public.epod_shipment_lookup
      where tracking_number = any(${submitted})`
    const foundSet = new Set(rows.map((r: { tracking_number: string }) => r.tracking_number.toUpperCase()))
    const notFound = submitted.filter((t) => !foundSet.has(t.toUpperCase()))
    return json({
      data: {
        found: rows,
        notFound,
        counts: { submitted: submitted.length, found: rows.length, notFound: notFound.length },
      },
    })
  } catch (e) {
    return json({ error: `Couldn't reach the address source — try again. (${e instanceof Error ? e.message : 'error'})` }, 502)
  } finally {
    await sql.end({ timeout: 5 })
  }
})
