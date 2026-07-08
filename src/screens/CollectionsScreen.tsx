import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { supabase } from '../lib/supabase'
import { STATUS_LABEL, type Parcel, type ParcelStatus } from '../lib/types'

/** Dispatcher visibility for AD-HOC COLLECTIONS (meeting ask #2's other half):
 *  what was actually collected at each depot, without a predefined job. Lists
 *  every parcel created by depot collection (meta.source = 'ad-hoc'), grouped by
 *  depot, filterable by depot + driver, with the scan time, who collected it,
 *  and its current lifecycle status. Read-only. */
export function CollectionsScreen() {
  const { fleet } = useFleet()
  const [items, setItems] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [depotFilter, setDepotFilter] = useState('all')
  const [driverFilter, setDriverFilter] = useState('all')

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
      .eq('meta->>source', 'ad-hoc')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else {
      setItems(data as Parcel[])
      setError(null)
    }
  }, [])

  useEffect(() => {
    void load()
    const channel = supabase
      .channel('collections-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, () => void load())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [load])

  const driverName = useCallback(
    (id: string | null | undefined) => fleet?.drivers.find((d) => d.id === id)?.name ?? id ?? '—',
    [fleet],
  )
  const ms = (p: Parcel, k: string) => (typeof p.meta?.[k] === 'string' ? (p.meta[k] as string) : null)

  const depots = useMemo(
    () => [...new Set((items ?? []).map((p) => ms(p, 'site_name') ?? 'Unknown depot'))].sort(),
    [items],
  )
  const collectors = useMemo(
    () => [...new Set((items ?? []).map((p) => ms(p, 'collected_by')).filter(Boolean) as string[])],
    [items],
  )

  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (p) =>
          (depotFilter === 'all' || (ms(p, 'site_name') ?? 'Unknown depot') === depotFilter) &&
          (driverFilter === 'all' || ms(p, 'collected_by') === driverFilter),
      ),
    [items, depotFilter, driverFilter],
  )

  // Group by depot, newest first within each.
  const groups = useMemo(() => {
    const m = new Map<string, Parcel[]>()
    for (const p of filtered) {
      const depot = ms(p, 'site_name') ?? 'Unknown depot'
      ;(m.get(depot) ?? m.set(depot, []).get(depot)!).push(p)
    }
    // Most-recent collection first within each depot.
    const at = (p: Parcel) => (typeof p.meta?.collected_at === 'string' ? (p.meta.collected_at as string) : '')
    for (const [, arr] of m) arr.sort((a, b) => at(b).localeCompare(at(a)))
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  return (
    <AdminShell
      active="collections"
      title="Collections"
      meta={items ? `${filtered.length} collected · ${groups.length} depot${groups.length === 1 ? '' : 's'}` : '…'}
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{error}</div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] text-muted">
          Depot
          <select
            value={depotFilter}
            onChange={(e) => setDepotFilter(e.target.value)}
            className="rounded-[10px] border border-line bg-white px-2.5 py-2 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
          >
            <option value="all">All depots</option>
            {depots.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          Driver
          <select
            value={driverFilter}
            onChange={(e) => setDriverFilter(e.target.value)}
            className="rounded-[10px] border border-line bg-white px-2.5 py-2 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
          >
            <option value="all">All drivers</option>
            {collectors.map((id) => (
              <option key={id} value={id}>
                {driverName(id)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {items && filtered.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white px-4 py-12 text-center text-[13px] text-muted">
          No ad-hoc collections yet. They appear here as drivers scan items at depots (driver app → a depot → “Collect items”).
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {groups.map(([depot, ps]) => (
            <section key={depot} className="overflow-hidden rounded-2xl border border-line bg-white">
              <div className="flex items-baseline justify-between gap-3 border-b border-line bg-paper/60 px-4 py-2.5">
                <div className="font-serif text-[15px] text-ink">{depot}</div>
                <span className="font-mono text-[11px] tracking-[0.5px] text-navy-500">
                  {ps.length} item{ps.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex flex-col">
                {ps.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                    <div className="min-w-0">
                      <div className="font-mono text-[12.5px] tracking-[0.5px] text-navy-500">{p.tracking_number}</div>
                      <div className="truncate text-[12px] text-muted">
                        {driverName(ms(p, 'collected_by'))} · {fmtWhen(ms(p, 'collected_at'))}
                      </div>
                    </div>
                    <span className={`flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] ${STATUS_TONE[p.status]}`}>
                      {STATUS_LABEL[p.status]}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </AdminShell>
  )
}

const STATUS_TONE: Record<ParcelStatus, string> = {
  awaiting_collection: 'border-line bg-white text-muted',
  collected: 'border-gold/50 bg-gold/10 text-gold',
  at_warehouse: 'border-navy-500/40 bg-navy-500/5 text-navy-500',
  delivered: 'border-ok/40 bg-ok/10 text-ok',
  returned: 'border-fail/40 bg-fail/10 text-fail',
}

/** "08 Jul, 16:55" from an ISO string, or "—". */
function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
