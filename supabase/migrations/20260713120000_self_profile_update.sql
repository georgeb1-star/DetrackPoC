-- Self-service profile: let a signed-in user edit their OWN display name.
--
-- `profiles` intentionally has no UPDATE policy (a user must never be able to
-- change their own role or driver_id — that would be privilege escalation).
-- This SECURITY DEFINER function is the narrow, safe exception: it updates
-- ONLY full_name, ONLY for the calling user (auth.uid()), and touches nothing
-- else. Email and password are changed through Supabase Auth, not here.
create or replace function public.update_my_profile(p_full_name text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set full_name = nullif(btrim(p_full_name), '')
   where id = auth.uid();
$$;

-- Not callable anonymously; any signed-in user may update their own name.
revoke all on function public.update_my_profile(text) from public;
grant execute on function public.update_my_profile(text) to authenticated;
