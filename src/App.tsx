import { useEffect, useMemo, useState } from 'react'
import { AppShell } from './components/AppShell'
import { useFleet } from './hooks/useFleet'
import { useParcels } from './hooks/useParcels'
import { useSites } from './hooks/useSites'
import { signOut, type Profile } from './hooks/useSession'
import type { QueuedPod } from './lib/db'
import { subscribeSync } from './lib/syncEvents'
import { isRollover, type Parcel, type Site } from './lib/types'
import { CaptureScreen } from './screens/CaptureScreen'
import { ResultScreen } from './screens/ResultScreen'
import { SiteCaptureScreen } from './screens/SiteCaptureScreen'
import { StopsScreen } from './screens/StopsScreen'

/** Simple screen state machine — a PoC doesn't need a router. */
type View =
  | { name: 'stops' }
  | { name: 'capture'; parcel: Parcel; scannedValue: string }
  | { name: 'site'; site: Site }
  | { name: 'done'; pod: QueuedPod; previewUrl: string }

export default function App({ profile }: { profile: Profile }) {
  const { parcels, error, reload } = useParcels()
  const { fleet, error: fleetError } = useFleet()
  const [view, setView] = useState<View>({ name: 'stops' })
  // Identity is the signed-in session — drives the run filter and the
  // driver_id stamped onto captures. RLS enforces the same scope server-side.
  const driverId = profile.driverId ?? ''
  // Sites (stores/depots) on this driver's route(s), for the no-manifest path.
  const { sites } = useSites()

  // Stop statuses change server-side as the sync worker drains the queue —
  // refresh the list whenever the queue moves (no-op when offline).
  useEffect(() => subscribeSync(() => void reload()), [reload])

  // Filter the run to the signed-in driver's routes. Degrade gracefully: while
  // the fleet is still loading we hold the loading state; if it fails to load
  // or has no routes (e.g. an un-migrated DB), fall back to showing every
  // parcel so the app still works.
  const myParcels = useMemo(() => {
    const fleetLoading = fleet == null && !fleetError
    if (parcels == null || fleetLoading) return null
    if (fleet == null || fleet.routes.length === 0) return parcels
    const myRouteIds = new Set(
      fleet.routes.filter((r) => r.driver_id === driverId).map((r) => r.id),
    )
    return parcels.filter((p) => p.route_id != null && myRouteIds.has(p.route_id))
  }, [parcels, fleet, fleetError, driverId])

  // The route(s) this driver runs, for the run-sheet header.
  const routeLabel = useMemo(() => {
    const names = fleet?.routes.filter((r) => r.driver_id === driverId).map((r) => r.name) ?? []
    return names.length ? names.join(' · ') : undefined
  }, [fleet, driverId])

  // The per-job POD page is a full-width console — render it outside the
  // sidebar shell so it owns the whole viewport (matches the proof-of-delivery
  // layout: navy app bar + evidence cards).
  if (view.name === 'capture') {
    return (
      <CaptureScreen
        parcel={view.parcel}
        trackingScanned={view.scannedValue}
        driverId={driverId}
        eyebrow={captureEyebrow(view.parcel, myParcels)}
        onBack={() => setView({ name: 'stops' })}
        onComplete={(pod, previewUrl) => setView({ name: 'done', pod, previewUrl })}
      />
    )
  }

  // Scan-and-capture against a site (store/depot) — the no-manifest path.
  if (view.name === 'site') {
    return <SiteCaptureScreen site={view.site} driverId={driverId} onBack={() => setView({ name: 'stops' })} />
  }

  return (
    <AppShell fullName={profile.fullName} onSignOut={() => void signOut()}>
      {view.name === 'stops' && (
        <StopsScreen
          parcels={myParcels}
          error={error}
          routeLabel={routeLabel}
          sites={sites ?? undefined}
          onSelectSite={(site) => setView({ name: 'site', site })}
          onSelect={(parcel, scannedValue) =>
            setView({ name: 'capture', parcel, scannedValue: scannedValue ?? parcel.tracking_number })
          }
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
