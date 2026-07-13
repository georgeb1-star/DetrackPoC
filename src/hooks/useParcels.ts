import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../lib/db'
import { supabase } from '../lib/supabase'
import type { Parcel } from '../lib/types'

/** Today's stops with a read-through Dexie cache: cached rows render
 *  immediately (so a cold start with no signal still shows the run sheet),
 *  then every successful server fetch replaces both state and cache. */
export function useParcels() {
  const [parcels, setParcels] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasData = useRef(false)

  const reload = useCallback(async () => {
    // The run is date-bounded: today's stops plus any un-cleared rollovers
    // (due_date < today). Future-dated runs — e.g. a recurring schedule that
    // pre-generates upcoming MON/WED/FRI days — belong to the dispatcher's view,
    // not a driver's run, so they're excluded here (local device date).
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
      .lte('due_date', today)
      // Don't drag the whole delivery history onto the run. The driver only
      // needs what StopsScreen actually shows: still-active stops (any age →
      // rollovers included) plus items completed *today*. Terminal stops from
      // earlier days are left server-side, unfetched — without this bound the
      // result set grows every run day (recurring schedules never stop adding).
      .or(`status.not.in.(delivered,returned),completed_at.gte.${today}`)
      // Oldest due first → rollovers lead the run, then today's stops
      .order('due_date', { ascending: true })
      .order('tracking_number')
    if (error) {
      // Offline-friendly: keep showing stale stops if we already have data —
      // the local queue, not this list, is the truth for what was captured
      if (!hasData.current) setError(error.message)
      return
    }
    hasData.current = true
    setParcels(data as Parcel[])
    setError(null)
    // Refresh the offline cache (server is the source of truth)
    await db.transaction('rw', db.parcels, async () => {
      await db.parcels.clear()
      await db.parcels.bulkAdd(data as Parcel[])
    }).catch(() => {}) // cache failures must never break the live list
  }, [])

  useEffect(() => {
    let live = true
    // Serve the cache first…
    void db.parcels.toArray().then((cached) => {
      if (live && cached.length && !hasData.current) {
        cached.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.tracking_number.localeCompare(b.tracking_number))
        setParcels(cached)
        hasData.current = true // cached data beats an error banner
      }
    })
    // …then the network
    void reload()
    // Realtime: pick up dispatcher allocations (route_id changes) and status
    // moves the instant they happen, so the run sheet stays live without a poll.
    const channel = supabase
      .channel('parcels-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, () => void reload())
      .subscribe()
    return () => {
      live = false
      void supabase.removeChannel(channel)
    }
  }, [reload])

  return { parcels, error, reload }
}
