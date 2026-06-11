import { useState, type FormEvent } from 'react'
import { signIn } from '../hooks/useSession'

/** Sign-in portal. On success the auth listener in main.tsx swaps the app to
 *  the right surface (driver run vs dispatcher), so this screen just needs to
 *  authenticate. Branded navy backdrop + paper card. */
export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { error } = await signIn(email.trim(), password)
    if (error) {
      setError(error.message === 'Invalid login credentials' ? 'Email or password not recognised.' : error.message)
      setSubmitting(false)
    }
    // success: onAuthStateChange takes it from here
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-navy bg-[radial-gradient(120%_120%_at_50%_-20%,#1d2d56_0%,#0e1218_58%)] px-5 py-10">
      {/* Blueprint dot-grid over the bloom — quiet depth, not decoration */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.22]"
        style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      />

      <div className="relative w-full max-w-[380px]">
        {/* Wordmark — road-signage condensed caps over the product's own motif */}
        <div className="mb-6 text-center">
          <div className="font-serif text-[40px] font-bold uppercase leading-none tracking-[2px] text-white">
            Citipost
          </div>
          <div className="mx-auto mt-3 flex items-center justify-center gap-3">
            <span className="barcode-strip h-4 w-14 text-gold" />
            <span className="text-[10.5px] font-bold uppercase tracking-[3px] text-gold-soft">
              Electronic proof of delivery
            </span>
            <span className="barcode-strip h-4 w-14 text-gold" />
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="gold-underline relative overflow-hidden rounded-2xl border border-line bg-white p-6 shadow-[0_30px_70px_-30px_rgba(0,0,0,.8)]"
        >
          <p className="text-[10.5px] font-semibold uppercase tracking-[2px] text-gold">Proof of delivery</p>
          <h1 className="mt-1 font-serif text-xl text-ink">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted">Drivers see their run; dispatch manages jobs.</p>

          <label className="mt-5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">Email</label>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@citipost.test"
            className={INPUT}
            required
          />

          <label className="mt-3.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">Password</label>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={INPUT}
            required
          />

          {error && (
            <div className="mt-3.5 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !email || !password}
            className="mt-5 w-full rounded-[13px] bg-navy-500 p-[14px] font-serif text-[17px] uppercase tracking-[2px] text-white transition hover:bg-[#1f46e0] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Demo credentials — one tap fills the form (PoC convenience) */}
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-[12px] text-[#8e99ac] backdrop-blur-sm">
          <span className="font-semibold text-gold-soft">Demo logins</span> — tap to fill · password{' '}
          <span className="font-mono text-white/80">citipost</span>
          <div className="mt-2 flex gap-2">
            {[
              { label: 'Admin', email: 'admin@citipost.test' },
              { label: 'Driver', email: 'sam@citipost.test' },
            ].map((d) => (
              <button
                key={d.email}
                type="button"
                onClick={() => {
                  setEmail(d.email)
                  setPassword('citipost')
                  setError(null)
                }}
                className="flex-1 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-left transition hover:bg-white/10"
              >
                <div className="text-[11px] font-bold uppercase tracking-[1px] text-gold-soft">{d.label}</div>
                <div className="truncate font-mono text-[11px] text-white/80">{d.email}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const INPUT =
  'mt-1.5 w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink ' +
  'focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10'
