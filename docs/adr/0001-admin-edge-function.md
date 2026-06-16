# Privileged admin operations go through an admin-gated Edge Function

**Status:** accepted

Creating Logins (`auth.users`) and writing the `profiles` table both require the
Supabase **service-role key**, which must never reach the browser — the whole
RLS posture (`CLAUDE.md`: "`profiles` has no insert/update policy, so a
signed-in user can't self-escalate") depends on the client being unable to write
profiles. So the admin panel's user-management actions run in a Supabase **Edge
Function** (`functions/admin`) that: (1) verifies the caller's JWT and confirms
their Profile role is `admin`, then (2) performs the action with a service-role
client. The browser only ever sees the anon key.

## Considered options

- **Broaden RLS** — add an `is_admin()` insert/update policy on `profiles`.
  Rejected: it reintroduces a client-writable path to the very table whose
  lock-down is the security invariant, and still can't create `auth.users`
  (which fundamentally needs the service role). It would solve half the problem
  while weakening the model.
- **A Vercel serverless function** holding the service-role key. Rejected: the
  repo is a pure Vite SPA with no server runtime, and the backend already lives
  entirely in Supabase. An Edge Function keeps the service-role key inside the
  platform that issues it (auto-injected as `SUPABASE_SERVICE_ROLE_KEY`, no
  secret to manage or leak into Vercel env).

## Consequences

- `drivers` and `routes` management stays **client-side** — admins already have
  RLS write access to those tables, so no function call is needed there. Only
  Login/Profile operations cross into the privileged function.
- No database migration is required: the function bypasses RLS via the service
  role, so the documented "no profiles write policy" invariant is preserved
  unchanged.
