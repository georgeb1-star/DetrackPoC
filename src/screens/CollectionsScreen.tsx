import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { parseEwkbPoint } from '../lib/geo'
import { supabase } from '../lib/supabase'
import { downloadCsv } from '../lib/trackingExport'
import { STATUS_LABEL, isTerminal, type Parcel, type ParcelStatus } from '../lib/types'

/** The collection scan's GPS (from parcel_events), for audit parity with PODs. */
interface CollEvent {
  parcel_id: string
  location: unknown
  gps_accuracy_m: number | null
  gps_source: string | null
  captured_at: string | null
}

const metaStr = (p: Parcel, k: string) => (typeof p.meta?.[k] === 'string' ? (p.meta[k] as string) : null)
const depotOf = (p: Parcel) => metaStr(p, 'site_name') ?? 'Unknown depot'
const collAt = (p: Parcel) => metaStr(p, 'collected_at') ?? ''

const DEPOTS_PER_PAGE = 9
const CARD_ITEM_CAP = 25

/** Dispatcher visibility for AD-HOC COLLECTIONS (meeting ask #2's other half):
 *  what was actually collected at each depot, without a predefined job. Lists
 *  every parcel created by depot collection (meta.source = 'ad-hoc'), grouped by
 *  depot with true per-depot totals, filterable by depot / driver / day / free
 *  text, with each item's scan time, collector, current lifecycle status, and
 *  the collection scan's GPS. Exportable to CSV. Read-only. */
export function CollectionsScreen() {
  const { fleet } = useFleet()
  const [items, setItems] = useState<Parcel[] | null>(null)
  const [events, setEvents] = useState<Map<string, CollEvent>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [depotFilter, setDepotFilter] = useState('all')
  const [driverFilter, setDriverFilter] = useState('all')
  const [dayFilter, setDayFilter] = useState('all')
  // Collections is an ACTIVE view: once an item is delivered/returned it's
  // complete and lives with the rest of the finished work (Captured PODs board,
  // tracking export). Off by default so this page shows what's still in hand;
  // toggle on to look back at completed collections here.
  const [showCompleted, setShowCompleted] = useState(false)
  const [page, setPage] = useState(0)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
      .eq('meta->>source', 'ad-hoc')
      .order('created_at', { ascending: false })
    if (error) {
      setError(error.message)
      return
    }
    const rows = data as Parcel[]
    setItems(rows)
    setError(null)

    // Pull the collection-stage scan GPS for these parcels (chunked .in so a
    // long history can't blow the URL). Soft-fails: no GPS just means no audit
    // pin, never a broken page.
    const ids = rows.map((r) => r.id)
    const map = new Map<string, CollEvent>()
    for (let i = 0; i < ids.length; i += 200) {
      const { data: evs } = await supabase
        .from('parcel_events')
        .select('parcel_id, location, gps_accuracy_m, gps_source, captured_at')
        .eq('stage', 'collection')
        .in('parcel_id', ids.slice(i, i + 200))
      for (const e of (evs ?? []) as CollEvent[]) {
        if (!e.parcel_id) continue
        const prev = map.get(e.parcel_id)
        if (!prev || (e.captured_at ?? '') > (prev.captured_at ?? '')) map.set(e.parcel_id, e)
      }
    }
    setEvents(map)
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

  const depots = useMemo(() => [...new Set((items ?? []).map(depotOf))].sort(), [items])
  const collectors = useMemo(
    () => [...new Set((items ?? []).map((p) => metaStr(p, 'collected_by')).filter(Boolean) as string[])],
    [items],
  )
  const days = useMemo(() => {
    const set = new Set<string>()
    for (const p of items ?? []) {
      const d = localDay(collAt(p))
      if (d) set.add(d)
    }
    return [...set].sort().reverse()
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (items ?? []).filter((p) => {
      if (!showCompleted && isTerminal(p.status)) return false
      if (depotFilter !== 'all' && depotOf(p) !== depotFilter) return false
      if (driverFilter !== 'all' && metaStr(p, 'collected_by') !== driverFilter) return false
      if (dayFilter !== 'all' && localDay(collAt(p)) !== dayFilter) return false
      if (q) {
        const hay = [p.tracking_number, p.recipient_name, p.postcode, metaStr(p, 'site_name')]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, search, depotFilter, driverFilter, dayFilter, showCompleted])

  // Group ALL matches by depot (not just a page) so each card shows the depot's
  // true item count; items newest-first within a depot, depots A→Z. Pagination
  // is over depots.
  const depotEntries = useMemo(() => {
    const m = new Map<string, Parcel[]>()
    for (const p of filtered) {
      const arr = m.get(depotOf(p))
      if (arr) arr.push(p)
      else m.set(depotOf(p), [p])
    }
    const entries = [...m.entries()]
    for (const [, arr] of entries) arr.sort((a, b) => collAt(b).localeCompare(collAt(a)))
    entries.sort((a, b) => a[0].localeCompare(b[0]))
    return entries
  }, [filtered])

  const pageCount = Math.max(1, Math.ceil(depotEntries.length / DEPOTS_PER_PAGE))
  const safePage = Math.min(page, pageCount - 1)
  const shownDepots = depotEntries.slice(safePage * DEPOTS_PER_PAGE, safePage * DEPOTS_PER_PAGE + DEPOTS_PER_PAGE)

  function exportCsv() {
    const header = ['TrackingNumber', 'Depot', 'CollectedBy', 'CollectedAt', 'Status', 'Latitude', 'Longitude', 'AccuracyM']
    const lines = [header.join(',')]
    for (const [depot, ps] of depotEntries) {
      for (const p of ps) {
        const pt = parseEwkbPoint(events.get(p.id)?.location)
        lines.push(
          [
            p.tracking_number,
            depot,
            driverName(metaStr(p, 'collected_by')),
            collAt(p),
            STATUS_LABEL[p.status],
            pt ? pt.lat.toFixed(5) : '',
            pt ? pt.lng.toFixed(5) : '',
            events.get(p.id)?.gps_accuracy_m ?? '',
          ]
            .map(csvField)
            .join(','),
        )
      }
    }
    downloadCsv(`collections_${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\r\n') + '\r\n')
  }

  const withReset =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v)
      setPage(0)
    }

  return (
    <AdminShell
      active="collections"
      title="Collections"
      meta={items ? `${filtered.length} collected · ${depotEntries.length} depot${depotEntries.length === 1 ? '' : 's'}` : '…'}
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{error}</div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => withReset(setSearch)(e.target.value)}
          placeholder="Search tracking, recipient, postcode, depot…"
          className="min-w-0 flex-1 rounded-[10px] border border-line bg-white px-3 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
        />
        <select
          value={depotFilter}
          onChange={(e) => withReset(setDepotFilter)(e.target.value)}
          aria-label="Filter by depot"
          className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
        >
          <option value="all">All depots</option>
          {depots.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select
          value={driverFilter}
          onChange={(e) => withReset(setDriverFilter)(e.target.value)}
          aria-label="Filter by driver"
          className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
        >
          <option value="all">All drivers</option>
          {collectors.map((id) => (
            <option key={id} value={id}>
              {driverName(id)}
            </option>
          ))}
        </select>
        <select
          value={dayFilter}
          onChange={(e) => withReset(setDayFilter)(e.target.value)}
          aria-label="Filter by collection day"
          className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
        >
          <option value="all">All days</option>
          {days.map((d) => (
            <option key={d} value={d}>
              {fmtDayLabel(d)}
            </option>
          ))}
        </select>
        <label className="ml-auto flex flex-none items-center gap-1.5 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => withReset(setShowCompleted)(e.target.checked)}
            className="h-4 w-4 accent-navy"
          />
          Show completed
        </label>
        <button
          type="button"
          disabled={filtered.length === 0}
          onClick={exportCsv}
          className="flex-none rounded-[10px] border border-navy bg-white px-3.5 py-2 font-serif text-[13px] text-navy transition hover:bg-paper active:translate-y-px disabled:opacity-40"
        >
          Export CSV
        </button>
      </div>

      {items && filtered.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white px-4 py-12 text-center text-[13px] text-muted">
          {(items ?? []).length === 0
            ? 'No ad-hoc collections yet. They appear here as drivers scan items at depots (driver app → a depot → “Collect items”).'
            : !showCompleted && !(search || depotFilter !== 'all' || driverFilter !== 'all' || dayFilter !== 'all')
              ? 'Nothing in hand right now — every collection here is complete and has moved to the Captured PODs board. Tick “Show completed” to see them.'
              : 'No collections match these filters.'}
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {shownDepots.map(([depot, ps]) => (
            <section key={depot} className="overflow-hidden rounded-2xl border border-line bg-white">
              <div className="flex items-baseline justify-between gap-3 border-b border-line bg-paper/60 px-4 py-2.5">
                <div className="font-serif text-[15px] text-ink">{depot}</div>
                <span className="font-mono text-[11px] tracking-[0.5px] text-navy-500">
                  {ps.length} item{ps.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex flex-col">
                {ps.slice(0, CARD_ITEM_CAP).map((p) => (
                  <div key={p.id} className="flex items-start justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                    <div className="min-w-0">
                      <div className="font-mono text-[12.5px] tracking-[0.5px] text-navy-500">{p.tracking_number}</div>
                      <div className="truncate text-[12px] text-muted">
                        {driverName(metaStr(p, 'collected_by'))} · {fmtWhen(metaStr(p, 'collected_at'))}
                      </div>
                      <CollLocation ev={events.get(p.id)} />
                    </div>
                    <span className={`flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] ${STATUS_TONE[p.status]}`}>
                      {STATUS_LABEL[p.status]}
                    </span>
                  </div>
                ))}
                {ps.length > CARD_ITEM_CAP && (
                  <div className="px-4 py-2 text-[11.5px] text-muted">
                    +{ps.length - CARD_ITEM_CAP} more — filter to narrow
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            Depots {safePage * DEPOTS_PER_PAGE + 1}–{Math.min((safePage + 1) * DEPOTS_PER_PAGE, depotEntries.length)} of{' '}
            {depotEntries.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              className="rounded-[9px] border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-navy-500 transition hover:border-navy-500/40 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="text-[12px] tabular-nums text-muted">Page {safePage + 1} / {pageCount}</span>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
              className="rounded-[9px] border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-navy-500 transition hover:border-navy-500/40 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </AdminShell>
  )
}

/** The collection scan's location — an OSM pin link + accuracy, or a muted
 *  "no GPS" note (audit parity with the PODs board). */
function CollLocation({ ev }: { ev: CollEvent | undefined }) {
  const pt = parseEwkbPoint(ev?.location)
  if (!pt) return <div className="text-[11px] text-muted">No collection GPS</div>
  return (
    <a
      href={`https://www.openstreetmap.org/?mlat=${pt.lat}&mlon=${pt.lng}#map=17/${pt.lat}/${pt.lng}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] text-navy-500 underline"
    >
      <PinGlyph /> {pt.lat.toFixed(4)}, {pt.lng.toFixed(4)}
      {ev?.gps_accuracy_m != null ? ` ±${ev.gps_accuracy_m}m` : ''}
    </a>
  )
}

function PinGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="inline h-3 w-3 -translate-y-px fill-none stroke-current" strokeWidth="2">
      <path d="M12 21s-7-5.7-7-11a7 7 0 0 1 14 0c0 5.3-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  )
}

const STATUS_TONE: Record<ParcelStatus, string> = {
  awaiting_collection: 'border-line bg-white text-muted',
  collected: 'border-gold/50 bg-gold/10 text-gold',
  at_warehouse: 'border-navy-500/40 bg-navy-500/5 text-navy-500',
  delivered: 'border-ok/40 bg-ok/10 text-ok',
  returned: 'border-fail/40 bg-fail/10 text-fail',
}

/** RFC-4180-ish CSV field quoting. */
function csvField(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** ISO → its local calendar day, YYYY-MM-DD (for the day filter). */
function localDay(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA')
}

/** A local day (YYYY-MM-DD) as "Mon 13 Jul" for the dropdown. */
function fmtDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
}

/** "08 Jul, 16:55" from an ISO string, or "—". */
function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
