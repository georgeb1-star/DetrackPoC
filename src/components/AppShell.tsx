import type { ReactNode } from 'react'
import { SyncBadge } from './SyncBadge'

/** Responsive driver shell — a real product UI, not a device mockup.
 *  Laptop: a persistent navy sidebar (brand · signed-in driver · sync · sign
 *  out) beside a content area that fills the page.
 *  Mobile/tablet: the sidebar collapses to a slim navy top bar. */
export function AppShell({
  children,
  fullName,
  onSignOut,
}: {
  children: ReactNode
  fullName: string | null
  onSignOut: () => void
}) {
  const name = fullName?.trim() || 'Driver'
  const initial = name.charAt(0).toUpperCase()

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_1fr]">
      {/* Desktop sidebar — persistent chrome on every screen */}
      <aside className="sticky top-0 hidden h-dvh flex-col bg-navy bg-[radial-gradient(140%_60%_at_50%_-10%,#1d2d56_0%,#0e1218_60%)] px-5 py-6 text-white lg:flex">
        <Brand large />

        <div className="mt-8">
          <SidebarLabel>Signed in</SidebarLabel>
          <div className="mt-2 flex items-center gap-2.5">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-navy-500 font-serif text-sm">
              {initial}
            </span>
            <div className="leading-tight">
              <div className="text-[13.5px] font-semibold">{name}</div>
              <div className="text-[11px] uppercase tracking-[1px] text-[#8e99ac]">Driver</div>
            </div>
          </div>
        </div>

        <div className="mt-8">
          <SidebarLabel>Sync status</SidebarLabel>
          <div className="mt-2">
            <SyncBadge />
          </div>
        </div>

        <button
          type="button"
          onClick={onSignOut}
          className="mt-auto flex items-center justify-between rounded-xl border border-white/[0.12] px-3.5 py-3 text-[13px] font-semibold text-[#cdd7ee] transition hover:bg-white/5"
        >
          Log out
          <SignOutGlyph />
        </button>
      </aside>

      {/* Mobile/tablet top bar */}
      <header className="gold-underline sticky top-0 z-30 bg-navy text-white lg:hidden">
        <div className="flex items-center justify-between gap-3 px-[18px] pb-2 pt-[max(10px,env(safe-area-inset-top))]">
          <Brand />
          <SyncBadge />
        </div>
        <div className="flex items-center justify-between gap-3 px-[18px] pb-2.5 text-[12px]">
          <span className="truncate text-[#8e99ac]">
            <span className="text-white/90">{name}</span> · Driver
          </span>
          <button
            type="button"
            onClick={onSignOut}
            className="flex-none rounded-lg border border-white/25 px-2.5 py-1 text-[12px] font-semibold text-white transition hover:bg-white/10"
          >
            Log out
          </button>
        </div>
      </header>

      {/* Content area — fills the page beside the sidebar */}
      <main className="min-w-0">{children}</main>
    </div>
  )
}

function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5 leading-none">
      <span className={`font-serif tracking-[0.3px] text-white ${large ? 'text-[17px]' : 'text-[15px]'}`}>
        Citipost
      </span>
      <span className="text-[10.5px] font-bold uppercase tracking-[2.5px] text-gold-soft">ePOD</span>
    </div>
  )
}

function SidebarLabel({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-[1.4px] text-[#8295bd]">{children}</p>
}

function SignOutGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 17l5-5-5-5M20 12H9M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
    </svg>
  )
}
