-- Parcel lifecycle: collection → warehouse → delivered.
--
-- Each stage is a SCAN EVENT (timestamp + GPS + who), recorded by the driver
-- app: a quick scan for collection/warehouse, the full POD capture for
-- delivery. parcels.status becomes the lifecycle position itself:
--
--   awaiting_collection → collected → at_warehouse → delivered
--                                                  ↘ returned (after max
--                                                    failed attempts)
--
-- Ordering is warn-but-allow: events are recorded as scanned, even out of
-- order; the app only ever advances status FORWARD (rank guard client-side),
-- so a late-syncing collection scan can never regress a delivered parcel.

-- 1. One row per stage scan. id is the client-generated UUID — the
--    idempotency key, exactly like pod_records (a sync retry upserts the
--    same row). captured_at = device clock at the scan (evidence time);
--    synced_at = server default now() at first insert (trust stamp, never
--    sent by the client). The 'delivered' stage row is written by the POD
--    sync with id = the pod's id, so the timeline lives in one table.
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

-- RLS mirrors pod_records: a driver writes/reads only their own scans.
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

-- Realtime for the dispatcher (tolerant of re-runs / missing publication).
do $$ begin
  alter publication supabase_realtime add table parcel_events;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- 2. parcels.status becomes the lifecycle. Existing rows: 'pending' (and any
--    legacy 'failed') map to awaiting_collection — nothing has been scanned
--    yet under the new model; delivered/returned stay terminal.
--    Order matters on a live database: drop the OLD check before remapping
--    rows to values it doesn't allow (a fresh `db reset` never notices — the
--    seed runs after migrations — but a populated cloud DB does).
alter table parcels drop constraint if exists parcels_status_check;
alter table parcels alter column status set default 'awaiting_collection';
update parcels set status = 'awaiting_collection' where status in ('pending','failed');
alter table parcels add constraint parcels_status_check
  check (status in ('awaiting_collection','collected','at_warehouse','delivered','returned'));
