import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFleet } from '../hooks/useFleet'
import { signOut } from '../hooks/useSession'
import { supabase } from '../lib/supabase'
import type { Area, Parcel } from '../lib/types'

/** Dispatcher allocation: assign parcels to a route (each route is run by one
 *  driver). Manual per-parcel assignment plus a one-click "auto-allocate by
 *  area". Writes parcels.route_id; the driver app picks the change up live via
 *  the parcels realtime channel. Same navy/gold/paper language as the
 *  Captured PODs view, with a tab back to it. */
export function AllocateScreen() {
  const { fleet } = useFleet()
  const [parcels, setParcels] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
  // The route that covers a given area (first match) — drives auto-allocation.
  const routeForArea = useCallback(
    (area: Area) => routes.find((r) => r.areas.includes(area)) ?? null,
    [routes],
  )

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

  async function autoAllocate() {
    if (!parcels) return
    setBusy(true)
    setError(null)
    const updates = parcels
      .filter((p) => p.route_id == null)
      .map((p) => ({ id: p.id, routeId: routeForArea(p.area)?.id ?? null }))
      .filter((u): u is { id: string; routeId: string } => u.routeId != null)
    setParcels(
      (prev) =>
        prev?.map((p) => {
          const u = updates.find((x) => x.id === p.id)
          return u ? { ...p, route_id: u.routeId } : p
        }) ?? prev,
    )
    const results = await Promise.all(
      updates.map((u) => supabase.from('parcels').update({ route_id: u.routeId }).eq('id', u.id)),
    )
    const firstErr = results.find((r) => r.error)?.error
    if (firstErr) {
      setError(firstErr.message)
      void load()
    }
    setBusy(false)
  }

  const unallocated = parcels?.filter((p) => p.route_id == null) ?? []
  // parcels grouped by route id, in the routes' display order
  const byRoute = useMemo(() => {
    const map = new Map<string, Parcel[]>()
    for (const r of routes) map.set(r.id, [])
    for (const p of parcels ?? []) if (p.route_id && map.has(p.route_id)) map.get(p.route_id)!.push(p)
    return map
  }, [routes, parcels])

  const canAuto = unallocated.some((p) => routeForArea(p.area))

  return (
    <div className="min-h-dvh sm:px-8 sm:py-8">
      <div className="mx-auto max-w-4xl">
        <header className="gold-underline relative bg-navy px-5 pb-5 pt-[max(16px,env(safe-area-inset-top))] text-white sm:rounded-t-2xl sm:px-6">
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-[11px] font-semibold text-[#9fb0d6] transition hover:text-white"
          >
            Sign out ›
          </button>
          <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-[2px] text-gold-soft">
            Citipost · Dispatch
          </div>
          <div className="mt-[3px] flex items-baseline justify-between gap-4">
            <h1 className="font-serif text-[22px]">Allocate parcels</h1>
            <span className="font-mono text-xs tracking-[1px] text-[#9fb0d6]">
              {parcels ? `${unallocated.length} unallocated` : '…'}
            </span>
          </div>
          {/* Dispatch tabs */}
          <div className="mt-3 flex gap-2">
            <span className="rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold text-white">
              Allocate
            </span>
            <a
              href="#/jobs"
              className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5"
            >
              Jobs
            </a>
            <a
              href="#/sites"
              className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5"
            >
              Sites
            </a>
            <a
              href="#/dispatch"
              className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5"
            >
              Captured PODs
            </a>
          </div>
        </header>

        <div className="min-h-[calc(100dvh-150px)] bg-paper p-4 sm:min-h-0 sm:rounded-b-2xl sm:p-5">
          {error && (
            <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
              {error}. Is the local Supabase stack running (and the routes migration applied)?
            </div>
          )}

          {/* Unallocated — the dispatcher's to-do list */}
          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="section-label">Unallocated · {unallocated.length}</p>
              <button
                type="button"
                disabled={busy || !canAuto}
                onClick={() => void autoAllocate()}
                className="rounded-[10px] bg-navy px-3.5 py-2 font-serif text-[13px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
              >
                Auto-allocate by area
              </button>
            </div>

            {parcels && unallocated.length === 0 ? (
              <div className="rounded-2xl border border-line bg-white px-4 py-6 text-center text-[13px] text-muted">
                Every parcel is on a route.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {unallocated.map((p) => (
                  <ParcelRow
                    key={p.id}
                    parcel={p}
                    routes={routes}
                    driverName={driverName}
                    busy={busy}
                    suggestion={routeForArea(p.area)?.name}
                    onAssign={(routeId) => void assign(p.id, routeId)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* By route — each driver's run, with reassign/unassign */}
          <section className="mt-7">
            <p className="section-label mb-2">Routes</p>
            <div className="flex flex-col gap-3">
              {routes.map((r) => {
                const stops = byRoute.get(r.id) ?? []
                return (
                  <article key={r.id} className="overflow-hidden rounded-2xl border border-line bg-white">
                    <div className="flex items-baseline justify-between gap-3 border-b border-line bg-paper/60 px-4 py-2.5">
                      <div>
                        <div className="font-serif text-[15px] text-ink">{r.name}</div>
                        <div className="text-[12px] text-muted">
                          {driverName(r.driver_id)} · {r.areas.join(', ') || 'no areas'}
                        </div>
                      </div>
                      <span className="font-mono text-[11px] tracking-[0.5px] text-navy-500">
                        {stops.length} stop{stops.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {stops.length === 0 ? (
                      <div className="px-4 py-3 text-[12.5px] text-muted">No parcels yet.</div>
                    ) : (
                      <div className="flex flex-col">
                        {stops.map((p) => (
                          <ParcelRow
                            key={p.id}
                            parcel={p}
                            routes={routes}
                            driverName={driverName}
                            busy={busy}
                            inset
                            onAssign={(routeId) => void assign(p.id, routeId)}
                          />
                        ))}
                      </div>
                    )}
                  </article>
                )
              })}
              {routes.length === 0 && (
                <div className="rounded-2xl border border-line bg-white px-4 py-6 text-center text-[13px] text-muted">
                  No routes found — apply the drivers/routes migration and seed.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

/** One parcel line with an inline route selector. Used both in the unallocated
 *  list and inside each route card (inset). */
function ParcelRow({
  parcel: p,
  routes,
  driverName,
  busy,
  inset = false,
  suggestion,
  onAssign,
}: {
  parcel: Parcel
  routes: { id: string; name: string; driver_id: string | null }[]
  driverName: (id: string | null) => string
  busy: boolean
  inset?: boolean
  suggestion?: string
  onAssign: (routeId: string | null) => void
}) {
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
            {p.area}
          </span>
        </div>
        <div className="truncate text-[12.5px] text-muted">
          {p.address_line}
          {p.postcode ? `, ${p.postcode}` : ''}
        </div>
        <div className="font-mono text-[11px] tracking-[0.5px] text-navy-500">{p.tracking_number}</div>
      </div>

      <div className="flex flex-none items-center gap-2">
        {suggestion && (
          <span className="hidden text-[11px] text-muted sm:inline">→ {suggestion}</span>
        )}
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
      </div>
    </div>
  )
}
