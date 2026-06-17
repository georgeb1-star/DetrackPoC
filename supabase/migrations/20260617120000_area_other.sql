-- Add 'Other' as a first-class parcel area: the bucket for parcels whose area
-- couldn't be auto-derived (enrichment from GWOptical) or whose manifest area
-- was unrecognised. routes.areas is an unconstrained text[] governed by the
-- frontend (src/lib/types.ts AREAS), so only parcels.area needs the new value.
alter table parcels drop constraint if exists parcels_area_check;
alter table parcels add constraint parcels_area_check
  check (area in ('South London','North London','West London','Central London','Kent','Surrey','Other'));
