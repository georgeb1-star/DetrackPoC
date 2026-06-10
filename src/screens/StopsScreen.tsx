import { useRef, useState } from 'react'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { TopBar } from '../components/TopBar'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { isRollover, MAX_DELIVERY_ATTEMPTS, type Parcel, type PodStatus } from '../lib/types'

const STATUS_STYLES: Record<Parcel['status'], string> = {
  pending: 'text-muted',
  delivered: 'text-ok',
  failed: 'text-fail',
  returned: 'text-fail',
}

/** Driver home (§6.1): scan entry, the active run (rollovers first), then a
 *  separate Completed section. A job is "done" the moment it's captured —
 *  even while the record is still queued offline. The run renders as a
 *  responsive card grid that fills the page on a laptop and stacks on mobile. */
export function StopsScreen({
  parcels,
  error,
  routeLabel,
  onSelect,
}: {
  parcels: Parcel[] | null
  error: string | null
  /** The route(s) the signed-in driver runs — shown in the run-sheet header. */
  routeLabel?: string
  onSelect: (parcel: Parcel, scannedValue?: string) => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  // Offline, the server still says "pending" — overlay the local queue so a
  // captured stop reads as done the moment the driver completes it
  const { queuedParcels } = useSyncStatus()

  // Done = terminal on the server, or a *delivered* capture queued locally.
  // A queued FAILED capture keeps the stop active — it's an attempt, the
  // parcel will be retried (and rolls over) until MAX_DELIVERY_ATTEMPTS.
  const isDone = (p: Parcel) => p.status !== 'pending' || queuedParcels.get(p.id) === 'delivered'
  // A completed stop only stays on the run for the day it was finished, so the
  // page doesn't grow unbounded: show it if it was just captured on this device
  // (queued), or its terminal completed_at is today. Older completed stops drop
  // off the run — they're still stored server-side, just hidden here.
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const completedToday = (p: Parcel) =>
    queuedParcels.has(p.id) ||
    (p.completed_at != null && new Date(p.completed_at).getTime() >= startOfToday.getTime())
  // useParcels orders by due_date first, so rollovers naturally lead the run
  const active = parcels?.filter((p) => !isDone(p)) ?? []
  const completed = parcels?.filter((p) => isDone(p) && completedToday(p)) ?? []
  const rollovers = active.filter((p) => isRollover(p)).length

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  })

  return (
    <>
      <TopBar
        eyebrow={routeLabel ? `Citipost · ${routeLabel}` : "Citipost · Today's run"}
        title="Today's stops"
        mono={
          parcels
            ? `${active.length} to do${rollovers ? ` · ${rollovers} rollover` : ''} · ${completed.length} done · ${today}`
            : today
        }
      />

      <div className="mx-auto w-full max-w-6xl px-4 py-5 lg:px-8 lg:py-7">
        {/* The scan-to-attach path is the feature that matters most (§5) — it
            sits as the primary action beside the section heading. */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="section-label">Stops</p>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex w-full items-center justify-center gap-3 rounded-[13px] bg-navy px-6 py-[14px] font-serif text-base tracking-[0.3px] text-white transition hover:bg-navy-600 active:translate-y-px sm:w-auto"
          >
            <BarcodeGlyph />
            Scan label
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
            Couldn't load parcels: {error}. Is the local Supabase stack running?
          </div>
        )}
        {!error && !parcels && (
          <div className="py-10 text-center text-[13px] text-muted">Loading stops…</div>
        )}
        {parcels && active.length === 0 && (
          <div className="rounded-2xl border border-line bg-white py-10 text-center text-[13px] text-muted">
            All stops complete — nice work.
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {active.map((p, i) => {
            const queuedFailed = queuedParcels.get(p.id) === 'failed'
            // Attempt counter: server-confirmed attempts, +1 if one is queued
            const attempts = p.attempts + (queuedFailed ? 1 : 0)
            const note =
              attempts > 0
                ? `Attempt ${Math.min(attempts + 1, MAX_DELIVERY_ATTEMPTS)} of ${MAX_DELIVERY_ATTEMPTS}` +
                  (queuedFailed ? ' · failed attempt queued' : p.last_failure ? ` · last: ${p.last_failure}` : '')
                : undefined
            return (
              <StopRow key={p.id} parcel={p} onSelect={onSelect} note={note}>
                {isRollover(p) ? (
                  <span className="rounded-full border border-gold/50 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
                    Rollover · {dueLabel(p.due_date)}
                  </span>
                ) : (
                  <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted">
                    Stop {i + 1}
                  </span>
                )}
              </StopRow>
            )
          })}
        </div>

        {completed.length > 0 && (
          <>
            <p className="section-label mb-3 mt-8">Completed</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {completed.map((p) => {
                const queuedStatus = queuedParcels.get(p.id)
                const status: PodStatus | Parcel['status'] = queuedStatus ?? p.status
                return (
                  <StopRow
                    key={p.id}
                    parcel={p}
                    onSelect={onSelect}
                    dim
                    note={p.status === 'returned' ? `Return to sender — ${p.attempts} failed attempts` : undefined}
                  >
                    <span className="text-[11px] font-bold uppercase tracking-[0.6px]">
                      <span className={STATUS_STYLES[status as Parcel['status']] ?? 'text-muted'}>
                        {status === 'delivered' ? '✓ delivered' : status}
                      </span>
                      {queuedStatus && <span className="text-gold"> · queued</span>}
                    </span>
                  </StopRow>
                )
              })}
            </div>
          </>
        )}

        {/* Mobile-only brand + dispatch handover (the sidebar carries these on
            laptop). The white bar is the surface the full-colour logo wants. */}
        <div className="mt-8 flex items-center justify-between rounded-2xl border border-line bg-white px-[18px] py-3 lg:hidden">
          <img src="/i2i-logo.png" alt="Insight 2 Innovate · Citipost" className="h-7 w-auto" />
          <a href="#/dispatch" className="text-xs font-semibold text-muted underline">
            Dispatcher view
          </a>
        </div>
      </div>

      {sheetOpen && parcels && (
        <ScanSheet
          parcels={parcels}
          onClose={() => setSheetOpen(false)}
          onMatch={(parcel, value) => {
            setSheetOpen(false)
            onSelect(parcel, value)
          }}
        />
      )}
    </>
  )
}

/** Scan sheet (§5): the camera scanner is the primary path into a capture —
 *  a decoded barcode auto-selects the matching parcel. Type-in stays as the
 *  manual fallback, and unknown values surface clearly instead of failing
 *  silently. Rendered as a full-screen modal overlay. */
function ScanSheet({
  parcels,
  onClose,
  onMatch,
}: {
  parcels: Parcel[]
  onClose: () => void
  onMatch: (parcel: Parcel, scannedValue: string) => void
}) {
  const [value, setValue] = useState('')
  const [unknown, setUnknown] = useState<string | null>(null)
  // The scanner re-fires the same frame several times a second — throttle
  // repeated unknown values so the banner doesn't flicker
  const lastUnknownRef = useRef({ v: '', t: 0 })

  function tryMatch(raw: string, source: 'scan' | 'type') {
    const needle = raw.trim().toUpperCase()
    if (!needle) return
    const parcel = parcels.find((p) => p.tracking_number.toUpperCase() === needle)
    if (parcel) {
      navigator.vibrate?.(80) // tactile "got it" on supporting devices
      onMatch(parcel, needle)
      return
    }
    if (source === 'scan') {
      const now = Date.now()
      if (lastUnknownRef.current.v === needle && now - lastUnknownRef.current.t < 2500) return
      lastUnknownRef.current = { v: needle, t: now }
    }
    setUnknown(needle)
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-navy/60 sm:items-center sm:justify-center" onClick={onClose}>
      {/* Small backdrop sliver on mobile so the camera sits near the TOP of
          the screen (visible while aiming); a centred dialog on laptop. */}
      <div className="h-12 flex-none sm:hidden" />
      <div
        className="flex-1 overflow-y-auto rounded-t-[22px] bg-paper p-[18px] pb-[max(24px,env(safe-area-inset-bottom))] sm:max-h-[88vh] sm:w-full sm:max-w-md sm:flex-none sm:rounded-[22px] sm:p-6 sm:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="section-label mb-2">Scan the label</p>
        <BarcodeScanner onDecode={(v) => tryMatch(v, 'scan')} />

        {unknown && (
          <div className="mt-2.5 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
            <span className="font-bold">Unknown parcel.</span> No stop matches{' '}
            <span className="font-mono">{unknown}</span> — check the label or pick from the list.
          </div>
        )}

        <p className="section-label mb-2 mt-4">Or type the tracking number</p>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setUnknown(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && tryMatch(value, 'type')}
          placeholder="CP-849213-GB"
          className="w-full rounded-[11px] border border-line bg-white px-3 py-[11px] font-mono text-sm uppercase tracking-[1px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[11px] border border-line bg-white p-[11px] text-[13.5px] font-semibold text-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => tryMatch(value, 'type')}
            className="flex-1 rounded-[11px] bg-navy p-[11px] font-serif text-[15px] text-white"
          >
            Find parcel
          </button>
        </div>
      </div>
    </div>
  )
}

/** One stop as a card; the status slot comes in as children, an optional note
 *  line (attempt history etc.) renders under the address. */
function StopRow({
  parcel: p,
  onSelect,
  dim = false,
  note,
  children,
}: {
  parcel: Parcel
  onSelect: (parcel: Parcel) => void
  dim?: boolean
  note?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(p)}
      className={`flex h-full w-full flex-col rounded-2xl border border-line bg-white p-4 text-left transition hover:border-navy-500/40 hover:shadow-[0_6px_20px_-10px_rgba(16,25,46,.35)] active:translate-y-px ${dim ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-[15px] font-semibold">{p.recipient_name}</div>
        <span className="flex-none">{children}</span>
      </div>
      <div className="mt-1 text-[13px] leading-[1.45] text-muted">
        {p.address_line}
        {p.postcode ? `, ${p.postcode}` : ''}
      </div>
      {note && <div className="mt-1 text-[11.5px] font-semibold text-fail">{note}</div>}
      <div className="mt-auto flex items-center justify-between pt-3">
        <span className="font-mono text-[11px] tracking-[1px] text-navy-500">{p.tracking_number}</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-gold">{p.area}</span>
      </div>
    </button>
  )
}

function dueLabel(dueDate: string): string {
  return new Date(`${dueDate}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function BarcodeGlyph() {
  return (
    <svg viewBox="0 0 24 16" className="h-4 w-6" fill="#e3c766" aria-hidden>
      <rect x="0" y="0" width="2" height="16" />
      <rect x="4" y="0" width="1" height="16" />
      <rect x="7" y="0" width="3" height="16" />
      <rect x="12" y="0" width="1" height="16" />
      <rect x="15" y="0" width="2" height="16" />
      <rect x="19" y="0" width="1" height="16" />
      <rect x="22" y="0" width="2" height="16" />
    </svg>
  )
}
