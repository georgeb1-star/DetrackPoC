-- Upgrade a REGION-ERA hosted ePOD database (parcels.area + routes.areas, the
-- 2026-06-10 model) up to the current COLLECT-AND-DELIVER schema described by
-- cloud-setup.sql (delivery_area/collection_area + sender block + two-dimensional
-- routes + collection_points).
--
-- Written for the project ydhypslunoybvwoslyss, whose live schema was probed on
-- 2026-07-08: everything already matches cloud-setup.sql EXCEPT the columns and
-- table added below. Idempotent and NON-DESTRUCTIVE — the legacy `area` /
-- `areas` columns are kept so the currently-deployed (region-era) app keeps
-- working until the current code is redeployed; drop them afterwards.
--
-- HOW TO APPLY: paste into the project's dashboard SQL Editor and Run.
-- Safe to re-run.

create extension if not exists postgis;

-- ── parcels: sender/origin block + delivery/collection area ──────────────────
alter table parcels add column if not exists delivery_area       text;
alter table parcels add column if not exists sender_name         text;
alter table parcels add column if not exists sender_address_line text;
alter table parcels add column if not exists sender_postcode     text;
alter table parcels add column if not exists collection_area     text;

-- Backfill delivery_area from the postcode outward prefix (UK area, e.g. "BR1
-- 5HR" -> "BR"), matching src/lib/enrich.postcodeArea. Only fills blanks.
update parcels
   set delivery_area = substring(upper(coalesce(postcode, '')) from '^[A-Z]{1,2}')
 where delivery_area is null or delivery_area = '';

-- The legacy region label lived in `area` (Greater London / South East / North
-- West) with a CHECK + default. The current code never writes `area`, so make
-- sure it can never block an insert that omits it.
alter table parcels drop constraint if exists parcels_area_check;
alter table parcels alter column area drop not null;

-- ── routes: two-dimensional coverage (collects-from / delivers-to) ───────────
alter table routes add column if not exists collection_areas text[] not null default '{}';
alter table routes add column if not exists delivery_areas   text[] not null default '{}';

-- Backfill both dimensions from the single legacy `areas` list.
update routes set delivery_areas   = areas where coalesce(array_length(delivery_areas, 1), 0) = 0 and areas is not null;
update routes set collection_areas = areas where coalesce(array_length(collection_areas, 1), 0) = 0 and areas is not null;

-- ── collection_points: display-only shop names/pins keyed on sender postcode ──
create table if not exists collection_points (
  postcode   text primary key,
  name       text,
  pin        geography(point, 4326),
  created_at timestamptz default now()
);
alter table collection_points enable row level security;
drop policy if exists collection_points_select on collection_points;
create policy collection_points_select on collection_points
  for select using (auth.uid() is not null);
drop policy if exists collection_points_admin_write on collection_points;
create policy collection_points_admin_write on collection_points
  for all using (public.is_admin()) with check (public.is_admin());
do $$ begin alter publication supabase_realtime add table collection_points;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ── re-assert admin-write RLS so the manifest seed can insert ────────────────
-- (These already exist on this project; re-asserting guarantees the coupon seed
--  — which inserts drivers/routes/manifests/parcels as an admin — succeeds.)
drop policy if exists parcels_admin_insert on parcels;
create policy parcels_admin_insert on parcels for insert with check (public.is_admin());
drop policy if exists parcels_admin_delete on parcels;
create policy parcels_admin_delete on parcels for delete using (public.is_admin());
drop policy if exists parcels_update on parcels;
create policy parcels_update on parcels for update
  using (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()))
  with check (public.is_admin() or route_id in (select id from routes where driver_id = public.auth_driver_id()));

drop policy if exists routes_admin_write on routes;
create policy routes_admin_write on routes for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists drivers_admin_write on drivers;
create policy drivers_admin_write on drivers for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists manifests_admin_all on manifests;
create policy manifests_admin_all on manifests for all using (public.is_admin()) with check (public.is_admin());

-- ── verify (optional — the SELECT prints the new shape) ──────────────────────
select 'parcels' as t, count(*) filter (where delivery_area is not null) as delivery_area_filled, count(*) as rows from parcels
union all select 'routes', count(*) filter (where array_length(delivery_areas,1) > 0), count(*) from routes;
