import { useEffect, useState } from 'react'
import { isForeignKeyError } from '../../lib/admin'
import { postcodeAreaName } from '../../lib/postcodeAreas'
import { supabase } from '../../lib/supabase'
import type { Driver, Route } from '../../lib/types'
import { Banner, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Card, Field, INPUT, Pill } from './ui'

/** Manage routes (a driver's run) — name, the driver who runs it, and the two
 *  postcode-area sets it pairs: which areas it collects from and which it
 *  delivers to (which power "auto-allocate by area" — a parcel matches when its
 *  collection_area ∈ collection_areas AND its delivery_area ∈ delivery_areas).
 *  Pure client-side: admins pass the routes RLS write policy. */
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
  const [collectionAreas, setCollectionAreas] = useState<string[]>([])
  const [deliveryAreas, setDeliveryAreas] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The postcode-areas actually present in the parcel set, offered as quick
  // toggles in both pickers (free entry still allowed for areas not yet seen).
  const [presentColl, setPresentColl] = useState<string[]>([])
  const [presentDeliv, setPresentDeliv] = useState<string[]>([])
  useEffect(() => {
    void supabase.from('parcels').select('collection_area, delivery_area').then(({ data }) => {
      const coll = new Set<string>(), deliv = new Set<string>()
      for (const r of (data ?? []) as { collection_area: string | null; delivery_area: string | null }[]) {
        if (r.collection_area) coll.add(r.collection_area)
        if (r.delivery_area) deliv.add(r.delivery_area)
      }
      setPresentColl([...coll].sort()); setPresentDeliv([...deliv].sort())
    })
  }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    const { error } = await supabase
      .from('routes')
      .insert({ name: trimmed, driver_id: driverId || null, collection_areas: collectionAreas, delivery_areas: deliveryAreas })
    if (error) setError(error.message)
    else {
      setName('')
      setDriverId('')
      setCollectionAreas([])
      setDeliveryAreas([])
      reload()
    }
    setBusy(false)
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
      <Card title="Add a route" sticky>
        <form onSubmit={add} className="grid gap-3 p-4">
          <Field label="Name" hint="Often the corridor, e.g. 'DY → EH'.">
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
          <AreaPicker label="Collects from" options={presentColl} selected={collectionAreas} onChange={setCollectionAreas} />
          <AreaPicker label="Delivers to" options={presentDeliv} selected={deliveryAreas} onChange={setDeliveryAreas} />
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
            <RouteRow
              key={r.id}
              route={r}
              drivers={drivers}
              presentColl={presentColl}
              presentDeliv={presentDeliv}
              reload={reload}
              onError={setError}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function RouteRow({
  route,
  drivers,
  presentColl,
  presentDeliv,
  reload,
  onError,
}: {
  route: Route
  drivers: Driver[]
  presentColl: string[]
  presentDeliv: string[]
  reload: () => void
  onError: (m: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(route.name)
  const [driverId, setDriverId] = useState(route.driver_id ?? '')
  const [collectionAreas, setCollectionAreas] = useState<string[]>(route.collection_areas)
  const [deliveryAreas, setDeliveryAreas] = useState<string[]>(route.delivery_areas)
  const [busy, setBusy] = useState(false)
  const driverName = drivers.find((d) => d.id === route.driver_id)?.name

  async function save() {
    setBusy(true)
    onError(null)
    const { error } = await supabase
      .from('routes')
      .update({ name: name.trim(), driver_id: driverId || null, collection_areas: collectionAreas, delivery_areas: deliveryAreas })
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
        <AreaPicker label="Collects from" options={presentColl} selected={collectionAreas} onChange={setCollectionAreas} />
        <AreaPicker label="Delivers to" options={presentDeliv} selected={deliveryAreas} onChange={setDeliveryAreas} />
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
              setCollectionAreas(route.collection_areas)
              setDeliveryAreas(route.delivery_areas)
            }}
            className={BTN_GHOST}
          >
            Cancel
          </button>
        </div>
      </article>
    )
  }

  // Both sides must be set for matchRoute to auto-allocate (collection_areas AND delivery_areas).
  const fullyConfigured = route.collection_areas.length > 0 && route.delivery_areas.length > 0
  const hasAreas = route.collection_areas.length > 0 || route.delivery_areas.length > 0
  return (
    <article className="flex flex-col gap-2 rounded-2xl border border-line bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-serif text-[15px] text-ink">{route.name}</span>
          {driverName ? <Pill tone="navy">{driverName}</Pill> : <Pill tone="muted">Unassigned</Pill>}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {hasAreas && (
            <span className="rounded-full bg-paper px-2 py-0.5 font-mono text-[11px] tracking-[0.5px] text-muted">
              <AreaCodes codes={route.collection_areas} /> → <AreaCodes codes={route.delivery_areas} />
            </span>
          )}
          {!fullyConfigured && (
            <span className="text-[12px] text-muted">Set both sides to auto-allocate</span>
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

/** Render postcode-area codes with the full post-town name on hover (title),
 *  joined by "·"; "—" when empty. A dotted underline hints they're hoverable. */
function AreaCodes({ codes }: { codes: string[] }) {
  if (codes.length === 0) return <>—</>
  return (
    <>
      {codes.map((c, i) => (
        <span key={c}>
          <span
            title={postcodeAreaName(c)}
            className="cursor-help underline decoration-dotted decoration-muted/50 underline-offset-2"
          >
            {c}
          </span>
          {i < codes.length - 1 && <span className="text-muted/50">·</span>}
        </span>
      ))}
    </>
  )
}

/** Tag-style picker: the present postcode-areas as toggles, plus free entry
 *  (upper-cased) for any area not yet seen in the parcel set. */
function AreaPicker({ label, options, selected, onChange }: {
  label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const all = [...new Set([...options, ...selected])].sort()
  const toggle = (a: string) => onChange(selected.includes(a) ? selected.filter((x) => x !== a) : [...selected, a])
  const add = () => { const a = draft.trim().toUpperCase(); if (a && !selected.includes(a)) onChange([...selected, a]); setDraft('') }
  return (
    <div>
      <p className="section-label mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {all.map((a) => (
          <button key={a} type="button" onClick={() => toggle(a)} title={postcodeAreaName(a)}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold transition ${
              selected.includes(a) ? 'border-navy-500/50 bg-navy-500/10 text-ink' : 'border-line text-muted hover:border-navy-500/30'}`}>
            {a}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="Add a code (e.g. DY)"
          className={`${INPUT} flex-1`} />
        <button type="button" onClick={add} className={BTN_GHOST}>Add</button>
      </div>
    </div>
  )
}
