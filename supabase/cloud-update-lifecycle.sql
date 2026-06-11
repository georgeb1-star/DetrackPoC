-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- after pulling the lifecycle build. Mirrors migration 20260610180000. Run it
-- AFTER the auth/RLS update (it relies on public.is_admin /
-- public.auth_driver_id). Safe to re-run.
--
-- Parcel lifecycle: collection → warehouse → delivered. Each stage is a scan
-- event (timestamp + GPS + driver); parcels.status becomes the lifecycle
-- position: awaiting_collection → collected → at_warehouse → delivered
-- (→ returned after max failed attempts).

create table if not exists parcel_events (
  id              uuid primary key,
  parcel_id       uuid references parcels(id),
  tracking_scanned text not null,
  stage           text not null check (stage in ('collection','warehouse','delivered')),
  captured_at     timestamptz not null,
  synced_at       timestamptz default now(),
  location        geography(point, 4326),
  gps_accuracy_m  int,
  gps_source      text check (gps_source in ('photo_exif','device','simulated')),
  driver_id       text references drivers(id),
  created_at      timestamptz default now()
);
create index if not exists parcel_events_parcel_idx on parcel_events(parcel_id);

alter table parcel_events enable row level security;
drop policy if exists parcel_events_select on parcel_events;
create policy parcel_events_select on parcel_events for select
  using (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists parcel_events_insert on parcel_events;
create policy parcel_events_insert on parcel_events for insert
  with check (public.is_admin() or driver_id = public.auth_driver_id());
drop policy if exists parcel_events_update on parcel_events;
create policy parcel_events_update on parcel_events for update
  using (public.is_admin() or driver_id = public.auth_driver_id())
  with check (public.is_admin() or driver_id = public.auth_driver_id());

do $$ begin
  alter publication supabase_realtime add table parcel_events;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- Order matters on a live database: the OLD check constraint must go before
-- rows are remapped to the new lifecycle values.
alter table parcels drop constraint if exists parcels_status_check;
alter table parcels alter column status set default 'awaiting_collection';
update parcels set status = 'awaiting_collection' where status in ('pending','failed');
alter table parcels add constraint parcels_status_check
  check (status in ('awaiting_collection','collected','at_warehouse','delivered','returned'));
