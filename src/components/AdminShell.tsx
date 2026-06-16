import { signOut } from '../hooks/useSession'

/** Which dispatch section is active — drives the app-bar tab highlight. */
export type AdminTab = 'allocate' | 'jobs' | 'sites' | 'pods' | 'admin'

const TABS: { key: AdminTab; label: string; short?: string; href: string }[] = [
  { key: 'allocate', label: 'Allocate', href: '#/allocate' },
  { key: 'jobs', label: 'Jobs', href: '#/jobs' },
  { key: 'sites', label: 'Sites', href: '#/sites' },
  { key: 'pods', label: 'Captured PODs', short: 'PODs', href: '#/dispatch' },
  { key: 'admin', label: 'Admin', href: '#/admin' },
]

/**
 * Shared admin-portal chrome: a full-width sticky navy app bar (brand, section
 * tabs, sign-out), a white page-header band (title, summary, page actions),
 * and a wide workspace so dispatch screens use the whole monitor instead of
 * floating in a narrow card. Pure layout — screens keep all their own logic.
 */
export function AdminShell({
  active,
  title,
  meta,
  actions,
  children,
}: {
  active: AdminTab
  title: string
  /** right-of-title summary, e.g. "2 unallocated · 8 parcels" */
  meta?: string
  /** page-level action buttons, right-aligned in the page header */
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* App bar. On phones the section tabs get their OWN full-width row
          under the brand — a single row truncated to "ALLOCAT…" left the
          other sections undiscoverable. sm+ keeps the one-row layout. */}
      <header className="sticky top-0 z-30">
        <div className="bg-navy bg-[radial-gradient(120%_200%_at_85%_-50%,#1d2d56_0%,#0e1218_55%)]">
          <div className="mx-auto w-full max-w-[1440px] px-4 pt-[env(safe-area-inset-top)] sm:px-6 lg:px-10">
            <div className="flex h-[50px] items-center gap-5 sm:h-[58px] sm:items-stretch">
              <a href="#/allocate" className="flex flex-none items-center" aria-label="Citipost Dispatch home">
                <span className="flex items-baseline gap-1.5 leading-none">
                  <span className="font-serif text-[19px] tracking-[0.3px] text-white">Citipost</span>
                  <span className="text-[10px] font-bold uppercase tracking-[2.2px] text-gold-soft">
                    Dispatch
                  </span>
                </span>
              </a>

              <nav
                aria-label="Dispatch sections"
                className="hidden min-w-0 flex-1 items-stretch gap-1 overflow-x-auto sm:flex"
              >
                {TABS.map((t) => (
                  <TabLink key={t.key} tab={t} active={active} />
                ))}
              </nav>

              <div className="ml-auto flex flex-none items-center gap-3 sm:ml-0">
                <span className="hidden rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[1px] text-[#8e99ac] md:inline">
                  Admin
                </span>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/25 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-white/10"
                >
                  Log out
                </button>
              </div>
            </div>

            {/* Phone tab row — all four sections visible at 390px */}
            <nav
              aria-label="Dispatch sections"
              className="-mx-1 flex h-11 items-stretch gap-0.5 overflow-x-auto px-1 sm:hidden"
            >
              {TABS.map((t) => (
                <TabLink key={t.key} tab={t} active={active} compact />
              ))}
            </nav>
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-gold via-gold/30 to-transparent" />
      </header>

      {/* Page header */}
      <div className="border-b border-line bg-white">
        <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6 lg:px-10">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="font-serif text-[22px] leading-tight text-ink">{title}</h1>
            {meta && <span className="font-mono text-xs tracking-[1px] text-muted">{meta}</span>}
          </div>
          {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>

      {/* Workspace */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-10">
        {children}
      </main>
    </div>
  )
}

/** One section tab; compact = the phone row (smaller type, tighter padding). */
function TabLink({
  tab,
  active,
  compact = false,
}: {
  tab: (typeof TABS)[number]
  active: AdminTab
  compact?: boolean
}) {
  const isActive = tab.key === active
  return (
    <a
      href={tab.href}
      aria-current={isActive ? 'page' : undefined}
      className={`relative flex items-center whitespace-nowrap font-serif uppercase transition ${
        compact ? 'px-2.5 text-[13px] tracking-[1px]' : 'px-3 text-[15px] tracking-[1.5px]'
      } ${isActive ? 'text-white' : 'text-[#8e99ac] hover:text-white'}`}
    >
      {compact ? (tab.short ?? tab.label) : tab.label}
      {isActive && <span className="absolute inset-x-2.5 bottom-0 h-[2.5px] rounded-full bg-gold" />}
    </a>
  )
}
