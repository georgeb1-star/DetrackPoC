import { uploadAdhocScan } from './adhoc'
import { db } from './db'
import { uploadEvent } from './events'
import { uploadPod } from './pod'
import { supabase } from './supabase'
import { emitSync } from './syncEvents'

/** §8 sync worker: drains the queue oldest-first. Triggered on app load, on
 *  `online` events, on a short interval, and right after each capture. */

/** After this many failed upload attempts an item is "stuck": skipped by
 *  automatic passes so it can never jam the queue behind it. A manual sync
 *  (tapping the badge) retries stuck items too. */
export const MAX_AUTO_ATTEMPTS = 5

let syncing = false

export function isSyncing(): boolean {
  return syncing
}

/**
 * A live auth session is a precondition for syncing. Every storage upload and
 * PostgREST write is RLS-gated on `auth.uid()` being non-null, so firing them
 * without a valid JWT gets each one rejected ("new row violates row-level
 * security policy"). That's exactly how a captured-and-delivered POD gets
 * stuck: the storage upload is refused, uploadPod throws before the record is
 * written, and after MAX_AUTO_ATTEMPTS the item is poisoned and skipped.
 *
 * Returns true only once we hold a non-expired session. A token that has
 * lapsed — common when a mobile PWA is backgrounded and the browser throttles
 * the auto-refresh timer — is refreshed up front, so uploads always carry a
 * live JWT. If there's genuinely no session (signed out, refresh revoked) we
 * return false and the caller skips the pass instead of burning the queue.
 */
async function ensureSession(): Promise<boolean> {
  const { data } = await supabase.auth.getSession()
  const session = data.session
  if (!session) return false
  // expires_at is unix seconds; refresh a minute early so a token can't lapse
  // mid-pass and turn an otherwise-healthy upload into a poison failure.
  const expiresSoon = session.expires_at != null && session.expires_at * 1000 < Date.now() + 60_000
  if (!expiresSoon) return true
  const { data: refreshed, error } = await supabase.auth.refreshSession()
  return !error && Boolean(refreshed.session)
}

export async function syncNow(opts: { includeStuck?: boolean } = {}): Promise<void> {
  // Single-flight: the triggers overlap freely (load + interval + online),
  // only one pass runs at a time.
  if (syncing || !navigator.onLine) return

  // No live session → don't fire authless uploads that storage/PostgREST will
  // reject (and that would poison the queue). Skip this pass entirely; a later
  // one runs once the session is back (sign-in, or a successful token refresh).
  if (!(await ensureSession())) return

  // Both queues drain oldest-first: stage scans (quick, no blobs) then PODs.
  // Order between the two doesn't matter for correctness — parcels.status
  // only ever advances forward, so a delivered POD syncing before its
  // collection scan can't be regressed by it.
  const queuedAdhoc = (await db.adhocScans.where('synced').equals(0).sortBy('queuedAt')).filter(
    (a) => opts.includeStuck || a.attempts < MAX_AUTO_ATTEMPTS,
  )
  const queuedEvents = (await db.events.where('synced').equals(0).sortBy('queuedAt')).filter(
    (ev) => opts.includeStuck || ev.attempts < MAX_AUTO_ATTEMPTS,
  )
  const queuedPods = (await db.pods.where('synced').equals(0).sortBy('queuedAt')).filter(
    (pod) => opts.includeStuck || pod.attempts < MAX_AUTO_ATTEMPTS,
  )
  if (!queuedAdhoc.length && !queuedEvents.length && !queuedPods.length) return

  syncing = true
  emitSync()
  try {
    // Ad-hoc collections first: each becomes a 'collected' parcel, and any later
    // scan events on it need the parcel to exist. Same poison/idempotency shape.
    for (const scan of queuedAdhoc) {
      try {
        await uploadAdhocScan(scan)
        await db.adhocScans.update(scan.scanId, { synced: 1, syncedAt: new Date().toISOString(), lastError: null })
      } catch (e) {
        const authLapse = !(await ensureSession())
        await db.adhocScans.update(scan.scanId, {
          attempts: authLapse ? scan.attempts : scan.attempts + 1,
          lastError: e instanceof Error ? e.message : String(e),
        })
        if (!navigator.onLine || authLapse) break
      } finally {
        emitSync()
      }
    }
    for (const event of queuedEvents) {
      try {
        const syncedAt = await uploadEvent(event)
        await db.events.update(event.eventId, {
          synced: 1,
          syncedAt: syncedAt ?? new Date().toISOString(),
          lastError: null,
        })
      } catch (e) {
        // An auth lapse mid-pass is transient — don't count it toward the
        // poison threshold; the next pass retries once the session refreshes.
        const authLapse = !(await ensureSession())
        await db.events.update(event.eventId, {
          attempts: authLapse ? event.attempts : event.attempts + 1,
          lastError: e instanceof Error ? e.message : String(e),
        })
        if (!navigator.onLine || authLapse) break
      } finally {
        emitSync()
      }
    }
    for (const pod of queuedPods) {
      try {
        const syncedAt = await uploadPod(pod)
        // Flip the flag, keep the item — the UI shows synced history (§8)
        await db.pods.update(pod.podId, {
          synced: 1,
          syncedAt: syncedAt ?? new Date().toISOString(),
          lastError: null,
        })
      } catch (e) {
        // An auth lapse (token died / signed out mid-pass) is transient — a
        // recovered session must auto-heal, so don't count it toward the
        // poison threshold; just stop the pass (nothing else will upload).
        const authLapse = !(await ensureSession())
        await db.pods.update(pod.podId, {
          attempts: authLapse ? pod.attempts : pod.attempts + 1,
          lastError: e instanceof Error ? e.message : String(e),
        })
        // Stop the pass if the network or session dropped — everything would
        // fail. Otherwise carry on: one genuinely rejected record (a "poison"
        // item) must never block the captures queued behind it.
        if (!navigator.onLine || authLapse) break
      } finally {
        emitSync() // the queued counter visibly drains item by item
      }
    }
  } finally {
    syncing = false
    emitSync()
  }
}

/** Fast loop: drains fresh items quickly. It skips stuck items (no
 *  includeStuck) so a genuinely poison record can't hammer the network every
 *  few seconds or wedge the queue behind it. */
const SYNC_INTERVAL_MS = 8_000
/** Slow safety net: a periodic pass that DOES retry stuck items, so recovery
 *  is fully automatic. A driver must never be told to tap a "sync" button —
 *  this sweep heals a stuck capture on its own even if the app stays open. */
const STUCK_SWEEP_MS = 120_000

/** Install the §8 triggers. Called once from main.tsx.
 *
 *  The recovery philosophy: stuck items must auto-heal without the driver
 *  doing anything. Three moments make a previously-failing upload likely to
 *  succeed — the network coming back, the app returning to the foreground
 *  (fresh session after a mobile PWA was backgrounded), and a cold start — so
 *  each fires a FULL pass (includeStuck) that retries even poisoned items. The
 *  slow sweep covers the remaining case: the app left open, online, with a
 *  stuck item that just needs another go. The manual SyncBadge tap still
 *  exists, but it's now reassurance, not a required step. */
export function startSyncTriggers(): void {
  // Ask the browser not to evict the queue under storage pressure — silently
  // best-effort (Chrome grants it for installed/engaged PWAs).
  void navigator.storage?.persist?.().catch(() => {})

  // Network restored → retry everything, stuck items included (a dropped
  // connection is the most common reason a capture failed in the first place).
  window.addEventListener('online', () => void syncNow({ includeStuck: true }))

  // App brought back to the foreground → a backgrounded mobile PWA gets its
  // timers throttled and its auth token can lapse; on return we hold a fresh
  // session and usually signal, so flush everything including stuck items.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow({ includeStuck: true })
  })

  window.setInterval(() => void syncNow(), SYNC_INTERVAL_MS)
  window.setInterval(() => void syncNow({ includeStuck: true }), STUCK_SWEEP_MS)
  void syncNow({ includeStuck: true }) // cold start: flush anything left stuck last session
}
