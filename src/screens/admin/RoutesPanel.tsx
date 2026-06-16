import { useState } from 'react'
import { isForeignKeyError } from '../../lib/admin'
import { supabase } from '../../lib/supabase'
import { AREAS, type Area, type Driver, type Route } from '../../lib/types'
import { Banner, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Card, Field, INPUT, Pill } from './ui'

/** Manage routes (a driver's run) — name, the driver who runs it, and the
 *  regions it covers (which power "auto-allocate by area"). Pure client-side:
 *  admins pass the routes RLS write policy. */
export function RoutesPanel({
  routes,
  drivers,
  reload,
}: {
  routes: Route[]
  drivers: Driver[]
  reload: () => void
}) {
  const [name, setName] = useState('')
  const [driverId, setDriverId] = useState('')
  const [areas, setAreas] = useState<Area[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    const { error } = await supabase
      .from('routes')
      .insert({ name: trimmed, driver_id: driverId || null, areas })
    if (error) setError(error.message)
    else {
      setName('')
      setDriverId('')
      setAreas([])
      reload()
    }
    setBusy(false)
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
      <Card title="Add a route" sticky>
        <form onSubmit={add} className="grid gap-3 p-4">
          <Field label="Name" hint="Often the region name, e.g. 'Greater London'.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Route name" className={INPUT} />
          </Field>
          <Field label="Driver">
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={INPUT}>
              <option value="">Unassigned</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Covers areas" hint="Used by auto-allocate by area.">
            <AreaChecks selected={areas} onToggle={(a) => setAreas(toggle(areas, a))} />
          </Field>
          <button type="submit" disabled={busy || !name.trim()} className={`w-full ${BTN_PRIMARY}`}>
            {busy ? 'Adding…' : 'Add route'}
          </button>
        </form>
      </Card>

      <section>
        {error && <Banner kind="error">{error}</Banner>}
        <p className="section-label mb-2">All routes · {routes.length}</p>
        {routes.length === 0 && (
          <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
            No routes yet — add one with the form.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {routes.map((r) => (
            <RouteRow key={r.id} route={r} drivers={drivers} reload={reload} onError={setError} />
          ))}
        </div>
      </section>
    </div>
  )
}

function RouteRow({
  route,
  drivers,
  reload,
  onError,
}: {
  route: Route
  drivers: Driver[]
  reload: () => void
  onError: (m: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(route.name)
  const [driverId, setDriverId] = useState(route.driver_id ?? '')
  const [areas, setAreas] = useState<Area[]>(route.areas)
  const [busy, setBusy] = useState(false)
  const driverName = drivers.find((d) => d.id === route.driver_id)?.name

  async function save() {
    setBusy(true)
    onError(null)
    const { error } = await supabase
      .from('routes')
      .update({ name: name.trim(), driver_id: driverId || null, areas })
      .eq('id', route.id)
    if (error) onError(error.message)
    else {
      setEditing(false)
      reload()
    }
    setBusy(false)
  }

  async function remove() {
    if (!confirm(`Delete route "${route.name}"?`)) return
    setBusy(true)
    onError(null)
    const { error } = await supabase.from('routes').delete().eq('id', route.id)
    if (error) {
      onError(
        isForeignKeyError(error)
          ? `Can't delete "${route.name}" — parcels or sites are still allocated to it. Reassign them first.`
          : error.message,
      )
    } else reload()
    setBusy(false)
  }

  if (editing) {
    return (
      <article className="grid gap-3 rounded-2xl border border-navy-500/30 bg-white p-4 ring-[3px] ring-navy-500/10">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Driver">
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={INPUT}>
            <option value="">Unassigned</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Covers areas">
          <AreaChecks selected={areas} onToggle={(a) => setAreas(toggle(areas, a))} />
        </Field>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void save()} disabled={busy || !name.trim()} className={BTN_PRIMARY}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setName(route.name)
              setDriverId(route.driver_id ?? '')
              setAreas(route.areas)
            }}
            className={BTN_GHOST}
          >
            Cancel
          </button>
        </div>
      </article>
    )
  }

  return (
    <article className="flex flex-col gap-2 rounded-2xl border border-line bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-serif text-[15px] text-ink">{route.name}</span>
          {driverName ? <Pill tone="navy">{driverName}</Pill> : <Pill tone="muted">Unassigned</Pill>}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {route.areas.length ? (
            route.areas.map((a) => (
              <span key={a} className="rounded-full bg-paper px-2 py-0.5 text-[11px] text-muted">
                {a}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-muted">No areas — won't auto-allocate</span>
          )}
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">
        <button type="button" onClick={() => setEditing(true)} disabled={busy} className={BTN_GHOST}>
          Edit
        </button>
        <button type="button" onClick={() => void remove()} disabled={busy} className={BTN_DANGER}>
          Delete
        </button>
      </div>
    </article>
  )
}

function AreaChecks({ selected, onToggle }: { selected: Area[]; onToggle: (a: Area) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {AREAS.map((a) => {
        const on = selected.includes(a)
        return (
          <label
            key={a}
            className={`flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2 text-[13px] transition ${
              on ? 'border-navy-500/40 bg-navy-500/5 text-ink' : 'border-line text-muted hover:border-navy-500/20'
            }`}
          >
            <input type="checkbox" checked={on} onChange={() => onToggle(a)} className="accent-navy-500" />
            {a}
          </label>
        )
      })}
    </div>
  )
}

const toggle = (list: Area[], a: Area): Area[] =>
  list.includes(a) ? list.filter((x) => x !== a) : [...list, a]
