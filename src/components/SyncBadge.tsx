import { useSyncStatus } from '../hooks/useSyncStatus'
import { syncNow } from '../lib/syncWorker'

/** Persistent "N queued / N synced" indicator (§6.3), pinned top-right of the
 *  phone frame on every screen. Tapping forces a sync pass (handy in demos). */
export function SyncBadge() {
  const { queued, synced, online, syncing } = useSyncStatus()

  return (
    <button
      type="button"
      onClick={() => void syncNow()}
      title="Tap to sync now"
      className="absolute right-3 top-[max(12px,env(safe-area-inset-top))] z-20 flex items-center gap-1.5 rounded-full border border-white/15 bg-navy-600/95 px-2.5 py-[5px] text-[10px] font-bold uppercase tracking-[0.6px] shadow-lg"
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
      <span className="text-white/25">·</span>
      <span className="text-[#86d6a8]">{synced} synced</span>
    </button>
  )
}
