import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { geocode } from '../lib/importManifest'
import { supabase } from '../lib/supabase'
import type { Site } from '../lib/types'

const KINDS: Site['kind'][] = ['store', 'depot', 'both']
const KIND_LABEL: Record<Site['kind'], string> = { store: 'Store', depot: 'Depot', both: 'Store & depot' }

/** Per-site activity, tallied from pod_records (captures against the site). */
type Activity = { count: number; last: string | null }
/** The editable fields of a site (route is reassigned inline, not here). */
interface EditPatch {
  name: string
  kind: Site['kind']
  address_line: string
  postcode: string
}

/** Geocode a single postcode to an EWKT point for the sites.destination
 *  geography column — the same format the manifest importer writes, so site
 *  captures get the same geofence treatment as parcels. null when the postcode
 *  is blank or postcodes.io has no match. */
async function geocodeToWkt(postcode: string | null): Promise<string | null> {
  const key = (postcode ?? '').trim().toUpperCase()
  if (!key) return null
  const fix = (await geocode([key])).get(key)
  return fix ? `SRID=4326;POINT(${fix.lng} ${fix.lat})` : null
}

/** Dispatcher Sites view (admin): create stores/depots and allocate them to a
 *  route, so they appear on a driver's run for scan-and-capture (no per-item
 *  manifest needed). A site can be a store, a depot, or both. Postcodes are
 *  geocoded (postcodes.io) into a geofence, sites are editable in place, and a
 *  site with captures can't be deleted (would orphan POD history). Same
 *  navy/gold/paper language as the other dispatch views. */
export function SitesScreen() {
  const { fleet } = useFleet()
  const [sites, setSites] = useState<Site[] | null>(null)
  const [activity, setActivity] = useState<Map<string, Activity>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // New-site form
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [kind, setKind] = useState<Site['kind']>('store')
  const [routeId, setRouteId] = useState('')

  const load = useCallback(async () => {
    const [sitesRes, capRes] = await Promise.all([
      supabase.from('sites').select('*').order('name'),
      supabase.from('pod_records').select('site_id, captured_at').not('site_id', 'is', null),
    ])
    if (sitesRes.error) {
      setError(sitesRes.error.message)
      return
    }
    setSites(sitesRes.data as Site[])
    // Tally captures per site (count + latest) for the activity signal and the
    // delete guard. If PODs aren't readable, just show sites without activity.
    if (!capRes.error) {
      const map = new Map<string, Activity>()
      for (const r of (capRes.data ?? []) as { site_id: string; captured_at: string }[]) {
        const e = map.get(r.site_id) ?? { count: 0, last: null }
        e.count++
        if (!e.last || r.captured_at > e.last) e.last = r.captured_at
        map.set(r.site_id, e)
      }
      setActivity(map)
    }
    setError(null)
  }, [])

  useEffect(() => {
    void load()
    const channel = supabase
      .channel('sites-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sites' }, () => void load())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [load])

  const routes = useMemo(() => fleet?.routes ?? [], [fleet])
  const driverName = useCallback(
    (id: string | null) => fleet?.drivers.find((d) => d.id === id)?.name ?? id ?? '—',
    [fleet],
  )

  async function addSite(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const pc = postcode.trim() || null
    let destination: string | null = null
    try {
      destination = await geocodeToWkt(pc)
    } catch {
      // postcodes.io hiccup — add the site anyway, just without a geofence.
    }
    const label = name.trim()
    const { error } = await supabase.from('sites').insert({
      name: label,
      address_line: address.trim() || null,
      postcode: pc,
      kind,
      destination,
      route_id: routeId || null,
    })
    if (error) setError(error.message)
    else {
      if (pc && !destination) {
        setNotice(`Added “${label}”, but ${pc} didn't geocode — no geofence set. Edit the site to retry.`)
      }
      setName('')
      setAddress('')
      setPostcode('')
      setKind('store')
      setRouteId('')
      void load()
    }
    setBusy(false)
  }

  // Optimistic route (re)assignment.
  async function assign(siteId: string, rId: string | null) {
    setSites((prev) => prev?.map((s) => (s.id === siteId ? { ...s, route_id: rId } : s)) ?? prev)
    const { error } = await supabase.from('sites').update({ route_id: rId }).eq('id', siteId)
    if (error) {
      setError(error.message)
      void load()
    }
  }

  // Edit name/kind/address/postcode. Re-geocodes only when the postcode
  // actually changed (so an unchanged edit can't clobber an existing geofence).
  async function saveSite(id: string, patch: EditPatch): Promise<boolean> {
    setError(null)
    setNotice(null)
    const site = sites?.find((s) => s.id === id)
    const newPc = patch.postcode.trim() || null
    const oldPc = site?.postcode ?? null
    const update: Record<string, unknown> = {
      name: patch.name.trim(),
      kind: patch.kind,
      address_line: patch.address_line.trim() || null,
      postcode: newPc,
    }
    if (newPc !== oldPc) {
      try {
        update.destination = await geocodeToWkt(newPc)
      } catch {
        update.destination = null
      }
      if (newPc && update.destination == null) setNotice(`${newPc} didn't geocode — saved without a geofence.`)
    }
    const { error } = await supabase.from('sites').update(update).eq('id', id)
    if (error) {
      setError(error.message)
      return false
    }
    void load()
    return true
  }

  // Delete guard: a site with captures can't be removed — the pod_records FK
  // (no cascade) would reject it anyway, but block up front with a clear reason.
  async function removeSite(id: string): Promise<boolean> {
    setError(null)
    const count = activity.get(id)?.count ?? 0
    if (count > 0) {
      setError(`Can't remove this site — ${count} capture${count === 1 ? '' : 's'} recorded against it.`)
      return false
    }
    setSites((prev) => prev?.filter((s) => s.id !== id) ?? prev)
    const { error } = await supabase.from('sites').delete().eq('id', id)
    if (error) {
      setError(error.message)
      void load()
      return false
    }
    return true
  }

  const needGeocode = (sites ?? []).filter((s) => s.postcode && s.destination == null).length

  return (
    <AdminShell
      active="sites"
      title="Sites"
      meta={
        sites
          ? `${sites.length} site${sites.length === 1 ? '' : 's'}${needGeocode ? ` · ${needGeocode} without geofence` : ''}`
          : '…'
      }
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-[11px] border border-gold/40 bg-gold/10 px-3 py-2.5 text-[13px] text-[#9a6a00]">
          {notice}
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        {/* Add a site */}
        <section className="overflow-hidden rounded-2xl border border-line bg-white xl:sticky xl:top-[82px]">
          <div className="border-b border-line bg-paper/60 px-4 py-2.5">
            <p className="section-label">Add a site</p>
          </div>
          <form onSubmit={addSite} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-1">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tesco Erith" className={INPUT} />
            </Field>
            <Field label="Type">
              <select value={kind} onChange={(e) => setKind(e.target.value as Site['kind'])} className={INPUT}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Address">
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, town" className={INPUT} />
            </Field>
            <Field label="Postcode">
              <input value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="DA18 4AA" className={INPUT} />
            </Field>
            <Field label="Route (optional)">
              <select value={routeId} onChange={(e) => setRouteId(e.target.value)} className={INPUT}>
                <option value="">Unallocated</option>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {driverName(r.driver_id)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex flex-col justify-end gap-1.5">
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="w-full rounded-[11px] bg-navy px-4 py-[11px] font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Adding…' : 'Add site'}
              </button>
              <span className="text-[11px] text-muted">The postcode is geocoded into a delivery geofence.</span>
            </div>
          </form>
        </section>

        {/* Sites list */}
        <section>
          <p className="section-label mb-2">All sites</p>
          {!sites ? (
            <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
              Loading sites…
            </div>
          ) : sites.length === 0 ? (
            <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
              No sites yet — add a store or depot with the form.
            </div>
          ) : (
            <SitesList
              sites={sites}
              activity={activity}
              routes={routes}
              driverName={driverName}
              onAssign={(id, rId) => void assign(id, rId)}
              onSave={saveSite}
              onRemove={removeSite}
            />
          )}
        </section>
      </div>
    </AdminShell>
  )
}

/** The filterable, paginated site list with inline edit + guarded delete. Owns
 *  its own view state (search/filters/page/which row is editing or confirming);
 *  the parent owns the data + writes. */
function SitesList({
  sites,
  activity,
  routes,
  driverName,
  onAssign,
  onSave,
  onRemove,
}: {
  sites: Site[]
  activity: Map<string, Activity>
  routes: { id: string; name: string; driver_id: string | null }[]
  driverName: (id: string | null) => string
  onAssign: (id: string, routeId: string | null) => void
  onSave: (id: string, patch: EditPatch) => Promise<boolean>
  onRemove: (id: string) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | Site['kind']>('all')
  const [routeFilter, setRouteFilter] = useState('all') // 'all' | 'unallocated' | routeId
  const [page, setPage] = useState(0)
  const [editId, setEditId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sites.filter((s) => {
      if (kindFilter !== 'all' && s.kind !== kindFilter) return false
      if (routeFilter === 'unallocated') {
        if (s.route_id) return false
      } else if (routeFilter !== 'all' && s.route_id !== routeFilter) return false
      if (q && !`${s.name} ${s.address_line ?? ''} ${s.postcode ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [sites, query, kindFilter, routeFilter])

  const PAGE_SIZE = 12
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const shown = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  // Any filter change jumps back to the first page.
  const resetTo = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v)
    setPage(0)
  }

  return (
    <>
      {/* Filter bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => resetTo(setQuery)(e.target.value)}
          placeholder="Search name, address, postcode…"
          className="min-w-0 flex-1 rounded-[10px] border border-line bg-white px-3 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
        />
        <select
          value={kindFilter}
          onChange={(e) => resetTo(setKindFilter)(e.target.value as 'all' | Site['kind'])}
          aria-label="Filter by type"
          className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
        >
          <option value="all">All types</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select
          value={routeFilter}
          onChange={(e) => resetTo(setRouteFilter)(e.target.value)}
          aria-label="Filter by route"
          className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
        >
          <option value="all">All routes</option>
          <option value="unallocated">Unallocated</option>
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
          No sites match these filters.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((s) =>
            editId === s.id ? (
              <EditRow
                key={s.id}
                site={s}
                busy={rowBusy === s.id}
                onCancel={() => setEditId(null)}
                onSave={async (patch) => {
                  setRowBusy(s.id)
                  const ok = await onSave(s.id, patch)
                  setRowBusy(null)
                  if (ok) setEditId(null)
                }}
              />
            ) : (
              <SiteRow
                key={s.id}
                site={s}
                activity={activity.get(s.id)}
                routes={routes}
                driverName={driverName}
                confirming={confirmId === s.id}
                busy={rowBusy === s.id}
                onAssign={(rId) => onAssign(s.id, rId)}
                onEdit={() => {
                  setEditId(s.id)
                  setConfirmId(null)
                }}
                onAskRemove={() => setConfirmId(s.id)}
                onCancelRemove={() => setConfirmId(null)}
                onConfirmRemove={async () => {
                  setRowBusy(s.id)
                  await onRemove(s.id)
                  setRowBusy(null)
                  setConfirmId(null)
                }}
              />
            ),
          )}
        </div>
      )}

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              className="rounded-[9px] border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-navy-500 transition hover:border-navy-500/40 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="text-[12px] tabular-nums text-muted">Page {safePage + 1} / {pageCount}</span>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
              className="rounded-[9px] border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-navy-500 transition hover:border-navy-500/40 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/** One site in display mode: identity + geofence/activity signal, inline route
 *  select, Edit, and a two-step (guarded) Remove. */
function SiteRow({
  site: s,
  activity,
  routes,
  driverName,
  confirming,
  busy,
  onAssign,
  onEdit,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  site: Site
  activity: Activity | undefined
  routes: { id: string; name: string; driver_id: string | null }[]
  driverName: (id: string | null) => string
  confirming: boolean
  busy: boolean
  onAssign: (routeId: string | null) => void
  onEdit: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}) {
  const geofenced = s.destination != null
  const captures = activity?.count ?? 0
  return (
    <article className="flex flex-col gap-2 rounded-2xl border border-line bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-serif text-[15px] text-ink">{s.name}</span>
          <span className="flex-none rounded-full border border-navy-500/30 bg-navy-500/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-navy-500">
            {KIND_LABEL[s.kind]}
          </span>
          {geofenced ? (
            <span className="flex-none rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-ok">
              Geofenced
            </span>
          ) : (
            <span className="flex-none rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
              No geofence
            </span>
          )}
        </div>
        <div className="truncate text-[12.5px] text-muted">
          {s.address_line || 'No address'}
          {s.postcode ? `, ${s.postcode}` : ''}
        </div>
        <div className="text-[11.5px] text-muted">
          {captures > 0 ? (
            <>
              {captures} capture{captures === 1 ? '' : 's'}
              {activity?.last ? ` · last ${fmtDate(activity.last)}` : ''}
            </>
          ) : (
            'No captures yet'
          )}
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[12px] font-semibold text-fail">Remove “{s.name}”?</span>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirmRemove}
              className="rounded-[10px] border border-fail/50 bg-fail/10 px-2.5 py-2 text-[12px] font-semibold text-fail transition hover:bg-fail/15 disabled:opacity-40"
            >
              {busy ? 'Removing…' : 'Confirm'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancelRemove}
              className="rounded-[10px] border border-line px-2.5 py-2 text-[12px] font-semibold text-muted transition hover:border-navy-500/40"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <select
              value={s.route_id ?? ''}
              onChange={(e) => onAssign(e.target.value || null)}
              aria-label={`Assign ${s.name} to a route`}
              className="rounded-[10px] border border-line bg-white px-2.5 py-2 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
            >
              <option value="">Unallocated</option>
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {driverName(r.driver_id)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${s.name}`}
              className="flex-none rounded-[10px] border border-line px-2.5 py-2 text-[12px] font-semibold text-navy-500 transition hover:border-navy-500/40"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={captures > 0}
              onClick={onAskRemove}
              aria-label={`Remove ${s.name}`}
              title={captures > 0 ? `${captures} capture${captures === 1 ? '' : 's'} recorded — can't remove` : undefined}
              className="flex-none rounded-[10px] border border-line px-2.5 py-2 text-[12px] font-semibold text-muted transition hover:border-fail/40 hover:text-fail disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
            >
              Remove
            </button>
          </>
        )}
      </div>
    </article>
  )
}

/** One site in edit mode: name/type/address/postcode, Save + Cancel. Its own
 *  draft state, seeded from the site; changing the postcode re-geocodes on save. */
function EditRow({
  site,
  busy,
  onCancel,
  onSave,
}: {
  site: Site
  busy: boolean
  onCancel: () => void
  onSave: (patch: EditPatch) => void
}) {
  const [name, setName] = useState(site.name)
  const [kind, setKind] = useState<Site['kind']>(site.kind)
  const [address, setAddress] = useState(site.address_line ?? '')
  const [postcode, setPostcode] = useState(site.postcode ?? '')
  return (
    <article className="rounded-2xl border border-navy-500/40 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value as Site['kind'])} className={INPUT}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Address">
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Postcode">
          <input value={postcode} onChange={(e) => setPostcode(e.target.value)} className={INPUT} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => onSave({ name, kind, address_line: address, postcode })}
          className="rounded-[10px] bg-navy px-4 py-2 font-serif text-[13.5px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-[10px] border border-line px-4 py-2 text-[13px] font-semibold text-muted transition hover:border-navy-500/40 disabled:opacity-40"
        >
          Cancel
        </button>
        <span className="text-[11.5px] text-muted">Changing the postcode re-geocodes the geofence.</span>
      </div>
    </article>
  )
}

const INPUT =
  'w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink ' +
  'focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">{label}</label>
      {children}
    </div>
  )
}

/** A capture timestamp (ISO w/ tz) as "13 Jul". */
function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}
