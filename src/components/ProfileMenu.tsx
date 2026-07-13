import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { emailToUsername } from '../lib/admin'
import { PROFILE_UPDATED_EVENT } from '../hooks/useSession'
import { supabase } from '../lib/supabase'

interface ProfileData {
  email: string | null
  /** local-part of a driver's synthetic email; null for real (admin) emails */
  username: string | null
  fullName: string | null
  role: 'admin' | 'driver' | null
}

type Note = { ok: boolean; text: string } | null

/**
 * Clickable identity → a profile dialog. Self-contained: it reads the current
 * user + profile itself, so any shell can drop in a trigger with no prop
 * threading. Editable: display name (scoped `update_my_profile` RPC), email
 * (admins only → Supabase Auth), password (Supabase Auth). Role and the linked
 * driver are read-only — a user can never change their own permissions here.
 */
export function ProfileMenu({
  triggerClassName,
  children,
}: {
  triggerClassName?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)} aria-haspopup="dialog">
        {children}
      </button>
      {open && <ProfileDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function ProfileDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ProfileData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')

  const [savingDetails, setSavingDetails] = useState(false)
  const [savingPw, setSavingPw] = useState(false)
  const [detailsMsg, setDetailsMsg] = useState<Note>(null)
  const [pwMsg, setPwMsg] = useState<Note>(null)

  // Close on Escape — matches the app's other overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Read the signed-in identity: email from the auth session, name/role from
  // the profile row (RLS lets a user read only their own).
  useEffect(() => {
    let live = true
    void (async () => {
      const { data: auth } = await supabase.auth.getUser()
      const user = auth.user
      const { data: prof, error } = await supabase
        .from('profiles')
        .select('role, full_name')
        .eq('id', user?.id ?? '')
        .maybeSingle()
      if (!live) return
      if (error) {
        setLoadError(error.message)
        return
      }
      const d: ProfileData = {
        email: user?.email ?? null,
        username: emailToUsername(user?.email),
        fullName: prof?.full_name ?? null,
        role: (prof?.role as 'admin' | 'driver' | null) ?? null,
      }
      setData(d)
      setName(d.fullName ?? '')
      setEmail(d.email ?? '')
    })()
    return () => {
      live = false
    }
  }, [])

  // A driver's "email" is a synthetic username → not an editable address.
  const isDriver = data?.role === 'driver' || data?.username != null

  async function saveDetails(e: FormEvent) {
    e.preventDefault()
    setDetailsMsg(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setDetailsMsg({ ok: false, text: 'Name can’t be empty.' })
      return
    }
    setSavingDetails(true)
    try {
      if (trimmed !== (data?.fullName ?? '')) {
        const { error } = await supabase.rpc('update_my_profile', { p_full_name: trimmed })
        if (error) throw new Error(error.message)
      }
      let emailNote = ''
      const newEmail = email.trim()
      if (!isDriver && newEmail && newEmail !== (data?.email ?? '')) {
        const { error } = await supabase.auth.updateUser({ email: newEmail })
        if (error) throw new Error(error.message)
        emailNote = ' A confirmation link was sent to the new address — your email changes once you follow it.'
      }
      window.dispatchEvent(new Event(PROFILE_UPDATED_EVENT))
      setData((d) => (d ? { ...d, fullName: trimmed } : d))
      setDetailsMsg({ ok: true, text: 'Saved.' + emailNote })
    } catch (err) {
      setDetailsMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not save.' })
    } finally {
      setSavingDetails(false)
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault()
    setPwMsg(null)
    if (pw1.length < 8) {
      setPwMsg({ ok: false, text: 'Use at least 8 characters.' })
      return
    }
    if (pw1 !== pw2) {
      setPwMsg({ ok: false, text: 'Passwords don’t match.' })
      return
    }
    setSavingPw(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: pw1 })
      if (error) throw new Error(error.message)
      setPw1('')
      setPw2('')
      setPwMsg({ ok: true, text: 'Password changed.' })
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not change password.' })
    } finally {
      setSavingPw(false)
    }
  }

  const displayName = (data?.fullName || '').trim() || (isDriver ? 'Driver' : 'Account')
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-navy/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your profile"
        className="max-h-[90dvh] w-full overflow-y-auto rounded-t-[22px] bg-paper p-5 pb-[max(20px,env(safe-area-inset-bottom))] sm:max-w-md sm:rounded-[22px] sm:p-6 sm:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-navy font-serif text-lg text-white">
              {initial}
            </span>
            <div className="min-w-0">
              <div className="truncate font-serif text-[18px] leading-tight text-ink">{displayName}</div>
              <div className="text-[11px] font-bold uppercase tracking-[1px] text-muted">
                {data?.role === 'admin' ? 'Dispatcher · Admin' : data?.role === 'driver' ? 'Driver' : 'Account'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex-none rounded-lg border border-line px-2 py-1 text-[13px] font-semibold text-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>

        {loadError && (
          <p className="mt-4 rounded-[11px] border border-fail/30 bg-fail/5 px-3 py-2 text-[13px] text-fail">
            Couldn’t load your profile: {loadError}
          </p>
        )}

        {/* Details — name (both) + email (admins) / username (drivers) */}
        <form onSubmit={saveDetails} className="mt-5">
          <p className="section-label mb-2">Details</p>

          <label className="block text-[12px] font-semibold text-muted" htmlFor="pf-name">
            Display name
          </label>
          <input
            id="pf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            placeholder="Your name"
            autoComplete="name"
          />

          {isDriver ? (
            <div className="mt-3">
              <span className="block text-[12px] font-semibold text-muted">Username</span>
              <div className="mt-1 flex items-center justify-between rounded-[11px] border border-line bg-white/60 px-3 py-2">
                <span className="font-mono text-[13.5px] text-ink">{data?.username ?? '—'}</span>
                <span className="text-[11px] font-semibold text-muted">set by dispatch</span>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <label className="block text-[12px] font-semibold text-muted" htmlFor="pf-email">
                Email
              </label>
              <input
                id="pf-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </div>
          )}

          {detailsMsg && <Feedback note={detailsMsg} />}

          <button
            type="submit"
            disabled={savingDetails}
            className="mt-3 w-full rounded-[11px] bg-navy py-2.5 font-serif text-[15px] text-white transition hover:bg-navy-600 disabled:opacity-60"
          >
            {savingDetails ? 'Saving…' : 'Save changes'}
          </button>
        </form>

        {/* Password — everyone */}
        <form onSubmit={changePassword} className="mt-6 border-t border-line pt-5">
          <p className="section-label mb-2">Change password</p>
          <input
            type="password"
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
            className={inputCls}
            placeholder="New password"
            autoComplete="new-password"
          />
          <input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            className={`${inputCls} mt-2`}
            placeholder="Confirm new password"
            autoComplete="new-password"
          />
          {pwMsg && <Feedback note={pwMsg} />}
          <button
            type="submit"
            disabled={savingPw}
            className="mt-3 w-full rounded-[11px] border border-navy/25 py-2.5 font-serif text-[15px] text-navy transition hover:bg-navy/5 disabled:opacity-60"
          >
            {savingPw ? 'Updating…' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  )
}

const inputCls =
  'mt-1 w-full rounded-[11px] border border-line bg-white px-3 py-2 text-[14px] text-ink outline-none transition focus:border-navy-500'

function Feedback({ note }: { note: NonNullable<Note> }) {
  return (
    <p
      className={`mt-2 rounded-[10px] px-3 py-2 text-[12.5px] font-medium ${
        note.ok ? 'bg-ok/10 text-ok' : 'bg-fail/10 text-fail'
      }`}
    >
      {note.text}
    </p>
  )
}
