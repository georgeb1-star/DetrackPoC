import { useSyncStatus } from '../hooks/useSyncStatus'
import { syncNow } from '../lib/syncWorker'

/** Persistent "N queued / N synced" indicator (§6.3), shown in the global app
 *  bar on every screen. Tapping forces a sync pass — including items that
 *  exhausted their automatic retries. */
export function SyncBadge() {
  const { queued, stuck, synced, online, syncing } = useSyncStatus()

  return (
    <button
      type="button"
      onClick={() => void syncNow({ includeStuck: true })}
      title={stuck > 0 ? 'Some items need a manual retry — tap to retry now' : 'Tap to sync now'}
      className="flex flex-none items-center gap-1.5 rounded-full border border-white/15 bg-navy-600 px-2.5 py-[5px] text-[10px] font-bold uppercase tracking-[0.6px]"
    >
      {!online && (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-gold" />
          <span className="text-gold-soft">offline</span>
          <span className="text-white/25">·</span>
        </>
      )}
      <span className={queued > 0 ? `text-gold-soft ${syncing ? 'animate-pulse' : ''}` : 'text-white/50'}>
        {queued} queued
      </span>
      {stuck > 0 && (
        <>
          <span className="text-white/25">·</span>
          <span className="text-[#ff918a]">{stuck} retry</span>
        </>
      )}
      <span className="text-white/25">·</span>
      <span className="text-[#6ee7a0]">{synced} synced</span>
    </button>
  )
}
