# Citipost ePOD — project conventions

Electronic Proof of Delivery — a production driver PWA + dispatcher portal.
Originally built to `epod-poc-claude-code-brief.md`; the original driver-app
look is `design-reference.html` (since superseded by the "Freight Modern" theme
— see Design tokens). Setup and the access model live in `README.md`.

## Ground rules

- **Auth & access.** Supabase Auth sign-in portal; accounts + profiles are
  provisioned out-of-band (`scripts/seed-auth.mjs` — rerun after every local
  `db reset`; password via `SEED_PASSWORD`). RLS on every table (`profiles`
  maps user → role + driver_id; drivers see only their route's parcels/PODs;
  dispatch is admin-only; `profiles` has no insert/update policy, so a
  signed-in user can't self-escalate). Private `pod-evidence` bucket
  (signed-URL reads). No multi-tenancy. Ships with no seed data — empty fleet
  until one is provisioned (`supabase/seed.sql` template).
- Keep logic commented where non-obvious: overlay maths (`stamp.ts`), sync
  idempotency (`pod.ts`/`syncWorker.ts`), GPS acquisition (`useGeolocation.ts`),
  EWKB parsing (`geo.ts`).
- Windows dev machine. The Supabase CLI is a devDependency; in sandboxed
  shells `npx supabase` can fail with EPERM — call the binary directly:
  `node_modules\@supabase\cli-windows-x64\bin\supabase.exe`.
- Docker Desktop must be running for `supabase start`.

## Stack decisions (fixed by the brief — don't re-litigate)

- Vite + React 19 + TS strict; PWA via `vite-plugin-pwa` (`devOptions.enabled`
  so offline works in dev; bulletproof offline = build + preview)
- Tailwind **v3** (classic `tailwind.config.js` — the brief specifies
  `theme.extend.colors`)
- Supabase JS v2 on the local CLI stack; PostGIS enabled
- Dexie for the offline queue; **capture always goes through the queue**,
  online or not
- Barcode: native `BarcodeDetector` if `getSupportedFormats()` is non-empty,
  else `@zxing/library` (dynamic import — keep it out of the main chunk)
- `signature_pad` for signatures; plain `<canvas>` for stamp + compress

## Architecture

```
CaptureScreen ─→ queuePod() ──→ Dexie (epod.pods: bundle + blobs, synced=0)
                    │                       ▲ flips to synced=1, kept as history
                    └→ syncNow() ─→ uploadPod(): storage upserts → pod_records
                                    upsert (onConflict id) → pod_photos upsert
                                    (onConflict pod_id,photo_type) → parcel status
Triggers: app load · window "online" · 8s interval · post-capture · badge tap
Events:   syncEvents.ts emitter → useSyncStatus / useQueuedPod re-query
Routing:  main.tsx hash router gated by useSession (LoginScreen when signed
          out) — #/allocate · #/jobs · #/dispatch = dispatcher (admin-only;
          drivers bounced), else driver App. driver_id comes from the session.
```

- **Idempotency invariant:** every server write is keyed on the
  client-generated `podId`; storage paths are deterministic
  (`{podId}/label.jpg`, `{podId}/where_left.jpg`, `{podId}/signature.png`).
  A retry must never duplicate — preserve this in any change.
- **Poison items:** after `MAX_AUTO_ATTEMPTS` (5) failures an item is
  "stuck" — skipped by automatic passes (never blocks the queue), retried by
  a manual badge tap (`syncNow({includeStuck:true})`).
- **Lifecycle (2026-06-10):** `parcels.status` IS the lifecycle:
  `awaiting_collection → collected → at_warehouse → delivered` (+ terminal
  `returned`). Each forward step is a scan event in `parcel_events`
  (client-UUID pk = idempotency key, stage, captured_at device clock,
  synced_at server default, location/accuracy/source, driver_id).
  Collection/warehouse = QUICK scans (no photo) from the scan sheet, queued in
  Dexie `events` (v4) and drained by the same sync worker; delivery = the full
  POD capture, whose sync also upserts a `delivered` event (id = podId).
  **Scanning auto-advances (2026-07-14, supersedes the earlier
  no-auto-advance / warn-but-allow model):** a scan moves the parcel to its
  NEXT lifecycle step, so re-scanning an already-collected parcel walks it
  forward (collected→at_warehouse→delivery) without re-picking a stage. The
  stage switch is a floor: picking Deliver routes a collected parcel straight
  to capture, so coupon runs (collect→deliver) skip warehouse; a 15 s
  per-label lockout stops a held camera burst-advancing. Server-side the
  guarantee is unchanged — status only ever advances forward via the atomic
  `advance_parcel_status` RPC (security invoker, rank guard in SQL), so
  late/concurrent syncs can't regress a parcel. Event INSERT RLS requires
  the parcel to be on the driver's own route (hardening migration
  2026-06-11). Tracking export covers the full journey: POD outcomes +
  collection/warehouse scans, merged chronologically.
- **Attempt model:** delivered = terminal; failed keeps the parcel at its
  current lifecycle stage (re-attempt, rolls over). The
  `apply_failed_attempt` RPC derives `attempts` from the COUNT of failed
  pod_records (idempotent — a sync retry can't double-count) and goes
  terminal `'returned'` at `MAX_DELIVERY_ATTEMPTS` (3).
- **Geofence:** haversine (geo.ts) between the capture fix and
  `parcels.destination` at capture → `pod_records.dest_distance_m`;
  thresholds 250 m ok / 1 km warn used in capture chip, receipt, dispatcher.
- **Offline cache:** Dexie v2 `parcels` table is a read-through cache of the
  stop list (cold offline start still renders the run).
- **Trust boundary:** `captured_at` = device clock at the shutter;
  `synced_at` = DB column default `now()` at first insert (never sent by the
  client, never overwritten on conflict-update).
- **GPS is real-or-nothing** (`gps_source`): photo EXIF (exifr) → live
  device fix (warm-up on capture-screen mount, *fresh* read at the
  shutter) → none (`location`/`gps_source` null, red "no fix" chip with the
  reason + Retry). There is NO simulated fallback (removed 2026-06-03 at
  the user's request, diverging from the brief); `gps_simulated` and the
  'simulated' enum value linger only for legacy rows. EXIF fixes have
  `gps_accuracy_m = null`. The fix burned into the photo is the fix stored
  on the record (tri-state `usedFix` in CaptureScreen). Browsers often
  strip EXIF GPS, so 'device' is the common case. Real GPS needs a secure
  context: `npm run dev:https` for LAN phones — but Chrome auto-denies
  geolocation on self-signed certs, so phone GPS demos want a trusted
  origin (deploy) or the phone-side `unsafely-treat-insecure-origin-as-
  secure` flag.
- **Geography columns** come back from PostgREST as EWKB hex — parse with
  `geo.ts` (offsets verified by `scripts/test-ewkb.mjs`).

## Data model (§4 + adjustments)

- `parcels` — tracking_number unique (the barcode value), recipient/address,
  `destination geography(point,4326)`, area, status, `due_date` (the run the
  parcel belongs to). No seed data — parcels are created via the dispatcher's
  manifest import. **Rollover is derived**: pending AND due_date < today →
  badge + sorted first (order by due_date) — no nightly job.
- `pod_records` — client UUID pk, parcel_id FK, tracking_scanned, status
  (delivered|failed), failure_reason (check: required when failed),
  received_by, captured_at, synced_at (default now()), location geography,
  gps_accuracy_m, gps_simulated, signature_path, driver_id
- `pod_photos` — pod_id FK cascade, photo_type label|where_left,
  storage_path, orig_kb, compressed_kb, **unique (pod_id, photo_type)**
- Bucket `pod-evidence`: private — signed-in read + insert only; the
  dispatcher views photos via signed URLs

## Design tokens — in `tailwind.config.js`

- **"Freight Modern" theme (2026-06-11, user-requested — diverges from the §7
  brief / design-reference.html).** Token NAMES kept from the original system;
  values remapped: `navy` = graphite chrome `#0e1218` / 600 `#1a2029` /
  **500 `#2d5bff` ultramarine** (links, tracking numbers, focus); `gold` =
  hi-vis amber `#f5a30b` / soft `#ffce6b` (eyebrows, rollover, queued,
  underline); `paper` `#eff2f6`; `ink` `#101620`; `muted` `#5b6573`;
  ok `#0fa065`; fail `#e5484d`; `line` = `rgba(13,19,32,.11)`. Canvas =
  blueprint dot-grid (index.css body). `.barcode-strip` = decorative motif.
- Type (self-hosted @fontsource, offline-safe): **Barlow Condensed rides the
  `font-serif` utility** (display/titles/buttons — index.css bumps it to 600);
  Barlow = body; IBM Plex Mono = tracking numbers, JSON. Section labels: 11px
  uppercase tracked muted bold.
- Responsive shell (`AppShell`): edge-to-edge on mobile (min-h-dvh,
  safe-area-aware top bar/badge/footer), centred ~430px elevated column on
  the navy gradient for laptop. No mockup chrome — this is the product UI.
  Gold-to-transparent `gold-underline` on top bars. GPS chip red "no fix" +
  reason note with Retry when no real fix exists. JSON panel: keys gold,
  strings green, numbers orange, booleans blue.

## Commands

```powershell
npm run dev                  # vite dev server
npm run build                # tsc -b && vite build (run before committing)
npx supabase start|stop      # local stack (Docker)
npx supabase db reset        # re-apply migrations (empty seed; wipes auth users!)
node scripts/seed-auth.mjs   # recreate accounts — required after db reset
node scripts/smoke-db.mjs    # stack/seed/RLS/bucket/idempotency smoke test
```
