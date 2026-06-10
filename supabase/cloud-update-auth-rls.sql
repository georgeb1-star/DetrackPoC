-- Add real auth + Row Level Security to an existing hosted project. Mirrors
-- migrations/20260610150000_auth_profiles_rls.sql; safe to re-run.
--
-- After applying, create the demo auth users — in the dashboard
-- (Authentication → Users) or with the seed script pointed at the host:
--   SUPABASE_URL=https://<ref>.supabase.co \
--   SUPABASE_SERVICE_ROLE_KEY=<service key> node scripts/seed-auth.mjs
-- (the script also upserts the matching profiles rows).

create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin','driver')),
  driver_id  text references drivers(id),
  full_name  text,
  created_at timestamptz not null default now()
);

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

alter table profiles    enable row level security;
alter table drivers     enable row level security;
alter table routes      enable row level security;
alter table manifests   enable row level security;
alter table parcels     enable row level security;
alter table pod_records enable row level security;
alter table pod_photos  enable row level security;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select using (id = auth.uid() or public.is_admin());

drop policy if exists drivers_select on drivers;
create policy drivers_select on drivers for select using (auth.uid() is not null);
drop policy if exists drivers_admin_write on drivers;
create policy drivers_admin_write on drivers for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists routes_select on routes;
create policy routes_select on routes for select using (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists routes_admin_write on routes;
create policy routes_admin_write on routes for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists parcels_select on parcels;
create policy parcels_select on parcels for select
  using (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()));
drop policy if exists parcels_update on parcels;
create policy parcels_update on parcels for update
  using (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()))
  with check (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()));
drop policy if exists parcels_admin_insert on parcels;
create policy parcels_admin_insert on parcels for insert with check (public.is_admin());
drop policy if exists parcels_admin_delete on parcels;
create policy parcels_admin_delete on parcels for delete using (public.is_admin());

drop policy if exists manifests_admin_all on manifests;
create policy manifests_admin_all on manifests for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists pod_records_select on pod_records;
create policy pod_records_select on pod_records for select using (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists pod_records_insert on pod_records;
create policy pod_records_insert on pod_records for insert with check (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists pod_records_update on pod_records;
create policy pod_records_update on pod_records for update
  using (public.is_admin() or driver_id = public.auth_driver_id())
  with check (public.is_admin() or driver_id = public.auth_driver_id());

drop policy if exists pod_photos_select on pod_photos;
create policy pod_photos_select on pod_photos for select
  using (exists (select 1 from pod_records pr where pr.id = pod_id and (public.is_admin() or pr.driver_id = public.auth_driver_id())));
drop policy if exists pod_photos_insert on pod_photos;
create policy pod_photos_insert on pod_photos for insert
  with check (exists (select 1 from pod_records pr where pr.id = pod_id and (public.is_admin() or pr.driver_id = public.auth_driver_id())));

-- Lock the evidence bucket to signed-in users (was public). The dispatcher
-- reads via signed URLs.
update storage.buckets set public = false where id = 'pod-evidence';
drop policy if exists "pod evidence read" on storage.objects;
create policy "pod evidence read" on storage.objects for select
  using (bucket_id = 'pod-evidence' and auth.uid() is not null);
drop policy if exists "pod evidence upload" on storage.objects;
create policy "pod evidence upload" on storage.objects for insert
  with check (bucket_id = 'pod-evidence' and auth.uid() is not null);
