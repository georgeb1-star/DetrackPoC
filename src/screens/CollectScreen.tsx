import { useRef, useState } from 'react'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { TopBar } from '../components/TopBar'
import { NO_FIX_NOTES, useGeolocation } from '../hooks/useGeolocation'
import { queueAdhocScan } from '../lib/adhoc'
import { syncNow } from '../lib/syncWorker'
import type { Site } from '../lib/types'

/** Ad-hoc COLLECTION at a depot (meeting ask #2). The driver rapid-scans items
 *  that were never pre-alerted — no parcel to match — and each becomes a
 *  'collected' parcel via the create_adhoc_parcel RPC on sync. No photo or
 *  signature: collection is a quick barcode + time + GPS, like a stage scan.
 *  Scanning is local-first, so it works offline and the queue drains later. */
export function CollectScreen({
  site,
  driverId,
  onBack,
}: {
  site: Site
  driverId: string
  onBack: () => void
}) {
  const { fix, noFixReason, acquiring, getFix, retry } = useGeolocation()
  const [typed, setTyped] = useState('')
  const [items, setItems] = useState<{ tracking: string; at: Date }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dupe, setDupe] = useState<string | null>(null)
  const lastScanRef = useRef({ v: '', t: 0 })
  const seen = useRef<Set<string>>(new Set()) // dedupe within this depot visit

  async function collect(raw: string, source: 'scan' | 'type') {
    const v = raw.trim().toUpperCase()
    if (!v || busy) return
    if (source === 'scan') {
      const now = Date.now()
      if (lastScanRef.current.v === v && now - lastScanRef.current.t < 2500) return
      lastScanRef.current = { v, t: now }
    }
    // Already collected on this visit → flag it, don't double-queue.
    if (seen.current.has(v)) {
      setDupe(v)
      setTyped('')
      return
    }
    setBusy(true)
    setError(null)
    setDupe(null)
    try {
      navigator.vibrate?.(60)
      const at = new Date()
      const location = await getFix() // fresh fix per item; null if no real fix
      await queueAdhocScan({
        trackingScanned: v,
        siteId: site.id,
        siteName: site.name,
        capturedAt: at,
        location,
        driverId,
      })
      void syncNow()
      seen.current.add(v)
      setItems((prev) => [{ tracking: v, at }, ...prev])
      setTyped('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <>
      <TopBar
        eyebrow="Citipost · Depot collection"
        title={site.name}
        mono={`${items.length} collected`}
        onBack={onBack}
      />

      <div className="mx-auto w-full max-w-2xl px-4 py-5 lg:px-8 lg:py-7">
        <div className="mb-5 rounded-2xl border border-line bg-white px-4 py-3.5">
          <div className="text-[15px] font-semibold">{site.name}</div>
          <div className="mt-0.5 text-[13px] leading-[1.45] text-muted">
            {site.address_line || 'No address on file'}
            {site.postcode ? `, ${site.postcode}` : ''}
          </div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.6px] text-gold">
            Not pre-alerted · scan whatever comes out
          </div>
        </div>

        {/* GPS state — collection records carry a real-or-nothing fix, like a POD */}
        <div className="mb-4 flex items-center justify-between rounded-[11px] border border-line bg-white px-[11px] py-[9px]">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">GPS location</div>
            <div className={`mt-[3px] text-[13px] tabular-nums ${fix ? 'font-semibold' : acquiring ? 'font-medium text-muted' : 'font-semibold text-fail'}`}>
              {fix ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}` : acquiring ? 'acquiring…' : 'no fix'}
            </div>
          </div>
          {!fix && !acquiring && noFixReason && (
            <button type="button" onClick={retry} className="text-[12px] font-semibold text-navy-500 underline">
              Retry GPS
            </button>
          )}
        </div>
        {!fix && !acquiring && noFixReason && (
          <p className="mb-4 -mt-2 text-[11.5px] leading-snug text-muted">{NO_FIX_NOTES[noFixReason]}</p>
        )}

        {error && (
          <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{error}</div>
        )}
        {dupe && (
          <div className="mb-3 rounded-[11px] border border-gold/40 bg-gold/10 px-3 py-2.5 text-[13px] text-ink">
            <span className="font-mono">{dupe}</span> is already collected here this visit.
          </div>
        )}

        <p className="section-label mb-2">Scan an item</p>
        <BarcodeScanner onDecode={(v) => void collect(v, 'scan')} />

        <p className="section-label mb-2 mt-4">Or type the barcode</p>
        <div className="flex gap-2">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void collect(typed, 'type')}
            placeholder="Item barcode"
            className="min-w-0 flex-1 rounded-[11px] border border-line bg-white px-3 py-[11px] font-mono text-sm uppercase tracking-[1px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void collect(typed, 'type')}
            className="flex-none rounded-[11px] bg-navy px-4 font-serif text-[15px] text-white disabled:opacity-40"
          >
            Collect
          </button>
        </div>

        {items.length > 0 && (
          <>
            <p className="section-label mb-2 mt-6">Collected this visit · {items.length}</p>
            <div className="overflow-hidden rounded-2xl border border-line bg-white">
              {items.map((it, i) => (
                <div
                  key={it.tracking}
                  className={`flex items-center justify-between px-4 py-2.5 ${i > 0 ? 'border-t border-line' : ''}`}
                >
                  <span className="font-mono text-[13px] tracking-[1px] text-navy-500">{it.tracking}</span>
                  <span className="text-[11.5px] tabular-nums text-muted">
                    {it.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <button
          type="button"
          onClick={onBack}
          className="mt-6 w-full rounded-[11px] border border-line bg-white p-[12px] text-[13.5px] font-semibold text-muted"
        >
          Done at this depot
        </button>
      </div>
    </>
  )
}
