import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFleet } from '../hooks/useFleet'
import { signOut } from '../hooks/useSession'
import { supabase } from '../lib/supabase'
import type { Site } from '../lib/types'

const KINDS: Site['kind'][] = ['store', 'depot', 'both']
const KIND_LABEL: Record<Site['kind'], string> = { store: 'Store', depot: 'Depot', both: 'Store & depot' }

/** Dispatcher Sites view (admin): create stores/depots and allocate them to a
 *  route, so they appear on a driver's run for scan-and-capture (no per-item
 *  manifest needed). A site can be a store, a depot, or both. Same
 *  navy/gold/paper language as the other dispatch views. */
export function SitesScreen() {
  const { fleet } = useFleet()
  const [sites, setSites] = useState<Site[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // New-site form
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [kind, setKind] = useState<Site['kind']>('store')
  const [routeId, setRouteId] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('sites').select('*').order('name')
    if (error) setError(error.message)
    else {
      setSites(data as Site[])
      setError(null)
    }
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
    const { error } = await supabase.from('sites').insert({
      name: name.trim(),
      address_line: address.trim() || null,
      postcode: postcode.trim() || null,
      kind,
      route_id: routeId || null,
    })
    if (error) setError(error.message)
    else {
      setName('')
      setAddress('')
      setPostcode('')
      setKind('store')
      setRouteId('')
      void load()
    }
    setBusy(false)
  }

  async function assign(siteId: string, rId: string | null) {
    setSites((prev) => prev?.map((s) => (s.id === siteId ? { ...s, route_id: rId } : s)) ?? prev)
    const { error } = await supabase.from('sites').update({ route_id: rId }).eq('id', siteId)
    if (error) {
      setError(error.message)
      void load()
    }
  }

  async function remove(siteId: string) {
    setSites((prev) => prev?.filter((s) => s.id !== siteId) ?? prev)
    const { error } = await supabase.from('sites').delete().eq('id', siteId)
    if (error) {
      setError(error.message)
      void load()
    }
  }

  return (
    <div className="min-h-dvh sm:px-8 sm:py-8">
      <div className="mx-auto max-w-4xl">
        <header className="gold-underline relative bg-navy px-5 pb-5 pt-[max(16px,env(safe-area-inset-top))] text-white sm:rounded-t-2xl sm:px-6">
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-[11px] font-semibold text-[#9fb0d6] transition hover:text-white"
          >
            Sign out ›
          </button>
          <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-[2px] text-gold-soft">
            Citipost · Dispatch
          </div>
          <div className="mt-[3px] flex items-baseline justify-between gap-4">
            <h1 className="font-serif text-[22px]">Sites</h1>
            <span className="font-mono text-xs tracking-[1px] text-[#9fb0d6]">
              {sites ? `${sites.length} site${sites.length === 1 ? '' : 's'}` : '…'}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="#/allocate" className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5">
              Allocate
            </a>
            <a href="#/jobs" className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5">
              Jobs
            </a>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold text-white">Sites</span>
            <a href="#/dispatch" className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5">
              Captured PODs
            </a>
          </div>
        </header>

        <div className="min-h-[calc(100dvh-150px)] bg-paper p-4 sm:min-h-0 sm:rounded-b-2xl sm:p-5">
          {error && (
            <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
              {error}. Signed in as an admin? (the sites migration must be applied and RLS allows admins only)
            </div>
          )}

          {/* Add a site */}
          <section className="mb-7 overflow-hidden rounded-2xl border border-line bg-white">
            <div className="border-b border-line bg-paper/60 px-4 py-2.5">
              <p className="section-label">Add a site</p>
            </div>
            <form onSubmit={addSite} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
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
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={busy || !name.trim()}
                  className="w-full rounded-[11px] bg-navy px-4 py-[11px] font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? 'Adding…' : 'Add site'}
                </button>
              </div>
            </form>
          </section>

          {/* Sites list */}
          <p className="section-label mb-2">All sites</p>
          {sites && sites.length === 0 && (
            <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
              No sites yet — add a store or depot above.
            </div>
          )}
          <div className="flex flex-col gap-2">
            {sites?.map((s) => (
              <article
                key={s.id}
                className="flex flex-col gap-2 rounded-2xl border border-line bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-serif text-[15px] text-ink">{s.name}</span>
                    <span className="flex-none rounded-full border border-navy-500/30 bg-navy-500/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-navy-500">
                      {KIND_LABEL[s.kind]}
                    </span>
                  </div>
                  <div className="truncate text-[12.5px] text-muted">
                    {s.address_line || 'No address'}
                    {s.postcode ? `, ${s.postcode}` : ''}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <select
                    value={s.route_id ?? ''}
                    onChange={(e) => void assign(s.id, e.target.value || null)}
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
                    onClick={() => void remove(s.id)}
                    aria-label={`Remove ${s.name}`}
                    className="flex-none rounded-[10px] border border-line px-2.5 py-2 text-[12px] font-semibold text-muted transition hover:border-fail/40 hover:text-fail"
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
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
