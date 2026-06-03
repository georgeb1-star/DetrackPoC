import { useRef, useState } from 'react'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { TopBar } from '../components/TopBar'
import { useSyncStatus } from '../hooks/useSyncStatus'
import type { Parcel } from '../lib/types'

const STATUS_STYLES: Record<Parcel['status'], string> = {
  pending: 'text-muted',
  delivered: 'text-ok',
  failed: 'text-fail',
}

/** Driver home (§6.1): prominent Scan label entry, then today's seeded stops. */
export function StopsScreen({
  parcels,
  error,
  onSelect,
}: {
  parcels: Parcel[] | null
  error: string | null
  onSelect: (parcel: Parcel, scannedValue?: string) => void
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  // Offline, the server still says "pending" — overlay the local queue so a
  // captured stop reads as done the moment the driver completes it
  const { queuedParcels } = useSyncStatus()

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  })

  return (
    <>
      <TopBar
        eyebrow="Citipost · Today's run"
        title="Today's stops"
        mono={parcels ? `${parcels.length} stops · ${today}` : today}
      />

      <div className="px-[18px] pb-2 pt-4">
        {/* The scan-to-attach path is the feature that matters most (§5) —
            it gets the prominent slot. Camera scanning lands in Checkpoint 5;
            the type-in fallback works now. */}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="flex w-full items-center justify-center gap-3 rounded-[13px] bg-navy p-[15px] font-serif text-base tracking-[0.3px] text-white transition active:translate-y-px"
        >
          <BarcodeGlyph />
          Scan label
        </button>
      </div>

      <div className="pb-5">
        <p className="section-label mb-1 px-[18px] pt-2">Stops</p>

        {error && (
          <div className="mx-[18px] my-2 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
            Couldn't load parcels: {error}. Is the local Supabase stack running?
          </div>
        )}
        {!error && !parcels && (
          <div className="px-[18px] py-6 text-center text-[13px] text-muted">Loading stops…</div>
        )}

        {parcels?.map((p, i) => {
          const queuedStatus = queuedParcels.get(p.id)
          return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p)}
            className="block w-full border-b border-line bg-white px-[18px] py-3.5 text-left transition active:bg-paper"
          >
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[15px] font-semibold">{p.recipient_name}</div>
              {queuedStatus ? (
                <div className="text-[11px] font-bold uppercase tracking-[0.6px]">
                  <span className={STATUS_STYLES[queuedStatus]}>{queuedStatus}</span>
                  <span className="text-gold"> · queued</span>
                </div>
              ) : (
                <div className={`text-[11px] font-bold uppercase tracking-[0.6px] ${STATUS_STYLES[p.status]}`}>
                  {p.status === 'pending' ? `Stop ${i + 1}` : p.status}
                </div>
              )}
            </div>
            <div className="mt-0.5 text-[13px] leading-[1.45] text-muted">
              {p.address_line}
              {p.postcode ? `, ${p.postcode}` : ''}
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-[1px] text-navy-500">
                {p.tracking_number}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
                {p.area}
              </span>
            </div>
          </button>
          )
        })}
      </div>

      {/* Pinned footer: the dispatch handover lives in the app now, not in
          demo chrome around it */}
      <div className="mt-auto border-t border-line bg-white px-[18px] py-3 pb-[max(12px,env(safe-area-inset-bottom))] text-center">
        <a href="#/dispatch" className="text-xs font-semibold text-muted underline">
          Dispatcher view
        </a>
      </div>

      {sheetOpen && parcels && (
        <ScanSheet
          parcels={parcels}
          onClose={() => setSheetOpen(false)}
          onMatch={(parcel, value) => {
            setSheetOpen(false)
            onSelect(parcel, value)
          }}
        />
      )}
    </>
  )
}

/** Scan sheet (§5): the camera scanner is the primary path into a capture —
 *  a decoded barcode auto-selects the matching parcel. Type-in stays as the
 *  manual fallback, and unknown values surface clearly instead of failing
 *  silently. */
function ScanSheet({
  parcels,
  onClose,
  onMatch,
}: {
  parcels: Parcel[]
  onClose: () => void
  onMatch: (parcel: Parcel, scannedValue: string) => void
}) {
  const [value, setValue] = useState('')
  const [unknown, setUnknown] = useState<string | null>(null)
  // The scanner re-fires the same frame several times a second — throttle
  // repeated unknown values so the banner doesn't flicker
  const lastUnknownRef = useRef({ v: '', t: 0 })

  function tryMatch(raw: string, source: 'scan' | 'type') {
    const needle = raw.trim().toUpperCase()
    if (!needle) return
    const parcel = parcels.find((p) => p.tracking_number.toUpperCase() === needle)
    if (parcel) {
      navigator.vibrate?.(80) // tactile "got it" on supporting devices
      onMatch(parcel, needle)
      return
    }
    if (source === 'scan') {
      const now = Date.now()
      if (lastUnknownRef.current.v === needle && now - lastUnknownRef.current.t < 2500) return
      lastUnknownRef.current = { v: needle, t: now }
    }
    setUnknown(needle)
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end bg-navy/50" onClick={onClose}>
      <div
        className="max-h-full overflow-y-auto rounded-t-[22px] bg-paper p-[18px] pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="section-label mb-2">Scan the label</p>
        <BarcodeScanner onDecode={(v) => tryMatch(v, 'scan')} />

        {unknown && (
          <div className="mt-2.5 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
            <span className="font-bold">Unknown parcel.</span> No stop matches{' '}
            <span className="font-mono">{unknown}</span> — check the label or pick from the list.
          </div>
        )}

        <p className="section-label mb-2 mt-4">Or type the tracking number</p>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setUnknown(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && tryMatch(value, 'type')}
          placeholder="CP-849213-GB"
          className="w-full rounded-[11px] border border-line bg-white px-3 py-[11px] font-mono text-sm uppercase tracking-[1px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[11px] border border-line bg-white p-[11px] text-[13.5px] font-semibold text-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => tryMatch(value, 'type')}
            className="flex-1 rounded-[11px] bg-navy p-[11px] font-serif text-[15px] text-white"
          >
            Find parcel
          </button>
        </div>
      </div>
    </div>
  )
}

function BarcodeGlyph() {
  return (
    <svg viewBox="0 0 24 16" className="h-4 w-6" fill="#e3c766" aria-hidden>
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
