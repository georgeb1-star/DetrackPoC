// Smoke test for the site (no-manifest) capture path under RLS. Proves:
//  - an admin can create a site on a route,
//  - the driver who owns that route sees it and can capture a POD against it
//    (site_id set, parcel_id null) — exactly what SiteCaptureScreen does,
//  - a different driver does NOT see it (RLS scoping).
// Setup/cleanup use the service-role key (bypasses RLS). Self-cleaning.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL_ = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY

/** env var → .env → local CLI (same lookup as scripts/seed-auth.mjs). */
function serviceKey() {
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

const SERVICE_KEY = serviceKey()
if (!SERVICE_KEY) {
  console.error('✗ No service-role key. Set SUPABASE_SERVICE_ROLE_KEY (find it via `npx supabase status`).')
  process.exit(1)
}
const svc = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } })
const asUser = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email, password: 'citipost' })
  if (error) throw new Error(`sign in ${email}: ${error.message}`)
  return c
}

let failed = false
const ok = (m) => console.log('✓', m)
const bad = (m) => { console.error('✗', m); failed = true }

// 1. admin/service creates a site on Sam's route (drv_demo / Greater London)
const { data: routes } = await svc.from('routes').select('id, driver_id')
const route = routes.find((r) => r.driver_id === 'drv_demo')
const { data: site, error: sErr } = await svc
  .from('sites')
  .insert({ name: 'SMOKE Depot', kind: 'depot', route_id: route.id })
  .select()
  .single()
if (sErr) bad(`create site: ${sErr.message}`)
else ok(`site created on Sam's route: ${site.id}`)

const podId = crypto.randomUUID()
if (site) {
  // 2. Sam (the route's driver) sees the site and captures against it
  const sam = await asUser('sam@citipost.test')
  const { data: samSites } = await sam.from('sites').select('id')
  ;(samSites ?? []).some((s) => s.id === site.id) ? ok('Sam sees the site') : bad('Sam cannot see the site')

  const { error: podErr } = await sam.from('pod_records').insert({
    id: podId,
    parcel_id: null,
    site_id: site.id,
    tracking_scanned: 'SITE-SMOKE-1',
    status: 'delivered',
    received_by: 'Goods-in',
    captured_at: new Date().toISOString(),
    location: 'POINT(0.177 51.484)',
    gps_source: 'device',
    driver_id: 'drv_demo',
  })
  podErr ? bad(`Sam capture against site: ${podErr.message}`) : ok('Sam captured a POD against the site (site_id, parcel_id null)')

  const { data: back } = await sam.from('pod_records').select('id, site_id, parcel_id').eq('id', podId)
  back?.length ? ok('Sam reads the capture back') : bad('Sam cannot read the capture back')

  // 3. Priya (different route) must NOT see Sam's site
  const priya = await asUser('priya@citipost.test')
  const { data: priyaSites } = await priya.from('sites').select('id')
  ;(priyaSites ?? []).some((s) => s.id === site.id) ? bad('Priya can see Sam\'s site (RLS leak!)') : ok('Priya correctly cannot see Sam\'s site (RLS scoped)')
}

// cleanup (service role bypasses RLS; pod_records has no delete policy)
await svc.from('pod_records').delete().eq('id', podId)
if (site) await svc.from('sites').delete().eq('id', site.id)
ok('cleaned up')

process.exit(failed ? 1 : 0)
