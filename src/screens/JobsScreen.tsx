import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import type { ParcelInput } from '../lib/manifest'
import { supabase } from '../lib/supabase'
import { buildTrackingCsv, downloadCsv, type TrackingPod, type TrackingScan } from '../lib/trackingExport'
import { STATUS_LABEL, STATUS_RANK, type Manifest, type ParcelStatus } from '../lib/types'
import { enrichShipments } from '../lib/enrichApi'
import { shipmentToParcelInput } from '../lib/enrich'
import { buildDrafts, geocode, manifestPostcodes, parseManifestFile, type ManifestDraft } from '../lib/importManifest'

/** The parcel fields the Jobs view needs (a subset of the full row). */
interface JobParcel {
  id: string
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  delivery_area: string
  status: string
  route_id: string | null
  manifest_id: string | null
}

/** Dispatcher Jobs view: paste tracking numbers into EnrichCard to look up
 *  addresses from the GWOptical mirror and create a job (a batch of parcels),
 *  then open a job to pick its individual parcels and assign the selected ones
 *  to a driver/route, and export captured tracking data as the Evri-format CSV.
 *  Parcels flow through the existing driver → POD pipeline; same navy/gold/paper
 *  language as the other dispatch views. */
export function JobsScreen() {
  const { fleet } = useFleet()
  const [manifests, setManifests] = useState<Manifest[] | null>(null)
  const [parcels, setParcels] = useState<JobParcel[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [mRes, pRes] = await Promise.all([
      supabase.from('manifests').select('*').order('imported_at', { ascending: false }),
      supabase
        .from('parcels')
        .select('id, tracking_number, recipient_name, address_line, postcode, delivery_area, status, route_id, manifest_id')
        .order('tracking_number'),
    ])
    if (mRes.error) {
      setError(mRes.error.message)
      return
    }
    setManifests(mRes.data as Manifest[])
    setParcels((pRes.data ?? []) as JobParcel[])
    setError(null)
  }, [])

  useEffect(() => {
    void load()
    const channel = supabase
      .channel('jobs-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'manifests' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parcels' }, () => void load())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [load])

  // Parcels grouped by their job.
  const byManifest = useMemo(() => {
    const m = new Map<string, JobParcel[]>()
    for (const p of parcels) {
      if (!p.manifest_id) continue
      const arr = m.get(p.manifest_id)
      if (arr) arr.push(p)
      else m.set(p.manifest_id, [p])
    }
    return m
  }, [parcels])

  const routes = useMemo(() => fleet?.routes ?? [], [fleet])
  const driverName = useCallback(
    (id: string | null) => fleet?.drivers.find((d) => d.id === id)?.name ?? id ?? '—',
    [fleet],
  )
  const routeName = useCallback((id: string | null) => routes.find((r) => r.id === id)?.name ?? null, [routes])

  // Bulk allocate the picked parcels (optimistic, then persist).
  const assignParcels = useCallback(
    async (ids: string[], routeId: string | null) => {
      setParcels((prev) => prev.map((p) => (ids.includes(p.id) ? { ...p, route_id: routeId } : p)))
      const { error } = await supabase.from('parcels').update({ route_id: routeId }).in('id', ids)
      if (error) {
        setError(error.message)
        void load()
      }
    },
    [load],
  )

  return (
    <AdminShell
      active="jobs"
      title="Jobs"
      meta={manifests ? `${manifests.length} job${manifests.length === 1 ? '' : 's'} · ${parcels.length} parcels` : '…'}
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
          {error}. Is the local Supabase stack running and reachable?
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        <div className="xl:sticky xl:top-[82px] flex flex-col gap-6">
          <ImportCard routes={routes} onImported={() => void load()} />
          <EnrichCard onImported={() => void load()} />
        </div>

        <JobsList
          manifests={manifests}
          byManifest={byManifest}
          routes={routes}
          driverName={driverName}
          routeName={routeName}
          onAssign={(ids, routeId) => void assignParcels(ids, routeId)}
          onError={setError}
        />
      </div>
    </AdminShell>
  )
}

/* ------------------------------------------------------------------ Commit --- */

/** Create-or-update a job by name and upsert its parcels (onConflict
 *  tracking_number). Used by the paste-box enricher. */
async function commitParcels(name: string, sourceFilename: string, parcels: ParcelInput[]): Promise<void> {
  const { data: existing } = await supabase.from('manifests').select('id').eq('name', name).maybeSingle()
  let manifestId: string
  if (existing) {
    manifestId = (existing as { id: string }).id
    const { error } = await supabase.from('manifests')
      .update({ imported_at: new Date().toISOString(), source_filename: sourceFilename }).eq('id', manifestId)
    if (error) throw new Error(error.message)
  } else {
    const { data, error } = await supabase.from('manifests')
      .insert({ name, source_filename: sourceFilename }).select().single()
    if (error) throw new Error(error.message)
    manifestId = (data as Manifest).id
  }
  const rows = parcels.map((p) => ({ ...p, manifest_id: manifestId }))
  const { error } = await supabase.from('parcels').upsert(rows, { onConflict: 'tracking_number' })
  if (error) throw new Error(error.message)
}

/** Create-or-update a job by name and upsert its parcels — full rows (incl.
 *  destination/due_date/route_id), unlike commitParcels which takes ParcelInput. */
async function commitManifestImport(name: string, sourceFilename: string, drafts: ManifestDraft[]): Promise<void> {
  const { data: existing } = await supabase.from('manifests').select('id').eq('name', name).maybeSingle()
  let manifestId: string
  if (existing) {
    manifestId = (existing as { id: string }).id
    const { error } = await supabase.from('manifests')
      .update({ imported_at: new Date().toISOString(), source_filename: sourceFilename }).eq('id', manifestId)
    if (error) throw new Error(error.message)
  } else {
    const { data, error } = await supabase.from('manifests')
      .insert({ name, source_filename: sourceFilename, reference: 'manifest-import' }).select().single()
    if (error) throw new Error(error.message)
    manifestId = (data as Manifest).id
  }
  // Explicit column mapping (drop the `branch` helper — not a parcels column).
  const rows = drafts.map((d) => ({
    tracking_number: d.tracking_number,
    recipient_name: d.recipient_name,
    address_line: d.address_line,
    postcode: d.postcode,
    destination: d.destination,
    delivery_area: d.delivery_area,
    collection_area: d.collection_area,
    status: d.status,
    due_date: d.due_date,
    route_id: d.route_id,
    manifest_id: manifestId,
    meta: d.meta,
  }))
  const { error } = await supabase.from('parcels').upsert(rows, { onConflict: 'tracking_number' })
  if (error) throw new Error(error.message)
}

/** Upload a coupon-style CSV/.xlsx → parse + geocode in the browser → preview →
 *  commit as a job. Allocates each parcel to the route whose name matches its
 *  Branch column (else unallocated). The self-serve path (meeting ask #4) — no
 *  script, no GWOptical dependency. */
function ImportCard({
  routes,
  onImported,
}: {
  routes: { id: string; name: string; driver_id: string | null }[]
  onImported: () => void
}) {
  const todayIso = new Date().toISOString().slice(0, 10)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Awaited<ReturnType<typeof parseManifestFile>> | null>(null)
  const [geoMap, setGeoMap] = useState<Map<string, { lng: number; lat: number }>>(new Map())
  const [date, setDate] = useState(todayIso)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const routeByName = useMemo(() => new Map(routes.map((r) => [r.name.toLowerCase(), r.id])), [routes])
  const preview = useMemo(
    () => (rows ? buildDrafts(rows, { date, geo: geoMap, routeByName }) : null),
    [rows, date, geoMap, routeByName],
  )
  const byRoute = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of preview?.drafts ?? []) {
      const key = d.route_id ? routes.find((r) => r.id === d.route_id)?.name ?? d.branch : `${d.branch || '?'} (unallocated)`
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return [...m.entries()]
  }, [preview, routes])

  async function onFile(file: File | undefined) {
    if (!file) return
    setBusy(true); setProblem(null); setFileName(file.name); setRows(null)
    try {
      const parsed = await parseManifestFile(file)
      if (!parsed.length) throw new Error('No rows found — is the header row present?')
      const geo = await geocode(manifestPostcodes(parsed))
      setRows(parsed); setGeoMap(geo)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function commit() {
    if (!preview || preview.drafts.length === 0) return
    setBusy(true); setProblem(null)
    try {
      const base = fileName.replace(/\.(csv|xlsx)$/i, '') || 'Manifest'
      await commitManifestImport(`${base} · ${date}`, fileName, preview.drafts)
      setRows(null); setFileName(''); setGeoMap(new Map())
      onImported()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const geoOk = preview ? preview.drafts.filter((d) => d.destination).length : 0

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white">
      <div className="border-b border-line bg-paper/60 px-4 py-2.5">
        <p className="section-label">Import a manifest</p>
      </div>
      <div className="p-4">
        {problem && (
          <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{problem}</div>
        )}

        <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">Run date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="mb-3 w-full rounded-[11px] border border-line bg-white px-3 py-[10px] text-sm text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10" />

        <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[11px] border-2 border-dashed border-navy-500/60 bg-white px-4 py-6 text-center transition active:scale-[0.99]">
          <span className="text-[13.5px] font-semibold text-navy-500">{busy ? 'Reading…' : 'Choose a CSV or .xlsx'}</span>
          <span className="text-[11.5px] text-muted">{fileName || 'Shop · Customer · Address1 · PostCode · Branch'}</span>
          <input type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>

        {preview && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span className="font-semibold text-ok">{preview.drafts.length} parcels</span>
              <span className="text-muted">{geoOk}/{preview.drafts.length} geocoded</span>
              {preview.misses.length > 0 && <span className="font-semibold text-fail">{preview.misses.length} no geocode</span>}
            </div>
            <div className="mt-2 flex flex-col gap-1 text-[12px] text-muted">
              {byRoute.map(([name, n]) => (
                <div key={name} className="flex justify-between">
                  <span>{name}</span>
                  <span className="font-mono text-navy-500">{n}</span>
                </div>
              ))}
            </div>
            {preview.misses.length > 0 && (
              <div className="mt-2 rounded-[11px] border border-gold/40 bg-gold/10 px-3 py-2 text-[12px] text-[#9a6a00]">
                No geocode (still imported, no geofence): {preview.misses.slice(0, 6).join('; ')}{preview.misses.length > 6 ? ` +${preview.misses.length - 6} more` : ''}
              </div>
            )}
            <button type="button" disabled={busy} onClick={() => void commit()}
              className="mt-3 w-full rounded-[11px] bg-navy px-4 py-2.5 font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:opacity-40">
              {busy ? 'Importing…' : `Import ${preview.drafts.length} parcels`}
            </button>
          </>
        )}
      </div>
    </section>
  )
}

/** Paste/scan bare tracking numbers → look up addresses in GWOptical (via the
 *  enrich-shipments function) → commit the found ones as a job. Not-found
 *  numbers are listed with Retry (a fresh shipment may not have synced yet). */
function EnrichCard({ onImported }: { onImported: () => void }) {
  const [text, setText] = useState('')
  const [jobName, setJobName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [found, setFound] = useState<ParcelInput[] | null>(null)
  const [notFound, setNotFound] = useState<string[]>([])

  const parseList = (s: string) => Array.from(new Set(
    s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
  ))

  async function lookup(numbers: string[], merge = false) {
    if (numbers.length === 0) return
    setBusy(true); setProblem(null)
    try {
      const res = await enrichShipments(numbers)
      const { data: cps } = await supabase.from('collection_points').select('postcode, name')
      const names = Object.fromEntries(
        ((cps ?? []) as { postcode: string; name: string | null }[])
          .filter((c) => c.name).map((c) => [c.postcode, c.name as string]),
      )
      const mapped = res.found.map((r) => shipmentToParcelInput(r, names))
      // merge=true (Retry) only ever receives the not-found set, which is disjoint from already-found — so appending can't duplicate.
      setFound((prev) => (merge && prev ? [...prev, ...mapped] : mapped))
      setNotFound(res.notFound)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function commit() {
    if (!found || found.length === 0) return
    setBusy(true); setProblem(null)
    try {
      // Timestamp the default name so consecutive un-named pastes each create
      // their own job rather than merging into one shared "Tracking import"
      // (commitParcels is create-or-update by name).
      const defaultName = `Tracking import ${new Date().toLocaleString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })}`
      await commitParcels(jobName.trim() || defaultName, '', found)
      setText(''); setJobName(''); setFound(null); setNotFound([])
      onImported()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white">
      <div className="border-b border-line bg-paper/60 px-4 py-2.5">
        <p className="section-label">Enrich from tracking numbers</p>
      </div>
      <div className="p-4">
        {problem && (
          <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{problem}</div>
        )}
        <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">Job name</label>
        <input value={jobName} onChange={(e) => setJobName(e.target.value)}
          className="mb-3 w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10" />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder="Paste tracking numbers — one per line"
          className="w-full rounded-[11px] border border-line bg-white px-3 py-2.5 font-mono text-[12.5px] text-ink focus:border-navy-500 focus:outline-none" />
        <button type="button" disabled={busy || parseList(text).length === 0}
          onClick={() => void lookup(parseList(text))}
          className="mt-3 w-full rounded-[11px] bg-navy px-4 py-2.5 font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:opacity-40">
          {busy ? 'Looking up…' : `Look up ${parseList(text).length} addresses`}
        </button>

        {found && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span className="font-semibold text-ok">{found.length} found</span>
              {notFound.length > 0 && <span className="font-semibold text-fail">{notFound.length} not found</span>}
            </div>
            {notFound.length > 0 && (
              <div className="mt-2 rounded-[11px] border border-gold/40 bg-gold/10 px-3 py-2 text-[12.5px] text-[#9a6a00]">
                <div className="mb-1 font-semibold">Not in GWOptical yet:</div>
                <div className="font-mono text-[11.5px] break-words">{notFound.join(', ')}</div>
                <button type="button" disabled={busy} onClick={() => void lookup(notFound, true)}
                  className="mt-2 rounded-[9px] border border-gold/50 bg-white px-2.5 py-1 text-[12px] font-semibold text-[#9a6a00]">
                  Retry not-found
                </button>
              </div>
            )}
            {found.length > 0 && (
              <button type="button" disabled={busy} onClick={() => void commit()}
                className="mt-3 w-full rounded-[11px] bg-navy px-4 py-2.5 font-serif text-[15px] text-white disabled:opacity-40">
                Import {found.length} parcels
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ Jobs list --- */

function JobsList({
  manifests,
  byManifest,
  routes,
  driverName,
  routeName,
  onAssign,
  onError,
}: {
  manifests: Manifest[] | null
  byManifest: Map<string, JobParcel[]>
  routes: { id: string; name: string; driver_id: string | null }[]
  driverName: (id: string | null) => string
  routeName: (id: string | null) => string | null
  onAssign: (ids: string[], routeId: string | null) => void
  onError: (msg: string | null) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function exportTracking(job?: Manifest) {
    setExporting(job?.id ?? 'all')
    setNote(null)
    onError(null)
    // The full journey: POD outcomes (delivered/attempted) + the
    // collection/warehouse lifecycle scans, merged chronologically by
    // buildTrackingCsv. The delivered stage isn't fetched from
    // parcel_events — its POD row already carries it.
    const [podRes, evRes] = await Promise.all([
      supabase
        .from('pod_records')
        .select(
          'tracking_scanned,status,failure_reason,received_by,captured_at,location, parcel:parcels(tracking_number,delivery_area,postcode,manifest_id), site:sites(name,postcode)',
        )
        .order('captured_at', { ascending: true }),
      supabase
        .from('parcel_events')
        .select(
          'tracking_scanned,stage,captured_at,location, parcel:parcels(tracking_number,delivery_area,postcode,manifest_id)',
        )
        .in('stage', ['collection', 'warehouse'])
        .order('captured_at', { ascending: true }),
    ])
    const error = podRes.error ?? evRes.error
    if (error) {
      onError(error.message)
      setExporting(null)
      return
    }
    type ParcelCtx = { tracking_number: string; delivery_area: string | null; postcode: string | null; manifest_id: string | null } | null
    type Row = {
      tracking_scanned: string
      status: TrackingPod['status']
      failure_reason: string | null
      received_by: string | null
      captured_at: string
      location: unknown
      parcel: ParcelCtx
      site: { name: string; postcode: string | null } | null
    }
    type EventRow = {
      tracking_scanned: string
      stage: TrackingScan['stage']
      captured_at: string
      location: unknown
      parcel: ParcelCtx
    }
    const pods: TrackingPod[] = (podRes.data as unknown as Row[])
      .filter((r) => !job || r.parcel?.manifest_id === job.id)
      .map((r) => ({
        parcel_tracking: r.parcel?.tracking_number ?? null,
        tracking_scanned: r.tracking_scanned,
        status: r.status,
        failure_reason: r.failure_reason,
        received_by: r.received_by,
        captured_at: r.captured_at,
        location: r.location,
        area: r.parcel?.delivery_area ?? null,
        postcode: r.parcel?.postcode ?? null,
        siteName: r.site?.name ?? null,
        sitePostcode: r.site?.postcode ?? null,
      }))
    const scans: TrackingScan[] = (evRes.data as unknown as EventRow[])
      .filter((r) => !job || r.parcel?.manifest_id === job.id)
      .map((r) => ({
        parcel_tracking: r.parcel?.tracking_number ?? null,
        tracking_scanned: r.tracking_scanned,
        stage: r.stage,
        captured_at: r.captured_at,
        location: r.location,
        area: r.parcel?.delivery_area ?? null,
        postcode: r.parcel?.postcode ?? null,
      }))

    if (pods.length === 0 && scans.length === 0) {
      setNote(`No tracking events captured yet${job ? ` for "${job.name}"` : ''}.`)
      setExporting(null)
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const slug = (job?.name ?? 'all').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    downloadCsv(`tracking_${slug}_${stamp}.csv`, buildTrackingCsv(pods, scans))
    setExporting(null)
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="section-label">Jobs</p>
        <button
          type="button"
          disabled={exporting != null}
          onClick={() => void exportTracking()}
          className="rounded-[10px] border border-navy bg-white px-3.5 py-2 font-serif text-[13px] text-navy transition hover:bg-paper active:translate-y-px disabled:opacity-40"
        >
          {exporting === 'all' ? 'Exporting…' : 'Export all tracking'}
        </button>
      </div>

      {note && (
        <div className="mb-2 rounded-[11px] border border-gold/40 bg-gold/10 px-3 py-2 text-[12.5px] text-[#9a6a00]">
          {note}
        </div>
      )}

      {manifests && manifests.length === 0 && (
        <div className="rounded-2xl border border-line bg-white px-4 py-8 text-center text-[13px] text-muted">
          No jobs yet — look up tracking numbers to create one.
        </div>
      )}

      <div className="flex flex-col gap-2">
        {manifests?.map((job) => {
          const stops = byManifest.get(job.id) ?? []
          const delivered = stops.filter((p) => p.status === 'delivered').length
          const open = openId === job.id
          return (
            <article key={job.id} className="overflow-hidden rounded-2xl border border-line bg-white">
              {/* Job header — click to open the parcels inside */}
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : job.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <Chevron open={open} />
                  <span className="min-w-0">
                    <span className="block font-serif text-[15px] text-ink">{job.name}</span>
                    <span className="block text-[12px] text-muted">
                      {fmtDate(job.imported_at)} · {stops.length} parcel{stops.length === 1 ? '' : 's'} · {delivered}{' '}
                      delivered
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={exporting != null}
                  onClick={() => void exportTracking(job)}
                  className="flex-none rounded-[10px] bg-navy px-3.5 py-2 font-serif text-[13px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:opacity-40"
                >
                  {exporting === job.id ? 'Exporting…' : 'Export tracking CSV'}
                </button>
              </div>

              {open && (
                <JobParcels
                  parcels={stops}
                  routes={routes}
                  driverName={driverName}
                  routeName={routeName}
                  onAssign={onAssign}
                />
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

/** The expanded parcels of one job: pick parcels, then assign the selection to
 *  a route (each route is run by one driver). */
function JobParcels({
  parcels,
  routes,
  driverName,
  routeName,
  onAssign,
}: {
  parcels: JobParcel[]
  routes: { id: string; name: string; driver_id: string | null }[]
  driverName: (id: string | null) => string
  routeName: (id: string | null) => string | null
  onAssign: (ids: string[], routeId: string | null) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Parcels can disappear/refresh under us (realtime) — keep the selection valid.
  const validIds = useMemo(() => new Set(parcels.map((p) => p.id)), [parcels])
  const picked = useMemo(() => [...selected].filter((id) => validIds.has(id)), [selected, validIds])

  const allOn = parcels.length > 0 && picked.length === parcels.length
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(allOn ? new Set() : new Set(parcels.map((p) => p.id)))
  }

  function assign(value: string) {
    if (!picked.length || !value) return
    onAssign(picked, value === '__none__' ? null : value)
    setSelected(new Set())
  }

  if (parcels.length === 0) {
    return <div className="border-t border-line px-4 py-3 text-[12.5px] text-muted">No parcels on this job.</div>
  }

  return (
    <div className="border-t border-line">
      {/* Select-all + bulk assign bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-paper/50 px-4 py-2">
        <label className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          <input type="checkbox" checked={allOn} onChange={toggleAll} className="h-4 w-4 accent-navy" />
          {picked.length > 0 ? `${picked.length} selected` : 'Select all'}
        </label>
        <div className="flex items-center gap-2">
          <select
            value=""
            disabled={picked.length === 0}
            onChange={(e) => assign(e.target.value)}
            aria-label="Assign selected parcels to a route"
            className="rounded-[9px] border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink focus:border-navy-500 focus:outline-none disabled:opacity-40"
          >
            <option value="">Assign selected to…</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {driverName(r.driver_id)}
              </option>
            ))}
            <option value="__none__">— Unallocate —</option>
          </select>
        </div>
      </div>

      {/* Parcel rows */}
      <div className="flex flex-col">
        {parcels.map((p) => {
          const on = picked.includes(p.id)
          const rName = routeName(p.route_id)
          return (
            <label
              key={p.id}
              className={`flex cursor-pointer items-center gap-3 border-t border-line px-4 py-2.5 transition ${
                on ? 'bg-navy-500/5' : 'hover:bg-paper/50'
              }`}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(p.id)} className="h-4 w-4 flex-none accent-navy" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-ink">{p.recipient_name}</span>
                  <span className="flex-none rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] text-gold">
                    {p.delivery_area}
                  </span>
                </div>
                <div className="truncate text-[12px] text-muted">
                  {p.address_line}
                  {p.postcode ? `, ${p.postcode}` : ''}
                </div>
                <div className="font-mono text-[11px] tracking-[0.5px] text-navy-500">{p.tracking_number}</div>
              </div>
              <div className="flex-none text-right">
                {rName ? (
                  <span className="text-[11.5px] font-semibold text-navy-500">{rName}</span>
                ) : (
                  <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted">Unallocated</span>
                )}
                <StageBadge status={p.status} />
              </div>
            </label>
          )
        })}
      </div>
    </div>
  )
}

/** Lifecycle position of one parcel: three step-dots (collected → warehouse
 *  → delivered) plus the status label — "what stage is it on the job". */
function StageBadge({ status }: { status: string }) {
  const s = status as ParcelStatus
  const rank = STATUS_RANK[s] ?? 0
  const returned = s === 'returned'
  return (
    <span className="mt-0.5 flex items-center justify-end gap-1.5">
      <span className="flex items-center gap-[3px]" aria-hidden>
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            className={`h-[7px] w-[7px] rounded-full ${
              rank >= step ? (returned ? 'bg-fail' : 'bg-ok') : 'bg-line'
            }`}
          />
        ))}
      </span>
      <span
        className={`text-[11px] font-semibold ${
          returned ? 'text-fail' : s === 'delivered' ? 'text-ok' : rank > 0 ? 'text-navy-500' : 'text-muted'
        }`}
      >
        {STATUS_LABEL[s] ?? status}
      </span>
    </span>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 flex-none stroke-navy-500 transition-transform ${open ? 'rotate-90' : ''}`}
      fill="none"
      strokeWidth="2.2"
      aria-hidden
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

