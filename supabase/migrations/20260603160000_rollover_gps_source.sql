-- Rollover + GPS provenance.
--
-- due_date: the run a parcel belongs to. A parcel still 'pending' after its
-- due date is a ROLLOVER — derived in the app (pending AND due_date < today),
-- no overnight job to run or fail. It sorts to the top of the next day's run.
alter table parcels
  add column if not exists due_date date not null default current_date;

-- gps_source: where the fix on a POD came from, most→least trustworthy:
--   photo_exif — embedded in the photo by the camera itself
--   device     — live geolocation at capture time
--   simulated  — demo fallback (gps_simulated stays for compatibility)
alter table pod_records
  add column if not exists gps_source text not null default 'device'
  check (gps_source in ('photo_exif', 'device', 'simulated'));
