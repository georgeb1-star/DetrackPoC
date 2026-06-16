# Citipost ePOD — domain glossary

The canonical vocabulary for this project. Implementation details belong in
`CLAUDE.md` and the code; this file defines *what the words mean* so we use them
consistently. Resolved during the admin-panel design (2026-06-16).

## Identity & access

The word "driver" is overloaded in casual speech. In this system it splits into
**two distinct things** that can exist independently:

- **Login** — an `auth.users` account: a credential (see **Username** /
  **Email** below) + password a person signs in with. Has no role or fleet
  meaning on its own. Created/managed only with the service-role key (never from
  the browser).

- **Username** — how a **driver** signs in: first initial + surname, e.g.
  `FCrawley` (case-insensitive). Drivers have no email. Admins sign in with their
  real company **email** instead. The sign-in box accepts either.

- **Synthetic email** — the implementation of a Username. Supabase Auth keys
  accounts on an email, so a Username is stored as `<username>@<internal-domain>`
  (a non-routable address that never reaches a real inbox). It's an internal
  detail — users only ever see/type the Username. See ADR 0003.

- **Profile** — a `profiles` row that maps one Login to a **Role** and, for
  drivers, to a **Roster entry**. This is the app's notion of *who you are*.
  One Login ↔ one Profile.

- **Role** — `admin` or `driver`. `admin` runs the dispatcher portal (allocate,
  jobs, sites, PODs, admin panel). `driver` sees only their own run.

- **Roster entry** (a.k.a. **Driver**, the `drivers` table row) — `id` + `name`.
  This is the *fleet identity* stamped onto every POD and scan event and
  assigned to a Route. A Roster entry can exist with **no Login at all** (e.g.
  a seeded driver, or one kept only so historical PODs still resolve a name).
  When we say "Driver" unqualified, we mean this roster entity.

- **Driver login** — the common case: a Login whose Profile has `role = driver`
  and whose `driver_id` points at a Roster entry. Creating a working driver
  therefore means ensuring **both** a Roster entry and a Driver login linked to
  it. Attribution (which PODs are whose) follows the Roster entry, not the
  Login — deleting a Login never orphans delivery history.

## Fleet & work

- **Route** — one Driver's run for a day (the `routes` row). Has a unique name,
  an assigned Roster entry (`driver_id`), and a set of **Areas** it covers.
  Assigning a parcel to a Route implicitly assigns it to that Roster entry.

- **Area** — a fixed delivery-area label: exactly `South London`,
  `North London`, `West London`, `Central London`, `Kent`, `Surrey`. Flat
  labels, not nested (`Central London` is not "inside" any other). A parcel
  carries one (`parcels.area`, DB CHECK-constrained, default `South London`); a
  Route covers a set (`routes.areas`). A Route's Areas drive the dispatcher's
  "auto-allocate by area", which matches a parcel's area against the labels a
  Route lists.

- **Allocation** — linking a Parcel (or Site) to a Route (`route_id`). `null` =
  unallocated (dispatcher to-do; hidden from every driver's run).

- **Parcel**, **Manifest (Job)**, **Site**, **POD**, **Scan event** — unchanged
  from `CLAUDE.md`; see there for lifecycle detail.

## Admin panel verbs

- **Add a user** — create a Login + Profile in one step. A driver gets a
  **Username** (suggested from their name) and a **Roster entry minted from
  their Full name** (one per person — the identity shown on deliveries); an
  admin gets an **email**. Re-linking a driver to an *existing* Roster entry is
  a Manage-panel action, not part of Add.
- **Assign a role / re-link a driver** — edit the Profile. Editing a driver's
  Full name also renames their linked Roster entry (kept in sync), unless you
  re-link them to a different existing entry.
- **Reset password** — set a new password on the Login (admin-chosen; see
  ADR 0002).
- **Deactivate** — ban the Login so it can't sign in, without deleting history.
- **Delete user** — remove the Login (cascades to its Profile). Does **not**
  touch the Roster entry or any PODs.
- **Manage drivers** — CRUD the Roster (`drivers`).
- **Manage routes** — CRUD Routes and their Areas.
