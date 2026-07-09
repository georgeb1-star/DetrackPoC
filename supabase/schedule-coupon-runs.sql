-- Phase 3 auto-scheduling: regenerate the coupon MON/WED/FRI runs UNATTENDED.
-- A Postgres function (the SQL port of the verified scripts/generate-coupon-runs.mjs)
-- scheduled daily with pg_cron. The stop template is read back from existing
-- coupon parcels (meta.source = 'coupon-pilot'), deduped to one stop per shop
-- (base tracking CPN-{CUST}-{SHOP}); each run's parcels are dated (-YYMMDD) and
-- inserted ON CONFLICT DO NOTHING, so a run already created — or partway through
-- delivery — is never disturbed. The driver app only shows due_date <= today,
-- so pre-generating a small buffer of upcoming service days is safe.
--
-- HOW TO APPLY: paste into the ydhy dashboard SQL Editor and Run. Safe to re-run.
-- After step 1 you can test with step 2 before the schedule in step 3 goes live.

-- ── 1) generator function ────────────────────────────────────────────────────
create or replace function public.generate_coupon_runs(
  p_days        int   default 3,                     -- upcoming service days to ensure exist
  p_weekdays    int[] default array[1, 3, 5],        -- ISO dow: 1=Mon .. 7=Sun (coupons = MON/WED/FRI)
  p_seed_status text  default 'awaiting_collection'  -- full collect→warehouse→deliver lifecycle
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  d          date := current_date;
  found      int  := 0;   -- service days handled so far
  made       int  := 0;   -- new parcels created
  cnt        int;
  v_manifest uuid;
begin
  while found < p_days loop
    if (extract(isodow from d)::int = any (p_weekdays)) then
      found := found + 1;

      -- Manifest per run date (manifests.name has no unique constraint → check then insert).
      select id into v_manifest from manifests where name = 'Coupons ' || d limit 1;
      if v_manifest is null then
        insert into manifests (name, reference, source_filename)
        values ('Coupons ' || d, 'coupon-pilot', 'generate_coupon_runs()')
        returning id into v_manifest;
      end if;

      -- Ensure this day's parcels exist — one per shop — idempotently.
      with tmpl as (
        select distinct on (regexp_replace(tracking_number, '-[0-9]{6}$', ''))
               regexp_replace(tracking_number, '-[0-9]{6}$', '') as base,
               recipient_name, address_line, postcode, destination,
               delivery_area, collection_area,
               sender_name, sender_address_line, sender_postcode,
               route_id, meta
        from parcels
        where meta->>'source' = 'coupon-pilot'
        order by regexp_replace(tracking_number, '-[0-9]{6}$', ''), created_at
      ),
      ins as (
        insert into parcels (
          tracking_number, recipient_name, address_line, postcode, destination,
          delivery_area, collection_area, sender_name, sender_address_line,
          sender_postcode, status, due_date, route_id, manifest_id, meta
        )
        select base || '-' || to_char(d, 'YYMMDD'),
               recipient_name, address_line, postcode, destination,
               delivery_area, collection_area, sender_name, sender_address_line,
               sender_postcode, p_seed_status, d, route_id, v_manifest, meta
        from tmpl
        on conflict (tracking_number) do nothing
        returning 1
      )
      select count(*) into cnt from ins;
      made := made + cnt;
    end if;
    d := d + 1;
  end loop;
  return made;
end;
$$;

-- Cron/owner only — never callable by app (authenticated/anon) users.
revoke all on function public.generate_coupon_runs(int, int[], text) from public;

-- ── 2) test it now (safe/idempotent — returns the count of NEW parcels) ──────
-- Run this line on its own first to confirm the function works:
--   select public.generate_coupon_runs();
-- (Expect 0 if today + the next service days already exist, or a multiple of 64
--  for any not-yet-generated days.)

-- ── 3) schedule daily via pg_cron ────────────────────────────────────────────
create extension if not exists pg_cron;   -- or enable via Dashboard → Database → Extensions
-- 05:00 UTC daily (≈06:00 UK in summer); the function no-ops on non-service
-- weekdays. Re-running with the same job name updates it (idempotent).
select cron.schedule('coupon-runs-daily', '0 5 * * *', $$select public.generate_coupon_runs();$$);

-- Manage / inspect:
--   select jobid, schedule, command, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 5;
--   select cron.unschedule('coupon-runs-daily');
