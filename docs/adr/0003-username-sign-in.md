# Drivers sign in with a username, stored as a synthetic email

**Status:** accepted

Drivers sign in with a **Username** (first initial + surname, e.g. `FCrawley`,
case-insensitive) and a password — no email. Admins keep their real company
email. The single sign-in field accepts either: anything containing `@` is
treated as an email, otherwise it's a username.

Supabase Auth (GoTrue) has no username credential — accounts are keyed on an
email (or phone). So a username is stored as a **synthetic email**
`<username>@drivers.citipost.local`: a syntactically valid, non-routable address
that never reaches a real inbox and never collides with a real one. The login
box and the admin Edge Function convert username ⇄ synthetic email; users only
ever see and type the username.

## Why this over the alternatives

- **A real `username` column + custom sign-in RPC.** Rejected: it means
  reimplementing credential lookup and password verification outside GoTrue
  (or a Postgres function that checks `crypt()`), giving up the audited auth
  path, refresh tokens, and ban/rate-limit machinery we already rely on. The
  synthetic-email trick keeps 100% of GoTrue untouched.
- **Giving every driver a real email.** Rejected as the original friction —
  drivers don't have/ want company inboxes, and there's no SMTP anyway (ADR
  0002), so email features are moot.

The cost is that the chosen domain is effectively permanent: the username lives
*inside* `auth.users.email`, so changing `drivers.citipost.local` later means
rewriting every driver's auth email. That's why the domain is a single named
constant, and why this is recorded here.

## Consequences

- **No schema migration.** `profiles`, RLS, the roster link, and the last-admin
  guards are unchanged — usernames ride entirely in the existing email column.
- The domain constant + the four conversion helpers are **duplicated** in
  `src/lib/admin.ts` (client) and `supabase/functions/admin/index.ts` (Deno
  can't import from `src/`). They must be kept in sync; both carry a comment
  saying so.
- A username clash surfaces as GoTrue's "email already registered", which the
  function rewrites to "Username … is already taken".
- Existing pre-username accounts (real emails, any role) keep working — the
  login box still accepts emails, so nothing needs migrating.
- Renaming a username rewrites the synthetic auth email via
  `updateUserById({ email, email_confirm: true })`; `email_confirm` avoids a
  (nonexistent) SMTP confirmation step, matching ADR 0002.
