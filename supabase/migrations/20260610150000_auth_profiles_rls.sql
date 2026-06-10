-- Real auth + Row Level Security. Replaces the PoC "RLS off, pick a driver"
-- posture: every data table is now access-controlled by the signed-in user's
-- role, derived from a profiles row linked to auth.users.
--
--   admin  — dispatcher: full read/write across the fleet (allocate, import
--            manifests, export tracking, view every POD).
--   driver — sees and acts only on parcels/PODs for the route(s) their
--            driver_id is assigned to.

-- One row per auth user → role + (for drivers) the text drivers.id stamped
-- onto PODs. Populated by scripts/seed-auth.mjs (auth.users can't be seeded
-- reliably from plain SQL).
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin','driver')),
  driver_id  text references drivers(id),
  full_name  text,
  created_at timestamptz not null default now()
);

-- Helpers read the caller's profile. SECURITY DEFINER so they bypass RLS on
-- profiles (no policy recursion); search_path pinned for safety.
create or replace function public.auth_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.auth_driver_id() returns text
  language sql stable security definer set search_path = public as $$
  select driver_id from profiles where id = auth.uid();
$$;

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.auth_role() = 'admin', false);
$$;

-- Enable RLS everywhere (was explicitly disabled in the PoC).
alter table profiles    enable row level security;
alter table drivers     enable row level security;
alter table routes      enable row level security;
alter table manifests   enable row level security;
alter table parcels     enable row level security;
alter table pod_records enable row level security;
alter table pod_photos  enable row level security;

-- profiles: own row, or any if admin.
create policy profiles_select on profiles for select
  using (id = auth.uid() or public.is_admin());

-- drivers: any signed-in user may read the roster (run sheet shows names);
-- only admins write.
create policy drivers_select on drivers for select
  using (auth.uid() is not null);
create policy drivers_admin_write on drivers for all
  using (public.is_admin()) with check (public.is_admin());

-- routes: admins all; a driver only their own route(s).
create policy routes_select on routes for select
  using (public.is_admin() or driver_id = public.auth_driver_id());
create policy routes_admin_write on routes for all
  using (public.is_admin()) with check (public.is_admin());

-- parcels: admins all; a driver only parcels on their route(s). Drivers may
-- UPDATE their own stops (POD sync writes status/attempts/completed_at);
-- INSERT/DELETE (manifest import, allocation) stays admin-only.
create policy parcels_select on parcels for select
  using (public.is_admin()
         or route_id in (select id from routes where driver_id = public.auth_driver_id()));
create policy parcels_update on parcels for update
  using (public.is_admin()
         or route_id in (select id from routes where driver_id = public.auth_driver_id()))
  with check (public.is_admin()
              or route_id in (select id from routes where driver_id = public.auth_driver_id()));
create policy parcels_admin_insert on parcels for insert with check (public.is_admin());
create policy parcels_admin_delete on parcels for delete using (public.is_admin());

-- manifests: admin only.
create policy manifests_admin_all on manifests for all
  using (public.is_admin()) with check (public.is_admin());

-- pod_records: a driver inserts/reads/updates only their own captures; admins all.
create policy pod_records_select on pod_records for select
  using (public.is_admin() or driver_id = public.auth_driver_id());
create policy pod_records_insert on pod_records for insert
  with check (public.is_admin() or driver_id = public.auth_driver_id());
create policy pod_records_update on pod_records for update
  using (public.is_admin() or driver_id = public.auth_driver_id())
  with check (public.is_admin() or driver_id = public.auth_driver_id());

-- pod_photos: gated by the parent POD's ownership.
create policy pod_photos_select on pod_photos for select
  using (exists (select 1 from pod_records pr
                 where pr.id = pod_id and (public.is_admin() or pr.driver_id = public.auth_driver_id())));
create policy pod_photos_insert on pod_photos for insert
  with check (exists (select 1 from pod_records pr
                      where pr.id = pod_id and (public.is_admin() or pr.driver_id = public.auth_driver_id())));

-- Storage: lock the evidence bucket to signed-in users (was public). Admins
-- read photos via signed URLs; drivers only write (their confirmation screen
-- shows the local blob, so it never reads back).
update storage.buckets set public = false where id = 'pod-evidence';
drop policy if exists "pod evidence read" on storage.objects;
drop policy if exists "pod evidence upload" on storage.objects;
create policy "pod evidence read" on storage.objects for select
  using (bucket_id = 'pod-evidence' and auth.uid() is not null);
create policy "pod evidence upload" on storage.objects for insert
  with check (bucket_id = 'pod-evidence' and auth.uid() is not null);
