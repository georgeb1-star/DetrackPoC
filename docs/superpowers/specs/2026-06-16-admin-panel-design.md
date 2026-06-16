# Admin Panel — design

**Date:** 2026-06-16
**Goal:** A fully working, admin-only panel that handles the administrative
tasks currently done via the Supabase dashboard, raw SQL, or by editing
scripts/code — without touching the backend.

See `CONTEXT.md` for terminology and `docs/adr/0001`, `0002` for the two
load-bearing decisions.

## Scope

Three areas, all currently backend-only:

1. **Users** — Logins + Profiles: create, assign role, link/relink driver,
   reset password, deactivate (ban), delete. Lists everyone with access.
2. **Drivers** — the roster (`drivers`): add, rename, remove.
3. **Routes** — the runs (`routes`): create, set name/driver/areas, remove.

Out of scope (already has UI or unaffected): parcels (manifest import),
allocation (Allocate screen), sites (Sites screen), POD viewing.

## Architecture

```
AdminScreen (#/admin, admin-only)
  ├─ Users  ─→ lib/admin.ts adminInvoke(action,payload)
  │             └─→ supabase.functions.invoke('admin')  [service-role, JWT-gated]
  │                   list_users · create_user · update_user · set_active · delete_user
  ├─ Drivers ─→ supabase.from('drivers')  [client-side, admin RLS]
  └─ Routes  ─→ supabase.from('routes')   [client-side, admin RLS]
```

- **Edge Function `functions/admin`** (Deno). Every request: read `Authorization`
  bearer → `auth.getUser()` to resolve the caller → look up their Profile role
  with a service client → reject non-admins (403). Then dispatch on
  `body.action` using the service-role client. Returns `{ data }` or
  `{ error }` with an appropriate status.
- **`lib/admin.ts`** — thin `adminInvoke(action, payload)` over
  `supabase.functions.invoke`, which auto-attaches the session JWT. Plus the
  `AdminUser` type (merged Login + Profile + linked roster name).
- **Drivers/Routes** — plain PostgREST writes; admins already pass RLS.

### Edge Function actions

| action | payload | does |
|---|---|---|
| `list_users` | — | `auth.admin.listUsers()` joined to `profiles` (+ roster name); returns `AdminUser[]` |
| `create_user` | email, password, role, driver_id?, full_name? | `createUser({email_confirm:true})` → upsert profile |
| `update_user` | id, role?, driver_id?, full_name?, password? | upsert profile fields; if password, `updateUserById` |
| `set_active` | id, active | ban (`ban_duration:'876000h'`) or unban (`'none'`) |
| `delete_user` | id | `deleteUser(id)` (cascades to profile) |

### Safety rules (enforced server-side, not just UI)

- **Never remove the last admin.** `update_user` demoting an admin, `set_active`
  banning an admin, and `delete_user` on an admin all first count remaining
  active admins and reject if this would leave zero.
- **No self-delete and no self-demote/-deactivate.** The signed-in admin can't
  lock themselves out. (Distinct from the last-admin rule; both apply.)
- **Driver role needs a roster link.** `create_user`/`update_user` reject
  `role:'driver'` with no `driver_id`.

## Frontend behaviour

- **Placement.** New `Admin` tab in `AdminShell` (`#/admin`), admin-only; drivers
  deep-linking are bounced (existing `main.tsx` guard, extended to `#/admin`).
- **Sub-navigation.** One `AdminScreen` with an in-page segmented control:
  Users · Drivers · Routes. Keeps the single AdminShell nav row intact.
- **Visual language.** Reuse the Freight Modern system exactly as `SitesScreen`
  does: `AdminShell` chrome, `INPUT`/`Field` helpers, navy/gold/paper, the
  add-form-left / list-right two-column layout. Apply frontend-design polish
  within that system; do not invent a new aesthetic.

### Users tab

- **Add user** form: email, full name, role (admin/driver), password (with a
  "generate" button that fills a strong random value, shown in clear so the
  admin can copy it once). When role = driver: a **Driver (roster)** select with
  an inline **"+ New driver"** option — choosing it reveals a name field; on
  submit the panel creates the roster row (client-side) then calls `create_user`
  with the new `driver_id`.
- **List**: each Login shows email, full name, role badge, linked driver, status
  (active/disabled). Row actions: change role, relink driver, reset password,
  deactivate/reactivate, delete. Destructive actions confirm. Server rejections
  (last-admin etc.) surface as an inline error.

### Drivers tab

- Add (name → id auto-generated `drv_<slug>_<rand>`), rename inline, remove.
- Remove attempts the delete; an FK violation (driver has PODs / a route / a
  login) is caught and shown as a plain-language message telling the admin what
  to detach first. We never silently cascade-delete delivery history.

### Routes tab

- Add (name, driver select, areas multi-select from the three fixed regions),
  edit name/driver/areas, remove. Remove handles the FK case (parcels/sites
  still allocated) with a clear message, same as drivers.

## Verification

1. `npm run build` (tsc + vite) — frontend type-clean.
2. Deploy `functions/admin` to the hosted project (additive, reversible).
3. Self-test against hosted: `list_users` (read-only), then create + delete a
   throwaway `…+selftest@…` Login to exercise the full privileged path; confirm
   non-admin callers get 403.
4. Report what was deployed; leave frontend deploy (Vercel) to the normal flow.

## Non-goals / YAGNI

No bulk import of users, no audit log, no per-Area route validation, no
change-password screen, no email flows (see ADR 0002).
