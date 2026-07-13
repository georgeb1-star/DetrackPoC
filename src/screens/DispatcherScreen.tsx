import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { fmtDistance, parseEwkbPoint } from '../lib/geo'
import { supabase } from '../lib/supabase'
import { MAX_DELIVERY_ATTEMPTS, type Parcel, type PodPhoto, type PodRecord } from '../lib/types'

interface JoinedPod extends PodRecord {
  parcel: Parcel | null
  /** Set when the capture was against a site (store/depot) instead of a parcel. */
  site: { name: string; address_line: string | null; postcode: string | null; kind: string; route_id: string | null } | null
  photos: PodPhoto[]
}

type StatusFilter = 'all' | 'delivered' | 'failed'
const PAGE_SIZE = 12

/** Dispatcher view (§6.4): the read side that proves the round trip — every
 *  captured POD joined to its parcel, with the stamped photo, location,
 *  device vs server timestamps, and failure reasons. Full-width page in the
 *  same navy/gold/paper language as the driver app.
 *
 *  Filterable (status / day / driver / free-text) and paginated; signed
 *  evidence URLs are minted only for the visible page (the bucket is private)
 *  and cached across pages, so paging doesn't re-sign or reload images. Live
 *  via the pod_records realtime channel — no polling. */
export function DispatcherScreen() {
  const { fleet } = useFleet()
  const [pods, setPods] = useState<JoinedPod[] | null>(null)
  const [urls, setUrls] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  // Filters
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dayFilter, setDayFilter] = useState('all')
  const [driverFilter, setDriverFilter] = useState('all')
  const [page, setPage] = useState(0)

  // Load POD metadata only (no signing here — the page effect signs what it
  // shows). Cheap enough to re-run on every realtime change.
  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('pod_records')
      .select(
        '*, parcel:parcels(*), site:sites(name,address_line,postcode,kind,route_id), photos:pod_photos(*)',
      )
      .order('created_at', { ascending: false })
    if (error) {
      setError(error.message)
      return
    }
    setPods(data as unknown as JoinedPod[])
    setError(null)
  }, [])

  // Realtime: new PODs appear the instant a driver device syncs (the table is
  // in the supabase_realtime publication). No interval poll — the previous 10s
  // poll re-ran the whole query and re-signed every URL on top of realtime.
  useEffect(() => {
    void load()
    const channel = supabase
      .channel('pod-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pod_records' }, () => void load())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [load])

  const driverName = useCallback(
    (id: string | null) => fleet?.drivers.find((d) => d.id === id)?.name ?? id ?? '—',
    [fleet],
  )
  const routeName = useCallback((id: string | null) => fleet?.routes.find((r) => r.id === id)?.name ?? null, [fleet])

  // Distinct capture days (local), newest first, for the day dropdown.
  const days = useMemo(() => {
    const set = new Set<string>()
    for (const p of pods ?? []) {
      const d = localDay(p.captured_at)
      if (d) set.add(d)
    }
    return [...set].sort().reverse()
  }, [pods])

  // Attempt ordinal per failed POD: its 1-based position among that parcel's
  // failed captures, in capture order. Lets each failed card show "attempt N".
  const attemptNo = useMemo(() => {
    const byParcel = new Map<string, JoinedPod[]>()
    for (const p of pods ?? []) {
      if (p.status === 'failed' && p.parcel_id) {
        const arr = byParcel.get(p.parcel_id)
        if (arr) arr.push(p)
        else byParcel.set(p.parcel_id, [p])
      }
    }
    const m = new Map<string, number>()
    for (const arr of byParcel.values()) {
      arr.sort((a, b) => a.captured_at.localeCompare(b.captured_at))
      arr.forEach((p, i) => m.set(p.id, i + 1))
    }
    return m
  }, [pods])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (pods ?? []).filter((pod) => {
      if (statusFilter !== 'all' && pod.status !== statusFilter) return false
      if (dayFilter !== 'all' && localDay(pod.captured_at) !== dayFilter) return false
      if (driverFilter !== 'all' && pod.driver_id !== driverFilter) return false
      if (q) {
        const hay = [
          pod.tracking_scanned,
          pod.parcel?.tracking_number,
          pod.parcel?.recipient_name,
          pod.parcel?.postcode,
          pod.parcel?.delivery_area,
          pod.site?.name,
          pod.received_by,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [pods, search, statusFilter, dayFilter, driverFilter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  // Sign evidence URLs for the visible page only, skipping anything already
  // signed (cached across pages). A ref holds the latest url map so the effect
  // needn't depend on it (which would loop). Signed URLs last an hour.
  const urlsRef = useRef(urls)
  urlsRef.current = urls
  useEffect(() => {
    const paths = [
      ...new Set(
        visible.flatMap((pod) => [
          ...pod.photos.map((ph) => ph.storage_path),
          ...(pod.signature_path ? [pod.signature_path] : []),
        ]),
      ),
    ].filter((p) => p && !urlsRef.current.has(p))
    if (paths.length === 0) return
    let cancelled = false
    void (async () => {
      const { data: signed } = await supabase.storage.from('pod-evidence').createSignedUrls(paths, 3600)
      if (cancelled || !signed) return
      setUrls((prev) => {
        const next = new Map(prev)
        for (const s of signed) if (s.signedUrl && s.path) next.set(s.path, s.signedUrl)
        return next
      })
    })()
    return () => {
      cancelled = true
    }
    // visible is derived from filtered + safePage; those cover it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, safePage])

  const deliveredAll = (pods ?? []).filter((p) => p.status === 'delivered').length
  const failedAll = (pods ?? []).length - deliveredAll
  const hasFilter = statusFilter !== 'all' || dayFilter !== 'all' || driverFilter !== 'all' || search.trim() !== ''

  // Any filter change jumps back to the first page.
  function withReset<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setPage(0)
    }
  }

  return (
    <AdminShell
      active="pods"
      title="Captured PODs"
      meta={
        pods
          ? `${pods.length} record${pods.length === 1 ? '' : 's'} · ${deliveredAll} delivered · ${failedAll} failed`
          : '…'
      }
    >
      {error && (
        <div className="mb-4 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
          Couldn't load PODs: {error}. Is the local Supabase stack running?
        </div>
      )}

      {pods && pods.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => withReset(setSearch)(e.target.value)}
            placeholder="Search tracking, recipient, postcode, site…"
            className="min-w-0 flex-1 rounded-[10px] border border-line bg-white px-3 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10"
          />
          <select
            value={statusFilter}
            onChange={(e) => withReset(setStatusFilter)(e.target.value as StatusFilter)}
            aria-label="Filter by outcome"
            className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
          >
            <option value="all">All outcomes</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
          </select>
          <select
            value={driverFilter}
            onChange={(e) => withReset(setDriverFilter)(e.target.value)}
            aria-label="Filter by driver"
            className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
          >
            <option value="all">All drivers</option>
            {(fleet?.drivers ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            value={dayFilter}
            onChange={(e) => withReset(setDayFilter)(e.target.value)}
            aria-label="Filter by capture day"
            className="rounded-[10px] border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink focus:border-navy-500 focus:outline-none"
          >
            <option value="all">All days</option>
            {days.map((d) => (
              <option key={d} value={d}>
                {fmtDayLabel(d)}
              </option>
            ))}
          </select>
        </div>
      )}

      {!pods ? (
        <div className="rounded-2xl border border-line bg-white py-14 text-center text-[13.5px] text-muted">
          Loading PODs…
        </div>
      ) : pods.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white py-14 text-center text-[13.5px] text-muted">
          No PODs captured yet — complete a delivery in the{' '}
          <a href="#/" className="text-navy-500 underline">
            driver app
          </a>
          .
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white py-14 text-center text-[13.5px] text-muted">
          No PODs match these filters.
        </div>
      ) : (
        <>
          {/* Evidence board — two-up on wide monitors so the width gets used */}
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {visible.map((pod) => (
              <PodCard
                key={pod.id}
                pod={pod}
                urls={urls}
                driverName={driverName}
                routeName={routeName}
                attempt={attemptNo.get(pod.id) ?? null}
                onPhoto={setLightbox}
              />
            ))}
          </div>

          {(pageCount > 1 || hasFilter) && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[12px] text-muted">
                {hasFilter ? `${filtered.length} of ${pods.length} · ` : ''}
                {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              {pageCount > 1 && (
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
              )}
            </div>
          )}
        </>
      )}

      {/* thumbnail → full (§6.4) */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-navy/85 p-6"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt="Proof of delivery, full size"
            className="max-h-[88vh] max-w-full rounded-xl shadow-2xl"
          />
        </div>
      )}
    </AdminShell>
  )
}

function PodCard({
  pod,
  urls,
  driverName,
  routeName,
  attempt,
  onPhoto,
}: {
  pod: JoinedPod
  urls: Map<string, string>
  driverName: (id: string | null) => string
  routeName: (id: string | null) => string | null
  attempt: number | null
  onPhoto: (url: string) => void
}) {
  const label = pod.photos.find((p) => p.photo_type === 'label') ?? pod.photos[0]
  const where = pod.photos.find((p) => p.photo_type === 'where_left')
  const labelUrl = label ? urls.get(label.storage_path) : undefined
  const whereUrl = where ? urls.get(where.storage_path) : undefined
  const signatureUrl = pod.signature_path ? urls.get(pod.signature_path) : undefined
  const point = parseEwkbPoint(pod.location)
  const failed = pod.status === 'failed'
  // The scan-to-attach proof: the scanned value vs the parcel it linked to
  const mismatch = pod.parcel && pod.tracking_scanned !== pod.parcel.tracking_number
  const route = routeName(pod.parcel?.route_id ?? pod.site?.route_id ?? null)
  const returned = pod.parcel?.status === 'returned'

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-white">
      <div className="flex flex-col gap-4 p-4 sm:flex-row">
        {/* Stamped photo thumbnails */}
        <div className="flex flex-none gap-2 sm:w-[150px] sm:flex-col">
          {label && labelUrl ? (
            <button
              type="button"
              onClick={() => onPhoto(labelUrl)}
              className="block w-[150px] flex-none cursor-zoom-in overflow-hidden rounded-xl border border-line"
            >
              <img src={labelUrl} alt="label" className="aspect-[4/3] w-full object-cover" />
            </button>
          ) : (
            <div className="flex aspect-[4/3] w-[150px] items-center justify-center rounded-xl border border-line bg-paper text-[11px] text-muted">
              no photo
            </div>
          )}
          {where && whereUrl && (
            <button
              type="button"
              onClick={() => onPhoto(whereUrl)}
              className="block w-[150px] flex-none cursor-zoom-in overflow-hidden rounded-xl border border-line"
            >
              <img src={whereUrl} alt="where left" className="aspect-[4/3] w-full object-cover" />
            </button>
          )}
        </div>

        {/* Parcel + outcome */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-serif text-[17px] text-ink">
              {pod.parcel?.tracking_number ?? pod.site?.name ?? 'Unmatched'}
            </h2>
            <StatusPill failed={failed} />
            {failed && attempt != null && (
              <span className="rounded-full border border-fail/30 bg-fail/5 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-fail">
                Attempt {attempt}/{MAX_DELIVERY_ATTEMPTS}
              </span>
            )}
            {returned && (
              <span className="rounded-full border border-fail/40 bg-fail/10 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-fail">
                Returned
              </span>
            )}
            {pod.site && (
              <span className="rounded-full border border-navy-500/30 bg-navy-500/5 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-navy-500">
                Site{pod.site.kind === 'both' ? '' : ` · ${pod.site.kind}`}
              </span>
            )}
            {route && (
              <span className="rounded-full border border-line bg-paper px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-muted">
                {route}
              </span>
            )}
            {pod.dest_distance_m != null && pod.dest_distance_m > 250 && (
              <span className="rounded-full border border-fail/40 bg-fail/10 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-fail">
                {fmtDistance(pod.dest_distance_m)} from address
              </span>
            )}
            {pod.gps_source === 'photo_exif' && (
              <span className="rounded-full border border-ok/40 bg-ok/10 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-ok">
                GPS from photo
              </span>
            )}
            {/* Legacy badge — new captures never simulate a fix */}
            {pod.gps_simulated && (
              <span className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-gold">
                GPS simulated
              </span>
            )}
            {/* Real-GPS-only: a capture without a fix is flagged, not faked */}
            {!point && (
              <span className="rounded-full border border-fail/40 bg-fail/10 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] text-fail">
                No GPS
              </span>
            )}
          </div>

          {pod.parcel && (
            <div className="mt-1 text-[13.5px] leading-snug">
              <span className="font-semibold">{pod.parcel.recipient_name}</span>
              <span className="text-muted">
                {' '}
                · {pod.parcel.address_line}
                {pod.parcel.postcode ? `, ${pod.parcel.postcode}` : ''} · {pod.parcel.delivery_area}
              </span>
            </div>
          )}

          {!pod.parcel && pod.site && (
            <div className="mt-1 text-[13.5px] leading-snug">
              <span className="font-semibold">{pod.site.name}</span>
              {(pod.site.address_line || pod.site.postcode) && (
                <span className="text-muted">
                  {' '}
                  · {pod.site.address_line ?? ''}
                  {pod.site.postcode ? `, ${pod.site.postcode}` : ''}
                </span>
              )}
            </div>
          )}

          <div className="mt-1 font-mono text-[11.5px] tracking-[0.5px] text-navy-500">
            scanned {pod.tracking_scanned}
            {mismatch && <span className="text-fail"> ≠ parcel</span>}
          </div>

          {failed && (
            <div className="mt-2 rounded-[10px] border border-fail/30 bg-fail/10 px-3 py-2 text-[13px] text-fail">
              <span className="font-bold">Reason:</span> {pod.failure_reason}
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-3">
            <Meta k="Driver" v={driverName(pod.driver_id)} />
            <Meta k="Received by" v={pod.received_by ?? '—'} />
            <Meta k="Captured (device)" v={fmt(pod.captured_at)} />
            <Meta k="Synced (server)" v={fmt(pod.synced_at)} />
            <Meta
              k="From address"
              v={
                pod.dest_distance_m == null ? (
                  '—'
                ) : (
                  <span className={pod.dest_distance_m <= 250 ? 'text-ok' : 'text-fail'}>
                    {fmtDistance(pod.dest_distance_m)}
                  </span>
                )
              }
            />
            <Meta
              k={`Location ${pod.gps_source === 'photo_exif' ? '(photo)' : pod.gps_simulated ? '(sim)' : ''}`}
              v={
                point ? (
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=17/${point.lat}/${point.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-navy-500 underline"
                  >
                    <PinGlyph /> {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
                    {pod.gps_accuracy_m != null ? ` ±${pod.gps_accuracy_m}m` : ''}
                  </a>
                ) : (
                  '—'
                )
              }
            />
          </div>

          {signatureUrl && (
            <div className="mt-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">Signature</div>
              <img
                src={signatureUrl}
                alt="signature"
                className="mt-1 h-12 rounded-[8px] border border-line bg-white px-2"
              />
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function StatusPill({ failed }: { failed: boolean }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.6px] ${
        failed ? 'border-fail/40 bg-fail/10 text-fail' : 'border-ok/40 bg-ok/10 text-ok'
      }`}
    >
      {failed ? 'Failed' : 'Delivered'}
    </span>
  )
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">{k}</div>
      <div className="mt-0.5 font-medium tabular-nums text-ink">{v}</div>
    </div>
  )
}

function PinGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="inline h-3.5 w-3.5 -translate-y-px fill-none stroke-current" strokeWidth="2">
      <path d="M12 21s-7-5.7-7-11a7 7 0 0 1 14 0c0 5.3-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  )
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** captured_at (ISO w/ tz) → its local calendar day, YYYY-MM-DD — for the day
 *  filter (grouping/comparison must be in the dispatcher's timezone). */
function localDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA') // en-CA renders as YYYY-MM-DD
}

/** A local day (YYYY-MM-DD) as "Mon 13 Jul" for the dropdown. */
function fmtDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
}
