-- Ad-hoc collection: a driver scans an item that was never pre-alerted, so there
-- is no parcel to match. Each scan becomes a first-class parcel at status
-- 'collected', tied to a route, so it flows through the normal lifecycle /
-- dispatcher view / tracking export.
--
-- TWO ways in (2026-07-13):
--   1. At a DEPOT — pass p_site_id; the route is derived from the site.
--   2. Off the run's Scan-label sheet — a barcode scanned in Collect mode that
--      isn't on the driver's run; pass p_route_id (the driver's current run).
-- If BOTH are null the RPC falls back to the driver's own route, but only when
-- that's unambiguous (exactly one route) — otherwise it asks for a route.
--
-- PICKUP-CLAIM (2026-07-13): the scanned barcode is usually ALREADY in the
-- system (imported unallocated) — Dave's Specsavers/returns case. When it is,
-- we CLAIM it onto the driver's run (set route_id if unallocated) and move it to
-- 'collected', so the driver can capture a full POD at drop-off. A parcel that's
-- already on another driver's route is never stolen (rejected). A barcode not in
-- the system at all is created fresh on the driver's run (the rare own-label
-- case). Either way the driver ends up with the parcel on their run.
--
-- Drivers can't insert parcels directly (parcels_admin_insert is admin-only, by
-- design). This SECURITY DEFINER RPC does the insert on the driver's behalf AFTER
-- checking they run the resolved route — the same pattern as advance_parcel_status
-- / apply_failed_attempt (privileged writes centralised behind a guarded RPC).
--
-- Idempotent twice over: ON CONFLICT (tracking_number) never duplicates a parcel
-- for a re-scanned barcode, and the collection event is keyed on the client id.
--
-- Apply in the ydhy dashboard SQL Editor. Safe to re-run.

-- Drop the previous depot-only signature so only the generalised one remains
-- (avoids a PostgREST overload-ambiguity if both were present).
drop function if exists public.create_adhoc_parcel(uuid, text, uuid, timestamptz, double precision, double precision, int, text);

create or replace function public.create_adhoc_parcel(
  p_id          uuid,               -- client-minted id (idempotency key); becomes the parcel + event id
  p_tracking    text,               -- scanned barcode
  p_site_id     uuid,               -- depot the item was collected at (null on the Scan-label path)
  p_captured_at timestamptz,
  p_lng         double precision default null,
  p_lat         double precision default null,
  p_accuracy_m  int              default null,
  p_gps_source  text             default null,
  p_route_id    uuid             default null  -- route the ad-hoc parcel joins (Scan-label path)
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_route          uuid;
  v_site_name      text;
  v_driver         text := public.auth_driver_id();
  v_parcel         uuid;
  v_created        boolean := false;
  v_geo            geography(point, 4326);
  v_existing_route uuid;
begin
  -- Resolve the route: depot site > explicit route > the driver's own route.
  if p_site_id is not null then
    select route_id, name into v_route, v_site_name from sites where id = p_site_id;
    if v_route is null then
      raise exception 'adhoc: unknown site %', p_site_id using errcode = 'P0002';
    end if;
  elsif p_route_id is not null then
    v_route := p_route_id;
  else
    -- No site and no route given: infer the driver's route, but only if there's
    -- exactly one (otherwise it's ambiguous — make the caller be explicit).
    if (select count(*) from routes where driver_id = v_driver) <> 1 then
      raise exception 'adhoc: cannot infer a route (none, or more than one) — specify a route'
        using errcode = '22023';
    end if;
    select id into v_route from routes where driver_id = v_driver;
  end if;

  -- The caller must run this route (admins may collect for any).
  if not public.is_admin()
     and v_route not in (select id from routes where driver_id = v_driver) then
    raise exception 'adhoc: route % is not on your run', v_route using errcode = '42501';
  end if;

  -- Fix from the scan, else the depot's own pin (depot path only), else none.
  v_geo := case
    when p_lng is not null and p_lat is not null
      then st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
    when p_site_id is not null
      then (select destination from sites where id = p_site_id)
    else null
  end;

  -- Create the parcel at 'collected'. Recipient/address are placeholders — an
  -- ad-hoc item's onward destination (DX/DHL) isn't known at collection.
  insert into parcels (
    id, tracking_number, recipient_name, address_line, destination,
    status, due_date, route_id, meta
  ) values (
    p_id, p_tracking, 'Ad-hoc collection',
    case when v_site_name is not null then 'Collected at ' || v_site_name else 'Collected ad-hoc' end,
    v_geo, 'collected', current_date, v_route,
    jsonb_build_object(
      'source', 'ad-hoc', 'site_id', p_site_id, 'site_name', v_site_name,
      'route_id', v_route, 'collected_at', p_captured_at, 'collected_by', v_driver)
  )
  on conflict (tracking_number) do nothing;

  if found then
    v_created := true;
    v_parcel  := p_id;
  else
    -- Already in the system: claim it onto this run if it isn't on a route yet,
    -- and move it forward to 'collected' so the driver can POD it at drop-off.
    select id, route_id into v_parcel, v_existing_route from parcels where tracking_number = p_tracking;
    -- Never steal a parcel that's already on another driver's route.
    if v_existing_route is not null and v_existing_route <> v_route and not public.is_admin() then
      raise exception 'adhoc: % is already on another route', p_tracking using errcode = '42501';
    end if;
    if v_existing_route is null then
      update parcels set route_id = v_route where id = v_parcel;
    end if;
    -- Forward-only: awaiting_collection is the only status below 'collected',
    -- so this advances a fresh parcel and leaves an already-moving one alone.
    update parcels set status = 'collected' where id = v_parcel and status = 'awaiting_collection';
  end if;

  -- Log the collection scan on the timeline (GPS + time), idempotent on p_id.
  insert into parcel_events (
    id, parcel_id, tracking_scanned, stage, captured_at,
    location, gps_accuracy_m, gps_source, driver_id
  ) values (
    p_id, v_parcel, p_tracking, 'collection', p_captured_at,
    v_geo, p_accuracy_m, p_gps_source, v_driver
  )
  on conflict (id) do nothing;

  return jsonb_build_object('parcel_id', v_parcel, 'created', v_created);
end;
$$;

-- App users only via the guarded RPC; anon can't reach it, and no one gets a
-- raw parcels insert.
revoke all on function public.create_adhoc_parcel(uuid, text, uuid, timestamptz, double precision, double precision, int, text, uuid) from public;
grant execute on function public.create_adhoc_parcel(uuid, text, uuid, timestamptz, double precision, double precision, int, text, uuid) to authenticated;
