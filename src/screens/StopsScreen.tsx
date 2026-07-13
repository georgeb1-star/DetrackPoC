import { useEffect, useMemo, useRef, useState } from 'react'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { TopBar } from '../components/TopBar'
import { NO_FIX_NOTES, useGeolocation } from '../hooks/useGeolocation'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { queueAdhocScan } from '../lib/adhoc'
import { queueEvent } from '../lib/events'
import { estimateRunMinutes, fmtDistance, fmtDuration, orderByProximity, parseEwkbPoint, runMetrics } from '../lib/geo'
import { syncNow } from '../lib/syncWorker'
import {
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
  onCollectSite,
  onSelect,
  onViewReceipt,
}: {
  parcels: Parcel[] | null
  error: string | null
  /** The route(s) the signed-in driver runs — shown in the run-sheet header. */
  routeLabel?: string
  /** Signed-in driver — stamped onto stage scan events. */
  driverId: string
  /** Stores/depots on this driver's route(s) — the no-manifest scan path. */
  sites?: Site[]
  /** Capture a delivery against a store site (photo/signature POD). */
  onSelectSite?: (site: Site) => void
  /** Ad-hoc collection at a depot — scan not-pre-alerted items in. */
  onCollectSite?: (site: Site) => void
  onSelect: (parcel: Parcel, scannedValue?: string) => void
  /** Re-opening a finished stop shows its read-only receipt, not the capture
   *  form — so the proof persists and a parcel can't be delivered twice. */
  onViewReceipt: (parcel: Parcel) => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  // Free-text run search (shop name / tracking / address / postcode / area) —
  // mirrors the dispatcher's allocate board so the two read the same way.
  const [query, setQuery] = useState('')
  // Bulk/per-pack collection: the set of parcels a confirm sheet is about to
  // mark collected. null = sheet closed. Both the group's "Collect all" and a
  // single row's collect open this one sheet (scoped to their targets).
  const [collectTargets, setCollectTargets] = useState<Parcel[] | null>(null)
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

  // Step 1: Phase state — default to Deliver if everything active is already collected.
  // The initial value uses allCollected but parcels may still be loading at mount
  // (active = []), so the default is 'collect' until the effect below corrects it.
  const allCollected = active.length > 0 && active.every((p) => STATUS_RANK[effectiveStatus(p)] >= STATUS_RANK['collected'])
  const [phase, setPhase] = useState<'collect' | 'deliver'>(allCollected ? 'deliver' : 'collect')

  // One-shot effect: once parcel data arrives, snap the phase to the right side
  // (e.g. a driver resuming a part-collected run). After it fires once it never
  // overrides the driver's manual phase switches.
  // A ref (not state) is used so setting it to true doesn't trigger a re-render
  // — using state here would re-run this effect and fight any manual phase switch.
  const phaseInitialised = useRef(false)
  useEffect(() => {
    if (phaseInitialised.current || active.length === 0) return
    phaseInitialised.current = true
    setPhase(allCollected ? 'deliver' : 'collect')
  }, [active, allCollected])

  // Step 2: Group active parcels by collection point (sender_postcode as key).
  // active is recomputed inline each render (new array ref), so useMemo would
  // re-run every render anyway — a plain const is honest and simpler.
  const collectGroups = (() => {
    const m = new Map<string, { name: string | null; postcode: string | null; parcels: Parcel[] }>()
    for (const p of active) {
      const key = p.sender_postcode ?? '∅'
      // name = the collection point. null when the parcel carries no sender/origin
      // (e.g. coupon runs, which are picked up as one batch) — the card then
      // renders header-less rather than a meaningless "Unknown origin" label.
      const g = m.get(key) ?? { name: p.sender_name || p.sender_address_line || null, postcode: p.sender_postcode, parcels: [] }
      g.parcels.push(p); m.set(key, g)
    }
    return [...m.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  })()

  // Deliver phase in a sensible DRIVE order: nearest-neighbour over the stops'
  // geocoded destinations, not the arbitrary tracking-number order the list
  // arrives in. Stops with no geocode fall to the end. Plain const (active is a
  // fresh array each render, so memoising wouldn't help — see collectGroups).
  const deliverOrder = orderByProximity(active, (p) => parseEwkbPoint(p.destination))
  // Run metrics over the ordered stops: total drive distance + per-stop legs +
  // a rough time estimate (labelled "~" — see estimateRunMinutes).
  const deliverPts = deliverOrder.map((p) => parseEwkbPoint(p.destination))
  const { totalM: runMeters, legs: runLegs } = runMetrics(deliverPts)
  const runUnlocated = deliverPts.filter((p) => p == null).length
  // Stable position of each stop in the drive order — lets the grid keep its
  // "Stop N" numbering and per-leg distance even when the Now/Next hero pulls
  // the first stop out, or a search narrows the rows.
  const orderIndex = useMemo(() => new Map(deliverOrder.map((p, i) => [p.id, i])), [deliverOrder])

  // Whether a parcel is already collected on *this* device's view (server
  // status or a queued collection scan). Drives the collect-phase ticks/counts.
  const isCollected = (p: Parcel) => STATUS_RANK[effectiveStatus(p)] >= STATUS_RANK['collected']

  // Run search — matches the fields a driver would glance at to find a stop.
  const q = query.trim().toLowerCase()
  const matchesQuery = (p: Parcel) =>
    !q ||
    p.recipient_name.toLowerCase().includes(q) ||
    p.tracking_number.toLowerCase().includes(q) ||
    (p.address_line ?? '').toLowerCase().includes(q) ||
    (p.postcode ?? '').toLowerCase().includes(q) ||
    (p.delivery_area ?? '').toLowerCase().includes(q)

  // Run progress for the day: done = terminal/captured, total = everything on
  // today's run. ETA is a rough estimate over the stops still to deliver.
  const total = active.length + completed.length
  const doneCount = completed.length
  const etaMin = runMeters > 0 && active.length > 0 ? estimateRunMinutes(runMeters, active.length) : 0

  /** Mark a set of parcels collected in one go (bulk batch pickup, or a single
   *  row). Writes a real per-parcel 'collection' event — same queue + server
   *  path as a scan, so the audit trail is intact and idempotency holds — then
   *  fires a sync. Re-guards against already-collected parcels so a double tap
   *  (or a racing scan) can't double-queue. One shared GPS fix: the batch is
   *  picked up at one place at one time. */
  async function collectParcels(targets: Parcel[], fix: Fix | null) {
    const at = new Date() // one capture time for the batch
    const todo = targets.filter((p) => !isCollected(p))
    for (const p of todo) {
      await queueEvent({
        parcel: p,
        trackingScanned: p.tracking_number,
        stage: 'collection',
        capturedAt: at,
        location: fix,
        driverId,
      })
    }
    void syncNow()
    setCollectTargets(null)
  }

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
    // Stages are chosen explicitly now, and both Collect→Deliver and
    // Collect→Warehouse→Deliver are valid runs — so skipping a stage isn't a
    // mistake to flag. The only heads-up worth giving is a scan that doesn't
    // move the parcel forward (a duplicate or out-of-order stage): it's still
    // recorded (events are the audit trail) but it didn't advance the stop.
    const warning =
      STATUS_RANK[STAGE_STATUS[stage]] <= STATUS_RANK[current]
        ? `Parcel is already ${STATUS_LABEL[current].toLowerCase()} — scan recorded anyway.`
        : null
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

  // The route this run belongs to — used to attach an ad-hoc scan (an unknown
  // label collected off the run) to the driver's route. All the driver's
  // parcels share it; null on an empty run (the RPC then infers the driver's
  // own single route server-side).
  const runRouteId = parcels?.find((p) => p.route_id)?.route_id ?? null

  /** Collect an unknown (not-on-run) label as a brand-new ad-hoc parcel on this
   *  run's route: local-first queue + fire-and-forget sync, exactly like a
   *  stage scan. The create_adhoc_parcel RPC makes it a 'collected' parcel. */
  async function adhocCollect(tracking: string, fix: Fix | null) {
    await queueAdhocScan({
      trackingScanned: tracking,
      routeId: runRouteId,
      capturedAt: new Date(),
      location: fix,
      driverId,
    })
    void syncNow()
  }

  /** Attempt-history note for a delivery stop (hero + grid share it). */
  const deliverNote = (p: Parcel): string | undefined => {
    const queuedFailed = queuedParcels.get(p.id) === 'failed'
    const attempts = p.attempts + (queuedFailed ? 1 : 0)
    if (attempts <= 0) return undefined
    return (
      `Attempt ${Math.min(attempts + 1, MAX_DELIVERY_ATTEMPTS)} of ${MAX_DELIVERY_ATTEMPTS}` +
      (queuedFailed ? ' · failed attempt queued' : p.last_failure ? ` · last: ${p.last_failure}` : '')
    )
  }

  // Deliver-phase rows: the drive-ordered run, narrowed by search.
  const deliverShown = query ? deliverOrder.filter(matchesQuery) : deliverOrder

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

        {/* Step 3: Collect/Deliver segmented control with live counts */}
        {(() => {
          const collectedCount = active.filter((p) => STATUS_RANK[effectiveStatus(p)] >= STATUS_RANK['collected']).length
          return (
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-[12px] border border-line bg-white p-1">
              {(['collect', 'deliver'] as const).map((ph) => (
                <button key={ph} type="button" onClick={() => setPhase(ph)}
                  className={`rounded-[9px] px-3 py-2 text-[13px] font-semibold transition ${phase === ph ? 'bg-navy text-white' : 'text-muted hover:text-ink'}`}>
                  {ph === 'collect' ? `Collect · ${collectedCount}/${active.length}` : 'Deliver'}
                </button>
              ))}
            </div>
          )
        })()}

        {/* Whole-run progress: a glanceable bar the driver can read at arm's
            length — how much of today is done, and a rough time left. */}
        {parcels && total > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
              <span className="font-semibold text-ink">
                {doneCount} of {total} done
              </span>
              {etaMin > 0 && <span className="text-muted">~{fmtDuration(etaMin)} left</span>}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-ok transition-all"
                style={{ width: `${total > 0 ? Math.round((doneCount / total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Find a stop fast — filters the cards below (both phases). */}
        {parcels && active.length > 0 && (
          <div className="relative mb-4">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this run — shop, tracking, postcode…"
              className="w-full rounded-[11px] border border-line bg-white px-3.5 py-[11px] pr-9 text-[14px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-2 py-1 text-[15px] font-semibold text-muted hover:text-ink"
              >
                ×
              </button>
            )}
          </div>
        )}

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

        {/* Step 4: Collect phase — grouped cards by sender/collection point.
            Coupon runs are one header-less batch: a "Collect all" clears it in
            one tap; individual rows can still be collected one at a time. */}
        {phase === 'collect' && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {collectGroups.map((g) => {
              const shown = query ? g.parcels.filter(matchesQuery) : g.parcels
              if (shown.length === 0) return null // hide groups with no search hit
              const done = g.parcels.filter(isCollected).length
              const remaining = g.parcels.filter((p) => !isCollected(p))
              return (
                <article key={g.postcode ?? g.name ?? 'origin'} className="flex flex-col rounded-2xl border border-line bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    {(g.name || g.postcode) && (
                      <div className="min-w-0">
                        {g.name && <div className="truncate text-[15px] font-semibold text-ink">{g.name}</div>}
                        {g.postcode && <div className="font-mono text-[11px] tracking-[0.5px] text-navy-500">{g.postcode}</div>}
                      </div>
                    )}
                    <span className={`flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] ${done === g.parcels.length ? 'border-ok/40 bg-ok/10 text-ok' : 'border-gold/50 bg-gold/10 text-gold'}`}>
                      Collected {done}/{g.parcels.length}
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-0.5 text-[12.5px] text-muted">
                    {shown.map((p) => {
                      const collected = isCollected(p)
                      return (
                        <li key={p.id} className="flex items-center gap-2 py-0.5">
                          <span className={`flex-none text-[13px] ${collected ? 'text-ok' : 'text-line'}`} aria-hidden>
                            {collected ? '✓' : '○'}
                          </span>
                          <span className={`min-w-0 flex-1 truncate ${collected ? 'text-ink' : ''}`}>
                            {p.recipient_name} · {p.delivery_area || '?'}
                          </span>
                          {collected ? (
                            <span className="flex-none font-mono text-[11px] text-navy-500">{p.tracking_number}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setCollectTargets([p])}
                              className="flex-none rounded-[8px] border border-navy-500/40 px-2.5 py-1 text-[11.5px] font-semibold text-navy-500 transition hover:bg-navy-500/5 active:translate-y-px"
                            >
                              Collect
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                  {remaining.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setCollectTargets(remaining)}
                      className="mt-3 w-full rounded-[11px] bg-navy px-4 py-3 font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px"
                    >
                      Collect all · {remaining.length}
                    </button>
                  )}
                </article>
              )
            })}
            {query && collectGroups.every((g) => g.parcels.filter(matchesQuery).length === 0) && (
              <div className="rounded-2xl border border-line bg-white py-8 text-center text-[13px] text-muted md:col-span-2 xl:col-span-3">
                No stops match "{query}".
              </div>
            )}
          </div>
        )}

        {/* Deliver phase: run summary (drive distance + rough time) then the
            nearest-neighbour-ordered stops. */}
        {phase === 'deliver' && active.length > 0 && runMeters > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-[12px] border border-line bg-white px-4 py-2.5 text-[13px]">
            <span className="font-semibold text-ink">≈ {fmtDistance(runMeters)} drive</span>
            <span className="text-muted">~{fmtDuration(estimateRunMinutes(runMeters, active.length))} est.</span>
            <span className="text-muted">{active.length} stops</span>
            {runUnlocated > 0 && <span className="text-gold">{runUnlocated} without a pin</span>}
          </div>
        )}
        {phase === 'deliver' && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {deliverShown.map((p) => {
              const i = orderIndex.get(p.id) ?? 0
              const status = effectiveStatus(p)
              const stageQueued = queuedStages.has(p.id) && status !== p.status
              return (
                <StopRow
                  key={p.id}
                  parcel={p}
                  onSelect={onSelect}
                  note={deliverNote(p)}
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
                      {runLegs[i] != null && <span className="text-navy-500"> · +{fmtDistance(runLegs[i]!)}</span>}
                    </span>
                  )}
                </StopRow>
              )
            })}
            {query && deliverShown.length === 0 && (
              <div className="rounded-2xl border border-line bg-white py-8 text-center text-[13px] text-muted md:col-span-2 xl:col-span-3">
                No stops match "{query}".
              </div>
            )}
          </div>
        )}

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
                    onSelect={onViewReceipt}
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
              {sites.map((s) => {
                const canCollect = s.kind === 'depot' || s.kind === 'both'
                const canDeliver = s.kind === 'store' || s.kind === 'both'
                return (
                  <div
                    key={s.id}
                    className="flex h-full w-full flex-col rounded-2xl border border-line bg-white p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 truncate text-[15px] font-semibold">{s.name}</div>
                      <span className="flex-none rounded-full border border-navy-500/30 bg-navy-500/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-navy-500">
                        {s.kind === 'both' ? 'Store · Depot' : s.kind}
                      </span>
                    </div>
                    <div className="mt-1 text-[13px] leading-[1.45] text-muted">
                      {s.address_line || 'No address'}
                      {s.postcode ? `, ${s.postcode}` : ''}
                    </div>
                    <div className="mt-auto flex flex-wrap gap-2 pt-3">
                      {canCollect && (
                        <button
                          type="button"
                          onClick={() => onCollectSite?.(s)}
                          className="flex-1 rounded-[11px] bg-navy-500 px-3 py-2 text-center text-[12.5px] font-semibold text-white transition hover:bg-[#1f46e0] active:translate-y-px"
                        >
                          Collect items →
                        </button>
                      )}
                      {canDeliver && (
                        <button
                          type="button"
                          onClick={() => onSelectSite?.(s)}
                          className="flex-1 rounded-[11px] border border-line bg-white px-3 py-2 text-center text-[12.5px] font-semibold text-navy-500 transition hover:border-navy-500/40 active:translate-y-px"
                        >
                          Capture delivery →
                        </button>
                      )}
                    </div>
                  </div>
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

      {collectTargets && (
        <CollectSheet
          targets={collectTargets}
          onClose={() => setCollectTargets(null)}
          onConfirm={(fix) => collectParcels(collectTargets, fix)}
        />
      )}

      {sheetOpen && parcels && (
        <ScanSheet
          parcels={parcels}
          onClose={() => setSheetOpen(false)}
          onMatch={(parcel, value) => {
            setSheetOpen(false)
            // Re-scanning a parcel that's already done (delivered, or returned
            // after max attempts) opens its read-only receipt — the same lock
            // as tapping a Completed card — so a stray re-scan can never mint a
            // second POD for it. Active/failed-but-retryable stops still capture.
            if (isDone(parcel)) onViewReceipt(parcel)
            else onSelect(parcel, value)
          }}
          onStageScan={recordStageScan}
          onAdhocCollect={adhocCollect}
          initialStage={phase === 'collect' ? 'collection' : 'delivered'}
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
  /** false = nothing was written (e.g. auto-scan of a delivered parcel) */
  recorded: boolean
}

/** The driver must pick one of these before a scan does anything — there is no
 *  default and no auto-advance, so a parcel can only ever move to a stage the
 *  driver deliberately chose. That's the whole point: it stops a stray scan
 *  from advancing the wrong parcel. */
const SCAN_STAGES: { key: Stage; label: string }[] = [
  { key: 'collection', label: 'Collect' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'delivered', label: 'Deliver' },
]

/** Scan sheet (§5): the driver first picks a stage — Collect, Warehouse or
 *  Deliver — then scans. There is NO auto/default stage: a parcel only moves
 *  to the stage the driver chose, which keeps a mis-aimed scan from advancing
 *  the wrong parcel. Collect/Warehouse are quick scans (stamp time + fresh
 *  GPS, sheet stays open for batch scanning); Deliver opens the full capture.
 *  Type-in is the manual fallback; unknown values surface clearly. */
function ScanSheet({
  parcels,
  onClose,
  onMatch,
  onStageScan,
  onAdhocCollect,
  initialStage,
}: {
  parcels: Parcel[]
  onClose: () => void
  onMatch: (parcel: Parcel, scannedValue: string) => void
  onStageScan: (parcel: Parcel, scannedValue: string, stage: Stage, fix: Fix | null) => Promise<string | null>
  /** Collect an unknown (not-on-run) label as a new ad-hoc parcel. */
  onAdhocCollect: (tracking: string, fix: Fix | null) => Promise<void>
  /** Pre-select the stage based on the active phase; the driver can still override. */
  initialStage?: Stage
}) {
  // Initialised from the current phase so the driver doesn't have to re-pick;
  // the stage switcher stays in place so they can still override.
  const [mode, setMode] = useState<Stage | null>(initialStage ?? null)
  const [value, setValue] = useState('')
  const [unknown, setUnknown] = useState<string | null>(null)
  const [scans, setScans] = useState<SessionScan[]>([])
  const [adhocBusy, setAdhocBusy] = useState(false)
  // GPS for quick scans: warm-up on sheet open, fresh fix at each scan —
  // same real-or-nothing model as the capture screen.
  const { fix, noFixReason, acquiring, getFix, retry } = useGeolocation()
  // The scanner re-fires the same frame several times a second — throttle
  // repeated values so one aim doesn't log/flag the same label repeatedly.
  const lastUnknownRef = useRef({ v: '', t: 0 })
  const lastScanRef = useRef({ v: '', t: 0 })

  async function tryMatch(raw: string, source: 'scan' | 'type') {
    if (mode === null) return // a stage must be chosen first — scanning is inert until then
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

    // Debounce repeat frames of the same label before anything is recorded
    // or opened.
    const now = Date.now()
    if (lastScanRef.current.v === needle && now - lastScanRef.current.t < 4000) return
    lastScanRef.current = { v: needle, t: now }

    // The stage is whatever the driver chose above — explicit, never inferred.
    const stage: Stage = mode

    if (stage === 'delivered') {
      navigator.vibrate?.(80) // tactile "got it" on supporting devices
      onMatch(parcel, needle)
      return
    }

    // Quick stage scan
    navigator.vibrate?.(80)
    setUnknown(null)
    setValue('')
    const at = new Date()
    const scanFix = await getFix() // fresh read so the event is located where scanned
    const warning = await onStageScan(parcel, needle, stage, scanFix)
    setScans((prev) =>
      [{ ref: parcel.tracking_number, name: parcel.recipient_name, stage, at, fix: scanFix, warning, recorded: true }, ...prev].slice(0, 8),
    )
  }

  /** Confirmed pick-up of a label that isn't on the run: fresh GPS, queue it,
   *  and log it in this session's list. On sync the parcel is claimed onto the
   *  run as collected (or created if it's genuinely new). */
  async function collectAdhoc(tracking: string) {
    if (adhocBusy) return
    setAdhocBusy(true)
    navigator.vibrate?.(80)
    const at = new Date()
    const scanFix = await getFix()
    await onAdhocCollect(tracking, scanFix)
    setScans((prev) =>
      [{ ref: tracking, name: 'Picked up', stage: 'collection' as Stage, at, fix: scanFix, warning: null, recorded: true }, ...prev].slice(0, 8),
    )
    setUnknown(null)
    setValue('')
    setAdhocBusy(false)
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
        {/* Pick the stage first — there is no default, so a scan can only ever
            move a parcel to the stage the driver explicitly chose here. */}
        <div className="mb-3 grid grid-cols-3 gap-1 rounded-[12px] border border-line bg-white p-1">
          {SCAN_STAGES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={`rounded-[9px] px-1 py-2.5 text-[13px] font-semibold transition ${
                mode === m.key ? 'bg-navy text-white' : 'text-muted hover:text-ink'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === null ? (
          // No stage chosen → the camera and type-in stay gated. Forcing the
          // choice up front is the whole mistake-prevention mechanism.
          <div className="rounded-[12px] border border-dashed border-navy-500/40 bg-navy-500/5 px-4 py-5 text-center text-[13px] font-medium leading-snug text-navy-500">
            Choose <span className="font-bold">Collect</span>, <span className="font-bold">Warehouse</span> or{' '}
            <span className="font-bold">Deliver</span> above to start scanning.
          </div>
        ) : (
          <>
            <p className="mb-2 text-[11.5px] leading-snug text-muted">
              {mode === 'delivered'
                ? 'Scanning opens the full delivery capture (photo, signature, outcome).'
                : `Quick scan — each label is stamped ${mode === 'collection' ? 'collected' : 'at warehouse'} with time + GPS. Keep scanning, the sheet stays open.`}
            </p>

            <BarcodeScanner onDecode={(v) => void tryMatch(v, 'scan')} />

            {/* GPS state — real-or-nothing, never silent: quick scans record
                this fix directly; Deliver hands over to the capture screen,
                which takes its own fresh read at the shutter. */}
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
          </>
        )}

        {unknown &&
          (mode === 'collection' ? (
            // In Collect mode a label that isn't on the run is usually an
            // in-system parcel that just wasn't allocated (or, rarely, a
            // brand-new item). Offer to pick it up — that claims it onto this
            // run as collected; the driver captures the full POD at drop-off.
            <div className="mt-2.5 rounded-[11px] border border-gold/50 bg-gold/10 px-3 py-3 text-[13px]">
              <div className="text-ink">
                <span className="font-mono font-semibold">{unknown}</span> isn't on your run.
              </div>
              <div className="mt-0.5 text-[12.5px] leading-snug text-muted">
                Pick it up and add it to your run? It joins as collected, stamped with the time + your GPS — you'll
                capture the delivery (photo + signature) at drop-off.
              </div>
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => setUnknown(null)}
                  disabled={adhocBusy}
                  className="flex-1 rounded-[10px] border border-line bg-white p-2.5 text-[13px] font-semibold text-muted disabled:opacity-40"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={() => void collectAdhoc(unknown)}
                  disabled={adhocBusy}
                  className="flex-1 rounded-[10px] bg-navy p-2.5 font-serif text-[14px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:opacity-50"
                >
                  {adhocBusy ? 'Picking up…' : 'Pick up'}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2.5 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
              <span className="font-bold">Unknown parcel.</span> No stop matches{' '}
              <span className="font-mono">{unknown}</span> — check the label or pick from the list.
              {/* This label isn't on the run — if the driver is collecting it,
                  one tap flips the stage to Collect and the pick-up offer shows. */}
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setMode('collection')}
                  className="rounded-[9px] border border-navy-500/40 bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-navy-500"
                >
                  Picking it up? Switch to Collect →
                </button>
              </div>
            </div>
          ))}

        {/* Session log: every quick scan this sheet recorded, newest first */}
        {scans.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {scans.map((s, i) => (
              <div
                key={`${s.ref}-${s.at.getTime()}`}
                className={`rounded-[11px] border px-3 py-2 ${
                  !s.recorded ? 'border-gold/40 bg-gold/10' : i === 0 ? 'border-ok/40 bg-ok/10' : 'border-line bg-white'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span className="min-w-0 truncate">
                    {s.recorded && <span className="font-bold text-ok">✓ </span>}
                    <span className="font-mono text-[12px] tracking-[0.5px] text-navy-500">{s.ref}</span>{' '}
                    {s.recorded && <span className="font-semibold text-ink">{STAGE_LABEL[s.stage]}</span>}
                  </span>
                  <span className="flex-none tabular-nums text-[11.5px] text-muted">
                    {s.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
                {s.recorded && (
                  <div className="text-[11px] text-muted">
                    {s.fix ? `${s.fix.lat.toFixed(5)}, ${s.fix.lng.toFixed(5)}${s.fix.accuracyM != null ? ` ±${s.fix.accuracyM}m` : ''}` : 'no GPS fix recorded'}
                  </div>
                )}
                {s.warning && <div className="mt-0.5 text-[11.5px] font-semibold text-[#9a6a00]">⚠ {s.warning}</div>}
              </div>
            ))}
          </div>
        )}

        {mode !== null && (
          <>
            <p className="section-label mb-2 mt-4">Or type the tracking number</p>
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setUnknown(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && void tryMatch(value, 'type')}
              placeholder="Tracking number"
              className="w-full rounded-[11px] border border-line bg-white px-3 py-[11px] font-mono text-sm uppercase tracking-[1px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
            />
          </>
        )}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[11px] border border-line bg-white p-[11px] text-[13.5px] font-semibold text-muted"
          >
            {mode === 'delivered' ? 'Cancel' : 'Done'}
          </button>
          {mode !== null && (
            <button
              type="button"
              onClick={() => void tryMatch(value, 'type')}
              className="flex-1 rounded-[11px] bg-navy p-[11px] font-serif text-[15px] text-white"
            >
              {mode === 'delivered' ? 'Find parcel' : 'Record scan'}
            </button>
          )}
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
        <div className="min-w-0 break-words text-[15px] font-semibold">{p.recipient_name}</div>
        <span className="flex-none">{children}</span>
      </div>
      <div className="mt-1 text-[13px] leading-[1.45] text-muted">
        {p.address_line}
        {p.postcode ? `, ${p.postcode}` : ''}
      </div>
      {note && <div className="mt-1 text-[11.5px] font-semibold text-fail">{note}</div>}
      {/* flex-wrap so a long status pill + area drop below the tracking number
          on a narrow card instead of overflowing off the right edge. */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 pt-3">
        <span className="font-mono text-[11px] tracking-[1px] text-navy-500">{p.tracking_number}</span>
        <span className="flex items-center gap-1.5">
          {stagePill}
          <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-gold">{p.delivery_area}</span>
        </span>
      </div>
    </button>
  )
}

/** Confirm sheet for bulk / single collection. Owns the GPS acquisition (warms
 *  up on open, fresh read at confirm) so the driver sees the fix before
 *  committing — real-or-nothing, exactly like a scan. `onConfirm` queues a
 *  per-parcel collection event; the parent closes the sheet. */
function CollectSheet({
  targets,
  onClose,
  onConfirm,
}: {
  targets: Parcel[]
  onClose: () => void
  onConfirm: (fix: Fix | null) => Promise<void>
}) {
  const { fix, noFixReason, acquiring, retry, getFix } = useGeolocation()
  const [busy, setBusy] = useState(false)
  const single = targets.length === 1

  async function go() {
    if (busy) return
    setBusy(true)
    navigator.vibrate?.(60)
    const f = await getFix() // fresh fix; null if no real fix (never fabricated)
    await onConfirm(f) // parent queues the events + closes the sheet
  }

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col justify-end bg-navy/60 sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        className="rounded-t-[22px] bg-paper p-[18px] pb-[max(24px,env(safe-area-inset-bottom))] sm:w-full sm:max-w-md sm:rounded-[22px] sm:p-6 sm:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[11px] font-bold uppercase tracking-[0.7px] text-navy-500">Confirm collection</div>
        <div className="mt-1 text-[18px] font-semibold text-ink">
          {single ? targets[0].recipient_name : `${targets.length} packs`}
        </div>
        <p className="mt-1 text-[12.5px] leading-snug text-muted">
          {single
            ? 'Marks this pack collected with the time + your current location.'
            : 'Marks every pack collected in one go — each gets its own scan record with the time + your current location.'}
        </p>

        {/* GPS state — real-or-nothing, never silent (same as the scan sheet) */}
        <div className="mt-3 rounded-[11px] border border-line bg-white px-3 py-2">
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
                <span className="text-[12px] font-semibold text-fail">No GPS fix — collection will record no location.</span>
                <button type="button" onClick={retry} className="flex-none text-[12px] font-bold text-navy-500 underline">
                  Retry
                </button>
              </>
            )}
          </div>
          {!acquiring && !fix && noFixReason && (
            <p className="mt-1 border-t border-line pt-1.5 text-[11.5px] leading-snug text-muted">
              {NO_FIX_NOTES[noFixReason]}
            </p>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-[11px] border border-line bg-white p-[13px] text-[14px] font-semibold text-muted disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void go()}
            disabled={busy}
            className="flex-1 rounded-[11px] bg-navy p-[13px] font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:opacity-50"
          >
            {busy ? 'Collecting…' : single ? 'Collect pack' : `Collect ${targets.length}`}
          </button>
        </div>
      </div>
    </div>
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
