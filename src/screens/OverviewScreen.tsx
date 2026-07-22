import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { fmtDistance, parseEwkbPoint } from '../lib/geo'
import { supabase } from '../lib/supabase'
import {
  MAX_DELIVERY_ATTEMPTS,
  STATUS_LABEL,
  STATUS_RANK,
  isRollover,
  type Parcel,
  type ParcelStatus,
  type PodRecord,
} from '../lib/types'

/** Selectable window for the OUTCOME metrics (the pipeline snapshot below is
 *  always "now", independent of this). */
type Range = 'today' | '7d' | '30d' | 'all'
const RANGE_LABEL: Record<Range, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All time' }

/** Epoch-ms floor for a range: local midnight for "today", now−N days otherwise. */
function sinceFor(range: Range): number {
  if (range === 'all') return 0
  if (range === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return Date.now() - (range === '7d' ? 7 : 30) * 86_400_000
}

const mstr = (p: Parcel, k: string) => (typeof p.meta?.[k] === 'string' ? (p.meta[k] as string) : null)
const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN)

/**
 * Admin OVERVIEW — the at-a-glance health of the operation, for both the pilot
 * demo (proof-of-value: success rate, GPS/geofence/signature evidence) and
 * day-to-day ops (pipeline, rollovers, per-driver, failure reasons). Two zones:
 *
 *   • "Right now" — a live snapshot of parcels' CURRENT state (not range-bound).
 *   • The selected window — OUTCOMES derived from the PODs captured in it.
 *
 * Everything aggregates client-side from parcels / pod_records / collection
 * events (pilot volumes are small; mirrors CollectionsScreen's fetch-all shape).
 */
export function OverviewScreen() {
  const { fleet } = useFleet()
  const [parcels, setParcels] = useState<Parcel[] | null>(null)
  const [pods, setPods] = useState<PodRecord[] | null>(null)
  // parcel_id → earliest collection-scan time, for the collect→deliver metric.
  const [collectedAt, setCollectedAt] = useState<Map<string, number>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('7d')
  // Which metric's drill-down modal is open (null = none). The list behind a
  // tile is built lazily from the same rows the tile counts.
  const [drill, setDrill] = useState<MetricId | null>(null)

  const load = useCallback(async () => {
    const [pRes, podRes, evRes] = await Promise.all([
      supabase.from('parcels').select('*'),
      supabase.from('pod_records').select('*'),
      supabase.from('parcel_events').select('parcel_id, captured_at').eq('stage', 'collection'),
    ])
    const err = pRes.error ?? podRes.error ?? evRes.error
    if (err) {
      setError(err.message)
      return
    }
    setError(null)
    setParcels(pRes.data as Parcel[])
    setPods(podRes.data as PodRecord[])
    const first = new Map<string, number>()
    for (const e of (evRes.data ?? []) as { parcel_id: string | null; captured_at: string | null }[]) {
      if (!e.parcel_id) continue
      const t = ms(e.captured_at)
      if (Number.isNaN(t)) continue
      const prev = first.get(e.parcel_id)
      if (prev == null || t < prev) first.set(e.parcel_id, t) // earliest collection
    }
    setCollectedAt(first)
  }, [])

  useEffect(() => {
    void load()
    // Live-refresh as captures/collections land, like the other admin boards.
    const channel = supabase
      .channel('overview-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pod_records' }, () => void load())
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

  // ── "Right now": a snapshot of current parcel state (range-independent) ──
  const snapshot = useMemo(() => {
    const ps = parcels ?? []
    const by = (s: Parcel['status']) => ps.filter((p) => p.status === s).length
    const startToday = new Date()
    startToday.setHours(0, 0, 0, 0)
    return {
      awaiting: by('awaiting_collection'),
      collected: by('collected'),
      atWarehouse: by('at_warehouse'),
      outstanding: by('awaiting_collection') + by('collected') + by('at_warehouse'),
      rollovers: ps.filter((p) => isRollover(p)).length,
      returned: by('returned'),
      deliveredToday: ps.filter((p) => p.status === 'delivered' && ms(p.completed_at) >= startToday.getTime()).length,
    }
  }, [parcels])

  // ── The selected window: outcomes from the PODs captured in it ──
  const period = useMemo(() => {
    const since = sinceFor(range)
    const inRange = (pods ?? []).filter((p) => ms(p.captured_at) >= since)
    const delivered = inRange.filter((p) => p.status === 'delivered')
    const failed = inRange.filter((p) => p.status === 'failed')
    const attempts = inRange.length

    // Evidence quality — the ePOD differentiator.
    const withGps = inRange.filter((p) => p.location != null).length
    const withDist = inRange.filter((p) => p.dest_distance_m != null)
    const near = withDist.filter((p) => (p.dest_distance_m as number) <= 250).length
    const mid = withDist.filter((p) => (p.dest_distance_m as number) > 250 && (p.dest_distance_m as number) <= 1000).length
    const far = withDist.filter((p) => (p.dest_distance_m as number) > 1000).length
    const signed = delivered.filter((p) => p.signature_path != null).length

    // First-attempt success: delivered parcels (completed in range) that logged
    // zero failed attempts. parcels.attempts counts failed attempts.
    const deliveredParcels = (parcels ?? []).filter((p) => p.status === 'delivered' && ms(p.completed_at) >= since)
    const firstTime = deliveredParcels.filter((p) => p.attempts === 0).length

    // Collect→deliver duration: delivered POD time minus the parcel's earliest
    // collection scan. Guard out nonsense (negative / > 30d) so one bad row
    // can't skew the average.
    const durations: number[] = []
    for (const p of delivered) {
      if (!p.parcel_id) continue
      const c = collectedAt.get(p.parcel_id)
      if (c == null) continue
      const d = ms(p.captured_at) - c
      if (d > 0 && d < 30 * 86_400_000) durations.push(d)
    }
    const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null

    // Ad-hoc collections logged in the window.
    const adhoc = (parcels ?? []).filter(
      (p) => p.meta?.source === 'ad-hoc' && (ms(mstr(p, 'collected_at')) >= since || ms(p.created_at) >= since),
    ).length

    // By driver: attempts + success rate, busiest first.
    const byDriverMap = new Map<string, { attempts: number; delivered: number }>()
    for (const p of inRange) {
      const row = byDriverMap.get(p.driver_id) ?? { attempts: 0, delivered: 0 }
      row.attempts++
      if (p.status === 'delivered') row.delivered++
      byDriverMap.set(p.driver_id, row)
    }
    const byDriver = [...byDriverMap.entries()]
      .map(([id, v]) => ({ id, ...v, rate: v.attempts ? v.delivered / v.attempts : 0 }))
      .sort((a, b) => b.attempts - a.attempts)

    // Failure reasons, most common first.
    const reasonMap = new Map<string, number>()
    for (const p of failed) {
      const r = p.failure_reason?.trim() || 'Unspecified'
      reasonMap.set(r, (reasonMap.get(r) ?? 0) + 1)
    }
    const reasons = [...reasonMap.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n)

    return {
      attempts,
      delivered: delivered.length,
      failed: failed.length,
      successRate: attempts ? delivered.length / attempts : null,
      firstTimeRate: deliveredParcels.length ? firstTime / deliveredParcels.length : null,
      deliveredParcels: deliveredParcels.length,
      gpsRate: attempts ? withGps / attempts : null,
      geo: { near, mid, far, withDist: withDist.length },
      geoRate: withDist.length ? near / withDist.length : null,
      sigRate: delivered.length ? signed / delivered.length : null,
      avgDuration,
      adhoc,
      byDriver,
      reasons,
    }
  }, [pods, parcels, collectedAt, range])

  // The open metric's underlying records, built only while a modal is open.
  const drillData = useMemo(
    () => (drill ? buildDrill(drill, { parcels: parcels ?? [], pods: pods ?? [], collectedAt, range, driverName }) : null),
    [drill, parcels, pods, collectedAt, range, driverName],
  )

  const loading = parcels == null || pods == null

  return (
    <AdminShell
      active="overview"
      title="Overview"
      meta={loading ? '…' : `${snapshot.outstanding} outstanding · ${period.attempts} attempts · ${RANGE_LABEL[range].toLowerCase()}`}
      actions={<RangeControl value={range} onChange={setRange} />}
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
          Couldn't load metrics: {error}
        </div>
      )}
      {loading && !error && <div className="py-16 text-center text-[13px] text-muted">Loading metrics…</div>}

      {!loading && (
        <>
          {/* ── Right now: current pipeline ── */}
          <SectionLabel>Right now</SectionLabel>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Outstanding" value={snapshot.outstanding} sub="in the pipeline" onClick={() => setDrill('outstanding')}>
              <StackBar
                segments={[
                  { value: snapshot.awaiting, className: 'bg-muted', label: 'Awaiting' },
                  { value: snapshot.collected, className: 'bg-gold', label: 'Collected' },
                  { value: snapshot.atWarehouse, className: 'bg-navy-500', label: 'Warehouse' },
                ]}
              />
            </Tile>
            <Tile label="Rollovers" value={snapshot.rollovers} tone={snapshot.rollovers > 0 ? 'gold' : 'default'} sub="overdue, still open" onClick={() => setDrill('rollovers')} />
            <Tile label="Delivered today" value={snapshot.deliveredToday} tone="ok" sub="completed since midnight" onClick={() => setDrill('delivered_today')} />
            <Tile label="Returned" value={snapshot.returned} tone={snapshot.returned > 0 ? 'fail' : 'default'} sub="to sender (max attempts)" onClick={() => setDrill('returned')} />
          </div>

          {/* ── Selected window: outcomes ── */}
          <SectionLabel>{RANGE_LABEL[range]} · outcomes</SectionLabel>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Delivery success" value={pct(period.successRate)} tone="ok" sub={`${period.delivered} delivered · ${period.failed} failed`} onClick={() => setDrill('success')}>
              <StackBar
                segments={[
                  { value: period.delivered, className: 'bg-ok', label: 'Delivered' },
                  { value: period.failed, className: 'bg-fail', label: 'Failed' },
                ]}
              />
            </Tile>
            <Tile label="First-attempt success" value={pct(period.firstTimeRate)} sub={`of ${period.deliveredParcels} delivered parcels`} onClick={() => setDrill('first_attempt')} />
            <Tile label="Avg collect → deliver" value={fmtDuration(period.avgDuration)} sub="collection scan to POD" onClick={() => setDrill('avg_duration')} />
            <Tile label="Ad-hoc collected" value={period.adhoc} sub="depot scans, no manifest" onClick={() => setDrill('adhoc')} />

            <Tile label="GPS coverage" value={pct(period.gpsRate)} tone={rateTone(period.gpsRate, 0.9, 0.75)} sub="PODs with a real fix" onClick={() => setDrill('gps')} />
            <Tile label="Within 250 m of address" value={pct(period.geoRate)} sub={`${period.geo.withDist} located PODs`} onClick={() => setDrill('geo')}>
              <StackBar
                segments={[
                  { value: period.geo.near, className: 'bg-ok', label: '≤250 m' },
                  { value: period.geo.mid, className: 'bg-gold', label: '≤1 km' },
                  { value: period.geo.far, className: 'bg-fail', label: '>1 km' },
                ]}
              />
            </Tile>
            <Tile label="Signature captured" value={pct(period.sigRate)} sub="of delivered parcels" onClick={() => setDrill('signature')} />
            <Tile label="Attempts logged" value={period.attempts} sub={`${period.delivered} ok · ${period.failed} failed`} onClick={() => setDrill('attempts')} />
          </div>

          {/* ── Breakdowns ── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="By driver" empty={period.byDriver.length === 0 ? 'No attempts in this window.' : null}>
              {(() => {
                const max = Math.max(1, ...period.byDriver.map((d) => d.attempts))
                return period.byDriver.map((d) => (
                  <BarRow
                    key={d.id}
                    label={driverName(d.id)}
                    value={d.attempts}
                    fraction={d.attempts / max}
                    trailing={`${Math.round(d.rate * 100)}% ok`}
                  />
                ))
              })()}
            </Card>

            <Card title="Failure reasons" empty={period.reasons.length === 0 ? 'No failed attempts — nice.' : null}>
              {(() => {
                const max = Math.max(1, ...period.reasons.map((r) => r.n))
                return period.reasons.map((r) => (
                  <BarRow key={r.reason} label={r.reason} value={r.n} fraction={r.n / max} />
                ))
              })()}
            </Card>
          </div>
        </>
      )}

      {drillData && <MetricModal drill={drillData} onClose={() => setDrill(null)} />}
    </AdminShell>
  )
}

/* ── Presentational pieces ─────────────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-[11px] font-bold uppercase tracking-[1.6px] text-muted">{children}</p>
}

const TONE: Record<'default' | 'ok' | 'gold' | 'fail', string> = {
  default: 'text-ink',
  ok: 'text-ok',
  gold: 'text-gold',
  fail: 'text-fail',
}

/** A single KPI: label, big number, optional sub-line and a thin bar under it.
 *  With `onClick` the whole tile becomes a button that opens the drill-down
 *  modal — an arrow appears on hover/focus to signal it's clickable. */
function Tile({
  label,
  value,
  sub,
  tone = 'default',
  onClick,
  children,
}: {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'ok' | 'gold' | 'fail'
  onClick?: () => void
  children?: React.ReactNode
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10.5px] font-bold uppercase tracking-[0.8px] text-muted">{label}</div>
        {onClick && (
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className="h-3.5 w-3.5 flex-none text-muted/35 transition group-hover:text-navy-500 group-focus-visible:text-navy-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        )}
      </div>
      <div className={`mt-1 font-serif text-[30px] leading-none tabular-nums ${TONE[tone]}`}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] leading-snug text-muted">{sub}</div>}
      {children && <div className="mt-auto pt-3">{children}</div>}
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="group flex flex-col rounded-2xl border border-line bg-white p-4 text-left transition hover:border-navy-500/50 hover:bg-navy-500/[0.02] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-navy-500/15"
      >
        {body}
      </button>
    )
  }
  return <div className="flex flex-col rounded-2xl border border-line bg-white p-4">{body}</div>
}

/** Thin stacked magnitude bar with a labelled key beneath. Empty → a hairline
 *  track so the tile height stays consistent. 2px gaps between fills. */
function StackBar({ segments }: { segments: { value: number; className: string; label: string }[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-paper">
        {total === 0
          ? null
          : segments
              .filter((s) => s.value > 0)
              .map((s) => (
                <div key={s.label} className={`h-full rounded-full ${s.className}`} style={{ flex: s.value }} />
              ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
            <span className={`h-2 w-2 flex-none rounded-full ${s.className}`} />
            {s.label} <span className="font-mono tabular-nums text-ink">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** A breakdown card wrapping a list of BarRows (or an empty note). */
function Card({ title, empty, children }: { title: string; empty: string | null; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4">
      <p className="mb-3 text-[11px] font-bold uppercase tracking-[1.6px] text-muted">{title}</p>
      {empty ? <p className="py-6 text-center text-[13px] text-muted">{empty}</p> : <div className="flex flex-col gap-2.5">{children}</div>}
    </section>
  )
}

/** One horizontal magnitude bar: label over a single-hue fill, value at the
 *  right, optional trailing note (e.g. success rate). */
function BarRow({ label, value, fraction, trailing }: { label: string; value: number; fraction: number; trailing?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="min-w-0 truncate text-ink">{label}</span>
        <span className="flex-none tabular-nums text-muted">
          <span className="font-semibold text-ink">{value}</span>
          {trailing && <span> · {trailing}</span>}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-paper">
        <div className="h-full rounded-full bg-navy-500" style={{ width: `${Math.max(fraction * 100, 2)}%` }} />
      </div>
    </div>
  )
}

/** Today / 7d / 30d / All segmented control for the outcome window. */
function RangeControl({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex gap-0.5 rounded-[10px] border border-line bg-white p-0.5">
      {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={`rounded-[7px] px-3 py-1.5 text-[12.5px] font-semibold transition ${
            value === r ? 'bg-navy text-white' : 'text-muted hover:text-ink'
          }`}
        >
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  )
}

/* ── formatters ── */

function pct(x: number | null): string {
  return x == null ? '—' : `${Math.round(x * 100)}%`
}

function rateTone(x: number | null, okAt: number, warnAt: number): 'default' | 'ok' | 'gold' | 'fail' {
  if (x == null) return 'default'
  if (x >= okAt) return 'ok'
  if (x >= warnAt) return 'gold'
  return 'fail'
}

/** ms → "2d 3h" / "4h 20m" / "35m" / "—". */
function fmtDuration(msVal: number | null): string {
  if (msVal == null) return '—'
  const mins = Math.round(msVal / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

/* ── Metric drill-down ──────────────────────────────────────────────────────
 * Clicking a tile opens a modal listing the exact records behind its number,
 * so a dispatcher can go straight from "4 rollovers" to *which* four. Each
 * metric normalises its parcels/PODs into a common DrillRow, so one renderer
 * serves them all. Built lazily (only while a modal is open). */

/** Every clickable tile, keyed to the rows it counts. */
type MetricId =
  | 'outstanding'
  | 'rollovers'
  | 'delivered_today'
  | 'returned'
  | 'success'
  | 'attempts'
  | 'first_attempt'
  | 'avg_duration'
  | 'adhoc'
  | 'gps'
  | 'geo'
  | 'signature'

type PillTone = 'ok' | 'fail' | 'gold' | 'navy' | 'muted'

const PILL: Record<PillTone, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok',
  fail: 'border-fail/40 bg-fail/10 text-fail',
  gold: 'border-gold/50 bg-gold/10 text-gold',
  navy: 'border-navy-500/40 bg-navy-500/5 text-navy-500',
  muted: 'border-line bg-white text-muted',
}

const STATUS_PILL: Record<ParcelStatus, PillTone> = {
  awaiting_collection: 'muted',
  collected: 'gold',
  at_warehouse: 'navy',
  delivered: 'ok',
  returned: 'fail',
}

interface DrillRow {
  id: string
  /** primary line — the tracking number (mono) */
  tracking: string
  /** secondary line — recipient · area, or driver · received-by */
  secondary?: string
  /** a located POD's fix, rendered as an OSM pin link */
  point?: { lat: number; lng: number } | null
  accuracy?: number | null
  /** right-aligned timestamp / due date */
  when?: string
  tags?: { label: string; tone: PillTone }[]
}

interface Drill {
  title: string
  subtitle?: string
  emptyNote: string
  rows: DrillRow[]
  /** how many rows past the cap were dropped (see ROW_CAP) */
  truncated?: number
}

interface DrillCtx {
  parcels: Parcel[]
  pods: PodRecord[]
  collectedAt: Map<string, number>
  range: Range
  driverName: (id: string | null | undefined) => string
}

/** Keep the modal snappy on a big "all time" set — show the most relevant
 *  (each metric sorts worst/newest first) and note the remainder. */
const ROW_CAP = 300

function buildDrill(id: MetricId, ctx: DrillCtx): Drill {
  const { parcels, pods, collectedAt, range, driverName } = ctx
  const since = sinceFor(range)
  const win = RANGE_LABEL[range]
  const inRange = pods.filter((p) => ms(p.captured_at) >= since)

  const cap = (rows: DrillRow[]) =>
    rows.length > ROW_CAP ? { rows: rows.slice(0, ROW_CAP), truncated: rows.length - ROW_CAP } : { rows }

  // A parcel → row (defaults: recipient·area secondary, current-status pill).
  const parcelRow = (p: Parcel, extra?: Partial<DrillRow>): DrillRow => ({
    id: p.id,
    tracking: p.tracking_number,
    secondary: [p.recipient_name, p.delivery_area || p.postcode].filter(Boolean).join(' · ') || undefined,
    tags: [{ label: STATUS_LABEL[p.status], tone: STATUS_PILL[p.status] }],
    ...extra,
  })

  // A POD → row (defaults: driver · received-by secondary, capture time).
  const podRow = (p: PodRecord, extra?: Partial<DrillRow>): DrillRow => ({
    id: p.id,
    tracking: p.tracking_scanned,
    secondary: [driverName(p.driver_id), p.received_by].filter(Boolean).join(' · ') || undefined,
    when: fmtWhen(p.captured_at),
    ...extra,
  })

  switch (id) {
    case 'outstanding': {
      const rows = parcels
        .filter((p) => p.status === 'awaiting_collection' || p.status === 'collected' || p.status === 'at_warehouse')
        .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.due_date.localeCompare(b.due_date))
        .map((p) => parcelRow(p, { when: `due ${fmtDay(p.due_date)}` }))
      return {
        title: 'Outstanding parcels',
        subtitle: 'Still in the pipeline — awaiting collection, collected, or at the warehouse.',
        emptyNote: 'Nothing outstanding — the pipeline is clear.',
        ...cap(rows),
      }
    }
    case 'rollovers': {
      const rows = parcels
        .filter((p) => isRollover(p))
        .sort((a, b) => a.due_date.localeCompare(b.due_date))
        .map((p) =>
          parcelRow(p, {
            when: `due ${fmtDay(p.due_date)}`,
            tags: [
              { label: STATUS_LABEL[p.status], tone: STATUS_PILL[p.status] },
              { label: `${daysOverdue(p.due_date)}d overdue`, tone: 'gold' },
            ],
          }),
        )
      return {
        title: 'Rollovers',
        subtitle: 'Overdue and still open — most overdue first.',
        emptyNote: 'No rollovers — everything is on schedule.',
        ...cap(rows),
      }
    }
    case 'delivered_today': {
      const startToday = new Date()
      startToday.setHours(0, 0, 0, 0)
      const rows = parcels
        .filter((p) => p.status === 'delivered' && ms(p.completed_at) >= startToday.getTime())
        .sort((a, b) => ms(b.completed_at) - ms(a.completed_at))
        .map((p) => parcelRow(p, { when: fmtWhen(p.completed_at), tags: [{ label: 'Delivered', tone: 'ok' }] }))
      return {
        title: 'Delivered today',
        subtitle: 'Completed since midnight.',
        emptyNote: 'Nothing delivered yet today.',
        ...cap(rows),
      }
    }
    case 'returned': {
      const rows = parcels
        .filter((p) => p.status === 'returned')
        .sort((a, b) => ms(b.completed_at) - ms(a.completed_at))
        .map((p) =>
          parcelRow(p, {
            when: p.completed_at ? fmtWhen(p.completed_at) : undefined,
            tags: [
              { label: 'Returned', tone: 'fail' },
              ...(p.last_failure ? [{ label: p.last_failure, tone: 'muted' as const }] : []),
            ],
          }),
        )
      return {
        title: 'Returned to sender',
        subtitle: `Hit the ${MAX_DELIVERY_ATTEMPTS}-attempt limit.`,
        emptyNote: 'No returns — nothing has maxed out its attempts.',
        ...cap(rows),
      }
    }
    case 'success':
    case 'attempts': {
      const rows = inRange
        .slice()
        .sort((a, b) => ms(b.captured_at) - ms(a.captured_at))
        .map((p) =>
          podRow(p, {
            tags:
              p.status === 'delivered'
                ? [{ label: 'Delivered', tone: 'ok' }]
                : [
                    { label: 'Failed', tone: 'fail' },
                    ...(p.failure_reason?.trim() ? [{ label: p.failure_reason.trim(), tone: 'muted' as const }] : []),
                  ],
          }),
        )
      return {
        title: id === 'success' ? 'Delivery outcomes' : 'Attempts logged',
        subtitle: `${win} · every delivery attempt`,
        emptyNote: 'No attempts in this window.',
        ...cap(rows),
      }
    }
    case 'first_attempt': {
      const rows = parcels
        .filter((p) => p.status === 'delivered' && ms(p.completed_at) >= since)
        .sort((a, b) => ms(b.completed_at) - ms(a.completed_at))
        .map((p) =>
          parcelRow(p, {
            when: fmtWhen(p.completed_at),
            tags:
              p.attempts === 0
                ? [{ label: 'First time', tone: 'ok' }]
                : [{ label: `${p.attempts + 1} attempts`, tone: 'gold' }],
          }),
        )
      return {
        title: 'First-attempt success',
        subtitle: `${win} · delivered parcels`,
        emptyNote: 'No delivered parcels in this window.',
        ...cap(rows),
      }
    }
    case 'avg_duration': {
      const withD: { p: PodRecord; d: number }[] = []
      for (const p of inRange) {
        if (p.status !== 'delivered' || !p.parcel_id) continue
        const c = collectedAt.get(p.parcel_id)
        if (c == null) continue
        const d = ms(p.captured_at) - c
        if (d > 0 && d < 30 * 86_400_000) withD.push({ p, d })
      }
      withD.sort((a, b) => b.d - a.d)
      const rows = withD.map(({ p, d }) => podRow(p, { tags: [{ label: fmtDuration(d), tone: 'navy' }] }))
      return {
        title: 'Collect → deliver times',
        subtitle: `${win} · collection scan to POD, longest first`,
        emptyNote: 'No delivered PODs with a matching collection scan.',
        ...cap(rows),
      }
    }
    case 'adhoc': {
      const at = (p: Parcel) => {
        const c = ms(mstr(p, 'collected_at'))
        return Number.isNaN(c) ? ms(p.created_at) : c
      }
      const rows = parcels
        .filter((p) => p.meta?.source === 'ad-hoc' && (ms(mstr(p, 'collected_at')) >= since || ms(p.created_at) >= since))
        .sort((a, b) => at(b) - at(a))
        .map((p) =>
          parcelRow(p, {
            secondary: [mstr(p, 'site_name') ?? 'Depot', driverName(mstr(p, 'collected_by'))].filter(Boolean).join(' · '),
            when: fmtWhen(mstr(p, 'collected_at') ?? p.created_at),
          }),
        )
      return {
        title: 'Ad-hoc collections',
        subtitle: `${win} · depot scans, no manifest`,
        emptyNote: 'No ad-hoc collections in this window.',
        ...cap(rows),
      }
    }
    case 'gps': {
      const rows = inRange
        .slice()
        // problems first: no-fix rows to the top, then newest.
        .sort((a, b) => Number(a.location != null) - Number(b.location != null) || ms(b.captured_at) - ms(a.captured_at))
        .map((p) =>
          podRow(p, {
            point: parseEwkbPoint(p.location),
            accuracy: p.gps_accuracy_m,
            tags:
              p.location != null
                ? [{ label: p.gps_source === 'photo_exif' ? 'EXIF fix' : 'Device fix', tone: 'ok' }]
                : [{ label: 'No fix', tone: 'fail' }],
          }),
        )
      return {
        title: 'GPS coverage',
        subtitle: `${win} · PODs with a real fix`,
        emptyNote: 'No attempts in this window.',
        ...cap(rows),
      }
    }
    case 'geo': {
      const rows = inRange
        .filter((p) => p.dest_distance_m != null)
        .sort((a, b) => (b.dest_distance_m as number) - (a.dest_distance_m as number)) // farthest first
        .map((p) => {
          const m = p.dest_distance_m as number
          return podRow(p, {
            point: parseEwkbPoint(p.location),
            accuracy: p.gps_accuracy_m,
            tags: [{ label: fmtDistance(m), tone: m <= 250 ? 'ok' : m <= 1000 ? 'gold' : 'fail' }],
          })
        })
      return {
        title: 'Distance from address',
        subtitle: `${win} · located PODs, farthest first`,
        emptyNote: 'No located PODs in this window.',
        ...cap(rows),
      }
    }
    case 'signature': {
      const rows = inRange
        .filter((p) => p.status === 'delivered')
        // missing signatures first, then newest.
        .sort((a, b) => Number(a.signature_path != null) - Number(b.signature_path != null) || ms(b.captured_at) - ms(a.captured_at))
        .map((p) =>
          podRow(p, {
            tags:
              p.signature_path != null
                ? [{ label: 'Signed', tone: 'ok' }]
                : [{ label: 'No signature', tone: 'muted' }],
          }),
        )
      return {
        title: 'Signature captured',
        subtitle: `${win} · delivered parcels`,
        emptyNote: 'No delivered parcels in this window.',
        ...cap(rows),
      }
    }
  }
}

/** The drill-down overlay: a dismissable dialog listing the records behind a
 *  metric. Esc / backdrop / ✕ close it; body scroll is locked while open. */
function MetricModal({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex overflow-y-auto bg-ink/50 p-4 backdrop-blur-[2px] sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={drill.title}
        onClick={(e) => e.stopPropagation()}
        className="m-auto w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-serif text-[18px] leading-tight text-ink">{drill.title}</h2>
            {drill.subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{drill.subtitle}</p>}
          </div>
          <div className="flex flex-none items-center gap-3">
            <span className="font-mono text-[12px] tabular-nums text-navy-500">
              {drill.rows.length}
              {drill.truncated ? `/${drill.rows.length + drill.truncated}` : ''}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted transition hover:bg-paper hover:text-ink"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="max-h-[65vh] overflow-y-auto">
          {drill.rows.length === 0 ? (
            <p className="px-5 py-12 text-center text-[13px] text-muted">{drill.emptyNote}</p>
          ) : (
            <ul className="divide-y divide-line">
              {drill.rows.map((r) => (
                <DrillRowView key={r.id} row={r} />
              ))}
            </ul>
          )}
          {drill.truncated ? (
            <p className="border-t border-line px-5 py-2.5 text-center text-[11.5px] text-muted">
              +{drill.truncated} more not shown
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** One record in the drill-down list. */
function DrillRowView({ row }: { row: DrillRow }) {
  return (
    <li className="flex items-start justify-between gap-3 px-5 py-2.5">
      <div className="min-w-0">
        <div className="font-mono text-[12.5px] tracking-[0.5px] text-navy-500">{row.tracking}</div>
        {row.secondary && <div className="mt-0.5 truncate text-[12px] text-muted">{row.secondary}</div>}
        {row.point && (
          <a
            href={`https://www.openstreetmap.org/?mlat=${row.point.lat}&mlon=${row.point.lng}#map=17/${row.point.lat}/${row.point.lng}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-navy-500 underline"
          >
            <svg viewBox="0 0 24 24" className="inline h-3 w-3 -translate-y-px fill-none stroke-current" strokeWidth="2">
              <path d="M12 21s-7-5.7-7-11a7 7 0 0 1 14 0c0 5.3-7 11-7 11z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
            {row.point.lat.toFixed(4)}, {row.point.lng.toFixed(4)}
            {row.accuracy != null ? ` ±${row.accuracy}m` : ''}
          </a>
        )}
        {row.tags && row.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.tags.map((t, i) => (
              <span
                key={i}
                className={`rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.5px] ${PILL[t.tone]}`}
              >
                {t.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {row.when && <span className="flex-none whitespace-nowrap text-[11.5px] tabular-nums text-muted">{row.when}</span>}
    </li>
  )
}

/** "08 Jul, 16:55" from an ISO string, or "—". */
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "20 Jul" from a YYYY-MM-DD run date. */
function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

/** Whole days a run date is past today (rollover age). */
function daysOverdue(day: string, today = new Date()): number {
  const due = new Date(`${day}T00:00:00`).getTime()
  const start = new Date(today)
  start.setHours(0, 0, 0, 0)
  if (Number.isNaN(due)) return 0
  return Math.max(0, Math.round((start.getTime() - due) / 86_400_000))
}
