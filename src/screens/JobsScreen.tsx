import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import {
  autoMap,
  buildParcelInputs,
  MANIFEST_FIELDS,
  parseManifestFile,
  splitRowsForEnrichment,
  type ColumnMapping,
  type ParsedManifest,
  type ParcelInput,
} from '../lib/manifest'
import { supabase } from '../lib/supabase'
import { buildTrackingCsv, downloadCsv, type TrackingPod, type TrackingScan } from '../lib/trackingExport'
import { STATUS_LABEL, STATUS_RANK, type Manifest, type ParcelStatus } from '../lib/types'
import { enrichShipments } from '../lib/enrichApi'
import { shipmentToParcelInput } from '../lib/enrich'

/** The parcel fields the Jobs view needs (a subset of the full row). */
interface JobParcel {
  id: string
  tracking_number: string
  recipient_name: string
  address_line: string
  postcode: string | null
  area: string
  status: string
  route_id: string | null
  manifest_id: string | null
}

/** Dispatcher Jobs view: import a parcel manifest (.xlsx) to create a job (a
 *  batch of parcels), then open a job to pick its individual parcels and assign
 *  the selected ones to a driver/route, and export captured tracking data as
 *  the Evri-format CSV. Parcels flow through the existing driver → POD pipeline;
 *  same navy/gold/paper language as the other dispatch views. */
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
        .select('id, tracking_number, recipient_name, address_line, postcode, area, status, route_id, manifest_id')
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
      title="Jobs & manifests"
      meta={manifests ? `${manifests.length} job${manifests.length === 1 ? '' : 's'} · ${parcels.length} parcels` : '…'}
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
          {error}. Is the local Supabase stack running (and the manifests migration applied)?
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        <div className="xl:sticky xl:top-[82px] flex flex-col gap-6">
          <ImportCard onImported={() => void load()} />
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

/* ---------------------------------------------------------------- Import --- */

/** Create-or-update a job by name and upsert its parcels (onConflict
 *  tracking_number). Shared by the file importer and the paste-box enricher. */
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

function ImportCard({ onImported }: { onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [filename, setFilename] = useState('')
  const [jobName, setJobName] = useState('')
  const [parsed, setParsed] = useState<ParsedManifest | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [showMapping, setShowMapping] = useState(false)

  const result = useMemo(
    () => (parsed ? buildParcelInputs(parsed.rows, mapping) : null),
    [parsed, mapping],
  )
  // "Confident" = every required column got auto-matched. When so, we hide the
  // mapping step entirely and just confirm; the dropdowns stay as a fallback.
  const confident = useMemo(
    () => MANIFEST_FIELDS.filter((f) => f.required).every((f) => mapping[f.key]),
    [mapping],
  )

  // Tracking-only: the file has a tracking column but no address column — route
  // through enrichment (GWOptical lookup) instead of the normal build path.
  const trackingOnly = !!(parsed && mapping.tracking_number && !mapping.address_line)
  const enrichCount = useMemo(
    () => (trackingOnly && parsed ? splitRowsForEnrichment(parsed.rows, mapping).toEnrich.length : 0),
    [trackingOnly, parsed, mapping],
  )

  async function onFile(file: File) {
    setProblem(null)
    setParsing(true)
    try {
      const p = await parseManifestFile(file)
      if (!p.headers.length) {
        setProblem('No columns found in the first sheet.')
        setParsing(false)
        return
      }
      const m = autoMap(p.headers)
      setParsed(p)
      setMapping(m)
      // Show the dropdowns only if a required column wasn't auto-matched.
      setShowMapping(!MANIFEST_FIELDS.filter((f) => f.required).every((f) => m[f.key]))
      setFilename(file.name)
      setJobName(file.name.replace(/\.[^.]+$/, ''))
    } catch (e) {
      setProblem(`Couldn't read the file: ${e instanceof Error ? e.message : String(e)}`)
    }
    setParsing(false)
  }

  function reset() {
    setParsed(null)
    setMapping({})
    setShowMapping(false)
    setFilename('')
    setJobName('')
    setProblem(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function commit() {
    if (trackingOnly ? enrichCount === 0 : !result || !result.parcels.length) return
    setImporting(true)
    setProblem(null)
    try {
      // Re-importing under the same job name UPDATES that job (fresh
      // imported_at, parcels stay attached) instead of minting a duplicate
      // job and re-homing the parcels onto it.
      const name = jobName.trim() || filename || 'Untitled job'

      // Tracking-only file: look up addresses in GWOptical, then commit found ones.
      if (parsed && mapping.tracking_number && !mapping.address_line) {
        const { toEnrich } = splitRowsForEnrichment(parsed.rows, mapping)
        const res = await enrichShipments(toEnrich)
        const enriched = res.found.map(shipmentToParcelInput)
        if (enriched.length === 0) {
          setProblem(`None of the ${toEnrich.length} tracking numbers were found in GWOptical yet.`)
          setImporting(false)
          return
        }
        await commitParcels(name, filename, enriched)
        reset()
        onImported()
        if (res.notFound.length > 0) {
          setProblem(`Imported ${enriched.length}; ${res.notFound.length} not found in GWOptical yet: ${res.notFound.slice(0, 10).join(', ')}${res.notFound.length > 10 ? '…' : ''}`)
        }
        setImporting(false)
        return
      }

      await commitParcels(name, filename, result!.parcels)
      reset()
      onImported()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
    setImporting(false)
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white">
      <div className="border-b border-line bg-paper/60 px-4 py-2.5">
        <p className="section-label">Import a manifest</p>
      </div>

      <div className="p-4">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
          }}
        />

        {problem && (
          <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
            {problem}
          </div>
        )}

        {!parsed ? (
          <button
            type="button"
            disabled={parsing}
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-navy-500/50 bg-paper/40 px-4 py-8 text-center transition hover:border-navy-500 active:scale-[0.99]"
          >
            <UploadGlyph />
            <span className="font-serif text-base text-navy">
              {parsing ? 'Reading…' : 'Choose a manifest (.xlsx)'}
            </span>
            <span className="text-[12.5px] text-muted">
              Each row becomes a parcel — we'll map the columns next
            </span>
          </button>
        ) : (
          <div>
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">
                Job name
              </label>
              <input
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
                className="w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
              />
              <p className="mt-1 text-[11.5px] text-muted">
                from <span className="font-mono">{filename}</span> · {parsed.rows.length} rows
              </p>
            </div>

            {confident && !showMapping ? (
              <div className="flex items-center justify-between gap-3 rounded-[11px] border border-ok/30 bg-ok/5 px-3 py-2.5">
                <span className="text-[12.5px] text-ink">
                  <span className="font-semibold text-ok">✓ Columns matched automatically</span>
                  <span className="text-muted"> — tracking, recipient and address all detected.</span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowMapping(true)}
                  className="flex-none text-[12.5px] font-semibold text-navy-500 underline"
                >
                  Review
                </button>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="section-label">Map columns</p>
                  {confident && (
                    <button
                      type="button"
                      onClick={() => setShowMapping(false)}
                      className="text-[12px] font-semibold text-navy-500 underline"
                    >
                      Done
                    </button>
                  )}
                </div>
                {!confident && (
                  <p className="mb-2 text-[12px] text-fail">
                    Couldn't match a required column (marked *) — please pick it below.
                  </p>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {MANIFEST_FIELDS.map((f) => (
                    <div key={f.key} className="flex items-center justify-between gap-3 rounded-[11px] border border-line bg-paper/40 px-3 py-2">
                      <span className="text-[13px] font-semibold text-ink">
                        {f.label}
                        {f.required && <span className="text-fail"> *</span>}
                      </span>
                      <select
                        value={mapping[f.key] ?? ''}
                        onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value || undefined }))}
                        className="max-w-[60%] rounded-[9px] border border-line bg-white px-2 py-1.5 text-[12.5px] text-ink focus:border-navy-500 focus:outline-none"
                      >
                        <option value="">— none —</option>
                        {parsed.headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(result || trackingOnly) && (
              <>
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
                  {trackingOnly ? (
                    <span className="font-semibold text-ok">{enrichCount} tracking numbers to look up</span>
                  ) : (
                    <span className="font-semibold text-ok">{result!.parcels.length} parcels ready</span>
                  )}
                  {!trackingOnly && result && result.errors.length > 0 && (
                    <span className="font-semibold text-fail">{result.errors.length} rows skipped</span>
                  )}
                </div>
                {!trackingOnly && result && result.errors.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-[12px] text-muted">
                    {result.errors.slice(0, 4).map((e) => (
                      <li key={e.index}>
                        Row {e.index + 2}: {e.reason}
                      </li>
                    ))}
                    {result.errors.length > 4 && <li>…and {result.errors.length - 4} more</li>}
                  </ul>
                )}

                {!trackingOnly && result && result.parcels.length > 0 && (
                  <div className="mt-3 overflow-x-auto rounded-[11px] border border-line">
                    <table className="w-full text-left text-[12.5px]">
                      <thead className="bg-paper/60 text-[10.5px] uppercase tracking-[0.5px] text-muted">
                        <tr>
                          <th className="px-2.5 py-1.5 font-bold">Tracking</th>
                          <th className="px-2.5 py-1.5 font-bold">Recipient</th>
                          <th className="px-2.5 py-1.5 font-bold">Address</th>
                          <th className="px-2.5 py-1.5 font-bold">Postcode</th>
                          <th className="px-2.5 py-1.5 font-bold">Area</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.parcels.slice(0, 6).map((p) => (
                          <tr key={p.tracking_number} className="border-t border-line">
                            <td className="px-2.5 py-1.5 font-mono text-[11.5px] text-navy-500">{p.tracking_number}</td>
                            <td className="px-2.5 py-1.5">{p.recipient_name}</td>
                            <td className="max-w-[180px] truncate px-2.5 py-1.5 text-muted">{p.address_line}</td>
                            <td className="px-2.5 py-1.5">{p.postcode ?? '—'}</td>
                            <td className="px-2.5 py-1.5">{p.area}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {result.parcels.length > 6 && (
                      <div className="border-t border-line bg-paper/40 px-2.5 py-1.5 text-[11.5px] text-muted">
                        +{result.parcels.length - 6} more
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-[11px] border border-line bg-white px-4 py-2.5 text-[13.5px] font-semibold text-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={importing || (trackingOnly ? enrichCount === 0 : !result || result.parcels.length === 0)}
                onClick={() => void commit()}
                className="flex-1 rounded-[11px] bg-navy px-4 py-2.5 font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
              >
                {importing ? 'Importing…' : trackingOnly ? `Look up & import ${enrichCount}` : `Import ${result?.parcels.length ?? 0} parcels`}
              </button>
            </div>
          </div>
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
      const mapped = res.found.map(shipmentToParcelInput)
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
          'tracking_scanned,status,failure_reason,received_by,captured_at,location, parcel:parcels(tracking_number,area,postcode,manifest_id), site:sites(name,postcode)',
        )
        .order('captured_at', { ascending: true }),
      supabase
        .from('parcel_events')
        .select(
          'tracking_scanned,stage,captured_at,location, parcel:parcels(tracking_number,area,postcode,manifest_id)',
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
    type ParcelCtx = { tracking_number: string; area: string | null; postcode: string | null; manifest_id: string | null } | null
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
        area: r.parcel?.area ?? null,
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
        area: r.parcel?.area ?? null,
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
          No jobs yet — import a manifest to create one.
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
                    {p.area}
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

function UploadGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 stroke-navy" fill="none" strokeWidth="1.7" aria-hidden>
      <path d="M12 16V4m0 0L7 9m5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  )
}
