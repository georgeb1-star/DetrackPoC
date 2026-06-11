import { useRef, useState } from 'react'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { TopBar } from '../components/TopBar'
import { NO_FIX_NOTES, useGeolocation } from '../hooks/useGeolocation'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { queueEvent } from '../lib/events'
import { syncNow } from '../lib/syncWorker'
import {
  expectedStage,
  isRollover,
  isTerminal,
  MAX_DELIVERY_ATTEMPTS,
  STAGE_LABEL,
  STAGE_STATUS,
  STATUS_LABEL,
  STATUS_RANK,
  type Fix,
  type Parcel,
  type ParcelStatus,
  type PodStatus,
  type Site,
  type Stage,
} from '../lib/types'

/** Status text colour in the Completed section (string-keyed: a queued
 *  capture can overlay 'failed', which isn't a parcel status). */
const STATUS_STYLES: Record<string, string> = {
  awaiting_collection: 'text-muted',
  collected: 'text-gold',
  at_warehouse: 'text-navy-500',
  delivered: 'text-ok',
  failed: 'text-fail',
  returned: 'text-fail',
}

/** Lifecycle pill styling per status — the stage chip on every active stop. */
const STAGE_PILL: Record<ParcelStatus, string> = {
  awaiting_collection: 'border-line bg-white text-muted',
  collected: 'border-gold/50 bg-gold/10 text-gold',
  at_warehouse: 'border-navy-500/40 bg-navy-500/5 text-navy-500',
  delivered: 'border-ok/40 bg-ok/10 text-ok',
  returned: 'border-fail/40 bg-fail/10 text-fail',
}

/** Driver home (§6.1): scan entry, the active run (rollovers first), then a
 *  separate Completed section. A job is "done" the moment it's captured —
 *  even while the record is still queued offline. The run renders as a
 *  responsive card grid that fills the page on a laptop and stacks on mobile. */
export function StopsScreen({
  parcels,
  error,
  routeLabel,
  driverId,
  sites,
  onSelectSite,
  onSelect,
}: {
  parcels: Parcel[] | null
  error: string | null
  /** The route(s) the signed-in driver runs — shown in the run-sheet header. */
  routeLabel?: string
  /** Signed-in driver — stamped onto stage scan events. */
  driverId: string
  /** Stores/depots on this driver's route(s) — the no-manifest scan path. */
  sites?: Site[]
  onSelectSite?: (site: Site) => void
  onSelect: (parcel: Parcel, scannedValue?: string) => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  // Offline, the server still shows the old stage — overlay the local queue so
  // a scanned/captured stop reads as moved the moment the driver acts
  const { queuedParcels, queuedStages } = useSyncStatus()

  // The lifecycle position this device knows about: a queued (unsynced) stage
  // scan or delivered capture advances the chip immediately, even offline.
  const effectiveStatus = (p: Parcel): ParcelStatus => {
    if (queuedParcels.get(p.id) === 'delivered') return 'delivered'
    const qs = queuedStages.get(p.id)
    if (qs && STATUS_RANK[STAGE_STATUS[qs]] > STATUS_RANK[p.status]) return STAGE_STATUS[qs]
    return p.status
  }

  // Done = terminal on the server, or a *delivered* capture queued locally.
  // A queued FAILED capture keeps the stop active — it's an attempt, the
  // parcel will be retried (and rolls over) until MAX_DELIVERY_ATTEMPTS.
  const isDone = (p: Parcel) => isTerminal(p.status) || queuedParcels.get(p.id) === 'delivered'
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

  /** Record a quick stage scan (collection/warehouse): local queue first, then
   *  a fire-and-forget sync. Returns the warn-but-allow note (skipped or
   *  duplicate stage) for the scan sheet's session log. */
  async function recordStageScan(
    parcel: Parcel,
    scannedValue: string,
    stage: Stage,
    fix: Fix | null,
  ): Promise<string | null> {
    const current = effectiveStatus(parcel)
    let warning: string | null = null
    if (STATUS_RANK[STAGE_STATUS[stage]] <= STATUS_RANK[current]) {
      warning = `Parcel is already ${STATUS_LABEL[current].toLowerCase()} — scan recorded anyway.`
    } else if (expectedStage(current) !== stage) {
      warning = `Skipped ${STAGE_LABEL[expectedStage(current)].toLowerCase()} — recorded anyway.`
    }
    await queueEvent({
      parcel,
      trackingScanned: scannedValue,
      stage,
      capturedAt: new Date(), // evidence time = device clock at the scan
      location: fix,
      driverId,
    })
    void syncNow() // drains now if we happen to be online
    return warning
  }

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
            const status = effectiveStatus(p)
            const stageQueued = queuedStages.has(p.id) && status !== p.status
            return (
              <StopRow
                key={p.id}
                parcel={p}
                onSelect={onSelect}
                note={note}
                stagePill={
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] ${STAGE_PILL[status]}`}
                  >
                    {STATUS_LABEL[status]}
                    {stageQueued && ' · queued'}
                  </span>
                }
              >
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
                      <span className={STATUS_STYLES[status] ?? 'text-muted'}>
                        {status === 'delivered' ? '✓ delivered' : status === 'failed' ? 'failed' : STATUS_LABEL[status as ParcelStatus]}
                      </span>
                      {queuedStatus && <span className="text-gold"> · queued</span>}
                    </span>
                  </StopRow>
                )
              })}
            </div>
          </>
        )}

        {/* Sites (stores/depots) on this run — no manifest, scan items on the
            spot and capture against the site. */}
        {sites && sites.length > 0 && (
          <>
            <p className="section-label mb-3 mt-8">Sites · scan &amp; capture</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {sites.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectSite?.(s)}
                  className="flex h-full w-full flex-col rounded-2xl border border-line bg-white p-4 text-left transition hover:border-navy-500/40 hover:shadow-[0_6px_20px_-10px_rgba(16,25,46,.35)] active:translate-y-px"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[15px] font-semibold">{s.name}</div>
                    <span className="flex-none rounded-full border border-navy-500/30 bg-navy-500/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-navy-500">
                      {s.kind === 'both' ? 'Store · Depot' : s.kind}
                    </span>
                  </div>
                  <div className="mt-1 text-[13px] leading-[1.45] text-muted">
                    {s.address_line || 'No address'}
                    {s.postcode ? `, ${s.postcode}` : ''}
                  </div>
                  <div className="mt-auto flex items-center justify-between pt-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-gold">No manifest</span>
                    <span className="text-[12px] font-semibold text-navy-500">Scan items →</span>
                  </div>
                </button>
              ))}
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
          onStageScan={recordStageScan}
        />
      )}
    </>
  )
}

/** One quick scan in this sheet session, for the running log. */
interface SessionScan {
  ref: string
  name: string
  stage: Stage
  at: Date
  fix: Fix | null
  warning: string | null
}

const SCAN_MODES: { key: Stage; label: string }[] = [
  { key: 'collection', label: 'Collect' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'delivered', label: 'Deliver' },
]

/** Scan sheet (§5): the camera scanner is the primary path — a decoded
 *  barcode auto-selects the matching parcel. The stage switch picks what the
 *  scan MEANS: Collect/Warehouse record a quick lifecycle event on the spot
 *  (timestamp + fresh GPS, batch-friendly — the sheet stays open and logs
 *  each scan); Deliver opens the full evidence capture as before. Type-in
 *  stays as the manual fallback, and unknown values surface clearly. */
function ScanSheet({
  parcels,
  onClose,
  onMatch,
  onStageScan,
}: {
  parcels: Parcel[]
  onClose: () => void
  onMatch: (parcel: Parcel, scannedValue: string) => void
  onStageScan: (parcel: Parcel, scannedValue: string, stage: Stage, fix: Fix | null) => Promise<string | null>
}) {
  const [mode, setMode] = useState<Stage>('delivered')
  const [value, setValue] = useState('')
  const [unknown, setUnknown] = useState<string | null>(null)
  const [scans, setScans] = useState<SessionScan[]>([])
  // GPS for quick scans: warm-up on sheet open, fresh fix at each scan —
  // same real-or-nothing model as the capture screen.
  const { fix, noFixReason, acquiring, getFix, retry } = useGeolocation()
  // The scanner re-fires the same frame several times a second — throttle
  // repeated values so one label doesn't log/flag repeatedly
  const lastUnknownRef = useRef({ v: '', t: 0 })
  const lastScanRef = useRef({ v: '', t: 0 })

  async function tryMatch(raw: string, source: 'scan' | 'type') {
    const needle = raw.trim().toUpperCase()
    if (!needle) return
    const parcel = parcels.find((p) => p.tracking_number.toUpperCase() === needle)
    if (!parcel) {
      if (source === 'scan') {
        const now = Date.now()
        if (lastUnknownRef.current.v === needle && now - lastUnknownRef.current.t < 2500) return
        lastUnknownRef.current = { v: needle, t: now }
      }
      setUnknown(needle)
      return
    }

    if (mode === 'delivered') {
      navigator.vibrate?.(80) // tactile "got it" on supporting devices
      onMatch(parcel, needle)
      return
    }

    // Quick stage scan — debounce repeat frames of the same label
    const now = Date.now()
    if (lastScanRef.current.v === `${mode}:${needle}` && now - lastScanRef.current.t < 4000) return
    lastScanRef.current = { v: `${mode}:${needle}`, t: now }
    navigator.vibrate?.(80)
    setUnknown(null)
    setValue('')
    const at = new Date()
    const scanFix = await getFix() // fresh read so the event is located where scanned
    const warning = await onStageScan(parcel, needle, mode, scanFix)
    setScans((prev) =>
      [{ ref: parcel.tracking_number, name: parcel.recipient_name, stage: mode, at, fix: scanFix, warning }, ...prev].slice(0, 8),
    )
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
        {/* What does this scan MEAN — the lifecycle stage being recorded */}
        <div className="mb-3 grid grid-cols-3 gap-1 rounded-[12px] border border-line bg-white p-1">
          {SCAN_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={`rounded-[9px] px-2 py-2 text-[12.5px] font-semibold transition ${
                mode === m.key ? 'bg-navy text-white' : 'text-muted hover:text-ink'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mb-2 text-[11.5px] leading-snug text-muted">
          {mode === 'delivered'
            ? 'Scanning opens the full delivery capture (photo, signature, outcome).'
            : `Quick scan — each label is stamped ${mode === 'collection' ? 'collected' : 'at warehouse'} with time + GPS. Keep scanning, the sheet stays open.`}
        </p>

        <BarcodeScanner onDecode={(v) => void tryMatch(v, 'scan')} />

        {/* GPS state — real-or-nothing, never silent. Shown in every mode:
            quick scans record this fix directly; Deliver hands over to the
            capture screen, which takes its own fresh read at the shutter. */}
        <div className="mt-2 rounded-[11px] border border-line bg-white px-3 py-1.5">
          <div className="flex min-h-[30px] items-center justify-between gap-3">
            {acquiring ? (
              <span className="flex items-center gap-2 text-[12px] font-medium text-muted">
                <span className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-navy/20 border-t-navy" />
                Acquiring GPS…
              </span>
            ) : fix ? (
              <span className="font-mono text-[12px] font-semibold tracking-[0.02em] text-ok">
                {fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}
                {fix.accuracyM != null ? ` ±${fix.accuracyM}m` : ''}
              </span>
            ) : (
              <>
                <span className="text-[12px] font-semibold text-fail">
                  {mode === 'delivered'
                    ? 'No GPS fix — the delivery will record no location.'
                    : 'No GPS fix — scans will record no location.'}
                </span>
                <button type="button" onClick={retry} className="flex-none text-[12px] font-bold text-navy-500 underline">
                  Retry
                </button>
              </>
            )}
          </div>
          {/* WHY there's no fix — a blocked permission must never be silent */}
          {!acquiring && !fix && noFixReason && (
            <p className="mt-1 border-t border-line pt-1.5 text-[11.5px] leading-snug text-muted">
              {NO_FIX_NOTES[noFixReason]}
            </p>
          )}
        </div>

        {unknown && (
          <div className="mt-2.5 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
            <span className="font-bold">Unknown parcel.</span> No stop matches{' '}
            <span className="font-mono">{unknown}</span> — check the label or pick from the list.
          </div>
        )}

        {/* Session log: every quick scan this sheet recorded, newest first */}
        {scans.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {scans.map((s, i) => (
              <div key={`${s.ref}-${s.at.getTime()}`} className={`rounded-[11px] border px-3 py-2 ${i === 0 ? 'border-ok/40 bg-ok/10' : 'border-line bg-white'}`}>
                <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span className="min-w-0 truncate">
                    <span className="font-bold text-ok">✓</span>{' '}
                    <span className="font-mono text-[12px] tracking-[0.5px] text-navy-500">{s.ref}</span>{' '}
                    <span className="font-semibold text-ink">{STAGE_LABEL[s.stage]}</span>
                  </span>
                  <span className="flex-none tabular-nums text-[11.5px] text-muted">
                    {s.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
                <div className="text-[11px] text-muted">
                  {s.fix ? `${s.fix.lat.toFixed(5)}, ${s.fix.lng.toFixed(5)}${s.fix.accuracyM != null ? ` ±${s.fix.accuracyM}m` : ''}` : 'no GPS fix recorded'}
                </div>
                {s.warning && <div className="mt-0.5 text-[11.5px] font-semibold text-[#9a6a00]">⚠ {s.warning}</div>}
              </div>
            ))}
          </div>
        )}

        <p className="section-label mb-2 mt-4">Or type the tracking number</p>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setUnknown(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void tryMatch(value, 'type')}
          placeholder="CP-849213-GB"
          className="w-full rounded-[11px] border border-line bg-white px-3 py-[11px] font-mono text-sm uppercase tracking-[1px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[11px] border border-line bg-white p-[11px] text-[13.5px] font-semibold text-muted"
          >
            {mode === 'delivered' ? 'Cancel' : 'Done'}
          </button>
          <button
            type="button"
            onClick={() => void tryMatch(value, 'type')}
            className="flex-1 rounded-[11px] bg-navy p-[11px] font-serif text-[15px] text-white"
          >
            {mode === 'delivered' ? 'Find parcel' : 'Record scan'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One stop as a card; the status slot comes in as children, an optional note
 *  line (attempt history etc.) renders under the address, and the lifecycle
 *  stage pill sits on the bottom row. */
function StopRow({
  parcel: p,
  onSelect,
  dim = false,
  note,
  stagePill,
  children,
}: {
  parcel: Parcel
  onSelect: (parcel: Parcel) => void
  dim?: boolean
  note?: string
  stagePill?: React.ReactNode
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
      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <span className="font-mono text-[11px] tracking-[1px] text-navy-500">{p.tracking_number}</span>
        <span className="flex items-center gap-1.5">
          {stagePill}
          <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-gold">{p.area}</span>
        </span>
      </div>
    </button>
  )
}

function dueLabel(dueDate: string): string {
  return new Date(`${dueDate}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function BarcodeGlyph() {
  return (
    <svg viewBox="0 0 24 16" className="h-4 w-6" fill="#ffce6b" aria-hidden>
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
