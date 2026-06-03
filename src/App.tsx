import { useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { SyncBadge } from './components/SyncBadge'
import { useParcels } from './hooks/useParcels'
import type { QueuedPod } from './lib/db'
import { subscribeSync } from './lib/syncEvents'
import { isRollover, type Parcel } from './lib/types'
import { CaptureScreen } from './screens/CaptureScreen'
import { ResultScreen } from './screens/ResultScreen'
import { StopsScreen } from './screens/StopsScreen'

/** Simple screen state machine — a PoC doesn't need a router. */
type View =
  | { name: 'stops' }
  | { name: 'capture'; parcel: Parcel; scannedValue: string }
  | { name: 'done'; pod: QueuedPod; previewUrl: string }

export default function App() {
  const { parcels, error, reload } = useParcels()
  const [view, setView] = useState<View>({ name: 'stops' })

  // Stop statuses change server-side as the sync worker drains the queue —
  // refresh the list whenever the queue moves (no-op when offline).
  useEffect(() => subscribeSync(() => void reload()), [reload])

  return (
    <AppShell>
      <SyncBadge />

      {view.name === 'stops' && (
        <StopsScreen
          parcels={parcels}
          error={error}
          onSelect={(parcel, scannedValue) =>
            setView({ name: 'capture', parcel, scannedValue: scannedValue ?? parcel.tracking_number })
          }
        />
      )}

      {view.name === 'capture' && (
        <CaptureScreen
          parcel={view.parcel}
          trackingScanned={view.scannedValue}
          eyebrow={captureEyebrow(view.parcel, parcels)}
          onBack={() => setView({ name: 'stops' })}
          onComplete={(pod, previewUrl) => setView({ name: 'done', pod, previewUrl })}
        />
      )}

      {view.name === 'done' && (
        <ResultScreen
          pod={view.pod}
          previewUrl={view.previewUrl}
          onReset={() => setView({ name: 'stops' })}
        />
      )}
    </AppShell>
  )
}

/** "Rollover · Domestic" for overdue stops, "Stop 2 of 7 · Domestic" within
 *  the active run, "Revisit · Domestic" when re-opening a completed stop. */
function captureEyebrow(parcel: Parcel, parcels: Parcel[] | null): string {
  if (isRollover(parcel)) return `Rollover · ${parcel.area}`
  const active = parcels?.filter((p) => p.status === 'pending') ?? []
  const idx = active.findIndex((p) => p.id === parcel.id)
  if (idx === -1) return `Revisit · ${parcel.area}`
  return `Stop ${idx + 1} of ${active.length} · ${parcel.area}`
}
