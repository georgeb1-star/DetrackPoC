-- Area labels move from the PoC's coarse English regions (Greater London /
-- South East / North West — see 20260610170000_region_areas.sql) to Citipost's
-- actual delivery areas. 'Greater London' is dropped; the parcel default and
-- the manifest-import fallback (manifest.ts) move to 'South London'.
--
-- Only parcels.area carries a CHECK; routes.areas is an unconstrained text[]
-- whose allowed values are governed by the frontend (src/lib/types.ts AREAS).
alter table parcels drop constraint if exists parcels_area_check;
alter table parcels alter column area set default 'South London';

-- Remap any pre-existing rows off the retired labels so the new CHECK accepts
-- them (no-op on an empty fleet, but keeps the migration safe to apply on data).
update parcels set area = 'South London'
  where area is not null
    and area not in ('South London', 'North London', 'West London', 'Central London', 'Kent', 'Surrey');

alter table parcels add constraint parcels_area_check
  check (area in ('South London', 'North London', 'West London', 'Central London', 'Kent', 'Surrey'));
