# ePOD PoC — handoff & onboarding

A proof-of-concept for **Electronic Proof of Delivery**: drivers scan parcels,
capture stamped photo/signature/GPS evidence (fully offline-capable), and
dispatchers import job manifests, allocate runs, and export tracking data.
React PWA + Supabase (Postgres/PostGIS, Auth, Storage, Realtime).

- **Repo:** https://github.com/georgeb1-star/DetrackPoC
- **Demo walkthrough:** `DEMO.md` (the ~10-minute acceptance script)
- **Project conventions & gotchas:** `CLAUDE.md` (read this before changing code)

> **PoC, not production.** Demo-grade auth, no multi-tenancy, placeholder
> carrier codes in the tracking export. Convincing demo > completeness.

---

## 1. Run it locally (15 minutes, zero credentials needed)

You do **not** need anyone's `.env` file or any shared secrets — the local
Supabase stack generates its own keys on your machine.

Prereqs: **Node 20+** (24 recommended — the test scripts use type-stripping),
**Docker Desktop** (running).

```powershell
git clone https://github.com/georgeb1-star/DetrackPoC.git
cd DetrackPoC
npm install
npx supabase start          # starts the local stack; PRINTS your keys
copy .env.example .env      # paste the printed anon key into .env
npx supabase db reset       # apply all migrations + demo seed
node scripts/seed-auth.mjs  # create the demo logins (REQUIRED after every db reset)
npm run dev                 # http://localhost:5173
```

### Demo logins (password for all: `citipost`)

| Role | Email | Sees |
| --- | --- | --- |
| Dispatcher (admin) | `admin@citipost.test` | everything: allocate, jobs, sites, captured PODs, export |
| Driver — Sam | `sam@citipost.test` | Greater London run only |
| Driver — Priya | `priya@citipost.test` | South East run only |
| Driver — Dan | `dan@citipost.test` | North West run only |

Access is enforced server-side with RLS — drivers cannot read another run even
with hand-crafted API calls.

### URLs

- Driver app: `http://localhost:5173` (sign in as a driver)
- Dispatcher: `#/allocate` (assign parcels to runs) · `#/jobs` (import a
  manifest .xlsx, export tracking CSV) · `#/dispatch` (captured PODs)
- Supabase Studio (inspect rows/files): `http://127.0.0.1:54323`
- Printable scan labels for the seeded parcels: `/labels.html`

### Verify your setup

```powershell
node scripts/smoke-db.mjs      # stack, RLS, storage, idempotency
node scripts/test-system.mjs   # full backend suite (RLS, lifecycle, attempts)
node scripts/test-manifest.mjs # manifest import end-to-end
node scripts/smoke-sites.mjs   # site (no-manifest) capture path
npm run build                  # must pass before committing (tsc + vite)
```

---

## 2. What the system does (60-second map)

- **Jobs/manifests** — admin imports a parcel manifest (.xlsx, one tracking
  number per row; column names auto-mapped). Parcels arrive unallocated.
- **Allocation** — parcels (and **sites** — stores/depots with no per-item
  manifest) are assigned to a **route**; each route belongs to one driver, so
  allocation = giving the driver the work. Changes reach the driver's phone
  live (Realtime).
- **Lifecycle** — `awaiting_collection → collected → at_warehouse → delivered`
  (or terminal `returned` after 3 failed attempts). Collection/warehouse are
  quick scans; delivery is the full POD capture. Status only moves forward
  (atomic RPC), so late-syncing scans can't regress a parcel.
- **Capture** — photo (compressed + evidence strip burned in), signature, GPS
  (real fix or nothing — no simulated fallback), geofence distance to the
  destination. **Everything goes through an offline queue** (Dexie/IndexedDB);
  sync is idempotent on a client-generated UUID, so retries never duplicate.
- **Export** — Evri-format tracking CSV from captured PODs (placeholder event
  codes — swap before any real integration).

Architecture details, invariants, and design tokens: `CLAUDE.md`.

---

## 3. Cloud assets (what you need from George)

### Hosted Supabase (project ref `ydhypslunoybvwoslyss`)

The deployed app points at a hosted Supabase project on George's account.
Either get **invited to the org / have the project transferred** (Supabase
dashboard → Project Settings), or create your own project and set it up from
the repo: run `supabase/cloud-setup.sql` in the SQL editor, then any
`supabase/cloud-update-*.sql` scripts newer than it, then create the demo
logins:

```powershell
$env:SUPABASE_URL = "https://<your-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key from dashboard>"
node scripts/seed-auth.mjs
```

⚠️ If you inherit the existing project, check the `cloud-update-*.sql` scripts
have all been applied — at the time of writing at least `cloud-update-sites.sql`
and `cloud-update-hardening.sql` were outstanding.

The **service-role key** (dashboard → Settings → API) is the only real secret
in this project. It never goes in git or in `.env` committed anywhere.

### Vercel

The current Vercel project is **not git-connected** — deploys were manual via
`npx vercel --prod`. Recommended: import the GitHub repo into your own Vercel
account (New Project → Import), set two environment variables:

```
VITE_SUPABASE_URL       = https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY  = <anon/publishable key from the Supabase dashboard>
```

…and every push to `master` will auto-deploy. (The anon key is publishable —
it's safe in a browser bundle; RLS is what protects the data.)

---

## 4. Gotchas that will bite you (learned the hard way)

- **After every `npx supabase db reset`, run `node scripts/seed-auth.mjs`** —
  the reset wipes auth users and nobody can log in until you recreate them.
- **"An invalid response was received from the upstream server"** from storage
  or auth after a reset → the Kong gateway has stale container routes:
  `docker restart supabase_kong_Detrack_PoC`, wait ~5 s, retry.
- **Sandboxed/restricted shells:** if `npx supabase` fails with EPERM, call the
  binary directly: `node_modules\@supabase\cli-windows-x64\bin\supabase.exe`.
- **PWA caching:** the app is a service-worker PWA. If a screen looks stale
  after pulling changes, hard-refresh (Ctrl+Shift+R); after a `db reset`, also
  clear site data (DevTools → Application → Storage) so the offline queue
  doesn't hold PODs for wiped parcels.
- **Real GPS needs a secure context.** On a LAN phone use `npm run dev:https`,
  but Chrome auto-denies geolocation on self-signed certs — phone GPS demos
  really want the deployed (HTTPS) build.
- **Don't re-litigate stack choices** (Tailwind v3, Dexie queue, barcode
  fallback chain, etc.) — they're fixed by the brief; see `CLAUDE.md`.

---

## 5. Day-to-day commands

```powershell
npm run dev                  # vite dev server
npm run build                # type-check + production build — run before committing
npm run preview              # serve the production build (bulletproof offline test)
npx supabase start|stop      # local stack (Docker)
npx supabase db reset        # re-seed (then seed-auth.mjs!)
```
