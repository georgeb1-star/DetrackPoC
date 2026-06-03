import Dexie, { type EntityTable } from 'dexie'
import type { Fix, PhotoType, PodStatus } from './types'

/** A capture as it sits in the local queue (§8): photo/signature blobs and
 *  all metadata land here FIRST — nothing blocks on the network. Synced items
 *  are kept (flag flipped, not deleted) so the UI can show history. */
export interface QueuedPod {
  /** Client-generated UUID — the idempotency key for every server write */
  podId: string
  parcelId: string | null
  parcelRef: string
  trackingScanned: string
  status: PodStatus
  failureReason: string | null
  receivedBy: string | null
  capturedAt: string // ISO, device clock (evidence time)
  location: Fix | null
  photos: { type: PhotoType; blob: Blob; origKb: number; compressedKb: number }[]
  signature: Blob | null
  /** 0 = queued, 1 = synced (numbers — Dexie can't index booleans) */
  synced: 0 | 1
  /** Server-issued trust stamp, copied back after upload */
  syncedAt: string | null
  queuedAt: string
  attempts: number
  lastError: string | null
}

export const db = new Dexie('epod') as Dexie & {
  pods: EntityTable<QueuedPod, 'podId'>
}

db.version(1).stores({
  // Only fields we query on need indexing; blobs ride along unindexed
  pods: 'podId, synced, queuedAt',
})
