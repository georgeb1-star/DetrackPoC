// Small presentational primitives shared by the admin panels. Same tokens and
// shapes as SitesScreen (INPUT/Field), kept here so the three panels don't each
// redefine them.

export const INPUT =
  'w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink ' +
  'focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10'

export const BTN_PRIMARY =
  'rounded-[11px] bg-navy px-4 py-[11px] font-serif text-[15px] text-white transition ' +
  'hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40'

export const BTN_GHOST =
  'rounded-[10px] border border-line px-2.5 py-2 text-[12px] font-semibold text-muted transition ' +
  'hover:border-navy-500/40 hover:text-navy-500'

export const BTN_DANGER =
  'rounded-[10px] border border-line px-2.5 py-2 text-[12px] font-semibold text-muted transition ' +
  'hover:border-fail/40 hover:text-fail'

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11.5px] leading-snug text-muted">{hint}</p>}
    </div>
  )
}

/** A bordered white card with a paper section-label header — the panels'
 *  add-form and list containers. */
export function Card({
  title,
  sticky,
  children,
}: {
  title: string
  sticky?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      className={`overflow-hidden rounded-2xl border border-line bg-white ${
        sticky ? 'xl:sticky xl:top-[82px]' : ''
      }`}
    >
      <div className="border-b border-line bg-paper/60 px-4 py-2.5">
        <p className="section-label">{title}</p>
      </div>
      {children}
    </section>
  )
}

export function Banner({ kind, children }: { kind: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    kind === 'error'
      ? 'border-fail/40 bg-fail/10 text-fail'
      : 'border-ok/40 bg-ok/10 text-[#0b7a4d]'
  return (
    <div className={`mb-4 rounded-[11px] border px-3 py-2.5 text-[13px] ${cls}`}>{children}</div>
  )
}

/** A small uppercase pill. `tone` maps to the Freight Modern token set. */
export function Pill({
  tone,
  children,
}: {
  tone: 'gold' | 'navy' | 'ok' | 'fail' | 'muted'
  children: React.ReactNode
}) {
  const tones: Record<string, string> = {
    gold: 'border-gold/40 bg-gold/10 text-[#8a5a00]',
    navy: 'border-navy-500/30 bg-navy-500/5 text-navy-500',
    ok: 'border-ok/40 bg-ok/10 text-[#0b7a4d]',
    fail: 'border-fail/40 bg-fail/10 text-fail',
    muted: 'border-line bg-paper text-muted',
  }
  return (
    <span
      className={`flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] ${tones[tone]}`}
    >
      {children}
    </span>
  )
}
