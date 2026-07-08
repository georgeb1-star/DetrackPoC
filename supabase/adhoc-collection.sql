-- Ad-hoc collection (meeting ask #2 — the Scotland/Menzies case): a driver at a
-- DEPOT scans items that were never pre-alerted. Each scan becomes a first-class
-- parcel at status 'collected', tied to the depot's route, so it flows through
-- the normal lifecycle / dispatcher view / tracking export.
--
-- Drivers can't insert parcels directly (parcels_admin_insert is admin-only, by
-- design). This SECURITY DEFINER RPC does the insert on the driver's behalf AFTER
-- checking they run the site's route — the same pattern as advance_parcel_status
-- / apply_failed_attempt (privileged writes centralised behind a guarded RPC).
--
-- Idempotent twice over: ON CONFLICT (tracking_number) never duplicates a parcel
-- for a re-scanned barcode, and the collection event is keyed on the client id.
--
-- Apply in the ydhy dashboard SQL Editor. Safe to re-run.

create or replace function public.create_adhoc_parcel(
  p_id          uuid,               -- client-minted id (idempotency key); becomes the parcel + event id
  p_tracking    text,               -- scanned barcode
  p_site_id     uuid,               -- depot the item was collected at
  p_captured_at timestamptz,
  p_lng         double precision default null,
  p_lat         double precision default null,
  p_accuracy_m  int              default null,
  p_gps_source  text             default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_route     uuid;
  v_site_name text;
  v_driver    text := public.auth_driver_id();
  v_parcel    uuid;
  v_created   boolean := false;
  v_geo       geography(point, 4326);
begin
  -- Resolve the depot and its route.
  select route_id, name into v_route, v_site_name from sites where id = p_site_id;
  if v_route is null then
    raise exception 'adhoc: unknown site %', p_site_id using errcode = 'P0002';
  end if;

  -- The caller must run this route (admins may collect for any).
  if not public.is_admin()
     and v_route not in (select id from routes where driver_id = v_driver) then
    raise exception 'adhoc: site % is not on your route', p_site_id using errcode = '42501';
  end if;

  -- Fix from the scan, else fall back to the depot's own pin.
  v_geo := case
    when p_lng is not null and p_lat is not null
      then st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
    else (select destination from sites where id = p_site_id)
  end;

  -- Create the parcel at 'collected'. Recipient/address are placeholders — an
  -- ad-hoc item's onward destination (DX/DHL) isn't known at collection.
  insert into parcels (
    id, tracking_number, recipient_name, address_line, destination,
    status, due_date, route_id, meta
  ) values (
    p_id, p_tracking, 'Ad-hoc collection', 'Collected at ' || v_site_name, v_geo,
    'collected', current_date, v_route,
    jsonb_build_object(
      'source', 'ad-hoc', 'site_id', p_site_id, 'site_name', v_site_name,
      'collected_at', p_captured_at, 'collected_by', v_driver)
  )
  on conflict (tracking_number) do nothing;

  if found then
    v_created := true;
    v_parcel  := p_id;
  else
    select id into v_parcel from parcels where tracking_number = p_tracking;
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
revoke all on function public.create_adhoc_parcel(uuid, text, uuid, timestamptz, double precision, double precision, int, text) from public;
grant execute on function public.create_adhoc_parcel(uuid, text, uuid, timestamptz, double precision, double precision, int, text) to authenticated;
