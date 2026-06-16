import { useState } from 'react'
import { isForeignKeyError, makeDriverId } from '../../lib/admin'
import { supabase } from '../../lib/supabase'
import type { Driver } from '../../lib/types'
import { Banner, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Card, Field, INPUT } from './ui'

/** Manage the roster (`drivers`) — the fleet identities stamped onto PODs and
 *  assigned to routes. Pure client-side: admins already pass the drivers RLS
 *  write policy. A roster entry may have no Login (that's fine). */
export function DriversPanel({ drivers, reload }: { drivers: Driver[]; reload: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.from('drivers').insert({ id: makeDriverId(trimmed), name: trimmed })
    if (error) setError(error.message)
    else {
      setName('')
      reload()
    }
    setBusy(false)
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
      <Card title="Add a driver" sticky>
        <form onSubmit={add} className="grid gap-3 p-4">
          <Field label="Name" hint="The roster name shown on run sheets and PODs. Add a sign-in for them in the Users tab.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam Lee" className={INPUT} />
          </Field>
          <button type="submit" disabled={busy || !name.trim()} className={`w-full ${BTN_PRIMARY}`}>
            {busy ? 'Adding…' : 'Add driver'}
          </button>
        </form>
      </Card>

      <section>
        {error && <Banner kind="error">{error}</Banner>}
        <p className="section-label mb-2">Roster · {drivers.length}</p>
        {drivers.length === 0 && (
          <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
            No drivers yet — add one with the form.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {drivers.map((d) => (
            <DriverRow key={d.id} driver={d} reload={reload} onError={setError} />
          ))}
        </div>
      </section>
    </div>
  )
}

function DriverRow({
  driver,
  reload,
  onError,
}: {
  driver: Driver
  reload: () => void
  onError: (m: string | null) => void
}) {
  const [name, setName] = useState(driver.name)
  const [busy, setBusy] = useState(false)
  const dirty = name.trim() !== driver.name && name.trim().length > 0

  async function rename() {
    setBusy(true)
    onError(null)
    const { error } = await supabase.from('drivers').update({ name: name.trim() }).eq('id', driver.id)
    if (error) onError(error.message)
    else reload()
    setBusy(false)
  }

  async function remove() {
    if (!confirm(`Remove driver "${driver.name}"? This can't be undone.`)) return
    setBusy(true)
    onError(null)
    const { error } = await supabase.from('drivers').delete().eq('id', driver.id)
    if (error) {
      onError(
        isForeignKeyError(error)
          ? `Can't remove "${driver.name}" — they're still linked to deliveries, a route, or a login. Reassign those first.`
          : error.message,
      )
    } else reload()
    setBusy(false)
  }

  return (
    <article className="flex flex-col gap-2 rounded-2xl border border-line bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={`Rename ${driver.name}`}
          className="min-w-0 flex-1 rounded-[10px] border border-transparent bg-transparent px-2 py-1.5 font-serif text-[15px] text-ink hover:border-line focus:border-navy-500 focus:bg-white focus:outline-none"
        />
        <span className="hidden font-mono text-[11px] tracking-[0.5px] text-muted sm:inline">{driver.id}</span>
      </div>
      <div className="flex flex-none items-center gap-2">
        {dirty && (
          <button type="button" onClick={() => void rename()} disabled={busy} className={BTN_GHOST}>
            {busy ? 'Saving…' : 'Save name'}
          </button>
        )}
        <button type="button" onClick={() => void remove()} disabled={busy} className={BTN_DANGER}>
          Remove
        </button>
      </div>
    </article>
  )
}
