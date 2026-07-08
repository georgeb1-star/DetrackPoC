import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { useFleet } from '../hooks/useFleet'
import { supabase } from '../lib/supabase'
import type { Parcel } from '../lib/types'

/** Return-to-base reconciliation (meeting ask #3). At base, someone scans the
 *  physical items in front of them; the screen cross-references each against the
 *  system's OUT-list — parcels the system has as 'collected' (optionally also
 *  'at_warehouse') — and surfaces three buckets live: accounted-for, still-out
 *  (expected but not scanned), and unexpected (scanned but not on the out-list).
 *  Read-only: it reports differences, it doesn't move any parcel. Session-scoped
 *  — a fresh page is a fresh count. */
export function ReconcileScreen() {
  const { fleet } = useFleet()
  const [outParcels, setOutParcels] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [routeFilter, setRouteFilter] = useState<string>('all')
  const [includeWarehouse, setIncludeWarehouse] = useState(false)
  const [scanned, setScanned] = useState<string[]>([]) // unique, newest-first, upper-cased
  const [typed, setTyped] = useState('')
  const lastScanRef = useRef({ v: '', t: 0 })

  const load = useCallback(async () => {
    const statuses = includeWarehouse ? ['collected', 'at_warehouse'] : ['collected']
    const { data, error } = await supabase.from('parcels').select('*').in('status', statuses).order('tracking_number')
    if (error) setError(error.message)
    else {
      setOutParcels(data as Parcel[])
      setError(null)
    }
  }, [includeWarehouse])

  // Realtime: keep the out-list live as parcels move (a driver delivering, or a
  // fresh ad-hoc collection landing) — mirrors the other dispatch boards.
  useEffect(() => {
    void load()
    const channel = supabase
      .channel('reconcile-feed')
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

  const out = useMemo(
    () => (outParcels ?? []).filter((p) => routeFilter === 'all' || p.route_id === routeFilter),
    [outParcels, routeFilter],
  )
  const scannedSet = useMemo(() => new Set(scanned), [scanned])
  const outTrackings = useMemo(() => new Set(out.map((p) => p.tracking_number.toUpperCase())), [out])

  const accounted = useMemo(() => out.filter((p) => scannedSet.has(p.tracking_number.toUpperCase())), [out, scannedSet])
  const missing = useMemo(() => out.filter((p) => !scannedSet.has(p.tracking_number.toUpperCase())), [out, scannedSet])
  const unexpected = useMemo(() => scanned.filter((s) => !outTrackings.has(s)), [scanned, outTrackings])

  function scan(raw: string, source: 'scan' | 'type') {
    const v = raw.trim().toUpperCase()
    if (!v) return
    if (source === 'scan') {
      const now = Date.now()
      if (lastScanRef.current.v === v && now - lastScanRef.current.t < 2500) return
      lastScanRef.current = { v, t: now }
    }
    navigator.vibrate?.(50)
    setScanned((prev) => (prev.includes(v) ? prev : [v, ...prev]))
    setTyped('')
  }

  const pct = out.length ? Math.round((accounted.length / out.length) * 100) : 0

  return (
    <AdminShell
      active="reconcile"
      title="Reconcile returns"
      meta={outParcels ? `${accounted.length}/${out.length} accounted · ${unexpected.length} unexpected` : '…'}
      actions={
        <button
          type="button"
          disabled={scanned.length === 0}
          onClick={() => setScanned([])}
          className="rounded-[10px] border border-line bg-white px-4 py-2.5 font-serif text-[13.5px] text-muted transition hover:border-navy-500/40 disabled:opacity-40"
        >
          Reset scan
        </button>
      }
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{error}</div>
      )}

      {/* Controls: which out-list to reconcile against */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] text-muted">
          Route
          <select
            value={routeFilter}
            onChange={(e) => setRouteFilter(e.target.value)}
            className="rounded-[10px] border border-line bg-white px-2.5 py-2 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
          >
            <option value="all">All routes</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {driverName(r.driver_id)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={includeWarehouse} onChange={(e) => setIncludeWarehouse(e.target.checked)} />
          Include at-warehouse
        </label>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        {/* Scan panel + progress */}
        <section>
          <div className="mb-4 rounded-2xl border border-line bg-white p-4">
            <div className="flex items-baseline justify-between">
              <span className="section-label">Accounted for</span>
              <span className="font-mono text-[13px] text-navy-500">{accounted.length}/{out.length}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-[12px] text-muted">
              <span>{missing.length} still out</span>
              <span className={unexpected.length ? 'font-semibold text-fail' : ''}>{unexpected.length} unexpected</span>
            </div>
          </div>

          <p className="section-label mb-2">Scan a returned item</p>
          <BarcodeScanner onDecode={(v) => scan(v, 'scan')} />
          <p className="section-label mb-2 mt-4">Or type the barcode</p>
          <div className="flex gap-2">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && scan(typed, 'type')}
              placeholder="Item barcode"
              className="min-w-0 flex-1 rounded-[11px] border border-line bg-white px-3 py-[11px] font-mono text-sm uppercase tracking-[1px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
            />
            <button type="button" onClick={() => scan(typed, 'type')} className="flex-none rounded-[11px] bg-navy px-4 font-serif text-[15px] text-white">
              Scan
            </button>
          </div>
        </section>

        {/* Exceptions + accounted lists */}
        <section className="grid items-start gap-6 sm:grid-cols-2 xl:grid-cols-3">
          <Bucket
            title="Still out"
            tone="warn"
            empty="Nothing outstanding."
            items={missing}
            renderItem={(p) => <Line key={p.id} tn={p.tracking_number} sub={`${p.recipient_name} · ${p.delivery_area || '?'}`} />}
          />
          <Bucket
            title="Unexpected"
            tone="fail"
            empty="No surprises."
            items={unexpected}
            renderItem={(tn) => <Line key={tn} tn={tn} sub="Not on the out-list" tone="fail" />}
          />
          <Bucket
            title="Accounted for"
            tone="ok"
            empty="Scan items to begin."
            items={accounted}
            renderItem={(p) => <Line key={p.id} tn={p.tracking_number} sub={p.recipient_name} tone="ok" />}
          />
        </section>
      </div>
    </AdminShell>
  )
}

function Bucket<T>({
  title,
  tone,
  empty,
  items,
  renderItem,
}: {
  title: string
  tone: 'ok' | 'warn' | 'fail'
  empty: string
  items: T[]
  renderItem: (item: T) => React.ReactNode
}) {
  const [page, setPage] = useState(0)
  const PAGE = 10
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE))
  const safePage = Math.min(page, pageCount - 1)
  const shown = items.slice(safePage * PAGE, safePage * PAGE + PAGE)
  const dot = tone === 'ok' ? 'bg-ok' : tone === 'fail' ? 'bg-fail' : 'bg-gold'
  return (
    <div>
      <p className="section-label mb-2 flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        {title} · {items.length}
      </p>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[12.5px] text-muted">{empty}</div>
      ) : (
        <>
          <div className="flex flex-col gap-2">{shown.map(renderItem)}</div>
          {pageCount > 1 && (
            <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-muted">
              <span>
                {safePage * PAGE + 1}–{Math.min((safePage + 1) * PAGE, items.length)} of {items.length}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                  className="rounded-[7px] border border-line bg-white px-2 py-0.5 font-semibold text-navy-500 disabled:opacity-40"
                >
                  Prev
                </button>
                <span className="tabular-nums">{safePage + 1}/{pageCount}</span>
                <button
                  type="button"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                  className="rounded-[7px] border border-line bg-white px-2 py-0.5 font-semibold text-navy-500 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Line({ tn, sub, tone }: { tn: string; sub: string; tone?: 'ok' | 'fail' }) {
  const border = tone === 'ok' ? 'border-ok/30' : tone === 'fail' ? 'border-fail/40' : 'border-line'
  return (
    <div className={`rounded-[11px] border ${border} bg-white px-3.5 py-2.5`}>
      <div className="font-mono text-[12.5px] tracking-[0.5px] text-navy-500">{tn}</div>
      <div className="truncate text-[12px] text-muted">{sub}</div>
    </div>
  )
}
