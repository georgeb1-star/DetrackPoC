# New Logins get an admin-set temporary password, not an email invite

**Status:** accepted

When an admin creates a Login from the panel, they set (or auto-generate) a
starting password that is shown once and passed to the driver out-of-band. We do
**not** use Supabase's email-invite / magic-link flow.

The deciding constraint: the hosted project has no SMTP configured, so invite
and password-reset emails silently never send — an invite flow would look like
it worked while leaving the driver unable to sign in. Admin-set passwords work
immediately with zero email dependency, which suits an internal fleet tool where
the dispatcher already has a direct line to each driver. The Login is created
with `email_confirm: true` so there is no confirmation step to strand.

## Consequences

- No "change password on first sign-in" enforcement and no in-app
  change-password screen for now (would be the natural follow-up if this
  graduates beyond an internal tool). If SMTP is added later, an invite flow can
  be offered alongside this one without removing it.
