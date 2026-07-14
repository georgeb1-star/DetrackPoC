import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { supabase } from '../lib/supabase'
import { isRollover, type Parcel, type PodRecord } from '../lib/types'

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
            <Tile label="Outstanding" value={snapshot.outstanding} sub="in the pipeline">
              <StackBar
                segments={[
                  { value: snapshot.awaiting, className: 'bg-muted', label: 'Awaiting' },
                  { value: snapshot.collected, className: 'bg-gold', label: 'Collected' },
                  { value: snapshot.atWarehouse, className: 'bg-navy-500', label: 'Warehouse' },
                ]}
              />
            </Tile>
            <Tile label="Rollovers" value={snapshot.rollovers} tone={snapshot.rollovers > 0 ? 'gold' : 'default'} sub="overdue, still open" />
            <Tile label="Delivered today" value={snapshot.deliveredToday} tone="ok" sub="completed since midnight" />
            <Tile label="Returned" value={snapshot.returned} tone={snapshot.returned > 0 ? 'fail' : 'default'} sub="to sender (max attempts)" />
          </div>

          {/* ── Selected window: outcomes ── */}
          <SectionLabel>{RANGE_LABEL[range]} · outcomes</SectionLabel>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Delivery success" value={pct(period.successRate)} tone="ok" sub={`${period.delivered} delivered · ${period.failed} failed`}>
              <StackBar
                segments={[
                  { value: period.delivered, className: 'bg-ok', label: 'Delivered' },
                  { value: period.failed, className: 'bg-fail', label: 'Failed' },
                ]}
              />
            </Tile>
            <Tile label="First-attempt success" value={pct(period.firstTimeRate)} sub={`of ${period.deliveredParcels} delivered parcels`} />
            <Tile label="Avg collect → deliver" value={fmtDuration(period.avgDuration)} sub="collection scan to POD" />
            <Tile label="Ad-hoc collected" value={period.adhoc} sub="depot scans, no manifest" />

            <Tile label="GPS coverage" value={pct(period.gpsRate)} tone={rateTone(period.gpsRate, 0.9, 0.75)} sub="PODs with a real fix" />
            <Tile label="Within 250 m of address" value={pct(period.geoRate)} sub={`${period.geo.withDist} located PODs`}>
              <StackBar
                segments={[
                  { value: period.geo.near, className: 'bg-ok', label: '≤250 m' },
                  { value: period.geo.mid, className: 'bg-gold', label: '≤1 km' },
                  { value: period.geo.far, className: 'bg-fail', label: '>1 km' },
                ]}
              />
            </Tile>
            <Tile label="Signature captured" value={pct(period.sigRate)} sub="of delivered parcels" />
            <Tile label="Attempts logged" value={period.attempts} sub={`${period.delivered} ok · ${period.failed} failed`} />
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

/** A single KPI: label, big number, optional sub-line and a thin bar under it. */
function Tile({
  label,
  value,
  sub,
  tone = 'default',
  children,
}: {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'ok' | 'gold' | 'fail'
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-white p-4">
      <div className="text-[10.5px] font-bold uppercase tracking-[0.8px] text-muted">{label}</div>
      <div className={`mt-1 font-serif text-[30px] leading-none tabular-nums ${TONE[tone]}`}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] leading-snug text-muted">{sub}</div>}
      {children && <div className="mt-auto pt-3">{children}</div>}
    </div>
  )
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
