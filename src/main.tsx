import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { supabaseConfigured } from './lib/supabase.ts'
import { startSyncTriggers } from './lib/syncWorker.ts'
import { DispatcherScreen } from './screens/DispatcherScreen.tsx'

// Auto-update service worker — keeps the offline app shell fresh.
registerSW({ immediate: true })

// §8 sync triggers: app load, `online` events, short interval.
if (supabaseConfigured) startSyncTriggers()

/** Two top-level views, one hash route: #/dispatch = dispatcher, else driver. */
function Root() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (!supabaseConfigured) return <SetupNotice />
  return hash === '#/dispatch' ? <DispatcherScreen /> : <App />
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
