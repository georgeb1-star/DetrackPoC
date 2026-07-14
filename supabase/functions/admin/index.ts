// Admin Edge Function — the ONLY privileged path for Login/Profile management.
//
// Why this exists: creating auth.users and writing `profiles` both need the
// service-role key, which must never reach the browser (the RLS posture depends
// on the client being unable to write profiles — see docs/adr/0001). So the
// admin panel calls this function; it (1) verifies the caller's JWT and that
// their profile role is 'admin', then (2) acts with a service-role client.
//
// Drivers/routes are NOT handled here — admins write those directly via RLS.
//
// Auto-injected env (hosted + local): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const BAN_FOREVER = '876000h' // ~100 years — Supabase has no permanent-ban flag
type Role = 'admin' | 'driver'

// Username sign-in: a driver username is stored as a synthetic auth email
// `<username>@<domain>`. KEEP THIS DOMAIN + THESE HELPERS IN SYNC with their
// copies in src/lib/admin.ts (Deno can't import from src/). See docs/adr/0003.
const DRIVER_EMAIL_DOMAIN = 'drivers.citipost.local'
const normalizeUsername = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9]/g, '')
const usernameToEmail = (username: string) => `${normalizeUsername(username)}@${DRIVER_EMAIL_DOMAIN}`
const emailToUsername = (email: string | null | undefined): string | null => {
  if (!email) return null
  const suffix = `@${DRIVER_EMAIL_DOMAIN}`
  return email.toLowerCase().endsWith(suffix) ? email.slice(0, -suffix.length) : null
}

/** Turn GoTrue's "email already registered" into a username-aware message. */
const dupMessage = (message: string, username: string): string =>
  /already/i.test(message)
    ? username
      ? `Username “${username}” is already taken — choose another.`
      : 'That email is already registered.'
    : message

interface AdminUser {
  id: string
  email: string | null
  username: string | null
  full_name: string | null
  role: Role | null
  driver_id: string | null
  driver_name: string | null
  disabled: boolean
  created_at: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  // Service-role client: bypasses RLS. Never expose this outside the function.
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- Gate: the caller must be a signed-in admin -------------------------
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Not authenticated' }, 401)

  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)
  const callerId = userData.user.id

  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', callerId)
    .maybeSingle()
  if (callerProfile?.role !== 'admin') return json({ error: 'Admins only' }, 403)

  // --- Dispatch -----------------------------------------------------------
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Bad JSON body' }, 400)
  }
  const action = String(body.action ?? '')

  try {
    switch (action) {
      case 'list_users':
        return json({ data: await listUsers(admin) })
      case 'create_user':
        return await createUser(admin, body)
      case 'update_user':
        return await updateUser(admin, body, callerId)
      case 'set_active':
        return await setActive(admin, body, callerId)
      case 'delete_user':
        return await deleteUser(admin, body, callerId)
      default:
        return json({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unexpected error' }, 500)
  }
})

/** Merge auth.users with their profiles + linked roster name. */
async function listUsers(admin: SupabaseClient): Promise<AdminUser[]> {
  const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw error
  const [{ data: profiles }, { data: drivers }] = await Promise.all([
    admin.from('profiles').select('id, role, driver_id, full_name'),
    admin.from('drivers').select('id, name'),
  ])
  const profById = new Map((profiles ?? []).map((p) => [p.id, p]))
  const driverName = new Map((drivers ?? []).map((d) => [d.id, d.name]))
  const now = Date.now()
  return list.users
    // ePOD-only: auth.users is SHARED with another app on this Supabase project,
    // so a login with no ePOD profile isn't ours — never list (or manage) it.
    .filter((u) => profById.has(u.id))
    .map((u): AdminUser => {
      const p = profById.get(u.id)
      const banned = (u as { banned_until?: string }).banned_until
      return {
        id: u.id,
        email: u.email ?? null,
        username: emailToUsername(u.email),
        full_name: p?.full_name ?? null,
        role: (p?.role as Role) ?? null,
        driver_id: p?.driver_id ?? null,
        driver_name: p?.driver_id ? (driverName.get(p.driver_id) ?? null) : null,
        disabled: banned ? new Date(banned).getTime() > now : false,
        created_at: u.created_at,
      }
    })
    // Sort by the visible handle (username for drivers, email for admins).
    .sort((a, b) => (a.username ?? a.email ?? '').localeCompare(b.username ?? b.email ?? ''))
}

/** auth.users ids of admins who can actually sign in (role=admin AND not banned).
 *  Drives the "never remove the last admin" guard. */
async function activeAdminIds(admin: SupabaseClient): Promise<Set<string>> {
  const users = await listUsers(admin)
  return new Set(users.filter((u) => u.role === 'admin' && !u.disabled).map((u) => u.id))
}

/** True when the id belongs to an ePOD-managed user (has a public.profiles row).
 *  Auth is shared with another app on this project, so every mutating action
 *  refuses ids that aren't ePOD users — we must never modify/ban/delete the
 *  other app's logins (and deleting one fails on its FKs anyway). */
async function isEpodUser(admin: SupabaseClient, id: string): Promise<boolean> {
  const { data } = await admin.from('profiles').select('id').eq('id', id).maybeSingle()
  return !!data
}

async function createUser(admin: SupabaseClient, body: Record<string, unknown>) {
  // Drivers sign up with a username (→ synthetic email); admins with a real
  // email. The caller sends whichever fits the role.
  const hasUsername = !!(body.username && String(body.username).trim())
  const username = hasUsername ? normalizeUsername(String(body.username)) : ''
  const rawEmail = String(body.email ?? '').trim().toLowerCase()
  const email = hasUsername ? usernameToEmail(username) : rawEmail
  const password = String(body.password ?? '')
  const role = body.role as Role
  const fullName = body.full_name ? String(body.full_name).trim() : null
  const driverId = body.driver_id ? String(body.driver_id) : null

  if (hasUsername && !username) return json({ error: 'That username has no letters or digits' }, 400)
  if (!email || email.startsWith('@')) return json({ error: 'A username or email is required' }, 400)
  if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400)
  if (role !== 'admin' && role !== 'driver') return json({ error: 'Role must be admin or driver' }, 400)
  if (role === 'driver' && !driverId) return json({ error: 'A driver login must be linked to a roster driver' }, 400)

  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no SMTP on this project — see docs/adr/0002
  })
  if (error) return json({ error: dupMessage(error.message, username) }, 400)

  const { error: pErr } = await admin
    .from('profiles')
    .upsert({ id: created.user.id, role, driver_id: driverId, full_name: fullName }, { onConflict: 'id' })
  if (pErr) {
    // Roll back the half-created login so a retry is clean.
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: `Login created but profile failed: ${pErr.message}` }, 400)
  }
  return json({ data: { id: created.user.id } })
}

async function updateUser(admin: SupabaseClient, body: Record<string, unknown>, callerId: string) {
  const id = String(body.id ?? '')
  if (!id) return json({ error: 'User id is required' }, 400)

  const { data: current } = await admin
    .from('profiles')
    .select('role, driver_id, full_name')
    .eq('id', id)
    .maybeSingle()
  // ePOD-only (shared auth): refuse a login that isn't an ePOD user, so we
  // never adopt or edit the co-tenant app's accounts.
  if (!current) return json({ error: "That user isn't managed by ePOD" }, 404)

  // Only touch the profile when a profile field was actually supplied — a
  // password-only reset must not require a role or rewrite anything else.
  const wantsProfileChange =
    body.role !== undefined || 'driver_id' in body || body.full_name !== undefined
  if (wantsProfileChange) {
    const nextRole = (body.role as Role | undefined) ?? (current?.role as Role | undefined)
    if (nextRole !== 'admin' && nextRole !== 'driver')
      return json({ error: 'Role must be admin or driver' }, 400)

    const nextDriverId = (
      'driver_id' in body ? (body.driver_id ? String(body.driver_id) : null) : (current?.driver_id ?? null)
    ) as string | null
    const nextFullName = (
      body.full_name !== undefined ? (body.full_name ? String(body.full_name).trim() : null) : (current?.full_name ?? null)
    ) as string | null

    // Guard: a driver must always be linked to a roster driver.
    if (nextRole === 'driver' && !nextDriverId)
      return json({ error: 'A driver login must be linked to a roster driver' }, 400)

    // Guard: demoting an admin → driver can't strand the system without one.
    if (current?.role === 'admin' && nextRole === 'driver') {
      if (id === callerId) return json({ error: "You can't remove your own admin role" }, 400)
      const admins = await activeAdminIds(admin)
      if (admins.has(id) && admins.size <= 1)
        return json({ error: "Can't demote the last active admin" }, 400)
    }

    // Upsert the fully-resolved row (handles a login that has no profile yet,
    // and is idempotent for fields the caller didn't change).
    const { error } = await admin
      .from('profiles')
      .upsert(
        { id, role: nextRole, driver_id: nextRole === 'admin' ? null : nextDriverId, full_name: nextFullName },
        { onConflict: 'id' },
      )
    if (error) return json({ error: error.message }, 400)
  }

  // Username change (drivers): rewrite the synthetic auth email. email_confirm
  // keeps it confirmed without trying to send a (nonexistent) SMTP mail.
  if (body.username !== undefined) {
    const username = normalizeUsername(String(body.username ?? ''))
    if (!username) return json({ error: 'Username can’t be empty' }, 400)
    const { error } = await admin.auth.admin.updateUserById(id, {
      email: usernameToEmail(username),
      email_confirm: true,
    })
    if (error) return json({ error: dupMessage(error.message, username) }, 400)
  }

  // Password reset (separate from profile fields).
  if (body.password) {
    const password = String(body.password)
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400)
    const { error } = await admin.auth.admin.updateUserById(id, { password })
    if (error) return json({ error: error.message }, 400)
  }
  return json({ data: { id } })
}

async function setActive(admin: SupabaseClient, body: Record<string, unknown>, callerId: string) {
  const id = String(body.id ?? '')
  const active = Boolean(body.active)
  if (!id) return json({ error: 'User id is required' }, 400)
  if (!(await isEpodUser(admin, id))) return json({ error: "That user isn't managed by ePOD" }, 404)
  if (!active) {
    if (id === callerId) return json({ error: "You can't deactivate yourself" }, 400)
    const admins = await activeAdminIds(admin)
    if (admins.has(id) && admins.size <= 1)
      return json({ error: "Can't deactivate the last active admin" }, 400)
  }
  const { error } = await admin.auth.admin.updateUserById(id, {
    ban_duration: active ? 'none' : BAN_FOREVER,
  })
  if (error) return json({ error: error.message }, 400)
  return json({ data: { id, active } })
}

async function deleteUser(admin: SupabaseClient, body: Record<string, unknown>, callerId: string) {
  const id = String(body.id ?? '')
  if (!id) return json({ error: 'User id is required' }, 400)
  if (id === callerId) return json({ error: "You can't delete yourself" }, 400)
  // ePOD-only (shared auth): never delete the co-tenant app's logins — and
  // deleting one would fail anyway, since that app's tables reference it.
  if (!(await isEpodUser(admin, id))) return json({ error: "That user isn't managed by ePOD" }, 404)
  const admins = await activeAdminIds(admin)
  if (admins.has(id) && admins.size <= 1)
    return json({ error: "Can't delete the last active admin" }, 400)
  // ePOD's own profiles FK is ON DELETE CASCADE, so the profile goes with the
  // login; pod_records/parcel_events reference the roster (drivers), not it.
  const { error } = await admin.auth.admin.deleteUser(id)
  if (error) return json({ error: error.message }, 400)
  return json({ data: { id } })
}
