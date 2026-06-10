import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { signOut, useSession } from './hooks/useSession.ts'
import { supabaseConfigured } from './lib/supabase.ts'
import { startSyncTriggers } from './lib/syncWorker.ts'
import { AllocateScreen } from './screens/AllocateScreen.tsx'
import { DispatcherScreen } from './screens/DispatcherScreen.tsx'
import { JobsScreen } from './screens/JobsScreen.tsx'
import { LoginScreen } from './screens/LoginScreen.tsx'
import PodCaptureScreen from './components/PodCaptureScreen.tsx'

// Service worker with an explicit update prompt — when a new build is
// waiting, Root shows a toast instead of serving the stale version once.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new Event('sw-update-available'))
  },
})

// §8 sync triggers: app load, `online` events, short interval.
if (supabaseConfigured) startSyncTriggers()

/** Auth-gated router. Not signed in → login. Driver → their run (dispatcher
 *  hashes are blocked). Admin → dispatcher portal by hash (#/allocate default,
 *  #/jobs, #/dispatch). */
function Root() {
  const [hash, setHash] = useState(window.location.hash)
  const [updateReady, setUpdateReady] = useState(false)
  const { loading, session, profile, profileError } = useSession()
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    const onUpdate = () => setUpdateReady(true)
    window.addEventListener('hashchange', onHash)
    window.addEventListener('sw-update-available', onUpdate)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('sw-update-available', onUpdate)
    }
  }, [])

  const isAdmin = profile?.role === 'admin'
  // A driver who deep-links to a dispatcher route gets bounced to their run.
  useEffect(() => {
    if (profile && !isAdmin && ['#/dispatch', '#/allocate', '#/jobs'].includes(hash)) {
      window.location.hash = ''
    }
  }, [profile, isAdmin, hash])

  // Standalone single-file component demo — no backend needed
  if (hash === '#/pod-demo') return <PodCaptureScreen />
  if (!supabaseConfigured) return <SetupNotice />
  if (loading) return <Splash />
  if (!session) return <LoginScreen />
  if (!profile) return <NoProfileNotice message={profileError} />

  let screen
  if (isAdmin) {
    screen =
      hash === '#/dispatch' ? <DispatcherScreen /> : hash === '#/jobs' ? <JobsScreen /> : <AllocateScreen />
  } else {
    screen = <App profile={profile} />
  }

  return (
    <>
      {screen}
      {updateReady && (
        <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-navy-600 py-2 pl-4 pr-2 text-[13px] text-white shadow-2xl">
          A new version is available
          <button
            type="button"
            onClick={() => void updateSW(true)}
            className="rounded-full bg-gold px-3.5 py-1.5 font-serif text-[13px] text-navy"
          >
            Refresh
          </button>
        </div>
      )}
    </>
  )
}

/** Brief brand splash while the session/profile resolves. */
function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-navy text-white">
      <div className="flex items-baseline gap-1.5 opacity-90">
        <span className="font-serif text-[20px]">Citipost</span>
        <span className="text-[11px] font-bold uppercase tracking-[2.5px] text-gold-soft">ePOD</span>
      </div>
    </div>
  )
}

/** Signed in, but no profile row maps the account to a role/driver. */
function NoProfileNotice({ message }: { message: string | null }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-navy px-6 text-center">
      <div className="w-full max-w-sm rounded-2xl bg-paper p-6">
        <h1 className="font-serif text-lg text-ink">Account not set up</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          {message ?? 'No profile is linked to this account yet.'}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-4 w-full rounded-[11px] bg-navy p-3 font-serif text-white transition hover:bg-navy-600"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/** Shown instead of a blank page when the build had no Supabase env vars. */
function SetupNotice() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl bg-paper p-6 shadow-phone">
        <h1 className="font-serif text-lg text-ink">Supabase isn't configured</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          This build was produced without the two required environment
          variables, so the app has no backend to talk to:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-[11px] bg-navy p-3 font-mono text-[11.5px] leading-relaxed text-gold-soft">
          VITE_SUPABASE_URL{'\n'}VITE_SUPABASE_ANON_KEY
        </pre>
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
          <span className="font-semibold text-ink">Locally:</span> copy{' '}
          <code className="font-mono text-[12px]">.env.example</code> to{' '}
          <code className="font-mono text-[12px]">.env</code> with the values from{' '}
          <code className="font-mono text-[12px]">npx supabase start</code>.{' '}
          <span className="font-semibold text-ink">On a host (e.g. Vercel):</span>{' '}
          set both variables in the project's environment settings — pointing at a{' '}
          <em>hosted</em> Supabase project, not 127.0.0.1 — then redeploy
          (Vite inlines them at build time).
        </p>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
