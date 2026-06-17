# Auto-enrich job import from GWOptical — design

**Date:** 2026-06-17
**Status:** Approved (brainstorm), pending implementation plan
**Related:**
- `src/screens/JobsScreen.tsx` (current manifest import + allocation)
- `src/screens/AllocateScreen.tsx` (auto-allocate by area)
- `src/lib/manifest.ts` (parse + map + build parcel inputs)
- `src/lib/types.ts` (`Area` / `AREAS`)
- `supabase/functions/admin/index.ts` (Edge Function pattern this mirrors)
- Lens repo `specsavers-report/scripts/load_data.py` (the GWOptical → `public.shipments` mirror)
- Memory: `gwoptical-integration`, `hosting-setup`

## 1. Goal

Let a dispatcher create parcels from **bare tracking numbers**. Recipient name +
delivery address are pulled automatically from GWOptical (read via Lens's
Supabase mirror of `dbo.Shipments`), so the address no longer has to be present
in the uploaded manifest.

### Non-goals (explicitly out of scope for this iteration)

- Geocoding the `destination` point for enriched parcels (the mirror has no
  geocode for the shipment address). Geofence simply won't apply to enriched
  parcels until added later.
- Back-filling addresses for parcels already imported.
- Any write back to GWOptical / Lens (read-only).
- A new postcode→area dataset beyond the map the user defines (see §10).

## 2. Background

**Current import (the only way parcels are created):** the dispatcher uploads an
`.xlsx`/`.csv` in Jobs → "Import a manifest". `manifest.ts` finds the header row,
auto-maps columns by synonym, and **requires** tracking number, recipient, and
address (postcode/area optional). Rows missing a required field are reported and
skipped. Parcels upsert on the unique `tracking_number`.

**The data source:** GWOptical's `dbo.Shipments` holds, per tracking number, the
full recipient block — `Recipient_FullName`, `Recipient_Address1/2/3`,
`Recipient_City`, `Recipient_County`, `Recipient_Postcode`, phone, email,
`DeliveryInstructions`, and `CarrierProviderServiceName`. Lens already mirrors
all of `dbo.Shipments` into its Supabase table `public.shipments`
(project `eivbxinppkwhqtglusmh`, eu-west-2) every ~5 minutes via
`load_data.py`. `tracking_number` is unique-indexed there; `recipient_postcode`
is indexed too.

**The hard constraint:** GWOptical itself sits on a private 10.x network
(Tailscale), reachable only from the Citipost automation host — never from
Vercel/Supabase. So ePOD cannot query GWOptical directly. It reaches the data
**via Lens's mirror**, which is a normal hosted Supabase project on the public
internet (same region as ePOD's `mqiwyfhxcjvkpnpbtgql`).

**Lens mirror access posture:** `public.shipments` has RLS **enabled with no
policy and grants revoked** (Lens migration 038) — anon/authenticated literally
cannot read it. Only a privileged connection (a dedicated role, or service_role
bypass) can. Therefore the read must happen **server-side**, never from the
browser.

## 3. Architecture & data flow

```
Dispatcher browser (ePOD on Vercel)
   │  paste a list of tracking numbers  OR  upload a tracking-only file
   ▼
ePOD Edge Function  enrich-shipments      (server-side; holds the Lens read creds)
   │  1. verify caller JWT + profile.role = 'admin'      (same gate as admin fn)
   │  2. SELECT <needed cols> FROM shipments WHERE tracking_number = ANY($list)  ← Lens, read-only
   ▼  returns { found: ShipmentRow[], notFound: string[], counts }   (raw matched rows)
Dispatcher browser  (src/lib/enrich.ts — node-testable)
   │  3. per matched row: compose address_line + recipient, derive area → ParcelInput
   │  4. render results (found preview + not-found list with Retry)
   ▼  5. commit mapped rows via the SAME parcels upsert the manifest importer uses
parcels (ePOD Supabase) — admin RLS enforced under the dispatcher's session
```

**Separation of duties:** the Edge Function does the *privileged cross-project
read + transform only*. The browser does the *parcels write*, under the
dispatcher's own authenticated session, through the existing admin RLS — exactly
as the manifest importer commits today. The Lens credential never leaves the
function; the function never bypasses ePOD's own RLS for the write.

This is a third instance of the proven host-bridge shape used by `load_data.py`
and `forward_gw_events.py`, but cloud-to-cloud (ePOD function → Lens DB) instead
of host-to-cloud, so no automation-host involvement and near-instant results.

## 4. Components

### 4.1 Edge Function `supabase/functions/enrich-shipments/index.ts`
Mirrors `admin/index.ts`: `Deno.serve`, the same CORS block, JWT verification,
and the **admin-only gate** (`profiles.role === 'admin'`). One POST action:
`enrich`, body `{ tracking_numbers: string[] }`.

- Connects to Lens with a **dedicated read-only role** (not service_role) via a
  Deno Postgres client (`postgres`/`postgresjs`), using a new function secret
  `LENS_DB_URL` (pooler URI, transaction mode, carrying the read-only role's
  creds). See §8.
- Normalises/dedupes the input tracking numbers; caps batch size (e.g. 1000) to
  bound a single query.
- `SELECT tracking_number, recipient_full_name, recipient_company,
  recipient_address1, recipient_address2, recipient_address3, recipient_city,
  recipient_county, recipient_postcode FROM public.shipments WHERE
  tracking_number = ANY($1) AND is_deleted = false` — **only these columns** (no
  phone/email/tax), minimising the PII crossing.
- Computes `notFound` = submitted − matched.
- Returns `{ data: { found: ShipmentRow[], notFound: string[], counts: {...} } }`
  where `ShipmentRow` is the raw selected columns. On a Lens connection error
  returns a clear, retryable error (the UI surfaces "couldn't reach the address
  source — try again").

The function is a **thin privileged reader**: it does the cross-project SELECT
and nothing else. All shaping is client-side (§4.2). It deliberately does *not*
duplicate transform logic (unlike `admin/index.ts`, which must duplicate auth
helpers) — keeping the testable business logic in one node-testable place.

### 4.2 Enrichment shaping — `src/lib/enrich.ts` (new, node-testable)
Pure TS, the single source of truth for turning a `ShipmentRow` into the
existing `ParcelInput` (from `manifest.ts`). Imported by both entry points and
by a node test, exactly like `manifest.ts`. Functions:
- `composeAddressLine(row): string` — join non-empty `address1/2/3, city,
  county` with ", ".
- `composeRecipient(row): string` — `recipient_full_name` ||
  `recipient_company` || "(no name)".
- `deriveArea(postcode): Area` — postcode→area map (§4.4); unmatched/blank →
  `'Other'`. **This is where the user-authored map lives** — plain, commented TS
  that's easy to read, amend, and node-test.
- `shipmentToParcelInput(row): ParcelInput` — composes the above into a
  `ParcelInput` (`meta` carries the raw row for traceability).

The paste box and the file importer both map via `shipmentToParcelInput`, so
their previews and commits are byte-identical.

### 4.3 Entry points (both)
1. **Paste box** — a new "Enrich from tracking numbers" panel on `JobsScreen`,
   beside "Import a manifest": a textarea (one tracking number per line / also
   accept comma/whitespace separated), a job-name field, and a "Look up
   addresses" button. Calls `enrich-shipments`, shows the found preview + the
   not-found list (with **Retry** — re-submits only the not-found set), then
   "Import N parcels" commits via the same upsert path as the importer.
2. **Extended file importer** — when an uploaded sheet maps a tracking column
   but **no address column**, route those rows through `enrich-shipments`
   instead of erroring as "missing address". Rows that already carry an address
   are kept as-is (no lookup). The "missing address" validation in
   `buildParcelInputs` is relaxed accordingly: a row with a tracking number but
   no address is no longer an error — it's an enrichment candidate.

### 4.4 Area derivation + the "Other" bucket
- **`'Other'` becomes a real 7th area.** Added to the `Area` union and the
  `AREAS` array in `types.ts`; `RoutesPanel` builds its "Covers areas"
  checkboxes from `AREAS`, so "Other" becomes tickable on any route with no
  extra UI. Added to the `parcels.area` CHECK constraint (migration +
  `cloud-setup.sql`).
- **`deriveArea(postcode)`** maps the postcode's outward code to one of the six
  geographic labels via a map the user defines (§10); **anything unmatched, or a
  missing/blank postcode, → `'Other'`** (never a wrong guess). No NULL sentinel
  — a real label keeps enriched parcels on the same allocation machinery as
  everything else.
- **Manifest fallback** `toArea()` in `manifest.ts` changes its fallback from
  `'South London'` → `'Other'` for consistency (an unknown/blank area is
  honestly "Other"). *Behaviour change to the existing importer — intentional.*

### 4.5 Inline area editor (the "fix it" control)
A small `<select>` of `AREAS` on the dispatcher's parcel rows (Allocate screen;
optionally the Jobs job-detail rows), mirroring the existing route dropdown,
writing `parcels.area`. Lets a dispatcher relabel an `'Other'` (or any
mis-classified) parcel to a real area, which then makes auto-allocate place it.
This also improves the pre-existing manifest flow, not just enrichment.

The three post-import levers for an `'Other'` parcel, dispatcher's choice:
1. Leave it in the Other bucket.
2. Assign it to a driver directly (bulk-select in Jobs / per-parcel in Allocate)
   — works today via `route_id`.
3. Relabel its area (4.5) and/or tick "Other" on a catch-all route so
   auto-allocate sweeps it on.

## 5. Data model changes

- **No relaxation of `parcels.recipient_name` / `address_line` NOT NULL** —
  because not-found tracking numbers are reported, never stored, every parcel
  still always has a real recipient + address.
- `parcels.area` CHECK gains `'Other'`. New migration
  `…_area_other.sql` (drop+recreate the CHECK to include 'Other'); same edit in
  `supabase/cloud-setup.sql`. `routes.areas` is unconstrained `text[]` — no DB
  change there.
- `Area` type + `AREAS` array gain `'Other'` in `src/lib/types.ts`.
- `destination` stays NULL for enriched parcels (non-goal §1).

## 6. Enrichment logic

**Function (server):**
1. **Normalise** the submitted list (trim, upper-case to match the importer's
   dedupe key); drop blanks; dedupe within the batch; cap size.
2. **Lookup** in `public.shipments` by `tracking_number` (`is_deleted = false`).
3. Return matched rows (`found`) + `notFound` = submitted − matched.

**Client (`src/lib/enrich.ts` + UI):**
4. Map each matched row via `shipmentToParcelInput` → compose
   `recipient_name`/`address_line`/`postcode`, derive `area` (geographic label
   or `'Other'`).
5. Render the found preview + the `notFound` list; commit the mapped rows only;
   offer **Retry** on `notFound` (a brand-new shipment commonly just hasn't hit
   Lens's 5-min sync yet).

Function response shape:
```ts
{ found: ShipmentRow[]; notFound: string[];
  counts: { submitted: number; found: number; notFound: number } }
```
where `ShipmentRow` = the raw selected columns (§4.1).

## 7. Idempotency & re-import

Commit uses the existing `parcels` upsert on `onConflict: 'tracking_number'`,
attached to the job/manifest exactly like the manifest importer — re-submitting
the same numbers updates rather than duplicating, and leaves `route_id`/`status`
untouched.

## 8. Security & secrets

- **Dedicated read-only role on Lens** scoped to `SELECT` on `public.shipments`
  (do *not* reuse Lens's service_role). Its pooler URI is stored as the ePOD
  Edge Function secret `LENS_DB_URL` (set via `supabase secrets set`, never
  committed; analogous to how `scripts/.env` holds host secrets). Creating this
  role + grant is a one-time change in the **Lens** project — a cross-product
  action to be done deliberately.
- **Admin-only:** the function rejects any caller whose profile role isn't
  `admin`, identical to `admin/index.ts`.
- **PII boundary:** recipient name/address/phone/email cross from the Specsavers
  reporting DB into ePOD. We query only the recipient fields we need (not phone/
  email/tax/IOSS) to minimise the crossing. Recorded as a deliberate boundary.

## 9. Coupling & failure modes

- **Bounded coupling:** the address is copied into ePOD's `parcels` at import. A
  Lens outage blocks only *new* enrichments; existing parcels are unaffected
  (no live foreign dependency).
- **Freshness dependency:** enrichment can only find shipments Lens has already
  synced (≤5 min lag, longer if Lens's loader is stalled). This is exactly why
  not-found is *report-and-retry*, not an error.
- **Lens unreachable:** function returns a retryable error; nothing is
  committed; dispatcher retries.

## 10. Open item for implementation (user contribution)

The **postcode → area map** in `deriveArea` (`src/lib/enrich.ts`) is the user's
domain knowledge and the one piece of business logic to be authored at
implementation time: which outward codes map to South/North/West/Central London,
Kent, Surrey — everything else → `'Other'`. A small, well-commented lookup so the
rules are easy to read, amend, and node-test. (Per learning-mode: this is a great
spot for the user to write the rules.)

Tests follow the repo convention: standalone node `.mjs` scripts that import the
real `src/lib/*.ts` via Node type-stripping and assert with a tiny `check()`
harness (see `scripts/test-manifest.mjs`). No test runner is added.

- `scripts/test-enrich.mjs` (pure, no DB/stack): `composeAddressLine`,
  `composeRecipient`, `deriveArea` (geographic match, Kent/Surrey, unmatched →
  Other, blank/null → Other), `shipmentToParcelInput`, and the
  `buildParcelInputs` relaxation (tracking-only rows become enrichment
  candidates, not errors; rows with an address still validate; `'Other'`
  fallback).
- Edge Function: verified manually/integration, not unit-tested (Deno + a live
  Lens connection). Checks: admin gate (401 no token / 403 non-admin), batch
  cap, found/notFound split, Lens-error path. Use a throwaway real tracking
  number against the live mirror (read-only).
- Manual e2e: paste box happy path; tracking-only file; mixed file (some rows
  already have an address); not-found + Retry; Other bucket → relabel and →
  auto-allocate.

## 12. Rollout / migration steps (high level)

1. Lens: create the read-only role + `GRANT SELECT ON public.shipments`.
2. ePOD: `area_other` migration (live DDL via the established `execute_sql`
   path, since the hosted project isn't CLI-migration-tracked) + `cloud-setup.sql`.
3. ePOD: `types.ts` (`'Other'`), `manifest.ts` fallback.
4. Deploy `enrich-shipments` Edge Function; `supabase secrets set LENS_DB_URL=…`.
5. Ship paste box + importer extension + inline area editor.
6. `npm run build` before committing; push → Vercel auto-rebuild.
