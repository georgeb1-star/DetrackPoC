import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Site } from '../lib/types'

/** Sites (stores/depots) visible to the caller. RLS scopes this server-side:
 *  a driver sees only sites on their route(s); an admin sees all. Realtime
 *  keeps it fresh when a dispatcher (re)allocates a site to a route. */
export function useSites() {
  const [sites, setSites] = useState<Site[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('sites').select('*').order('name')
    if (error) setError(error.message)
    else {
      setSites(data as Site[])
      setError(null)
    }
  }, [])

  useEffect(() => {
    void reload()
    const channel = supabase
      .channel('driver-sites-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sites' }, () => void reload())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [reload])

  return { sites, error, reload }
}
