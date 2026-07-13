import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { supabase } from '../lib/supabase'
import { matchRoute, unallocatedReason } from '../lib/allocate'
import { fmtDistance, orderByProximity, parseEwkbPoint, runMetrics } from '../lib/geo'
import { STATUS_LABEL, type Parcel } from '../lib/types'

/** Dispatcher allocation: assign parcels to a route (each route is run by one
 *  driver). Manual per-parcel assignment plus a one-click "auto-allocate by
 *  area". Writes parcels.route_id; the driver app picks the change up live via
 *  the parcels realtime channel. Same navy/gold/paper language as the
 *  Captured PODs view, with a tab back to it.
 *
 *  Scoped to a single run (due_date): recurring routes generate one run per
 *  service day, so the whole board — unallocated list, route cards, distances,
 *  auto-allocate — works against the selected day only, with a search box over
 *  the top. Parcels past awaiting_collection are locked (can't be reassigned
 *  mid-flight). */
export function AllocateScreen() {
  const { fleet } = useFleet()
  const [parcels, setParcels] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [day, setDay] = useState('') // '' = follow the derived default
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('parcels').select('*').order('tracking_number')
    if (error) setError(error.message)
    else {
      setParcels(data as Parcel[])
      setError(null)
    }
  }, [])

  // Realtime: keep the board live if a second dispatcher (or a driver) moves a
  // parcel. The poll-free channel mirrors the Captured PODs view.
  useEffect(() => {
    void load()
    const channel = supabase
      .channel('allocate-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, () => void load())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [load])

  const routes = useMemo(() => fleet?.routes ?? [], [fleet])
  const driverName = useCallback(
    (id: string | null) => fleet?.drivers.find((d) => d.id === id)?.name ?? id ?? '—',
    [fleet],
  )

  // Distinct runs present in the data (+ always today), with per-run counts so
  // the dispatcher can see at a glance which run still needs allocating.
  const runInfo = useMemo(() => {
    const m = new Map<string, { total: number; unallocated: number }>()
    for (const p of parcels ?? []) {
      const e = m.get(p.due_date) ?? { total: 0, unallocated: 0 }
      e.total++
      if (p.route_id == null) e.unallocated++
      m.set(p.due_date, e)
    }
    return m
  }, [parcels])

  const runDates = useMemo(() => {
    const set = new Set<string>(runInfo.keys())
    set.add(todayIso())
    return [...set].sort()
  }, [runInfo])

  // Default run: today if it has a run, else the earliest run still holding
  // unallocated parcels, else the most recent run. The user's pick (day) wins.
  const defaultDay = useMemo(() => {
    const today = todayIso()
    if (runInfo.has(today)) return today
    const withUnallocated = [...runInfo.entries()]
      .filter(([, v]) => v.unallocated > 0)
      .map(([d]) => d)
      .sort()
    if (withUnallocated.length) return withUnallocated[0]
    const all = [...runInfo.keys()].sort()
    return all[all.length - 1] ?? today
  }, [runInfo])
  const activeDay = day || defaultDay

  // Optimistic write — flip route_id locally, then persist. Realtime/reload
  // reconciles if the server disagrees.
  async function assign(parcelId: string, routeId: string | null) {
    setBusy(true)
    setParcels((prev) => prev?.map((p) => (p.id === parcelId ? { ...p, route_id: routeId } : p)) ?? prev)
    const { error } = await supabase.from('parcels').update({ route_id: routeId }).eq('id', parcelId)
    if (error) {
      setError(error.message)
      void load()
    }
    setBusy(false)
  }

  // Parcels on the selected run (everything below is scoped to this).
  const scoped = useMemo(
    () => (parcels ?? []).filter((p) => p.due_date === activeDay),
    [parcels, activeDay],
  )
  const scopedUnallocated = useMemo(() => scoped.filter((p) => p.route_id == null), [scoped])

  function autoAllocate() {
    void (async () => {
      setBusy(true)
      setError(null)
      // Only this run's still-collectable parcels — never touch in-flight ones.
      const targets = scopedUnallocated
        .filter((p) => p.status === 'awaiting_collection')
        .map((p) => ({ id: p.id, routeId: matchRoute(p, routes)?.id ?? null }))
        .filter((u): u is { id: string; routeId: string } => u.routeId != null)
      if (targets.length === 0) {
        setBusy(false)
        return
      }
      const routeOf = new Map(targets.map((t) => [t.id, t.routeId]))
      setParcels(
        (prev) => prev?.map((p) => (routeOf.has(p.id) ? { ...p, route_id: routeOf.get(p.id)! } : p)) ?? prev,
      )
      // One UPDATE per target route (grouped .in()) instead of one per parcel —
      // a run can hold hundreds of stops, so batch the writes.
      const byRouteId = new Map<string, string[]>()
      for (const t of targets) {
        const arr = byRouteId.get(t.routeId)
        if (arr) arr.push(t.id)
        else byRouteId.set(t.routeId, [t.id])
      }
      const results = await Promise.all(
        [...byRouteId.entries()].map(([routeId, ids]) =>
          supabase.from('parcels').update({ route_id: routeId }).in('id', ids),
        ),
      )
      const firstErr = results.find((r) => r.error)?.error
      if (firstErr) {
        setError(firstErr.message)
        void load()
      }
      setBusy(false)
    })()
  }

  // Search over the run — recipient, tracking, postcode, address, area codes.
  const matchesQuery = useCallback(
    (p: Parcel) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return (
        p.recipient_name.toLowerCase().includes(q) ||
        p.tracking_number.toLowerCase().includes(q) ||
        (p.postcode ?? '').toLowerCase().includes(q) ||
        p.address_line.toLowerCase().includes(q) ||
        (p.collection_area ?? '').toLowerCase().includes(q) ||
        (p.delivery_area ?? '').toLowerCase().includes(q)
      )
    },
    [query],
  )

  const unallocatedShown = useMemo(
    () => scopedUnallocated.filter(matchesQuery),
    [scopedUnallocated, matchesQuery],
  )

  // Run's parcels grouped by route id (unfiltered by search — the header count
  // and distance reflect the true run; search only narrows the rows shown).
  const byRoute = useMemo(() => {
    const map = new Map<string, Parcel[]>()
    for (const r of routes) map.set(r.id, [])
    for (const p of scoped) if (p.route_id && map.has(p.route_id)) map.get(p.route_id)!.push(p)
    return map
  }, [routes, scoped])

  const canAuto = scopedUnallocated.some(
    (p) => p.status === 'awaiting_collection' && matchRoute(p, routes),
  )

  return (
    <AdminShell
      active="allocate"
      title="Allocate parcels"
      meta={
        parcels
          ? `${fmtRunDate(activeDay)} · ${scopedUnallocated.length} unallocated · ${scoped.length} parcels`
          : '…'
      }
      actions={
        <button
          type="button"
          disabled={busy || !canAuto}
          onClick={autoAllocate}
          className="rounded-[10px] bg-navy px-4 py-2.5 font-serif text-[13.5px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
        >
          Auto-allocate by area
        </button>
      }
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
          {error}. Is the local Supabase stack running (and the routes migration applied)?
        </div>
      )}

      {/* Run + search filter bar */}
      <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className="flex flex-col gap-1">
          <span className="section-label">Run date</span>
          <select
            value={activeDay}
            onChange={(e) => setDay(e.target.value)}
            aria-label="Run date"
            className="rounded-[10px] border border-line bg-white px-3 py-2 text-[13.5px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
          >
            {runDates.map((d) => {
              const info = runInfo.get(d)
              const suffix = !info
                ? 'no parcels'
                : info.unallocated > 0
                  ? `${info.unallocated} unallocated`
                  : `${info.total} allocated`
              return (
                <option key={d} value={d}>
                  {fmtRunDate(d)} — {suffix}
                </option>
              )
            })}
          </select>
        </label>

        <label className="flex min-w-[220px] flex-1 flex-col gap-1">
          <span className="section-label">Search this run</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, tracking number, postcode, area…"
            className="rounded-[10px] border border-line bg-white px-3 py-2 text-[13.5px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
          />
        </label>
      </div>

      {!parcels ? (
        <div className="rounded-2xl border border-line bg-white px-4 py-10 text-center text-[13px] text-muted">
          Loading parcels…
        </div>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          {/* Unallocated — the dispatcher's to-do list for this run */}
          <section>
            <p className="section-label mb-2">Unallocated · {unallocatedShown.length}</p>

            {scoped.length === 0 ? (
              <div className="rounded-2xl border border-line bg-white px-4 py-10 text-center text-[13px] text-muted">
                No parcels on this run.
              </div>
            ) : unallocatedShown.length === 0 ? (
              <div className="rounded-2xl border border-line bg-white px-4 py-10 text-center text-[13px] text-muted">
                {query ? 'No unallocated parcels match your search.' : 'Every parcel on this run is on a route.'}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {unallocatedShown.map((p) => (
                  <ParcelRow
                    key={p.id}
                    parcel={p}
                    routes={routes}
                    driverName={driverName}
                    busy={busy}
                    suggestion={matchRoute(p, routes)?.name}
                    reason={unallocatedReason(p, routes)}
                    onAssign={(routeId) => void assign(p.id, routeId)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* By route — each driver's run, with reassign/unassign */}
          <section>
            <p className="section-label mb-2">Routes</p>
            <div className="flex flex-col gap-3">
              {routes.map((r) => {
                const stops = byRoute.get(r.id) ?? []
                const shownStops = query ? stops.filter(matchesQuery) : stops
                // Rough drive distance for the route, in nearest-neighbour order —
                // lets the dispatcher balance runs at a glance.
                const routeM = runMetrics(
                  orderByProximity(stops, (p) => parseEwkbPoint(p.destination)).map((p) => parseEwkbPoint(p.destination)),
                ).totalM
                return (
                  <article key={`${r.id}:${activeDay}`} className="overflow-hidden rounded-2xl border border-line bg-white">
                    <div className="flex items-baseline justify-between gap-3 border-b border-line bg-paper/60 px-4 py-2.5">
                      <div>
                        <div className="font-serif text-[15px] text-ink">{r.name}</div>
                        <div className="text-[12px] text-muted">
                          {driverName(r.driver_id)} · {r.collection_areas.join('·') || '—'} → {r.delivery_areas.join('·') || '—'}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] tracking-[0.5px] text-navy-500">
                        {stops.length} stop{stops.length === 1 ? '' : 's'}
                        {routeM > 0 && <span className="text-muted"> · ≈{fmtDistance(routeM)}</span>}
                      </span>
                    </div>
                    {stops.length === 0 ? (
                      <div className="px-4 py-3 text-[12.5px] text-muted">No parcels yet.</div>
                    ) : shownStops.length === 0 ? (
                      <div className="px-4 py-3 text-[12.5px] text-muted">No stops match your search.</div>
                    ) : (
                      <RouteStops
                        stops={shownStops}
                        routes={routes}
                        driverName={driverName}
                        busy={busy}
                        onAssign={(id, routeId) => void assign(id, routeId)}
                      />
                    )}
                  </article>
                )
              })}
              {routes.length === 0 && (
                <div className="rounded-2xl border border-line bg-white px-4 py-10 text-center text-[13px] text-muted">
                  No routes found — apply the drivers/routes migration and seed.
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </AdminShell>
  )
}

/** A route's allocated parcels, paginated — a recurring run can hold hundreds
 *  of stops (one per shop per service day), so page them 10 at a time inside
 *  the card instead of an endless in-card scroll. Own page state per route. */
function RouteStops({
  stops,
  routes,
  driverName,
  busy,
  onAssign,
}: {
  stops: Parcel[]
  routes: { id: string; name: string; driver_id: string | null }[]
  driverName: (id: string | null) => string
  busy: boolean
  onAssign: (parcelId: string, routeId: string | null) => void
}) {
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 10
  const pageCount = Math.max(1, Math.ceil(stops.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const shown = stops.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  return (
    <div className="flex flex-col">
      {shown.map((p) => (
        <ParcelRow
          key={p.id}
          parcel={p}
          routes={routes}
          driverName={driverName}
          busy={busy}
          inset
          onAssign={(routeId) => onAssign(p.id, routeId)}
        />
      ))}
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-line bg-paper/40 px-4 py-2">
          <span className="text-[11.5px] text-muted">
            {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, stops.length)} of {stops.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              className="rounded-[8px] border border-line bg-white px-2.5 py-1 text-[12px] font-semibold text-navy-500 transition hover:border-navy-500/40 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="text-[11.5px] tabular-nums text-muted">{safePage + 1}/{pageCount}</span>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
              className="rounded-[8px] border border-line bg-white px-2.5 py-1 text-[12px] font-semibold text-navy-500 transition hover:border-navy-500/40 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** One parcel line with an inline route selector. Used both in the unallocated
 *  list and inside each route card (inset). Once a parcel is past
 *  awaiting_collection it's in flight on a driver's run — the selector is
 *  replaced by a locked status pill so it can't be reassigned mid-run. */
function ParcelRow({
  parcel: p,
  routes,
  driverName,
  busy,
  inset = false,
  suggestion,
  reason,
  onAssign,
}: {
  parcel: Parcel
  routes: { id: string; name: string; driver_id: string | null }[]
  driverName: (id: string | null) => string
  busy: boolean
  inset?: boolean
  suggestion?: string
  reason?: string | null
  onAssign: (routeId: string | null) => void
}) {
  const locked = p.status !== 'awaiting_collection'
  return (
    <div
      className={`flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${
        inset ? 'border-b border-line px-4 py-2.5 last:border-b-0' : 'rounded-[11px] border border-line bg-white px-3.5 py-2.5'
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{p.recipient_name}</span>
          <span className="flex-none rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
            {p.collection_area || '?'} → {p.delivery_area || '?'}
          </span>
        </div>
        <div className="truncate text-[12.5px] text-muted">
          {p.address_line}
          {p.postcode ? `, ${p.postcode}` : ''}
        </div>
        {reason && <div className="text-[11.5px] font-medium text-muted">{reason}</div>}
        <div className="font-mono text-[11px] tracking-[0.5px] text-navy-500">{p.tracking_number}</div>
      </div>

      <div className="flex flex-none items-center gap-2">
        {locked ? (
          <span
            title={`${STATUS_LABEL[p.status]} — locked while in flight`}
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-paper px-2.5 py-2 text-[12px] font-semibold text-muted"
          >
            <LockIcon />
            {STATUS_LABEL[p.status]}
          </span>
        ) : (
          <>
            {suggestion && <span className="hidden text-[11px] text-muted sm:inline">→ {suggestion}</span>}
            <select
              value={p.route_id ?? ''}
              disabled={busy}
              onChange={(e) => onAssign(e.target.value || null)}
              aria-label={`Assign ${p.tracking_number} to a route`}
              className="rounded-[10px] border border-line bg-white px-2.5 py-2 text-[13px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10 disabled:opacity-50"
            >
              <option value="">Unassigned</option>
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {driverName(r.driver_id)}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    </div>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

/** Today as YYYY-MM-DD (matches the manifest import's run-date convention). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** A run date (YYYY-MM-DD) as e.g. "Mon 13 Jul". Parsed as local midnight so
 *  UK dates don't slip a day. */
function fmtRunDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
}
