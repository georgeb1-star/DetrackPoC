-- Sites: stores/depots delivered to WITHOUT a per-item manifest. A driver can
-- scan items and capture proof against the site (no pre-loaded parcel). A site
-- can be a store, a depot, or both. Sites are allocated to a route like parcels
-- so they appear on a driver's run.
--
-- RLS mirrors parcels (assumes ..._auth_profiles_rls ran first): admins manage
-- every site; a driver sees only sites on their own route(s). A capture against
-- a site is a normal pod_records row (driver_id = the driver) with site_id set
-- and parcel_id null — already covered by the pod_records driver_id policies.

create table if not exists sites (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  address_line text,
  postcode     text,
  kind         text not null default 'store' check (kind in ('store','depot','both')),
  destination  geography(point, 4326),
  route_id     uuid references routes(id),
  created_at   timestamptz default now()
);
create index if not exists sites_route_idx on sites(route_id);

-- A POD can be captured against a site instead of a manifested parcel.
alter table pod_records add column if not exists site_id uuid references sites(id);
create index if not exists pod_records_site_idx on pod_records(site_id);

alter table sites enable row level security;

-- admins: all sites; a driver: only sites on their route(s).
create policy sites_select on sites for select
  using (public.is_admin()
         or route_id in (select id from routes where driver_id = public.auth_driver_id()));
create policy sites_admin_write on sites for all
  using (public.is_admin()) with check (public.is_admin());

-- Live updates for the Sites view / driver run.
do $$ begin
  alter publication supabase_realtime add table sites;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
