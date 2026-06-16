import { useCallback, useEffect, useState } from 'react'
import {
  adminInvoke,
  deriveUsername,
  generatePassword,
  makeDriverId,
  normalizeUsername,
  type AdminUser,
  type Role,
} from '../../lib/admin'
import { supabase } from '../../lib/supabase'
import type { Driver } from '../../lib/types'
import { Banner, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Card, Field, INPUT, Pill } from './ui'

const NEW_DRIVER = '__new__'

/** Manage Logins + Profiles (see CONTEXT.md). All writes go through the
 *  admin Edge Function (service-role, admin-gated) — the browser never holds
 *  the service key. Roster rows for inline "+ New driver" are created
 *  client-side first (admins pass the drivers RLS policy), then linked. */
export function UsersPanel({ drivers, reloadFleet }: { drivers: Driver[]; reloadFleet: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [meId, setMeId] = useState<string | null>(null)

  // Add-user form
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<Role>('driver')
  const [username, setUsername] = useState('') // drivers
  const [usernameEdited, setUsernameEdited] = useState(false)
  const [email, setEmail] = useState('') // admins
  const [password, setPassword] = useState('')
  const [driverId, setDriverId] = useState('')
  const [newDriverName, setNewDriverName] = useState('')
  const [busy, setBusy] = useState(false)

  // Suggest the username from the full name (first initial + surname) until the
  // admin types their own — then leave it alone.
  useEffect(() => {
    if (role === 'driver' && !usernameEdited) setUsername(deriveUsername(fullName))
  }, [fullName, role, usernameEdited])

  const load = useCallback(async () => {
    try {
      setUsers(await adminInvoke<AdminUser[]>('list_users'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users')
    }
  }, [])

  useEffect(() => {
    void load()
    void supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null))
  }, [load])

  async function addUser(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setOk(null)
    // Drivers identify by username; admins by email.
    const cleanUsername = normalizeUsername(username)
    if (role === 'driver' && !cleanUsername) return setError('Enter a username (first initial + surname, e.g. FCrawley)')
    if (role === 'admin' && !email.trim()) return setError('Email is required for an admin login')
    if (password.length < 8) return setError('Set a password of at least 8 characters (use Generate)')

    let linkedDriver: string | null = null
    if (role === 'driver') {
      if (driverId === NEW_DRIVER) {
        const trimmed = newDriverName.trim()
        if (!trimmed) return setError('Enter the new driver’s name')
        const id = makeDriverId(trimmed)
        const { error: dErr } = await supabase.from('drivers').insert({ id, name: trimmed })
        if (dErr) return setError(`Couldn’t create roster driver: ${dErr.message}`)
        linkedDriver = id
        reloadFleet()
      } else if (driverId) {
        linkedDriver = driverId
      } else {
        return setError('Pick a roster driver (or add a new one) for a driver login')
      }
    }

    const handle = role === 'driver' ? cleanUsername : email.trim()
    setBusy(true)
    try {
      await adminInvoke('create_user', {
        ...(role === 'driver' ? { username: cleanUsername } : { email: email.trim() }),
        password,
        role,
        driver_id: linkedDriver,
        full_name: fullName.trim() || null,
      })
      setOk(`Created ${handle} — password: ${password}  (copy it now; it isn’t stored)`)
      setFullName('')
      setRole('driver')
      setUsername('')
      setUsernameEdited(false)
      setEmail('')
      setPassword('')
      setDriverId('')
      setNewDriverName('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create user')
    }
    setBusy(false)
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
      <Card title="Add a user" sticky>
        <form onSubmit={addUser} className="grid gap-3 p-4">
          <Field label="Full name">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Sam Lee" className={INPUT} />
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={INPUT}>
              <option value="driver">Driver — sees only their own run</option>
              <option value="admin">Admin — full dispatcher access</option>
            </select>
          </Field>

          {role === 'driver' ? (
            <Field
              label="Username"
              hint="First initial + surname, e.g. FCrawley. Case-insensitive — this is what they type to sign in."
            >
              <input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value)
                  setUsernameEdited(true)
                }}
                placeholder="fcrawley"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={`${INPUT} font-mono`}
              />
            </Field>
          ) : (
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@citipost.co.uk"
                className={INPUT}
              />
            </Field>
          )}

          {role === 'driver' && (
            <Field label="Driver (roster)" hint="The fleet identity their deliveries attribute to.">
              <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={INPUT}>
                <option value="">Select a driver…</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                <option value={NEW_DRIVER}>+ New driver…</option>
              </select>
              {driverId === NEW_DRIVER && (
                <input
                  value={newDriverName}
                  onChange={(e) => setNewDriverName(e.target.value)}
                  placeholder="New driver’s name"
                  className={`${INPUT} mt-2`}
                />
              )}
            </Field>
          )}

          <Field label="Temporary password" hint="Shown once after you create the login — pass it to the user.">
            <div className="flex gap-2">
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Click Generate"
                className={`${INPUT} font-mono`}
              />
              <button
                type="button"
                onClick={() => setPassword(generatePassword())}
                className="flex-none rounded-[11px] border border-line px-3 text-[12px] font-semibold text-navy-500 transition hover:border-navy-500/40 hover:bg-navy-500/5"
              >
                Generate
              </button>
            </div>
          </Field>

          <button
            type="submit"
            disabled={busy || (role === 'driver' ? !normalizeUsername(username) : !email.trim())}
            className={`w-full ${BTN_PRIMARY}`}
          >
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </form>
      </Card>

      <section>
        {error && <Banner kind="error">{error}</Banner>}
        {ok && <Banner kind="ok">{ok}</Banner>}
        <p className="section-label mb-2">People with access · {users?.length ?? '…'}</p>
        {users && users.length === 0 && (
          <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
            No users yet.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {users?.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              drivers={drivers}
              isSelf={u.id === meId}
              reload={load}
              onError={setError}
              onOk={setOk}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function UserRow({
  user,
  drivers,
  isSelf,
  reload,
  onError,
  onOk,
}: {
  user: AdminUser
  drivers: Driver[]
  isSelf: boolean
  reload: () => Promise<void>
  onError: (m: string | null) => void
  onOk: (m: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<Role>(user.role ?? 'driver')
  const [driverId, setDriverId] = useState(user.driver_id ?? '')
  const [fullName, setFullName] = useState(user.full_name ?? '')
  const [username, setUsername] = useState(user.username ?? '')
  const [busy, setBusy] = useState(false)
  // Only synthetic (username) logins can be renamed — admins keep real emails.
  const canRenameUsername = user.username !== null && role === 'driver'
  // What to call this login in messages: username for drivers, email for admins.
  const handle = user.username ?? user.email ?? 'this login'

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    onError(null)
    onOk(null)
    try {
      await fn()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Action failed')
    }
    setBusy(false)
  }

  const saveProfile = () =>
    run(async () => {
      if (role === 'driver' && !driverId) throw new Error('Pick a roster driver for a driver login')
      const cleanUsername = normalizeUsername(username)
      if (canRenameUsername && !cleanUsername) throw new Error('Username can’t be empty')
      const renaming = canRenameUsername && cleanUsername !== user.username
      await adminInvoke('update_user', {
        id: user.id,
        role,
        driver_id: role === 'driver' ? driverId : null,
        full_name: fullName.trim() || null,
        ...(renaming ? { username: cleanUsername } : {}),
      })
      onOk(`Updated ${renaming ? cleanUsername : (user.username ?? user.email)}`)
      setOpen(false)
      await reload()
    })

  const resetPassword = () =>
    run(async () => {
      const pw = generatePassword()
      await adminInvoke('update_user', { id: user.id, password: pw })
      onOk(`New password for ${handle}: ${pw}  (copy it now)`)
    })

  const toggleActive = () =>
    run(async () => {
      await adminInvoke('set_active', { id: user.id, active: user.disabled })
      await reload()
    })

  const remove = () =>
    run(async () => {
      if (!confirm(`Delete ${handle}? Their login is removed; delivery history is kept.`)) return
      await adminInvoke('delete_user', { id: user.id })
      onOk(`Deleted ${handle}`)
      await reload()
    })

  return (
    <article
      className={`rounded-2xl border bg-white px-4 py-3 ${
        user.disabled ? 'border-line opacity-70' : 'border-line'
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-serif text-[15px] text-ink">
              {user.username ?? user.email ?? '(no login)'}
            </span>
            {user.role === 'admin' ? (
              <Pill tone="gold">Admin</Pill>
            ) : user.role === 'driver' ? (
              <Pill tone="navy">Driver</Pill>
            ) : (
              <Pill tone="muted">No profile</Pill>
            )}
            {user.disabled && <Pill tone="fail">Disabled</Pill>}
            {isSelf && <Pill tone="muted">You</Pill>}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-muted">
            {user.full_name || 'No name'}
            {user.role === 'driver' && ` · ${user.driver_name ?? 'unlinked'}`}
          </div>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <button type="button" onClick={() => setOpen((v) => !v)} disabled={busy} className={BTN_GHOST}>
            {open ? 'Close' : 'Manage'}
          </button>
          <button
            type="button"
            onClick={toggleActive}
            disabled={busy || isSelf}
            title={isSelf ? "You can't deactivate yourself" : undefined}
            className={BTN_GHOST}
          >
            {user.disabled ? 'Reactivate' : 'Deactivate'}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy || isSelf}
            title={isSelf ? "You can't delete yourself" : undefined}
            className={BTN_DANGER}
          >
            Delete
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={INPUT}>
              <option value="driver">Driver</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          {role === 'driver' && (
            <Field label="Driver (roster)">
              <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={INPUT}>
                <option value="">Select…</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {canRenameUsername && (
            <Field label="Username" hint="Changing this changes how they sign in.">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={`${INPUT} font-mono`}
              />
            </Field>
          )}
          <Field label="Full name">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={INPUT} />
          </Field>
          <div className="flex items-end gap-2 sm:col-span-2">
            <button type="button" onClick={saveProfile} disabled={busy} className={BTN_PRIMARY}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" onClick={resetPassword} disabled={busy} className={BTN_GHOST}>
              Reset password
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
