# Build an ePOD Proof of Concept — Claude Code Brief

> Paste this whole file into Claude Code from the root of an empty repo. Build it incrementally, checkpoint after each numbered section in §11, and stop to show me a runnable state at each checkpoint rather than building everything in one pass.
>
> I have also placed `design-reference.html` in the repo root. **Open it — it is the canonical look for the driver app.** Match its palette, typography, and component styling (see §7).

---

## 1. Context — what you're building

A **proof of concept for Electronic Proof of Delivery (ePOD)** for a parcel/logistics operation. A delivery driver, on their phone, captures a small *bundle of evidence* at the moment of delivery. The PoC must prove that this bundle can be captured reliably — including with no network signal — and synced to a backend where a dispatcher can see it attached to the correct parcel.

This is a PoC, not production. Optimise for a convincing, runnable demo over completeness. Keep auth, multi-tenancy, and infrastructure minimal.

## 2. Goal & success criteria

The PoC is successful when I can, on a phone or in a mobile-emulated browser:

1. Pick a parcel by **scanning its barcode** (the scan auto-selects the matching parcel — no scrolling a list).
2. Capture the **evidence bundle** (photos, timestamp, GPS, recipient, optional signature, status).
3. Do all of that with the **network turned off**, see the record marked "queued", then watch it **upload automatically** when the network returns.
4. Open a **dispatcher view** and see that captured record linked to the right parcel, with its photo, location pin, and timestamp.

## 3. Tech stack — use these, don't deliberate

- **Frontend:** React + TypeScript + Vite, configured as an installable **PWA** (`vite-plugin-pwa`) so it works offline.
- **Styling:** Tailwind CSS — but themed to match the reference design in §7, *not* default Tailwind looks.
- **Backend / data:** **Supabase** — Postgres (with the **PostGIS** extension), Storage, and the JS client (`@supabase/supabase-js`).
- **Run Supabase locally** via the Supabase CLI (`supabase start`) so the PoC is self-contained. Put URL/anon key in `.env` and commit a `.env.example`.
- **Offline queue:** IndexedDB via **Dexie**.
- **Barcode scanning:** the native `BarcodeDetector` API where available, falling back to **`@zxing/library`**. Match the decoded string against `parcels.tracking_number`.
- **Signature:** `signature_pad`.
- **Image overlay + compression:** plain `<canvas>` (no library).

If any choice above genuinely blocks you, state the blocker and your proposed alternative, then continue — don't stall.

## 4. Data model — create exactly this schema

Generate a Supabase migration with this shape (adjust types sensibly, keep the structure):

```sql
create extension if not exists postgis;

-- The parcels / jobs a driver is delivering today
create table parcels (
  id              uuid primary key default gen_random_uuid(),
  tracking_number text unique not null,      -- the barcode value read off the label
  recipient_name  text not null,
  address_line    text not null,
  postcode        text,
  destination     geography(point, 4326),    -- where it *should* go
  area            text default 'Domestic',   -- Domestic | International | Fulfilment | Sortation
  status          text default 'pending',    -- pending | delivered | failed
  created_at      timestamptz default now()
);

-- One proof-of-delivery record per delivery attempt
create table pod_records (
  id              uuid primary key default gen_random_uuid(),
  parcel_id       uuid references parcels(id),
  tracking_scanned text not null,            -- what the driver actually scanned
  status          text not null,             -- delivered | failed
  failure_reason  text,                       -- required when status = failed
  received_by     text,                       -- name, or "left in porch", etc.
  captured_at     timestamptz not null,       -- device clock, at moment of capture
  synced_at       timestamptz,                -- server clock, set on upload (trust boundary)
  location        geography(point, 4326),
  gps_accuracy_m  int,
  gps_simulated   boolean default false,      -- true if the device couldn't get a real fix
  signature_path  text,                       -- storage path, nullable
  driver_id       text default 'drv_demo',
  created_at      timestamptz default now()
);

-- A POD can have multiple photos (label, where-left, etc.)
create table pod_photos (
  id            uuid primary key default gen_random_uuid(),
  pod_id        uuid references pod_records(id) on delete cascade,
  photo_type    text not null,               -- 'label' | 'where_left'
  storage_path  text not null,
  orig_kb       int,
  compressed_kb int
);
```

- Create a **Storage bucket** `pod-evidence` for photos and signatures.
- **Seed** ~8 parcels across the four `area` values, with realistic UK addresses and unique tracking numbers, so the demo has data on first run. Print the tracking numbers in the README so I can test scanning by typing them in if no physical label is handy.

## 5. The capture record — the full evidence bundle

This is the heart of the PoC. A single capture must collect **all** of the following:

- **Photo(s)** — at minimum a photo of the **label**; allow an optional second photo of **where it was left**. Each photo, on capture: drawn to canvas, longest edge capped at ~1280px, the **timestamp + GPS coordinates + parcel ref burned onto a strip at the bottom of the image**, then exported as JPEG (~0.72 quality). Record both `orig_kb` and `compressed_kb`.
- **Timestamp** — capture the **device clock** as `captured_at` at the moment of the photo. The server sets `synced_at` on upload. Treat `captured_at` as the evidence time and `synced_at` as the trust stamp; both are kept.
- **GPS location** — `navigator.geolocation` with `enableHighAccuracy`. Store lat/lng, the **accuracy in metres**, and a `gps_simulated` flag. If the fix is denied or times out, fall back to a fixed demo coordinate and set `gps_simulated = true` so trusted and untrusted reads are always distinguishable.
- **Recipient / how** — a free-text "received by" field that accepts a name *or* a hand-off note like "left in porch".
- **Signature** — optional. A canvas signature pad; if signed, save the PNG to storage and set `signature_path`.
- **Status** — **Delivered** or **Failed**. If **Failed**, a `failure_reason` is **required** before the capture can complete (e.g. "no access", "refused", "address not found").
- **Barcode / tracking number** — scanned off the label. The scanned value is stored as `tracking_scanned` and used to **auto-select the matching parcel** (`parcels.tracking_number`). If no parcel matches, surface a clear "unknown parcel" state rather than silently failing. This scan-to-attach link is the feature that matters most — make sure it's the primary path into a capture, with manual selection as the fallback.

## 6. Screens to build

1. **Driver — Today's stops:** list of seeded parcels (ref, recipient, address, area, status). A prominent **"Scan label"** button at the top.
2. **Driver — Capture:** reached by scanning (auto-selects parcel) or tapping a stop. Contains the full evidence bundle from §5. A single **"Complete delivery"** action that builds the record. Must be usable one-handed on a phone.
3. **Sync status:** a persistent indicator showing **N queued / N synced**, with the queued count visibly draining as uploads succeed.
4. **Dispatcher — Captured PODs:** a read-side list of `pod_records` joined to their parcel, each showing the stamped photo (thumbnail → full), a small map pin or the coordinates, `captured_at`, `synced_at`, status, and (for failures) the reason. This proves the round trip and that the barcode linked the capture to the right parcel.

## 7. Visual design language — match the reference demo

The driver app must look like `design-reference.html` (in the repo root — **open it; it is the source of truth**). The aesthetic is a refined, professional logistics tool: **deep navy, gold accents, Georgia serif display type**, light "paper" surfaces. Avoid generic Tailwind defaults.

**Palette** — add to `tailwind.config` `theme.extend.colors`:

```js
colors: {
  navy:  { DEFAULT: '#0e1c38', 600: '#16294d', 500: '#1f3a66' },
  gold:  { DEFAULT: '#c9a227', soft: '#e3c766' },
  paper: '#f6f4ee',
  ink:   '#10192e',
  muted: '#6b7589',
  ok:    '#2f8f5b',
  fail:  '#c0492f',
}
```

Hairline borders are `rgba(14,28,56,.12)`.

**Typography:** Georgia / serif (`font-serif` → `Georgia, 'Times New Roman', serif`) for the app title, the parcel ref, and primary buttons. System sans for body text and form fields. Monospace for the barcode line and the POD record JSON.

**App background (driver):** dark navy — a radial navy glow top-right layered over a linear navy gradient. The driver screen sits on this like a device on a desk.

**Phone-frame container (driver app):** ~390px wide, `border-radius: 30px`, with a layered ring shadow that reads as a device bezel:

```css
box-shadow: 0 30px 60px -20px rgba(0,0,0,.6), 0 0 0 9px #060b18, 0 0 0 11px #223256;
```

Centre it on wider screens. The dispatcher view can be a normal full-width page in the same palette.

**Components:**

- *Top bar* — navy fill; a gold, uppercase, letter-spaced eyebrow ("Stop 7 of 14 · Domestic"); the parcel ref in Georgia serif; the scanned barcode in monospace beneath; and a thin gold-to-transparent gradient underline along the bottom edge.
- *Stop block* — white surface, recipient name bold, address muted.
- *Section labels* — ~11px, uppercase, letter-spaced, muted, bold.
- *Capture zone* — dashed navy border, 4:3 ratio, a round navy disc holding a gold-soft camera glyph, with prompt text. Once a photo is taken it fills the zone (border becomes solid) with a translucent "Retake" pill top-right.
- *Meta chips* — white rounded cards, uppercase key + tabular-number value. The **GPS chip turns gold and its label reads "(simulated)"** when the fix is a fallback.
- *Fields* — uppercase labels, rounded inputs, a soft navy focus ring.
- *Outcome control* — a two-button segmented switch: **Delivered fills green, Failed fills red** when active.
- *Complete button* — full-width navy, Georgia serif label, with a gold progress bar that fills along the bottom on tap.
- *Confirmation* — a green "captured & queued" banner with a tick disc, the stamped photo, then the POD record in a **dark navy panel** with a gold-soft header and syntax-coloured JSON (keys gold, strings green, numbers orange, booleans blue).

Match the spacing, corner radii and overall restraint of the reference — clean and legible, not busy. Carry the same navy / gold / paper palette into the dispatcher view so the two screens read as one product.

## 8. Offline-first behaviour — the hard requirement

This is what makes the PoC convincing, so build it deliberately:

- A completed capture is written **first to IndexedDB (Dexie)** — photo blobs, signature blob, and all metadata — and the driver immediately sees "captured & queued". **Nothing blocks on the network.**
- A **sync worker** drains the queue when online: upload photos/signature to the `pod-evidence` bucket, insert the `pod_records` and `pod_photos` rows, set `synced_at`, then mark the local item synced (don't delete it — flip a flag so the UI can show synced history).
- Trigger sync on app load, on `online` events, and on a short interval. Make it **idempotent** (use the locally-generated `pod_id`) so a retry never double-inserts.
- It must work with DevTools set to **Offline**: capture several deliveries offline, then go online and watch them upload.

## 9. Acceptance tests — the PoC must pass these

Write a short `DEMO.md` walking through these, and make each one demonstrably pass:

1. Scanning (or typing) a seeded tracking number opens the capture screen with that parcel pre-selected.
2. A label photo shows the timestamp + coordinates burned into the image, and reports a compressed size well under the original.
3. Marking a delivery **Failed** with no reason is blocked; adding a reason allows completion.
4. With the network **off**, completing a delivery shows "queued" and the queued counter increments.
5. Turning the network **on** drains the queue: rows appear in Supabase, photos appear in the bucket, `synced_at` is set, and the counter falls to zero.
6. The dispatcher view shows the new POD attached to the correct parcel, with photo, location, and timestamp.

## 10. Out of scope — do NOT build

No real authentication (hardcode a demo driver), no multi-tenant/org model, no route optimisation, no real carrier or EPC system integration, no customer notifications, no push notifications, no payments. A single seeded demo dataset is fine. Don't gold-plate styling beyond matching §7 — clean and legible beats elaborate.

## 11. How to work — sequencing & checkpoints

Proceed in this order and pause for a runnable checkpoint after each:

1. Scaffold (Vite + React + TS + Tailwind + PWA), set up the §7 theme tokens, Supabase local init, `.env.example`, README skeleton.
2. Migration + seed data + storage bucket. Confirm `supabase start` + seed works.
3. Driver stops list + manual parcel selection + capture screen UI, styled to §7 (no offline yet, write straight to Supabase).
4. Canvas overlay + compression + GPS + signature wired into capture.
5. Barcode scanning → auto-select parcel.
6. Offline queue (Dexie) + sync worker + sync-status indicator.
7. Dispatcher captured-PODs view.
8. `DEMO.md` + final README pass.

At each checkpoint, tell me the exact commands to run it and what I should see.

## 12. Deliverables

- A repo that runs with a documented `supabase start` → seed → `npm run dev` sequence.
- `README.md`: setup, run commands, seeded tracking numbers, and how to simulate offline.
- `DEMO.md`: the §9 walkthrough.
- `CLAUDE.md`: project conventions, the data model, the §7 design tokens, and the architecture decisions above, so future sessions have context.

Keep the code readable and commented where the logic is non-obvious (the overlay maths, the sync idempotency, the GPS fallback). Favour clarity over cleverness — this is a PoC meant to be understood and extended.
