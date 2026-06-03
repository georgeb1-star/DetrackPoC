# ePOD PoC — project conventions

A complete proof-of-concept for Electronic Proof of Delivery. The brief is
`epod-poc-claude-code-brief.md`; the canonical driver-app look is
`design-reference.html` (open it — match it, don't approximate it). The
acceptance-test walkthrough is `DEMO.md`.

## Ground rules

- **PoC, not production.** Convincing runnable demo > completeness. No real
  auth (hardcoded `drv_demo`), no multi-tenancy, RLS off, public bucket.
- Keep logic commented where non-obvious: overlay maths (`stamp.ts`), sync
  idempotency (`pod.ts`/`syncWorker.ts`), GPS fallback (`useGeolocation.ts`),
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
Routing:  main.tsx hash router — #/dispatch = DispatcherScreen, else driver App
```

- **Idempotency invariant:** every server write is keyed on the
  client-generated `podId`; storage paths are deterministic
  (`{podId}/label.jpg`, `{podId}/where_left.jpg`, `{podId}/signature.png`).
  A retry must never duplicate — preserve this in any change.
- **Trust boundary:** `captured_at` = device clock at the shutter;
  `synced_at` = DB column default `now()` at first insert (never sent by the
  client, never overwritten on conflict-update).
- **GPS:** acquired on capture-screen mount; denied/timeout/insecure-context
  → Erith fallback `51.484, 0.177 ±35m` with `gps_simulated=true`. The fix
  burned into the photo is the fix stored on the record (`usedFixRef`).
- **Geography columns** come back from PostgREST as EWKB hex — parse with
  `geo.ts` (offsets verified by `scripts/test-ewkb.mjs`).

## Data model (§4 + adjustments)

- `parcels` — tracking_number unique (the barcode value), recipient/address,
  `destination geography(point,4326)`, area, status; seeded with 8 UK parcels
  (`CP-849213-GB` = the design-reference parcel)
- `pod_records` — client UUID pk, parcel_id FK, tracking_scanned, status
  (delivered|failed), failure_reason (check: required when failed),
  received_by, captured_at, synced_at (default now()), location geography,
  gps_accuracy_m, gps_simulated, signature_path, driver_id
- `pod_photos` — pod_id FK cascade, photo_type label|where_left,
  storage_path, orig_kb, compressed_kb, **unique (pod_id, photo_type)**
- Bucket `pod-evidence`: public read + open insert (PoC policies)

## Design tokens (§7) — in `tailwind.config.js`

- navy `#0e1c38` / 600 `#16294d` / 500 `#1f3a66`; gold `#c9a227` /
  soft `#e3c766`; paper `#f6f4ee`; ink `#10192e`; muted `#6b7589`;
  ok `#2f8f5b`; fail `#c0492f`; hairline `line` = `rgba(14,28,56,.12)`
- Georgia serif: app title, parcel ref, primary buttons. Mono: barcode lines,
  JSON. Section labels: 11px uppercase tracked muted bold.
- Phone frame 390px / radius 30px / `shadow-phone` bezel on the navy
  radial+linear desk gradient. Gold-to-transparent `gold-underline` on top
  bars. GPS chip gold + "(simulated)" on fallback. JSON panel: keys gold,
  strings green, numbers orange, booleans blue.

## Commands

```powershell
npm run dev                  # vite dev server
npm run build                # tsc -b && vite build (run before committing)
npx supabase start|stop      # local stack (Docker)
npx supabase db reset        # re-apply migration + seed
node scripts/smoke-db.mjs    # stack/seed/bucket/idempotency smoke test
```
