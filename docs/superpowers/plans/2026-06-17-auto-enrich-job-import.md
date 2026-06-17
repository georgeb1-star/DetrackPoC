# Auto-enrich Job Import from GWOptical — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dispatcher create parcels from bare tracking numbers, with recipient + address pulled automatically from GWOptical via Lens's Supabase mirror.

**Architecture:** A thin, admin-gated ePOD Edge Function (`enrich-shipments`) does the one privileged thing the browser can't — a cross-project read of Lens's `public.shipments` (RLS-locked) using a dedicated read-only role. It returns matched raw rows + a not-found list. All shaping (compose address, derive area → `ParcelInput`) lives in a node-testable `src/lib/enrich.ts`, shared by two entry points (a paste box and the extended file importer). Unmatched postcodes land in a new first-class `'Other'` area; an inline area editor lets dispatchers relabel.

**Tech Stack:** Vite + React 19 + TS strict; Supabase JS v2; Supabase Edge Functions (Deno); `postgres` (Deno PG driver); node `.mjs` test scripts via Node type-stripping (no test runner).

> **Commit note (this repo):** the user gates commits explicitly and works on `master`. Keep the per-task commit steps below, but only run them on the user's go-ahead. Always `npm run build` before any commit that touches `src/`.

> **Spec:** `docs/superpowers/specs/2026-06-17-auto-enrich-job-import-from-gwoptical-design.md`

---

## File map

- **Create** `src/lib/enrich.ts` — `ShipmentRow` type, `composeAddressLine`, `composeRecipient`, `deriveArea` (postcode→area map), `shipmentToParcelInput`. Pure, no imports from `./supabase`.
- **Create** `src/lib/enrichApi.ts` — `enrichShipments(trackingNumbers)` client wrapper around `supabase.functions.invoke('enrich-shipments', …)` (mirrors `adminInvoke`). Kept separate so `enrich.ts` stays import-pure for node tests.
- **Create** `supabase/functions/enrich-shipments/index.ts` — thin admin-gated reader of Lens `public.shipments`.
- **Create** `supabase/migrations/20260617120000_area_other.sql` — add `'Other'` to the `parcels.area` CHECK.
- **Create** `scripts/test-enrich.mjs` — node test for `enrich.ts` + the `manifest.ts` relaxation.
- **Modify** `src/lib/types.ts` — add `'Other'` to `Area` + `AREAS`.
- **Modify** `src/lib/manifest.ts` — `toArea` fallback → `'Other'`; relax `buildParcelInputs` so a tracking-only row is an enrichment candidate, not an error; add `splitRowsForEnrichment`.
- **Modify** `supabase/cloud-setup.sql` — `parcels.area` CHECK includes `'Other'`.
- **Modify** `src/screens/JobsScreen.tsx` — extract a shared `commitParcels` helper; add the `EnrichCard` paste-box; route address-less file imports through enrichment.
- **Modify** `src/screens/AllocateScreen.tsx` — inline area `<select>` on parcel rows (+ `assignArea`).

---

## Task 1: Add the `'Other'` area (types, DB, manifest fallback)

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/manifest.ts:91-94` (`toArea`)
- Create: `supabase/migrations/20260617120000_area_other.sql`
- Modify: `supabase/cloud-setup.sql:57-58`

- [ ] **Step 1: Add `'Other'` to the `Area` type and `AREAS` array**

In `src/lib/types.ts`, change the area block to:

```ts
export type Area =
  | 'South London'
  | 'North London'
  | 'West London'
  | 'Central London'
  | 'Kent'
  | 'Surrey'
  | 'Other'
export const AREAS: Area[] = [
  'South London', 'North London', 'West London', 'Central London', 'Kent', 'Surrey', 'Other',
]
```

- [ ] **Step 2: Change the manifest fallback to `'Other'`**

In `src/lib/manifest.ts`, `toArea`:

```ts
function toArea(value: string): Area {
  const found = AREAS.find((a) => a.toLowerCase() === value.trim().toLowerCase())
  return found ?? 'Other'
}
```

Also update the doc comment on `ManifestField` (line ~11) "area defaults to South London" → "area defaults to Other".

- [ ] **Step 3: Write the migration file**

Create `supabase/migrations/20260617120000_area_other.sql`:

```sql
-- Add 'Other' as a first-class parcel area: the bucket for parcels whose area
-- couldn't be auto-derived (enrichment from GWOptical) or whose manifest area
-- was unrecognised. routes.areas is an unconstrained text[] governed by the
-- frontend (src/lib/types.ts AREAS), so only parcels.area needs the new value.
alter table parcels drop constraint if exists parcels_area_check;
alter table parcels add constraint parcels_area_check
  check (area in ('South London','North London','West London','Central London','Kent','Surrey','Other'));
```

- [ ] **Step 4: Mirror the CHECK into `cloud-setup.sql`**

In `supabase/cloud-setup.sql`, update the `parcels.area` definition:

```sql
  area            text default 'South London'
                  check (area in ('South London','North London','West London','Central London','Kent','Surrey','Other')),
```

- [ ] **Step 5: Apply the DDL to the live DB**

The hosted project isn't CLI-migration-tracked, so apply via the Supabase MCP `execute_sql` (project `mqiwyfhxcjvkpnpbtgql`):

```sql
alter table parcels drop constraint if exists parcels_area_check;
alter table parcels add constraint parcels_area_check
  check (area in ('South London','North London','West London','Central London','Kent','Surrey','Other'));
```

Then verify in a separate `execute_sql` call:

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'parcels_area_check';
```

Expected: the def lists all seven labels including `'Other'`.

- [ ] **Step 6: Build (catches any non-exhaustive `Area` handling)**

Run: `npm run build`
Expected: `tsc -b && vite build` completes with no type errors. (If `tsc` flags a non-exhaustive switch over `Area`, add an `'Other'` branch there.)

- [ ] **Step 7: Commit** (on user go-ahead)

```bash
git add src/lib/types.ts src/lib/manifest.ts supabase/migrations/20260617120000_area_other.sql supabase/cloud-setup.sql
git commit -m "feat(areas): add 'Other' as a first-class parcel area"
```

---

## Task 2: `src/lib/enrich.ts` transforms + node test (TDD)

**Files:**
- Create: `scripts/test-enrich.mjs`
- Create: `src/lib/enrich.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-enrich.mjs`:

```js
// Pure-function tests for the enrichment transforms (no DB/stack). Node 24
// type-stripping imports the real src/lib modules under test.
//   node scripts/test-enrich.mjs
import {
  composeAddressLine, composeRecipient, deriveArea, shipmentToParcelInput,
} from '../src/lib/enrich.ts'
import { buildParcelInputs, splitRowsForEnrichment } from '../src/lib/manifest.ts'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

const row = {
  tracking_number: 'TRK1',
  recipient_full_name: 'Jane Doe',
  recipient_company: 'Acme Optics',
  recipient_address1: '1 High St',
  recipient_address2: 'Unit 4',
  recipient_address3: '',
  recipient_city: 'Bromley',
  recipient_county: 'Kent',
  recipient_postcode: 'BR1 1AA',
}

console.log('compose')
check('address joins non-empty parts with ", "',
  composeAddressLine(row) === '1 High St, Unit 4, Bromley, Kent', composeAddressLine(row))
check('recipient prefers full name', composeRecipient(row) === 'Jane Doe')
check('recipient falls back to company',
  composeRecipient({ ...row, recipient_full_name: '' }) === 'Acme Optics')
check('recipient falls back to placeholder',
  composeRecipient({ ...row, recipient_full_name: '', recipient_company: '' }) === '(no name)')

console.log('deriveArea')
check('BR → Kent', deriveArea('BR1 1AA') === 'Kent')
check('SE → South London', deriveArea('SE10 9AB') === 'South London')
check('KT → Surrey', deriveArea('KT1 1AA') === 'Surrey')
check('WC → Central London', deriveArea('WC2N 5DU') === 'Central London')
check('lowercase + extra spaces tolerated', deriveArea('  br1 1aa ') === 'Kent')
check('unknown prefix → Other', deriveArea('ZZ1 1ZZ') === 'Other')
check('East London (no home) → Other', deriveArea('E1 6AN') === 'Other')
check('blank → Other', deriveArea('') === 'Other')
check('null → Other', deriveArea(null) === 'Other')

console.log('shipmentToParcelInput')
const pi = shipmentToParcelInput(row)
check('maps tracking/recipient/address/postcode/area', 
  pi.tracking_number === 'TRK1' && pi.recipient_name === 'Jane Doe' &&
  pi.address_line === '1 High St, Unit 4, Bromley, Kent' && pi.postcode === 'BR1 1AA' &&
  pi.area === 'Kent', JSON.stringify(pi))
check('raw row kept in meta', pi.meta.recipient_city === 'Bromley')

console.log('manifest relaxation')
// A tracking-only mapping (no address column). Address row is now an enrichment
// candidate, NOT a "missing address" error.
const rows = [
  { Track: 'A1' }, { Track: 'A2' }, { Track: '' /* blank skipped */ }, { Track: 'A1' /* dupe */ },
]
const split = splitRowsForEnrichment(rows, { tracking_number: 'Track' })
check('two unique tracking numbers extracted', 
  split.toEnrich.length === 2 && split.toEnrich[0] === 'A1', JSON.stringify(split.toEnrich))
check('rows with address still build normally', (() => {
  const r = [{ T: 'B1', N: 'Bob', A: '2 Road' }]
  const { parcels, errors } = buildParcelInputs(r, { tracking_number: 'T', recipient_name: 'N', address_line: 'A' })
  return parcels.length === 1 && errors.length === 0 && parcels[0].area === 'Other'
})())

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `node scripts/test-enrich.mjs`
Expected: FAIL — `Cannot find module '../src/lib/enrich.ts'` (and `splitRowsForEnrichment` not exported yet).

- [ ] **Step 3: Implement `src/lib/enrich.ts`**

Create `src/lib/enrich.ts`:

```ts
import type { Area } from './types'
import type { ParcelInput } from './manifest'

/** The shipment columns the enrich-shipments Edge Function returns (a subset of
 *  Lens's public.shipments — only what we need to build a parcel). */
export interface ShipmentRow {
  tracking_number: string
  recipient_full_name: string | null
  recipient_company: string | null
  recipient_address1: string | null
  recipient_address2: string | null
  recipient_address3: string | null
  recipient_city: string | null
  recipient_county: string | null
  recipient_postcode: string | null
}

/** GWOptical splits the address across several columns; ePOD stores one line.
 *  Join the non-empty parts in postal order. */
export function composeAddressLine(row: ShipmentRow): string {
  return [
    row.recipient_address1, row.recipient_address2, row.recipient_address3,
    row.recipient_city, row.recipient_county,
  ]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

/** Prefer a person's name, then the company, then a clear placeholder. */
export function composeRecipient(row: ShipmentRow): string {
  return (row.recipient_full_name ?? '').trim()
    || (row.recipient_company ?? '').trim()
    || '(no name)'
}

// Postcode outward-code → ePOD area. USER-AUTHORED domain map — refine the rules
// freely; anything not listed (incl. blank) falls back to 'Other', which is the
// safe "needs review" bucket. Keys are the leading letters of the outward code.
const POSTCODE_AREA: Record<string, Area> = {
  SE: 'South London',
  SW: 'South London', // south-west — move to 'West London' if you prefer
  N: 'North London',
  NW: 'North London', // north-west — move to 'West London' if you prefer
  W: 'West London',
  WC: 'Central London',
  EC: 'Central London',
  // Kent
  BR: 'Kent', DA: 'Kent', ME: 'Kent', CT: 'Kent', TN: 'Kent',
  // Surrey
  KT: 'Surrey', SM: 'Surrey', CR: 'Surrey', GU: 'Surrey', RH: 'Surrey',
  // 'E' (East London) and everything else intentionally → 'Other'.
}

/** Map a UK postcode to one of ePOD's areas via its outward-code letters.
 *  Unmatched / missing → 'Other'. Matches the 2-letter prefix first (WC, EC,
 *  NW, SE, …) then the 1-letter (N, W, …). */
export function deriveArea(postcode: string | null | undefined): Area {
  const pc = (postcode ?? '').trim().toUpperCase()
  if (!pc) return 'Other'
  const letters = (pc.match(/^[A-Z]{1,2}/) ?? [''])[0]
  if (letters.length === 2 && POSTCODE_AREA[letters]) return POSTCODE_AREA[letters]
  const one = letters.slice(0, 1)
  return POSTCODE_AREA[letters] ?? POSTCODE_AREA[one] ?? 'Other'
}

/** A matched shipment row → the ParcelInput the importer/commit path expects.
 *  The raw row is stashed in meta for traceability. */
export function shipmentToParcelInput(row: ShipmentRow): ParcelInput {
  return {
    tracking_number: row.tracking_number,
    recipient_name: composeRecipient(row),
    address_line: composeAddressLine(row),
    postcode: (row.recipient_postcode ?? '').trim() || null,
    area: deriveArea(row.recipient_postcode),
    meta: { ...(row as unknown as Record<string, string>) },
  }
}
```

- [ ] **Step 4: Add `splitRowsForEnrichment` to `manifest.ts`**

In `src/lib/manifest.ts`, after `buildParcelInputs`, add:

```ts
/** For a tracking-only import (a mapping with a tracking column but no address
 *  column): pull the unique, non-blank tracking numbers to send for enrichment.
 *  Dedupe is case-insensitive, matching buildParcelInputs' key. */
export function splitRowsForEnrichment(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): { toEnrich: string[] } {
  const seen = new Set<string>()
  const toEnrich: string[] = []
  const col = mapping.tracking_number
  if (col) {
    for (const row of rows) {
      const tn = (row[col] ?? '').trim()
      if (!tn) continue
      const key = tn.toUpperCase()
      if (seen.has(key)) continue
      seen.add(key)
      toEnrich.push(tn)
    }
  }
  return { toEnrich }
}
```

> Note: `buildParcelInputs` already only errors a row when a *required, mapped*
> field is blank. With no address column mapped, the relaxation in Task 5 routes
> the file to enrichment before `buildParcelInputs` runs, so no change to its
> error logic is needed here — the test asserts current behaviour holds.

- [ ] **Step 5: Run the test — verify it passes**

Run: `node scripts/test-enrich.mjs`
Expected: all checks `✓`, `N passed, 0 failed`, exit 0.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 7: Commit** (on user go-ahead)

```bash
git add src/lib/enrich.ts src/lib/manifest.ts scripts/test-enrich.mjs
git commit -m "feat(enrich): shipment→parcel transforms + postcode→area map (tested)"
```

---

## Task 3: `enrich-shipments` Edge Function (thin Lens reader)

**Files:**
- Create: `supabase/functions/enrich-shipments/index.ts`
- Create: `src/lib/enrichApi.ts`

> **Prerequisite (Lens project `eivbxinppkwhqtglusmh`, one-time, manual):**
> create a dedicated read-only role and grant it `SELECT` on `public.shipments`:
> ```sql
> create role epod_reader login password '<generated>';
> grant usage on schema public to epod_reader;
> grant select on public.shipments to epod_reader;
> ```
> Build its pooler connection string (Supavisor tenant format —
> `epod_reader.eivbxinppkwhqtglusmh`): verify the exact host/format in the Lens
> Supabase dashboard → Database → Connection pooling:
> `postgresql://epod_reader.eivbxinppkwhqtglusmh:<password>@aws-1-eu-west-2.pooler.supabase.com:6543/postgres`

- [ ] **Step 1: Write the function**

Create `supabase/functions/enrich-shipments/index.ts`:

```ts
// enrich-shipments — admin-gated, server-side reader of Lens's GWOptical mirror.
//
// Why: Lens's public.shipments holds the delivery address per tracking number,
// but it's RLS-locked (no policy, grants revoked) and lives in a SEPARATE
// Supabase project, so the browser can't read it. This function verifies the
// caller is an ePOD admin (same gate as functions/admin), then reads only the
// columns we need from Lens via a dedicated read-only role (LENS_DB_URL). It
// does NO shaping — the client maps rows via src/lib/enrich.ts.
//
// Auto-injected env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Secret to set:      LENS_DB_URL  (read-only pooler URI for the Lens project).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.0'
import postgres from 'https://deno.land/x/postgresjs@v3.4.5/mod.js'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const MAX_BATCH = 1000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const lensUrl = Deno.env.get('LENS_DB_URL')
  if (!lensUrl) return json({ error: 'Address source not configured' }, 500)

  // --- Gate: caller must be a signed-in admin (same as functions/admin) ---
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Not authenticated' }, 401)
  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', userData.user.id).maybeSingle()
  if (profile?.role !== 'admin') return json({ error: 'Admins only' }, 403)

  // --- Parse + normalise the input list ---
  let body: { tracking_numbers?: unknown }
  try { body = await req.json() } catch { return json({ error: 'Bad JSON body' }, 400) }
  const raw = Array.isArray(body.tracking_numbers) ? body.tracking_numbers : []
  const seen = new Set<string>()
  const submitted: string[] = []
  for (const v of raw) {
    const tn = String(v ?? '').trim()
    if (!tn) continue
    const key = tn.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    submitted.push(tn)
  }
  if (submitted.length === 0) return json({ error: 'No tracking numbers provided' }, 400)
  if (submitted.length > MAX_BATCH) return json({ error: `Too many at once (max ${MAX_BATCH})` }, 400)

  // --- Read Lens (read-only role); return raw matched rows + the misses ---
  const sql = postgres(lensUrl, { prepare: false, max: 1, idle_timeout: 5 })
  try {
    const rows = await sql`
      select tracking_number, recipient_full_name, recipient_company,
             recipient_address1, recipient_address2, recipient_address3,
             recipient_city, recipient_county, recipient_postcode
      from public.shipments
      where tracking_number = any(${submitted}) and is_deleted = false`
    const foundSet = new Set(rows.map((r: { tracking_number: string }) => r.tracking_number.toUpperCase()))
    const notFound = submitted.filter((t) => !foundSet.has(t.toUpperCase()))
    return json({
      data: {
        found: rows,
        notFound,
        counts: { submitted: submitted.length, found: rows.length, notFound: notFound.length },
      },
    })
  } catch (e) {
    return json({ error: `Couldn't reach the address source — try again. (${e instanceof Error ? e.message : 'error'})` }, 502)
  } finally {
    await sql.end({ timeout: 5 })
  }
})
```

- [ ] **Step 2: Write the client wrapper**

Create `src/lib/enrichApi.ts`:

```ts
import { supabase } from './supabase'
import type { ShipmentRow } from './enrich'

export interface EnrichResult {
  found: ShipmentRow[]
  notFound: string[]
  counts: { submitted: number; found: number; notFound: number }
}

/** Call the enrich-shipments Edge Function. functions.invoke attaches the
 *  caller's JWT; the function enforces admin-only. Throws with the function's
 *  own error message. */
export async function enrichShipments(trackingNumbers: string[]): Promise<EnrichResult> {
  const { data, error } = await supabase.functions.invoke('enrich-shipments', {
    body: { tracking_numbers: trackingNumbers },
  })
  if (error) {
    const ctx = (error as { context?: unknown }).context
    if (ctx instanceof Response) {
      try {
        const b = await ctx.clone().json()
        if (b && typeof b === 'object' && 'error' in b) throw new Error(String(b.error))
      } catch { /* not JSON */ }
    }
    throw new Error(error instanceof Error ? error.message : 'Enrichment failed')
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error))
  }
  return (data as { data: EnrichResult }).data
}
```

- [ ] **Step 3: Deploy the function + set the secret**

```bash
node_modules/@supabase/cli-windows-x64/bin/supabase.exe functions deploy enrich-shipments --project-ref mqiwyfhxcjvkpnpbtgql
node_modules/@supabase/cli-windows-x64/bin/supabase.exe secrets set LENS_DB_URL="postgresql://epod_reader.eivbxinppkwhqtglusmh:<password>@aws-1-eu-west-2.pooler.supabase.com:6543/postgres" --project-ref mqiwyfhxcjvkpnpbtgql
```
(Per CLAUDE.md, in sandboxed shells call the `supabase.exe` binary directly rather than `npx supabase`.)

- [ ] **Step 4: Integration check (manual, read-only)**

From the dispatcher UI signed in as an admin (or a quick console call), invoke with one real tracking number known to exist in GWOptical and one bogus one. Expected JSON: `data.found` has the real row's address columns, `data.notFound` contains the bogus one, `counts` adds up. Also confirm a non-admin session gets 403 and no token gets 401.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: no type errors (the function is Deno and excluded from `tsc`; the new `src/lib/enrichApi.ts` compiles).

- [ ] **Step 6: Commit** (on user go-ahead)

```bash
git add supabase/functions/enrich-shipments/index.ts src/lib/enrichApi.ts
git commit -m "feat(enrich): admin-gated edge function reading Lens shipments mirror"
```

---

## Task 4: Paste-box entry point on the Jobs screen

**Files:**
- Modify: `src/screens/JobsScreen.tsx` (extract `commitParcels`; add `EnrichCard`; render it)

- [ ] **Step 1: Extract a shared `commitParcels` helper**

In `JobsScreen.tsx`, lift the manifest/parcels commit out of `ImportCard.commit` (lines ~189-233) into a module-level async function so both cards reuse it:

```ts
import type { ParcelInput } from '../lib/manifest'

/** Create-or-update a job by name and upsert its parcels (onConflict
 *  tracking_number). Shared by the file importer and the paste-box enricher. */
async function commitParcels(name: string, sourceFilename: string, parcels: ParcelInput[]): Promise<void> {
  const { data: existing } = await supabase.from('manifests').select('id').eq('name', name).maybeSingle()
  let manifestId: string
  if (existing) {
    manifestId = (existing as { id: string }).id
    const { error } = await supabase.from('manifests')
      .update({ imported_at: new Date().toISOString(), source_filename: sourceFilename }).eq('id', manifestId)
    if (error) throw new Error(error.message)
  } else {
    const { data, error } = await supabase.from('manifests')
      .insert({ name, source_filename: sourceFilename }).select().single()
    if (error) throw new Error(error.message)
    manifestId = (data as Manifest).id
  }
  const rows = parcels.map((p) => ({ ...p, manifest_id: manifestId }))
  const { error } = await supabase.from('parcels').upsert(rows, { onConflict: 'tracking_number' })
  if (error) throw new Error(error.message)
}
```

Then replace `ImportCard.commit`'s body with a call to `commitParcels(name, filename, result.parcels)` (keeping its `setImporting`/`reset`/`onImported`/error handling around it).

- [ ] **Step 2: Add the `EnrichCard` component**

Add to `JobsScreen.tsx`:

```tsx
import { enrichShipments } from '../lib/enrichApi'
import { shipmentToParcelInput } from '../lib/enrich'

/** Paste/scan bare tracking numbers → look up addresses in GWOptical (via the
 *  enrich-shipments function) → commit the found ones as a job. Not-found
 *  numbers are listed with Retry (a fresh shipment may not have synced yet). */
function EnrichCard({ onImported }: { onImported: () => void }) {
  const [text, setText] = useState('')
  const [jobName, setJobName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [found, setFound] = useState<ParcelInput[] | null>(null)
  const [notFound, setNotFound] = useState<string[]>([])

  const parseList = (s: string) => Array.from(new Set(
    s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
  ))

  async function lookup(numbers: string[]) {
    if (numbers.length === 0) return
    setBusy(true); setProblem(null)
    try {
      const res = await enrichShipments(numbers)
      setFound(res.found.map(shipmentToParcelInput))
      setNotFound(res.notFound)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function commit() {
    if (!found || found.length === 0) return
    setBusy(true); setProblem(null)
    try {
      await commitParcels(jobName.trim() || 'Tracking import', '', found)
      setText(''); setJobName(''); setFound(null); setNotFound([])
      onImported()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white">
      <div className="border-b border-line bg-paper/60 px-4 py-2.5">
        <p className="section-label">Enrich from tracking numbers</p>
      </div>
      <div className="p-4">
        {problem && (
          <div className="mb-3 rounded-[11px] border border-fail/40 bg-fail/10 px-3 py-2.5 text-[13px] text-fail">{problem}</div>
        )}
        <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">Job name</label>
        <input value={jobName} onChange={(e) => setJobName(e.target.value)}
          className="mb-3 w-full rounded-[11px] border border-line bg-white px-3 py-[11px] text-sm text-ink focus:border-navy-500 focus:outline-none focus:ring-[3px] focus:ring-navy-500/10" />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6}
          placeholder="Paste tracking numbers — one per line"
          className="w-full rounded-[11px] border border-line bg-white px-3 py-2.5 font-mono text-[12.5px] text-ink focus:border-navy-500 focus:outline-none" />
        <button type="button" disabled={busy || parseList(text).length === 0}
          onClick={() => void lookup(parseList(text))}
          className="mt-3 w-full rounded-[11px] bg-navy px-4 py-2.5 font-serif text-[15px] text-white transition hover:bg-navy-600 active:translate-y-px disabled:opacity-40">
          {busy ? 'Looking up…' : `Look up ${parseList(text).length} addresses`}
        </button>

        {found && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span className="font-semibold text-ok">{found.length} found</span>
              {notFound.length > 0 && <span className="font-semibold text-fail">{notFound.length} not found</span>}
            </div>
            {notFound.length > 0 && (
              <div className="mt-2 rounded-[11px] border border-gold/40 bg-gold/10 px-3 py-2 text-[12.5px] text-[#9a6a00]">
                <div className="mb-1 font-semibold">Not in GWOptical yet:</div>
                <div className="font-mono text-[11.5px] break-words">{notFound.join(', ')}</div>
                <button type="button" disabled={busy} onClick={() => void lookup(notFound)}
                  className="mt-2 rounded-[9px] border border-gold/50 bg-white px-2.5 py-1 text-[12px] font-semibold text-[#9a6a00]">
                  Retry not-found
                </button>
              </div>
            )}
            {found.length > 0 && (
              <button type="button" disabled={busy} onClick={() => void commit()}
                className="mt-3 w-full rounded-[11px] bg-navy px-4 py-2.5 font-serif text-[15px] text-white disabled:opacity-40">
                Import {found.length} parcels
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Render `EnrichCard` under `ImportCard`**

In the `JobsScreen` return, in the left column (around line 114-116):

```tsx
<div className="xl:sticky xl:top-[82px] flex flex-col gap-6">
  <ImportCard onImported={() => void load()} />
  <EnrichCard onImported={() => void load()} />
</div>
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 5: Manual check**

Paste a couple of real tracking numbers → "Look up addresses" → found preview shows composed address + area; "Import" creates a job whose parcels appear in the list (realtime). Paste a bogus one → it lands under "Not in GWOptical yet" with a working Retry.

- [ ] **Step 6: Commit** (on user go-ahead)

```bash
git add src/screens/JobsScreen.tsx
git commit -m "feat(jobs): paste-box to import parcels from bare tracking numbers"
```

---

## Task 5: Extend the file importer for tracking-only files

**Files:**
- Modify: `src/screens/JobsScreen.tsx` (`ImportCard` — detect no address column → enrich)

- [ ] **Step 1: Detect the tracking-only case and enrich**

In `ImportCard`, when a parsed file maps a `tracking_number` column but **no `address_line`** column, route it through enrichment instead of `buildParcelInputs`. Add this branch to `commit()` (before the normal `result.parcels` path):

```tsx
import { autoMap, buildParcelInputs, parseManifestFile, splitRowsForEnrichment, MANIFEST_FIELDS, type ColumnMapping, type ParsedManifest } from '../lib/manifest'

// inside commit(), after computing `name`:
if (parsed && mapping.tracking_number && !mapping.address_line) {
  const { toEnrich } = splitRowsForEnrichment(parsed.rows, mapping)
  const res = await enrichShipments(toEnrich)
  const enriched = res.found.map(shipmentToParcelInput)
  if (enriched.length === 0) {
    setProblem(`None of the ${toEnrich.length} tracking numbers were found in GWOptical yet.`)
    setImporting(false)
    return
  }
  await commitParcels(name, filename, enriched)
  if (res.notFound.length > 0) {
    setProblem(`Imported ${enriched.length}; ${res.notFound.length} not found in GWOptical yet: ${res.notFound.slice(0, 10).join(', ')}${res.notFound.length > 10 ? '…' : ''}`)
  }
  reset()
  onImported()
  setImporting(false)
  return
}
```

- [ ] **Step 2: Don't block the UI on a missing address column**

The preview/commit button currently disables when `result.parcels.length === 0` (which a tracking-only file triggers). Update the disabled + summary logic so that when `mapping.tracking_number && !mapping.address_line`, the button is enabled and labelled "Look up & import N", where N = `splitRowsForEnrichment(parsed.rows, mapping).toEnrich.length`. Concretely, compute:

```tsx
const trackingOnly = !!(parsed && mapping.tracking_number && !mapping.address_line)
const enrichCount = useMemo(
  () => (trackingOnly && parsed ? splitRowsForEnrichment(parsed.rows, mapping).toEnrich.length : 0),
  [trackingOnly, parsed, mapping],
)
```

and use them on the commit button:

```tsx
disabled={importing || (trackingOnly ? enrichCount === 0 : !result || result.parcels.length === 0)}
// label:
{importing ? 'Importing…' : trackingOnly ? `Look up & import ${enrichCount}` : `Import ${result?.parcels.length ?? 0} parcels`}
```

Also, when `trackingOnly`, hide the "missing address" error list (those aren't errors here) — guard the existing `result.errors` block with `{!trackingOnly && …}`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 4: Manual check**

Upload an `.xlsx` with only a "Tracking Number" column → mapping shows tracking matched, address unmatched → button reads "Look up & import N" → import creates the job with enriched addresses; not-found are reported.

- [ ] **Step 5: Commit** (on user go-ahead)

```bash
git add src/screens/JobsScreen.tsx
git commit -m "feat(jobs): auto-enrich tracking-only manifest uploads"
```

---

## Task 6: Inline area editor (the "fix it" control)

**Files:**
- Modify: `src/screens/AllocateScreen.tsx` (add `assignArea` + an area `<select>` in `ParcelRow`)

- [ ] **Step 1: Add an `assignArea` handler**

In `AllocateScreen`, alongside `assign` (line ~53):

```ts
import { AREAS } from '../lib/types'

async function assignArea(parcelId: string, area: Area) {
  setBusy(true)
  setParcels((prev) => prev?.map((p) => (p.id === parcelId ? { ...p, area } : p)) ?? prev)
  const { error } = await supabase.from('parcels').update({ area }).eq('id', parcelId)
  if (error) { setError(error.message); void load() }
  setBusy(false)
}
```

Pass it into both `ParcelRow` usages: add `onSetArea={(area) => void assignArea(p.id, area)}`.

- [ ] **Step 2: Render the area select in `ParcelRow`**

Add `onSetArea: (area: Area) => void` to `ParcelRow`'s props, and replace the static area badge (lines ~228-230) with an inline select that styles `'Other'` as needs-attention:

```tsx
<select
  value={p.area}
  disabled={busy}
  onChange={(e) => onSetArea(e.target.value as Area)}
  aria-label={`Area for ${p.tracking_number}`}
  className={`flex-none rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.6px] focus:outline-none ${
    p.area === 'Other' ? 'border-fail/40 bg-fail/10 text-fail' : 'border-gold/40 bg-gold/10 text-gold'
  }`}
>
  {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
</select>
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 4: Manual check**

On the Allocate screen, an `'Other'` parcel shows a red area chip; changing it to e.g. "Kent" persists (realtime) and, if a route covers Kent, "Auto-allocate by area" now places it.

- [ ] **Step 5: Commit** (on user go-ahead)

```bash
git add src/screens/AllocateScreen.tsx
git commit -m "feat(allocate): inline area editor for relabelling parcels"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 2: Pure-function tests**

Run: `node scripts/test-enrich.mjs`
Expected: `N passed, 0 failed`.

- [ ] **Step 3: End-to-end walkthrough (manual)**

Confirm, signed in as an admin against the hosted stack:
- Paste box: real numbers → found + import; bogus → not-found + Retry.
- Tracking-only file: enriched + imported.
- Mixed file (some rows already carry an address): rows with an address import as-is; address-less rows — note current scope routes a file to enrichment only when *no* address column is mapped, so a column-present-but-blank mix imports the blank ones as errors (documented limitation; refine later if needed).
- `'Other'` parcels: relabel via the area chip; auto-allocate by area.

- [ ] **Step 4: Deploy**

Push `master` (on user go-ahead) → Vercel auto-rebuilds. Verify the live bundle hash changed.

---

## Notes / known limitations

- **Mixed files** (an address column exists but some rows leave it blank): out of
  scope this iteration — enrichment kicks in only when *no* address column is
  mapped. A blank-cell row still reports as a missing-address error. Revisit if
  it shows up in real manifests.
- **`destination` geofence** is not set for enriched parcels (the mirror has no
  geocode). Geofence simply doesn't apply to them yet.
- **Lens coupling:** enrichment depends on Lens's 5-min loader having synced the
  shipment; the not-found + Retry flow is the mitigation. Existing parcels are
  unaffected once their address is copied into ePOD.
