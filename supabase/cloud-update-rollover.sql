-- Paste into the Supabase dashboard SQL Editor of an EXISTING cloud project
-- (https://supabase.com/dashboard/project/_/sql/new) to bring it up to the
-- rollover + gps_source schema. Safe to run more than once.

alter table parcels
  add column if not exists due_date date not null default current_date;

alter table pod_records
  add column if not exists gps_source text not null default 'device'
  check (gps_source in ('photo_exif', 'device', 'simulated'));

-- Demo rollover: yesterday's leftover stop (only while it is still pending)
update parcels set due_date = current_date - 1
where tracking_number = 'CP-100003-GB' and status = 'pending';
