import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export type Role = 'admin' | 'driver'

/** The signed-in user's app identity, read from the `profiles` table. */
export interface Profile {
  id: string
  role: Role
  /** text drivers.id for a driver; null for an admin */
  driverId: string | null
  fullName: string | null
}

export interface SessionState {
  /** true until the session (and, when signed in, the profile) has resolved */
  loading: boolean
  session: Session | null
  profile: Profile | null
  /** set when a session exists but has no usable profile row */
  profileError: string | null
}

/** Live auth state: the Supabase session plus the user's profile (role +
 *  driver_id). The session comes from `onAuthStateChange`; the profile is
 *  fetched whenever the user changes (RLS lets a user read only their own). */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionLoading(false)
    })
    // Fires on sign-in / sign-out / token refresh. Keep the callback sync (no
    // awaited supabase calls inside it) — the profile fetch runs in the effect
    // below, keyed on the user id.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setSessionLoading(false)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id ?? null
  useEffect(() => {
    if (!userId) {
      setProfile(null)
      setProfileError(null)
      return
    }
    let live = true
    setProfileLoading(true)
    void supabase
      .from('profiles')
      .select('id, role, driver_id, full_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!live) return
        setProfileLoading(false)
        if (error) {
          setProfile(null)
          setProfileError(error.message)
        } else if (!data) {
          setProfile(null)
          setProfileError('This account has no profile yet — ask a dispatcher to set it up.')
        } else {
          setProfile({ id: data.id, role: data.role as Role, driverId: data.driver_id, fullName: data.full_name })
          setProfileError(null)
        }
      })
    return () => {
      live = false
    }
  }, [userId])

  return {
    loading: sessionLoading || (!!userId && profileLoading && !profile && !profileError),
    session,
    profile,
    profileError,
  }
}

export function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password })
}

export function signOut() {
  return supabase.auth.signOut()
}
