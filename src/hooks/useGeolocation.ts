import { useCallback, useEffect, useRef, useState } from 'react'
import type { Fix } from '../lib/types'

/** Why a device fix couldn't be acquired — surfaced in the capture UI so a
 *  missing fix is never silent. There is NO simulated fallback: the record
 *  gets a real fix or none at all. */
export type NoFixReason = 'insecure' | 'denied' | 'unavailable' | 'timeout'

/** Driver-readable explanations per reason — actionable where the user can
 *  act (permissions, OS location services), honest where they can't. Shared
 *  by every screen that shows GPS state (scan sheet, delivery capture). */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
export const NO_FIX_NOTES: Record<NoFixReason, string> = {
  insecure:
    'Location needs a secure address — open the app at http://localhost:5190 on this machine (or an HTTPS address), not the plain-HTTP LAN URL.',
  denied: IS_IOS
    ? 'Location is blocked by iOS — Settings → Privacy & Security → Location Services: on, and allow your browser While Using the App. Then Retry.'
    : 'Location is blocked for this site — click the padlock/tune icon by the address bar → Site settings → Location → Allow, then Retry.',
  unavailable:
    'The device returned no fix — on Windows turn on Settings → Privacy & security → Location → Location services, then Retry.',
  timeout:
    'Could not get a fix in time — Retry, ideally with Wi-Fi on (laptops locate via nearby networks).',
}

interface Acquired {
  fix: Fix | null
  /** set iff fix is null */
  reason: NoFixReason | null
}

function acquire(opts: PositionOptions): Promise<Acquired> {
  return new Promise((resolve) => {
    // Browsers only expose real geolocation in secure contexts — a phone
    // hitting the dev server over plain-HTTP LAN lands here. Note that
    // self-signed HTTPS (dev:https) is "secure" enough to pass this check
    // but Chrome still auto-denies the permission prompt on cert-error
    // origins, which then reports as 'denied' below.
    if (!window.isSecureContext || !('geolocation' in navigator)) {
      resolve({ fix: null, reason: 'insecure' })
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          fix: {
            lat: +p.coords.latitude.toFixed(5),
            lng: +p.coords.longitude.toFixed(5),
            accuracyM: Math.round(p.coords.accuracy),
            source: 'device',
          },
          reason: null,
        }),
      (err) =>
        resolve({
          fix: null,
          reason:
            err.code === err.PERMISSION_DENIED
              ? 'denied'
              : err.code === err.TIMEOUT
                ? 'timeout'
                : 'unavailable',
        }),
      opts,
    )
  })
}

/** Two-stage acquisition, real-GPS-only:
 *  - Mount (and manual `retry()`): a warm-up read that also surfaces the
 *    permission prompt before the driver reaches the shutter. `fix` is null
 *    with `acquiring` true while in flight.
 *  - Shutter (`getFix`): a *fresh* read so the recorded position is where
 *    the photo was actually taken. `maximumAge` lets the still-warm mount
 *    fix answer instantly; if the fresh read fails, a real mount-time fix
 *    still wins (it can only be screen-age stale). If nothing real is
 *    available the caller gets null — never a fabricated point. */
export function useGeolocation() {
  const [acquired, setAcquired] = useState<Acquired | null>(null)
  const warmupRef = useRef<Promise<Acquired> | null>(null)

  const retry = useCallback(() => {
    setAcquired(null) // chip returns to "acquiring…" while the retry runs
    const p = acquire({ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 })
    warmupRef.current = p
    void p.then((a) => {
      if (warmupRef.current === p) setAcquired(a) // ignore superseded retries
    })
  }, [])

  useEffect(() => {
    retry()
  }, [retry])

  const getFix = useCallback(async (): Promise<Fix | null> => {
    const fresh = await acquire({ enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 })
    if (fresh.fix) {
      setAcquired(fresh)
      return fresh.fix
    }
    const warm = await (warmupRef.current ?? Promise.resolve(fresh))
    if (warm.fix) return warm.fix
    setAcquired(fresh) // surface the freshest failure reason in the UI
    return null
  }, [])

  return {
    fix: acquired?.fix ?? null,
    noFixReason: acquired?.reason ?? null,
    acquiring: acquired === null,
    getFix,
    retry,
  }
}
