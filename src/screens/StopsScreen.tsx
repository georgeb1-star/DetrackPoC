import { useMemo, useRef, useState } from 'react'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { TopBar } from '../components/TopBar'
import { NO_FIX_NOTES, useGeolocation } from '../hooks/useGeolocation'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { queueAdhocScan } from '../lib/adhoc'
import { queueEvent } from '../lib/events'
import { fmtDistance, haversineM, orderByProximity, parseEwkbPoint, runMetrics } from '../lib/geo'
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

  // Group active parcels by collection point (sender_postcode as key).
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

  // The run splits by lifecycle step, one section each:
  //   To collect   = awaiting_collection
  //   To warehouse = collected (next step: check into the warehouse)
  //   To deliver   = at_warehouse (ready to drop)
  // A collected parcel is NOT yet ready to deliver — it has to be warehoused
  // first — so it lives in its own section, not "To deliver".
  const toWarehouse = active.filter((p) => effectiveStatus(p) === 'collected')
  // "To deliver" ordered into a sensible DRIVE sequence: nearest-neighbour over
  // the stops' geocoded destinations, not the arbitrary tracking-number order
  // the list arrives in. Stops with no geocode fall to the end. Plain const
  // (active is a fresh array each render, so memoising wouldn't help).
  const deliverReady = active.filter((p) => effectiveStatus(p) === 'at_warehouse')
  const deliverOrder = orderByProximity(deliverReady, (p) => parseEwkbPoint(p.destination))
  // Run metrics over the ordered stops: total drive distance + per-stop legs.
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
  // today's run.
  const total = active.length + completed.length
  const doneCount = completed.length

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

      {/* pb-24 on mobile leaves room under the content for the floating Scan
          button so it never covers the last stop. */}
      <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-24 lg:px-8 lg:py-7">
        {/* One universal action: scanning is the whole lifecycle. A scan moves
            each parcel to its next step on its own (collect → deliver), so
            there's no mode to pick first — this is THE button. */}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="mb-5 flex w-full items-center justify-center gap-3 rounded-[14px] bg-navy px-6 py-[18px] font-serif text-lg tracking-[0.3px] text-white transition hover:bg-navy-600 active:translate-y-px"
        >
          <BarcodeGlyph />
          Scan a label
        </button>

        {/* Whole-run progress: a glanceable bar the driver can read at arm's
            length — how much of today is done. */}
        {parcels && total > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
              <span className="font-semibold text-ink">
                {doneCount} of {total} done
              </span>
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

        {/* ── To collect ── grouped by pickup point; only groups with parcels
            still to collect show. Every parcel is THE card (same as the other
            sections); the one tap shortcut kept is per-pickup batch "Collect
            all" (coupon-run pickups). */}
        {(() => {
          const groups = collectGroups
            .map((g) => ({ ...g, remaining: g.parcels.filter((p) => !isCollected(p)) }))
            .filter((g) => g.remaining.length > 0)
          const totalToCollect = groups.reduce((n, g) => n + g.remaining.length, 0)
          if (totalToCollect === 0) return null
          const anyHit = groups.some((g) => g.remaining.some(matchesQuery))
          return (
            <>
              <p className="section-label mb-3">To collect · {totalToCollect}</p>
              {groups.map((g) => {
                // Only the still-to-collect parcels — a collected one leaves
                // this section and appears under "To warehouse".
                const shown = query ? g.remaining.filter(matchesQuery) : g.remaining
                if (shown.length === 0) return null // hide groups with no search hit
                const done = g.parcels.filter(isCollected).length
                return (
                  <div key={g.postcode ?? g.name ?? 'origin'} className="mb-6">
                    {/* pickup-point sub-header — where these come from */}
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 truncate text-[13px]">
                        <span className="font-semibold text-ink">{g.name || 'Coupon batch'}</span>
                        {g.postcode && <span className="ml-1.5 font-mono text-[11px] text-navy-500">{g.postcode}</span>}
                      </div>
                      <span className="flex-none rounded-full border border-gold/50 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
                        Collected {done}/{g.parcels.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {shown.map((p) => (
                        <StopRow key={p.id} parcel={p} interactive={false} />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setCollectTargets(g.remaining)}
                      className="mt-3 w-full rounded-[11px] bg-navy px-6 py-3 font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px sm:w-auto"
                    >
                      Collect all · {g.remaining.length}
                    </button>
                  </div>
                )
              })}
              {query && !anyHit && (
                <div className="rounded-2xl border border-line bg-white py-8 text-center text-[13px] text-muted">
                  No stops match "{query}".
                </div>
              )}
            </>
          )
        })()}

        {/* ── To warehouse ── collected parcels whose next step is being
            checked into the warehouse. Same card as every other section. */}
        {toWarehouse.length > 0 &&
          (() => {
            const shown = query ? toWarehouse.filter(matchesQuery) : toWarehouse
            return (
              <>
                <p className="section-label mb-3 mt-8">To warehouse · {toWarehouse.length}</p>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {shown.map((p) => (
                    <StopRow key={p.id} parcel={p} interactive={false} />
                  ))}
                  {query && shown.length === 0 && (
                    <div className="rounded-2xl border border-line bg-white py-8 text-center text-[13px] text-muted md:col-span-2 xl:col-span-3">
                      No stops match "{query}".
                    </div>
                  )}
                </div>
              </>
            )
          })()}

        {/* ── To deliver ── the warehoused parcels in drive order, same card
            (with a "Stop N · +dist" tag). Grows as the driver warehouses. */}
        {deliverOrder.length > 0 && (
          <>
            <p className="section-label mb-3 mt-8">To deliver · {deliverOrder.length}</p>
            {runMeters > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-[12px] border border-line bg-white px-4 py-2.5 text-[13px]">
                <span className="font-semibold text-ink">≈ {fmtDistance(runMeters)} drive</span>
                <span className="text-muted">{deliverOrder.length} stops</span>
                {runUnlocated > 0 && <span className="text-gold">{runUnlocated} without a pin</span>}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {deliverShown.map((p) => {
                const i = orderIndex.get(p.id) ?? 0
                return (
                  <StopRow
                    key={p.id}
                    parcel={p}
                    onSelect={onSelect}
                    note={deliverNote(p)}
                    topRight={
                      isRollover(p) ? (
                        <span className="rounded-full border border-gold/50 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
                          Rollover · {dueLabel(p.due_date)}
                        </span>
                      ) : (
                        <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted">
                          Stop {i + 1}
                          {runLegs[i] != null && <span className="text-navy-500"> · +{fmtDistance(runLegs[i]!)}</span>}
                        </span>
                      )
                    }
                  />
                )
              })}
              {query && deliverShown.length === 0 && (
                <div className="rounded-2xl border border-line bg-white py-8 text-center text-[13px] text-muted md:col-span-2 xl:col-span-3">
                  No stops match "{query}".
                </div>
              )}
            </div>
          </>
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
                    topRight={
                      <span className="text-[11px] font-bold uppercase tracking-[0.6px]">
                        <span className={STATUS_STYLES[status] ?? 'text-muted'}>
                          {status === 'delivered' ? '✓ delivered' : status === 'failed' ? 'failed' : STATUS_LABEL[status as ParcelStatus]}
                        </span>
                        {queuedStatus && <span className="text-gold"> · queued</span>}
                      </span>
                    }
                  />
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

      {/* Mobile: a thumb-reachable Scan button that stays put while the driver
          scrolls a long run (the top button scrolls away). Desktop keeps the
          top button — there's no scroll-reach problem beside the sidebar. */}
      {parcels && (
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="Scan a label"
          className="fixed bottom-[max(16px,env(safe-area-inset-bottom))] right-4 z-30 flex items-center gap-2 rounded-full bg-navy px-5 py-3.5 font-serif text-[15px] text-white shadow-[0_12px_30px_-8px_rgba(14,18,24,.65)] transition active:translate-y-px lg:hidden"
        >
          <BarcodeGlyph />
          Scan
        </button>
      )}

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
          effectiveStatusOf={effectiveStatus}
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

/** Scan sheet (§5): ONE universal action, no stage to pick. A scan moves the
 *  parcel to its next step from its own status — awaiting → collect (a quick,
 *  GPS-stamped scan; the sheet stays open for a pickup burst), collected or
 *  at_warehouse → open the delivery capture, delivered/returned → read-only
 *  receipt (never a second POD). Warehouse is parked (skipped in the flow) for
 *  the coupon pilot. Guardrails against a stray re-scan opening a capture by
 *  mistake: a 15 s per-label lock, and a geofence check — a delivery scan >1 km
 *  from the drop asks to confirm first. Type-in is the manual fallback; an
 *  unknown label can always be picked up (a pick-up is always a collection). */
function ScanSheet({
  parcels,
  onClose,
  onMatch,
  onStageScan,
  onAdhocCollect,
  effectiveStatusOf,
}: {
  parcels: Parcel[]
  onClose: () => void
  onMatch: (parcel: Parcel, scannedValue: string) => void
  onStageScan: (parcel: Parcel, scannedValue: string, stage: Stage, fix: Fix | null) => Promise<string | null>
  /** Collect an unknown (not-on-run) label as a new ad-hoc parcel. */
  onAdhocCollect: (tracking: string, fix: Fix | null) => Promise<void>
  /** The parcel's lifecycle position on this device (server + queued scans) —
   *  drives the per-parcel auto-advance. */
  effectiveStatusOf: (parcel: Parcel) => ParcelStatus
}) {
  const [value, setValue] = useState('')
  const [unknown, setUnknown] = useState<string | null>(null)
  const [scans, setScans] = useState<SessionScan[]>([])
  const [adhocBusy, setAdhocBusy] = useState(false)
  // A deliver scan fired well away from the drop — hold for a confirm rather
  // than opening the capture, so a stray re-scan at the depot can't start a
  // delivery by accident. null = no pending confirm.
  const [farDeliver, setFarDeliver] = useState<{ parcel: Parcel; value: string; distanceM: number } | null>(null)
  // GPS for quick scans: warm-up on sheet open, fresh fix at each scan —
  // same real-or-nothing model as the capture screen.
  const { fix, noFixReason, acquiring, getFix, retry } = useGeolocation()
  // The scanner re-fires the same frame several times a second — throttle
  // repeated values so one aim doesn't log/flag the same label repeatedly.
  const lastUnknownRef = useRef({ v: '', t: 0 })
  const lastScanRef = useRef({ v: '', t: 0 })
  // tracking → last time we auto-advanced it, so a held camera / accidental
  // repeat can't walk one parcel through several stages in a burst.
  const advancedAtRef = useRef<Map<string, number>>(new Map())

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

    // Debounce repeat frames of the same label before anything is recorded
    // or opened.
    const now = Date.now()
    if (lastScanRef.current.v === needle && now - lastScanRef.current.t < 4000) return
    lastScanRef.current = { v: needle, t: now }

    // One universal action: the scan moves the parcel to its next step, chosen
    // from ITS OWN status — awaiting → collect, collected → warehouse (both
    // quick GPS-stamped scans), at_warehouse → deliver (capture),
    // delivered/returned → receipt. No stage for the driver to pick.
    const current = effectiveStatusOf(parcel)

    if (isTerminal(current)) {
      // Delivered / returned — open the read-only receipt, never re-capture.
      onMatch(parcel, needle)
      return
    }

    if (current === 'at_warehouse') {
      // Ready to deliver. Guard against a stray re-scan far from the drop
      // (e.g. a double-scan back at the depot) opening a capture by mistake:
      // if we have a fix and it's well away from the destination, confirm first.
      const dest = parseEwkbPoint(parcel.destination)
      const distanceM = fix && dest ? haversineM(fix, dest) : null
      if (distanceM != null && distanceM > 1000) {
        setFarDeliver({ parcel, value: needle, distanceM })
        return
      }
      navigator.vibrate?.(80) // hands over to the full delivery capture
      onMatch(parcel, needle)
      return
    }

    // A quick, GPS-stamped scan to the next handling step: collect an awaiting
    // parcel, or check a collected one into the warehouse. Lock the label
    // briefly afterwards so a held camera / accidental repeat can't fire again.
    const quickStage: Stage = current === 'collected' ? 'warehouse' : 'collection'
    if (now - (advancedAtRef.current.get(needle) ?? 0) < 15000) return
    advancedAtRef.current.set(needle, now)

    navigator.vibrate?.(80)
    setUnknown(null)
    setValue('')
    const at = new Date()
    const scanFix = await getFix() // fresh read so the event is located where scanned
    const warning = await onStageScan(parcel, needle, quickStage, scanFix)
    setScans((prev) =>
      [{ ref: parcel.tracking_number, name: parcel.recipient_name, stage: quickStage, at, fix: scanFix, warning, recorded: true }, ...prev].slice(0, 8),
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
        {/* One honest line about what a scan does — no stage to pick. Each scan
            moves the parcel to its next step on its own. */}
        <div className="mb-3 rounded-[12px] border border-line bg-white px-3.5 py-2.5 text-[12.5px] leading-snug text-muted">
          <span className="font-semibold text-ink">Just scan. </span>Each scan moves the parcel to its next step —
          collect → warehouse (quick, GPS-stamped, sheet stays open) → deliver, which opens the capture.
        </div>

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
                  No GPS fix — collection scans will record no location.
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

        {/* Geofence guard: a deliver scan fired well away from the drop asks
            first, so a stray re-scan (e.g. back at the depot) can't open a
            capture by mistake. */}
        {farDeliver && (
          <div className="mt-2.5 rounded-[11px] border border-gold/50 bg-gold/10 px-3 py-3 text-[13px]">
            <div className="text-ink">
              You're <span className="font-semibold">{fmtDistance(farDeliver.distanceM)}</span> from{' '}
              <span className="font-semibold">{farDeliver.parcel.recipient_name}</span>.
            </div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-muted">
              That's a long way from the drop — deliver here anyway?
            </div>
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                onClick={() => setFarDeliver(null)}
                className="flex-1 rounded-[10px] border border-line bg-white p-2.5 text-[13px] font-semibold text-muted"
              >
                Not yet
              </button>
              <button
                type="button"
                onClick={() => {
                  const f = farDeliver
                  setFarDeliver(null)
                  navigator.vibrate?.(80)
                  onMatch(f.parcel, f.value)
                }}
                className="flex-1 rounded-[10px] bg-navy p-2.5 font-serif text-[14px] text-white transition hover:bg-navy-600 active:translate-y-px"
              >
                Deliver here
              </button>
            </div>
          </div>
        )}

        {unknown && (
          // A label that isn't on the run is usually an in-system parcel that
          // just wasn't allocated (or, rarely, a brand-new item). Picking it up
          // is always a collection — so the offer shows whatever tab you're on;
          // it claims the label onto this run as collected and the driver
          // captures the full POD at drop-off.
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
        )}

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
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[11px] border border-line bg-white p-[11px] text-[13.5px] font-semibold text-muted"
          >
            Done
          </button>
          <button
            type="button"
            onClick={() => void tryMatch(value, 'type')}
            className="flex-1 rounded-[11px] bg-navy p-[11px] font-serif text-[15px] text-white"
          >
            Enter
          </button>
        </div>
      </div>
    </div>
  )
}

/** THE parcel card — one identical shape used in every lifecycle section
 *  (To collect / To warehouse / To deliver / Completed) so the run reads as one
 *  consistent grid. `topRight` is an optional slot (drive-order "Stop N",
 *  rollover, or a completed status); an optional `note` line renders under the
 *  address. Non-interactive (`interactive={false}`) for the scan-driven collect
 *  / warehouse sections, a tappable button for deliver / completed. */
function StopRow({
  parcel: p,
  onSelect,
  interactive = true,
  dim = false,
  note,
  topRight,
}: {
  parcel: Parcel
  onSelect?: (parcel: Parcel) => void
  interactive?: boolean
  dim?: boolean
  note?: string
  topRight?: React.ReactNode
}) {
  const cls = `flex h-full w-full flex-col rounded-2xl border border-line bg-white p-4 text-left ${
    dim ? 'opacity-70' : ''
  } ${interactive ? 'transition hover:border-navy-500/40 hover:shadow-[0_6px_20px_-10px_rgba(16,25,46,.35)] active:translate-y-px' : ''}`
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 break-words text-[15px] font-semibold">{p.recipient_name}</div>
        {topRight && <span className="flex-none">{topRight}</span>}
      </div>
      <div className="mt-1 text-[13px] leading-[1.45] text-muted">
        {p.address_line}
        {p.postcode ? `, ${p.postcode}` : ''}
      </div>
      {note && <div className="mt-1 text-[11.5px] font-semibold text-fail">{note}</div>}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 pt-3">
        <span className="font-mono text-[11px] tracking-[1px] text-navy-500">{p.tracking_number}</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-gold">{p.delivery_area}</span>
      </div>
    </>
  )
  return interactive ? (
    <button type="button" onClick={() => onSelect?.(p)} className={cls}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
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
