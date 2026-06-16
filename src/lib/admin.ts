import { supabase } from './supabase'

export type Role = 'admin' | 'driver'

/** A Login (auth.users) merged with its Profile and the linked Roster entry's
 *  name — the row shape the admin panel's Users list renders. Mirrors the
 *  AdminUser shape returned by supabase/functions/admin. */
export interface AdminUser {
  id: string
  email: string | null
  full_name: string | null
  role: Role | null
  driver_id: string | null
  driver_name: string | null
  /** true when the Login is banned (deactivated) and can't sign in */
  disabled: boolean
  created_at: string
}

/** Call the admin Edge Function. `functions.invoke` automatically attaches the
 *  caller's session JWT; the function verifies the caller is an admin before
 *  doing anything. Returns the function's `data` payload, or throws with the
 *  function's own error message (not the opaque "non-2xx status code"). */
export async function adminInvoke<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke('admin', { body: { action, ...payload } })
  if (error) throw new Error(await functionErrorMessage(error))
  // Defensive: the function always wraps success as { data } and failures as a
  // non-2xx status, but guard against a 200 carrying an { error } just in case.
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error))
  }
  return (data as { data: T }).data
}

/** FunctionsHttpError carries the function's JSON body on a Response in
 *  `.context`; dig the human message out of it. */
async function functionErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown }).context
  if (ctx instanceof Response) {
    try {
      const body = await ctx.clone().json()
      if (body && typeof body === 'object' && 'error' in body) return String(body.error)
    } catch {
      /* not JSON — fall through */
    }
  }
  return error instanceof Error ? error.message : 'Admin action failed'
}

/** A readable, ambiguity-free temporary password (no 0/O/1/l/I). The admin
 *  copies it once and passes it to the driver — see docs/adr/0002. */
export function generatePassword(len = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const arr = new Uint32Array(len)
  crypto.getRandomValues(arr)
  return Array.from(arr, (n) => chars[n % chars.length]).join('')
}

/** A stable, opaque-ish roster id derived from the driver's name. The value is
 *  stamped onto every POD/event, so it must be unique and never reused. */
export function makeDriverId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 18)
  const rand = Math.random().toString(36).slice(2, 6)
  return `drv_${slug || 'driver'}_${rand}`
}

/** True when a PostgREST error is a foreign-key violation — i.e. the row is
 *  still referenced (a driver with PODs/route/login, a route with parcels). */
export function isForeignKeyError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '23503' || /foreign key/i.test(error.message ?? '')
}
