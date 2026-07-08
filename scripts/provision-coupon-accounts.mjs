// Provision pilot login accounts on the hosted project. Needs the SERVICE_ROLE
// key (the `admin` Edge Function isn't deployed on ydhy, so we call the admin
// auth API directly — exactly what that function does internally).
//
// Reads the key WITHOUT putting it in the shell/transcript if you drop it in
// scripts/.env (gitignored) as SUPABASE_SERVICE_ROLE_KEY. Order of resolution:
//   arg > env SUPABASE_SERVICE_ROLE_KEY > scripts/.env > project .env
//
//   node scripts/provision-coupon-accounts.mjs [URL] [SERVICE_ROLE_KEY]
//
// Idempotent: existing logins get their password reset + profile re-asserted.
// Drivers sign in with a username (-> synthetic email); admins with a real email
// (set PAUL_EMAIL / DAVE_EMAIL to create Paul & Dave admin accounts too).

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const DRIVER_EMAIL_DOMAIN = 'drivers.citipost.local' // must match src/lib/admin.ts
const normalizeUsername = (raw) => raw.toLowerCase().replace(/[^a-z0-9]/g, '')
const usernameToEmail = (u) => `${normalizeUsername(u)}@${DRIVER_EMAIL_DOMAIN}`
function readEnvFile(path) {
  try { return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => l.split('=', 2).map((s) => s.trim()))) }
  catch { return {} }
}
/** Readable password, no ambiguous chars (mirrors admin.ts generatePassword). */
function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const a = new Uint32Array(len); crypto.getRandomValues(a)
  return Array.from(a, (n) => chars[n % chars.length]).join('')
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const rootEnv = readEnvFile('.env')
const scriptsEnv = readEnvFile('scripts/.env')
const URL = argv[0] || process.env.SUPABASE_URL || rootEnv.VITE_SUPABASE_URL
const KEY = argv[1] || process.env.SUPABASE_SERVICE_ROLE_KEY || scriptsEnv.SUPABASE_SERVICE_ROLE_KEY

const accounts = [
  { kind: 'driver', username: 'pgarland', full_name: 'Peter Garland', driver_id: 'drv_peter_garland' },
  { kind: 'driver', username: 'dward', full_name: 'Dean Ward', driver_id: 'drv_dean_ward' },
]
if (process.env.PAUL_EMAIL) accounts.push({ kind: 'admin', email: process.env.PAUL_EMAIL, full_name: 'Paul Gibbons' })
if (process.env.DAVE_EMAIL) accounts.push({ kind: 'admin', email: process.env.DAVE_EMAIL, full_name: 'Dave Buchan' })

async function main() {
  if (!URL || !KEY) {
    console.error('Need URL + SERVICE_ROLE key. Put SUPABASE_SERVICE_ROLE_KEY in scripts/.env (gitignored) or pass as arg 2.')
    process.exitCode = 1; return
  }
  if (!/^ey|^sb_secret/.test(KEY)) console.warn('(warning: key does not look like a service_role key — account creation may fail under RLS)')
  const db = createClient(URL, KEY, { auth: { persistSession: false } })

  // existing logins by email (for idempotent create-or-reset)
  const { data: list, error: listErr } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listErr) { console.error('listUsers failed (is this the service_role key?):', listErr.message); process.exitCode = 1; return }
  const byEmail = new Map(list.users.map((u) => [u.email?.toLowerCase(), u.id]))

  const results = []
  for (const a of accounts) {
    const email = a.kind === 'driver' ? usernameToEmail(a.username) : a.email.toLowerCase()
    const password = genPassword()
    let id = byEmail.get(email)
    if (id) {
      const { error } = await db.auth.admin.updateUserById(id, { password })
      if (error) { results.push(`${email}: UPDATE FAILED ${error.message}`); continue }
    } else {
      const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true })
      if (error) { results.push(`${email}: CREATE FAILED ${error.message}`); continue }
      id = data.user.id
    }
    const { error: pErr } = await db.from('profiles').upsert(
      { id, role: a.kind, driver_id: a.kind === 'driver' ? a.driver_id : null, full_name: a.full_name },
      { onConflict: 'id' })
    results.push(pErr ? `${email}: profile FAILED ${pErr.message}`
      : `${a.full_name.padEnd(15)} ${a.kind.padEnd(6)} login: ${a.kind === 'driver' ? a.username : email}   password: ${password}`)
  }
  console.log('\n=== Pilot accounts (hand these out; change on first use) ===')
  results.forEach((r) => console.log('  ' + r))
}

await main()
