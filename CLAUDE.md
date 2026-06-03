# ePOD PoC — project conventions

A proof-of-concept for Electronic Proof of Delivery. The full brief is in
`epod-poc-claude-code-brief.md`; the canonical driver-app look is
`design-reference.html` (open it — match it, don't approximate it).

## Ground rules

- **PoC, not production.** Convincing runnable demo > completeness. No real
  auth (hardcoded `drv_demo`), no multi-tenancy, no route optimisation.
- Build in the §11 checkpoint order; each checkpoint must be runnable.
- Keep logic commented where non-obvious: overlay maths, sync idempotency,
  GPS fallback.
- Windows dev machine; Supabase runs locally via `npx supabase` (CLI is a
  devDependency). Docker Desktop must be running for `supabase start`.

## Stack decisions (fixed by the brief — don't re-litigate)

- Vite + React + TS, PWA via `vite-plugin-pwa` (dev SW enabled for offline demos)
- Tailwind **v3** (classic `tailwind.config.js`, because the brief specifies
  `theme.extend.colors`) — tokens below
- Supabase JS v2; local stack via CLI; PostGIS enabled
- Offline queue: Dexie (IndexedDB) — capture writes locally first, a sync
  worker drains the queue (idempotent on locally-generated `pod_id`)
- Barcode: native `BarcodeDetector`, fallback `@zxing/library`
- Signature: `signature_pad`; image stamp/compress: plain `<canvas>`

## Data model (§4)

- `parcels` — tracking_number (unique, the barcode value), recipient, address,
  `destination geography(point,4326)`, area (Domestic|International|Fulfilment|Sortation),
  status (pending|delivered|failed)
- `pod_records` — parcel_id FK, tracking_scanned, status (delivered|failed),
  failure_reason (required when failed), received_by, `captured_at` (device
  clock = evidence time) vs `synced_at` (server clock = trust stamp),
  `location geography(point,4326)`, gps_accuracy_m, `gps_simulated` flag,
  signature_path, driver_id
- `pod_photos` — pod_id FK (cascade), photo_type ('label'|'where_left'),
  storage_path, orig_kb, compressed_kb
- Storage bucket: `pod-evidence`

## Design tokens (§7) — in `tailwind.config.js`

- navy `#0e1c38` / 600 `#16294d` / 500 `#1f3a66`; gold `#c9a227` / soft `#e3c766`
- paper `#f6f4ee`, ink `#10192e`, muted `#6b7589`, ok `#2f8f5b`, fail `#c0492f`
- hairline border colour `line` = `rgba(14,28,56,.12)`
- Georgia serif for display (title, parcel ref, primary buttons); system sans
  body; mono for barcode + JSON
- Phone frame: 390px, radius 30px, `shadow-phone` bezel ring; driver app sits
  on the navy radial+linear gradient body background
- GPS chip turns **gold** with "(simulated)" when the fix is a fallback

## Commands

```powershell
npm run dev          # vite dev server
npm run build        # tsc -b && vite build
npx supabase start   # local supabase (Docker required)
npx supabase db reset  # re-run migrations + seed
```
