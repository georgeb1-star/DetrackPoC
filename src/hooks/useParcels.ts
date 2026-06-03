import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Parcel } from '../lib/types'

/** Today's stops, ordered like the seed. Exposes reload so screens can refresh
 *  after a delivery completes. */
export function useParcels() {
  const [parcels, setParcels] = useState<Parcel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasData = useRef(false)

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
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
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { parcels, error, reload }
}
