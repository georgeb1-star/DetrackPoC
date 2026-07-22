import { useSyncStatus } from '../hooks/useSyncStatus'
import { syncNow } from '../lib/syncWorker'

/** Driver-facing sync indicator, shown in the global app bar on every screen.
 *  It answers the one thing a driver cares about — "is my work safe, and is
 *  anything waiting?" — so it surfaces offline / queued / needs-retry state and
 *  an all-clear tick when nothing's pending. The raw synced running total (§6.3)
 *  is deliberately dropped: it climbs into the hundreds on a coupon run and is
 *  telemetry noise to a driver, not an actionable signal. Tapping forces a sync
 *  pass — including items that exhausted their automatic retries. */
export function SyncBadge() {
  const { queued, stuck, online, syncing } = useSyncStatus()
  const pending = queued > 0 || stuck > 0

  return (
    <button
      type="button"
      onClick={() => void syncNow({ includeStuck: true })}
      title={stuck > 0 ? 'Some items need a manual retry — tap to retry now' : 'Tap to sync now'}
      // Wrap-safe, shrinkable: on a phone the mobile top bar is tight — flex-wrap
      // + min-w-0 lets the badge stack to a second line instead of pushing off
      // the screen edge. Roomy in the desktop sidebar, so it stays one line there.
      className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-2xl border border-white/15 bg-navy-600 px-2.5 py-[5px] text-[10px] font-bold uppercase tracking-[0.6px]"
    >
      {!online && (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-gold" />
          <span className="text-gold-soft">offline</span>
          <span className="text-white/25">·</span>
        </>
      )}
      {queued > 0 && (
        <span className={`text-gold-soft ${syncing ? 'animate-pulse' : ''}`}>{queued} queued</span>
      )}
      {queued > 0 && stuck > 0 && <span className="text-white/25">·</span>}
      {stuck > 0 && <span className="text-[#ff918a]">{stuck} retry</span>}
      {/* Queue clear: a plain all-clear tick, not a running synced count. */}
      {!pending && <span className="text-[#6ee7a0]">✓ All uploaded</span>}
    </button>
  )
}
