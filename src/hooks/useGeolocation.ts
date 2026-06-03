import { useCallback, useEffect, useRef, useState } from 'react'
import type { Fix } from '../lib/types'

/** Demo fallback (Erith, like the reference) used when the fix is denied,
 *  times out, or geolocation is unavailable (e.g. plain-HTTP LAN access).
 *  The 'simulated' source keeps trusted and untrusted reads distinguishable (§5). */
const FALLBACK: Fix = { lat: 51.484, lng: 0.177, accuracyM: 35, source: 'simulated' }

function acquire(): Promise<Fix> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(FALLBACK)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: +p.coords.latitude.toFixed(5),
          lng: +p.coords.longitude.toFixed(5),
          accuracyM: Math.round(p.coords.accuracy),
          source: 'device',
        }),
      () => resolve(FALLBACK),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    )
  })
}

/** Starts acquiring on mount (like the reference). `fix` is null while
 *  acquiring; `getFix()` awaits the in-flight acquisition so a photo snapped
 *  in the first seconds still gets stamped with the eventual fix. */
export function useGeolocation() {
  const [fix, setFix] = useState<Fix | null>(null)
  const promiseRef = useRef<Promise<Fix> | null>(null)

  useEffect(() => {
    const p = acquire()
    promiseRef.current = p
    let live = true
    void p.then((f) => live && setFix(f))
    return () => {
      live = false
    }
  }, [])

  const getFix = useCallback((): Promise<Fix> => {
    promiseRef.current ??= acquire()
    return promiseRef.current
  }, [])

  return { fix, getFix }
}
