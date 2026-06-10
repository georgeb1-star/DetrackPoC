// Seed demo auth users + profiles. Run AFTER `supabase db reset` (which wipes
// auth users and re-seeds drivers/routes). Idempotent — re-running only fills
// gaps. auth.users can't be seeded reliably from plain SQL, so we use the
// admin API with the service-role key.
//
//   Local:  node scripts/seed-auth.mjs           (key auto-read from `supabase status`)
//   Hosted: SUPABASE_URL=https://<ref>.supabase.co \
//           SUPABASE_SERVICE_ROLE_KEY=<service key> node scripts/seed-auth.mjs
//
// The service-role key is NEVER hardcoded (it must not live in git). Locally it
// comes from the running stack; for a host, pass it via the env vars above.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

/** Pull SERVICE_ROLE_KEY from the local CLI (`supabase status -o env`). */
function keyFromCli() {
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

const URL_ = process.env.SUPABASE_URL || env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321'
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || keyFromCli()

if (!SERVICE_KEY) {
  console.error('✗ No service-role key. Set SUPABASE_SERVICE_ROLE_KEY (find it via `npx supabase status`).')
  process.exit(1)
}

const PASSWORD = 'citipost' // demo only (min length 6)

// driverId must match supabase/seed.sql drivers; admin has none.
const ACCOUNTS = [
  { email: 'admin@citipost.test', role: 'admin', driverId: null, fullName: 'Dispatch Admin' },
  { email: 'sam@citipost.test', role: 'driver', driverId: 'drv_demo', fullName: 'Sam Okafor' },
  { email: 'priya@citipost.test', role: 'driver', driverId: 'drv_priya', fullName: 'Priya Nair' },
  { email: 'dan@citipost.test', role: 'driver', driverId: 'drv_dan', fullName: 'Dan Whitlock' },
]

const supabase = createClient(URL_, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Existing users by email (so re-runs don't error on duplicates).
const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
if (listErr) {
  console.error('✗ could not list users:', listErr.message)
  console.error('  Is the stack running and the service-role key correct?')
  process.exit(1)
}
const byEmail = new Map(list.users.map((u) => [u.email, u.id]))

let failed = false
for (const acc of ACCOUNTS) {
  let userId = byEmail.get(acc.email)
  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: acc.email,
      password: PASSWORD,
      email_confirm: true,
    })
    if (error) {
      console.error(`✗ create ${acc.email} failed:`, error.message)
      failed = true
      continue
    }
    userId = data.user.id
    console.log(`✓ created ${acc.email}`)
  } else {
    console.log(`· ${acc.email} already exists`)
  }

  const { error: pErr } = await supabase
    .from('profiles')
    .upsert(
      { id: userId, role: acc.role, driver_id: acc.driverId, full_name: acc.fullName },
      { onConflict: 'id' },
    )
  if (pErr) {
    console.error(`✗ profile for ${acc.email} failed:`, pErr.message)
    failed = true
  } else {
    console.log(`  profile → ${acc.role}${acc.driverId ? ` (${acc.driverId})` : ''}`)
  }
}

console.log(failed ? '\nDone with errors.' : `\nAll set. Sign in with any address above · password: ${PASSWORD}`)
process.exit(failed ? 1 : 0)
