# ePOD PoC — demo walkthrough

The six acceptance tests from §9 of the brief, in order. Total time ~10 minutes.

## Setup (once)

```powershell
npm install
npx supabase start          # Docker Desktop must be running
copy .env.example .env      # paste the publishable/anon key printed above
npx supabase db reset       # apply migrations + seed
node scripts/seed-auth.mjs  # create the demo logins (admin + 3 drivers)
npm run dev                 # http://localhost:5173
```

The app opens to a **sign-in portal**. Demo logins — password `citipost`:

| Role | Email | Sees |
| --- | --- | --- |
| Dispatcher / admin | `admin@citipost.test` | allocate jobs, import manifests, export tracking CSV, every captured POD |
| Driver — Sam | `sam@citipost.test` | only Sam's run (Greater London · Domestic) |
| Driver — Priya | `priya@citipost.test` | only Priya's run (International) |
| Driver — Dan | `dan@citipost.test` | only Dan's run (Fulfilment · Sortation) |

Access is enforced **server-side with RLS**: a driver can't read another driver's
jobs or PODs even by crafting a request, and dispatcher tools are admin-only.

- Driver app (sign in as a driver): **http://localhost:5173**
- Dispatcher (sign in as admin): **#/allocate** · **#/jobs** · **#/dispatch**
- Supabase Studio (to inspect rows/files): **http://127.0.0.1:54323**
- Re-seed at any time: `npx supabase db reset` **then** `node scripts/seed-auth.mjs`
  (the reset wipes auth users; the script recreates them)
- For the most faithful offline test use a production build: `npm run build && npm run preview`

Scannable labels for every seeded parcel (Code 128 + QR, printable) live at
**`/labels.html`** — open it on one screen and scan with the phone. Tracking
numbers, for type-in:

`CP-849213-GB` · `CP-100002-GB` · `CP-100003-GB` · `CP-200004-GB` ·
`CP-200005-GB` · `CP-300006-GB` · `CP-300007-GB` · `CP-400008-GB`

---

## Test 1 — scan/type a tracking number → parcel pre-selected

1. On the stops screen, tap **Scan label**.
2. Either point the camera at a barcode of `CP-849213-GB`, or type it and hit
   **Find parcel**.
3. **Pass:** the capture screen opens with *Meridian Logistics, Erith* in the
   top bar and stop block — no list scrolling.
4. Also try a junk value (`NOPE-123`): a red **Unknown parcel** banner names
   the value instead of failing silently.

## Test 2 — stamped, compressed photo

1. In a capture, tap the label zone and choose any photo (a real phone photo
   of a few MB shows the effect best).
2. **Pass:** the preview shows the dark strip burned onto the bottom of the
   image with the gold parcel ref, date/time, and `lat, lng ±accuracy` —
   and after completing, the confirmation reports e.g.
   *"Compressed 3 482 KB → 174 KB before upload"*, well under the original.

## Test 3 — Failed requires a reason

1. In a capture (photo added), switch the outcome to **Failed**.
2. **Pass:** *Complete delivery* is disabled while *Failure reason* is empty.
3. Pick *No access* (or *Other…* + text): the button enables; the reason
   appears in the record and later in the dispatcher view.

## Test 4 — offline capture queues

1. DevTools → Network tab → throttling dropdown → **Offline**
   (the badge top-right gains a gold **offline** marker).
2. Complete 2–3 deliveries on different stops.
3. **Pass:** each confirmation shows **"Captured & queued offline — will
   upload automatically when signal returns"**, the JSON says
   `synced_at: null`, `stored: "pending-upload"`, `device_queued: true`, and
   the badge counts up *1 queued… 2 queued… 3 queued*. The stops list marks
   those stops *delivered · queued* in gold.

## Test 5 — going online drains the queue

1. Leave the last confirmation open. Set throttling back to **No throttling**.
2. **Pass:** within ~8 s (or instantly if you tap the badge) the queue drains
   item by item — badge falls to **0 queued · N synced**, and the open
   confirmation flips live to **"Captured & synced"** with the server
   `synced_at` filled in and real storage paths in the JSON.
3. In Studio: `pod_records` rows have `synced_at` set (server clock),
   `pod_photos` rows point at files in the **pod-evidence** bucket. Exactly
   one row per capture — retries are idempotent on the client-generated id.

## Test 6 — dispatcher sees the round trip

1. Open **http://localhost:5173/#/dispatch**.
2. **Pass:** every capture appears against the **correct parcel** (ref,
   recipient, address), with:
   - the stamped photo thumbnail (click → full size),
   - the `scanned CP-…` line proving the barcode→parcel link,
   - **Captured (device)** and **Synced (server)** timestamps side by side,
   - a map-pin link with coordinates and ±accuracy (red **No GPS** badge
     when the capture had no real fix — there is no simulated fallback),
   - the failure reason on failed deliveries, and the signature if one was
     drawn.

---

## Beyond the §9 tests — feature demos

### Rollover (priority carry-over)
`CP-100003-GB` (Dev & Sons Hardware) is seeded **due yesterday**: it leads
the run with a gold **ROLLOVER · 02 Jun** badge. Any stop still unfinished at
the end of a day does the same automatically the next day — derived from
`due_date`, no overnight job.

### Attempt model (failed ≠ finished)
Fail a stop with a reason: it stays in the **active** list showing
*"Attempt 2 of 3 · last: No access"* and rolls over day to day. Fail the same
stop three times and it goes terminal — **returned** (return to sender) in
the Completed section. Each attempt is its own POD in the dispatcher.

### Geofence (was it captured at the right place?)
The capture screen shows a live **Distance from address** chip (green ≤250 m,
gold ≤1 km, red beyond), the distance is stored on the record, and the
dispatcher flags far captures with a red **"x km from address"** pill.
Capturing from a desk means every parcel except the nearest goes visibly
red — a nice on-purpose demo of the flag (with no fix at all, the distance
shows "—" and the dispatcher gets a **No GPS** badge instead).

### Offline resilience details
- A capture that the server permanently rejects is skipped after 5 attempts
  (salmon **"N retry"** in the badge; tap the badge to force-retry it) — it
  can never block the captures behind it.
- The stop list is cached locally: cold-start the app with no signal and the
  run sheet still renders.
- New builds show a **"new version — Refresh"** toast instead of silently
  serving the old version once.

### Live dispatcher
Keep `#/dispatch` open on one screen while completing a delivery on the
phone: the POD appears the moment it syncs (Supabase Realtime; 10s poll as
fallback).

---

## Useful extras

- **Force a sync pass:** tap the `N queued · N synced` badge.
- **No-fix state on demand:** DevTools → ⋮ → More tools → Sensors →
  Location → *Location unavailable* → the GPS chip turns red **no fix**
  with a reason note + Retry, the stamp reads `GPS unavailable`, and the
  synced record stores no location. (Sensors → custom coordinates fakes a
  *real-looking* device fix — handy for demoing the geofence.)
- **Reset everything:** `npx supabase db reset` (server data) + DevTools →
  Application → Storage → *Clear site data* (local queue).
