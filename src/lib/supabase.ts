import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** False when the build had no Supabase env vars (fresh clone, or a deploy
 *  without them configured). The app renders a setup notice instead of a
 *  blank page — never throw at module load, it kills the whole bundle. */
export const supabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient(
  url || 'http://unconfigured.invalid',
  anonKey || 'unconfigured',
)

/** Storage bucket holding photos + signatures (public read in this PoC). */
export const EVIDENCE_BUCKET = 'pod-evidence'
