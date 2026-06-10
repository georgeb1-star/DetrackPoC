import { useCallback, useEffect, useState } from 'react'
import { signOut } from '../hooks/useSession'
import { fmtDistance, parseEwkbPoint } from '../lib/geo'
import { supabase } from '../lib/supabase'
import type { Parcel, PodPhoto, PodRecord } from '../lib/types'

interface JoinedPod extends PodRecord {
  parcel: Parcel | null
  photos: PodPhoto[]
}

/** Dispatcher view (§6.4): the read side that proves the round trip — every
 *  captured POD joined to its parcel, with the stamped photo, location,
 *  device vs server timestamps, and failure reasons. Full-width page in the
 *  same navy/gold/paper language as the driver app. */
export function DispatcherScreen() {
  const [pods, setPods] = useState<JoinedPod[] | null>(null)
  const [urls, setUrls] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('pod_records')
      .select('*, parcel:parcels(*), photos:pod_photos(*)')
      .order('created_at', { ascending: false })
    if (error) {
      setError(error.message)
      return
    }
    const rows = data as unknown as JoinedPod[]
    setPods(rows)
    setError(null)
    // The evidence bucket is private under RLS — mint short-lived signed URLs
    // for every photo + signature so the dispatcher can view them.
    const paths = rows.flatMap((pod) => [
      ...pod.photos.map((ph) => ph.storage_path),
      ...(pod.signature_path ? [pod.signature_path] : []),
    ])
    if (paths.length === 0) {
      setUrls(new Map())
      return
    }
    const { data: signed } = await supabase.storage.from('pod-evidence').createSignedUrls(paths, 3600)
    setUrls(
      new Map((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path as string, s.signedUrl as string])),
    )
  }, [])

  // Realtime: new PODs appear the instant a driver device syncs (the table is
  // in the supabase_realtime publication). The lazy poll stays as a fallback
  // for environments where Realtime isn't enabled.
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 10_000)
    const channel = supabase
      .channel('pod-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pod_records' }, () => void load())
      .subscribe()
    return () => {
      clearInterval(id)
      void supabase.removeChannel(channel)
    }
  }, [load])

  return (
    // Edge-to-edge on mobile, contained card on larger screens
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
            <h1 className="font-serif text-[22px]">Captured PODs</h1>
            <span className="font-mono text-xs tracking-[1px] text-[#9fb0d6]">
              {pods ? `${pods.length} record${pods.length === 1 ? '' : 's'}` : '…'}
            </span>
          </div>
          {/* Dispatch tabs */}
          <div className="mt-3 flex gap-2">
            <a
              href="#/allocate"
              className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5"
            >
              Allocate
            </a>
            <a
              href="#/jobs"
              className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5"
            >
              Jobs
            </a>
            <a
              href="#/sites"
              className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#9fb0d6] transition hover:bg-white/5"
            >
              Sites
            </a>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold text-white">
              Captured PODs
            </span>
          </div>
        </header>

        <div className="min-h-[calc(100dvh-110px)] bg-paper p-4 sm:min-h-0 sm:rounded-b-2xl sm:p-5">
          {error && (
            <div className="rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">
              Couldn't load PODs: {error}. Is the local Supabase stack running?
            </div>
          )}

          {pods && pods.length === 0 && (
            <div className="py-14 text-center text-[13.5px] text-muted">
              No PODs captured yet — complete a delivery in the{' '}
              <a href="#/" className="text-navy-500 underline">
                driver app
              </a>
              .
            </div>
          )}

          <div className="flex flex-col gap-3">
            {pods?.map((pod) => (
              <PodCard key={pod.id} pod={pod} urls={urls} onPhoto={setLightbox} />
            ))}
          </div>
        </div>
      </div>

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
    </div>
  )
}

function PodCard({
  pod,
  urls,
  onPhoto,
}: {
  pod: JoinedPod
  urls: Map<string, string>
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
              {pod.parcel?.tracking_number ?? 'Unmatched parcel'}
            </h2>
            <StatusPill failed={failed} />
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
                {pod.parcel.postcode ? `, ${pod.parcel.postcode}` : ''} · {pod.parcel.area}
              </span>
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

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-4">
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
