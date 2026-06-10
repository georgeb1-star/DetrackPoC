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
    <div className="flex min-h-dvh flex-col items-center justify-center bg-navy bg-[radial-gradient(120%_120%_at_50%_-20%,#1f3a66_0%,#0e1c38_55%)] px-5 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 flex items-baseline justify-center gap-1.5 leading-none">
          <span className="font-serif text-[22px] tracking-[0.3px] text-white">Citipost</span>
          <span className="text-xs font-bold uppercase tracking-[2.5px] text-gold-soft">ePOD</span>
        </div>

        <form
          onSubmit={onSubmit}
          className="gold-underline relative overflow-hidden rounded-2xl border border-line bg-paper p-6 shadow-[0_30px_70px_-30px_rgba(0,0,0,.7)]"
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
            className="mt-5 w-full rounded-[13px] bg-navy p-[14px] font-serif text-base tracking-[0.3px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Demo credentials — PoC convenience, not for production */}
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-[12px] leading-relaxed text-[#9fb0d6]">
          <span className="font-semibold text-gold-soft">Demo logins</span> · password{' '}
          <span className="font-mono text-white/80">citipost</span>
          <div className="mt-1 font-mono text-[11.5px]">
            admin@citipost.test · sam@citipost.test
          </div>
        </div>
      </div>
    </div>
  )
}

const INPUT =
  'mt-1.5 w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink ' +
  'focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10'
