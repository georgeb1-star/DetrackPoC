import { signOut } from '../hooks/useSession'

/** Which dispatch section is active — drives the app-bar tab highlight. */
export type AdminTab = 'allocate' | 'jobs' | 'sites' | 'pods'

const TABS: { key: AdminTab; label: string; href: string }[] = [
  { key: 'allocate', label: 'Allocate', href: '#/allocate' },
  { key: 'jobs', label: 'Jobs', href: '#/jobs' },
  { key: 'sites', label: 'Sites', href: '#/sites' },
  { key: 'pods', label: 'Captured PODs', href: '#/dispatch' },
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
      {/* App bar */}
      <header className="sticky top-0 z-30">
        <div className="bg-navy bg-[radial-gradient(120%_200%_at_85%_-50%,#1f3a66_0%,#0e1c38_55%)]">
          <div className="mx-auto flex h-[58px] w-full max-w-[1440px] items-stretch gap-5 px-4 pt-[env(safe-area-inset-top)] sm:px-6 lg:px-10">
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
              className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto"
            >
              {TABS.map((t) => {
                const isActive = t.key === active
                return (
                  <a
                    key={t.key}
                    href={t.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={`relative flex items-center whitespace-nowrap px-3 text-[13px] font-semibold transition ${
                      isActive ? 'text-white' : 'text-[#9fb0d6] hover:text-white'
                    }`}
                  >
                    {t.label}
                    {isActive && (
                      <span className="absolute inset-x-2.5 bottom-0 h-[2.5px] rounded-full bg-gold" />
                    )}
                  </a>
                )
              })}
            </nav>

            <div className="flex flex-none items-center gap-3">
              <span className="hidden rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[1px] text-[#9fb0d6] md:inline">
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
