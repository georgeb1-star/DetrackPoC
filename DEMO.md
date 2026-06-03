# ePOD PoC — demo walkthrough

The six acceptance tests from §9 of the brief, in order. Total time ~10 minutes.

## Setup (once)

```powershell
npm install
npx supabase start          # Docker Desktop must be running
copy .env.example .env      # paste the publishable/anon key printed above
npm run dev                 # http://localhost:5173
```

- Driver app: **http://localhost:5173** · Dispatcher: **http://localhost:5173/#/dispatch**
- Supabase Studio (to inspect rows/files): **http://127.0.0.1:54323**
- Re-seed at any time: `npx supabase db reset`
- For the most faithful offline test use a production build: `npm run build && npm run preview`

Seeded tracking numbers (type these, or render one as a Code 128 / QR at
[zxing.org generator](https://zxing.appspot.com/generator) and scan it):

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
   - a map-pin link with coordinates and ±accuracy (gold **GPS simulated**
     badge when the fix was a fallback),
   - the failure reason on failed deliveries, and the signature if one was
     drawn.

---

## Useful extras

- **Force a sync pass:** tap the `N queued · N synced` badge.
- **Simulated GPS on demand:** DevTools → ⋮ → More tools → Sensors →
  Location → *Location unavailable* → the GPS chip turns gold "(simulated)"
  and the stamp gains `(sim)`.
- **Reset everything:** `npx supabase db reset` (server data) + DevTools →
  Application → Storage → *Clear site data* (local queue).
