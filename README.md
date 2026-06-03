# ePOD Proof of Concept

Electronic Proof of Delivery PoC: a driver PWA that captures an evidence
bundle (stamped photos, timestamp, GPS, recipient, optional signature,
delivered/failed status) at the moment of delivery — **including fully
offline** — and syncs it to Supabase, where a dispatcher view shows it
attached to the correct parcel.

**Status: complete.** All eight checkpoints of
[`epod-poc-claude-code-brief.md`](epod-poc-claude-code-brief.md) are built;
the acceptance-test walkthrough is in [`DEMO.md`](DEMO.md).

## Stack

- **React + TypeScript + Vite**, installable PWA (`vite-plugin-pwa`, service
  worker active in dev too)
- **Tailwind v3** themed to [`design-reference.html`](design-reference.html)
  (navy / gold / paper, Georgia serif display)
- **Supabase** local stack (Postgres + PostGIS, Storage) via the CLI
- **Dexie** (IndexedDB) offline queue + idempotent sync worker
- **Barcode:** native `BarcodeDetector` → `@zxing/library` fallback
  (lazy-loaded) · **Signature:** `signature_pad` · **Stamp/compress:** plain
  `<canvas>`

## Prerequisites

- Node 20+ and npm
- **Docker Desktop running** (required by `supabase start`)

## Setup & run

```powershell
npm install
npx supabase start          # boots local Supabase; prints URL + keys
copy .env.example .env      # paste the publishable/anon key from above
npm run dev                 # http://localhost:5173
```

| URL | What |
| --- | --- |
| http://localhost:5173 | Driver app (phone-framed) |
| http://localhost:5173/#/dispatch | Dispatcher — captured PODs |
| http://127.0.0.1:54323 | Supabase Studio (tables, bucket) |

`npx supabase status` re-prints the keys; `npx supabase db reset` re-runs the
migration + seed.

## Seeded tracking numbers

Scan a barcode of one of these (any Code 128/QR generator works), or just
type it into the scan sheet:

| Tracking number | Recipient | Area |
| --- | --- | --- |
| `CP-849213-GB` | Meridian Logistics, Erith | Domestic |
| `CP-100002-GB` | Patricia Holloway, Maidstone | Domestic |
| `CP-100003-GB` | Dev & Sons Hardware, London | Domestic |
| `CP-200004-GB` | Brightwell Imports Ltd, Edinburgh | International |
| `CP-200005-GB` | Atlantique Wines (UK), Cardiff | International |
| `CP-300006-GB` | Acme Home Goods — J. Mercer, Leeds | Fulfilment |
| `CP-300007-GB` | Tillys Toy Shop, Norwich | Fulfilment |
| `CP-400008-GB` | NN4 Regional Sort Hub, Northampton | Sortation |

(`CP-849213-GB` is the parcel from `design-reference.html`.)

## Simulating offline

DevTools → Network → throttling → **Offline**. Complete deliveries — each
shows **"captured & queued"** and the badge counts up. Switch back online and
the queue drains within seconds (`online` event + 8s interval), the open
confirmation flips to **synced**, and rows/photos appear in Supabase. The
most faithful offline app-shell test is a production build:
`npm run build && npm run preview`.

## How the offline sync works (the short version)

1. **Complete delivery** writes the whole bundle — photo/signature **blobs**
   included — to IndexedDB and returns instantly. Nothing blocks on the
   network.
2. A **sync worker** (app load · `online` event · 8s interval · post-capture)
   drains the queue oldest-first: upload photos/signature → upsert
   `pod_records` → upsert `pod_photos` → update parcel status.
3. Every step is **idempotent on the client-generated `pod_id`**
   (deterministic storage paths + `on conflict` upserts), so retries after
   partial failures never duplicate anything.
4. `captured_at` is the device clock (evidence time); `synced_at` is set by a
   **DB default on insert** — the server's own clock, the trust stamp.
5. Synced queue items are kept with a flipped flag (history), not deleted.

## Repo guide

| Path | Purpose |
| --- | --- |
| `design-reference.html` | Canonical look for the driver app |
| `epod-poc-claude-code-brief.md` | The build brief |
| `supabase/migrations/` | Schema: parcels, pod_records, pod_photos, bucket + policies |
| `supabase/seed.sql` | The 8 demo parcels |
| `src/lib/` | stamp (canvas overlay), pod (queue+upload), syncWorker, db (Dexie), geo (EWKB) |
| `src/screens/` | Stops, Capture, Result, Dispatcher |
| `scripts/smoke-db.mjs` | Stack/seed/bucket/idempotency smoke test |
| `DEMO.md` | §9 acceptance-test walkthrough |
| `CLAUDE.md` | Conventions + architecture for future sessions |

## PoC boundaries

No real auth (hardcoded `drv_demo`), single tenant, no route optimisation, no
notifications. The storage bucket is public-read and RLS is off — fine for a
local demo, not for production.
