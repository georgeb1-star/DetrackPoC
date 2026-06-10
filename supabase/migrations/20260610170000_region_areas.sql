-- Areas become English delivery REGIONS, not service categories.
--   Domestic    → Greater London
--   International→ South East
--   Fulfilment  → North West
--   Sortation   → North West
-- A region is also the name of the route that runs it. This migration brings an
-- already-seeded database to the new model; a fresh `db reset` gets the regions
-- straight from seed.sql. Idempotent — safe to re-run.

-- Drop the old value check so we can rewrite the column.
alter table parcels drop constraint if exists parcels_area_check;

-- Remap existing rows (only the old values — re-runs leave regions untouched).
update parcels set area = case area
    when 'Domestic'     then 'Greater London'
    when 'International' then 'South East'
    when 'Fulfilment'   then 'North West'
    when 'Sortation'    then 'North West'
    else area
  end
  where area in ('Domestic', 'International', 'Fulfilment', 'Sortation');

-- New default + region check.
alter table parcels alter column area set default 'Greater London';
alter table parcels add constraint parcels_area_check
  check (area in ('Greater London', 'South East', 'North West'));

-- Rename the two functional routes to regions + align their coverage. On a
-- fresh reset routes are seeded later (already named), so these no-op there.
update routes set name = 'South East', areas = array['South East']
  where name = 'International & Air';
update routes set name = 'North West', areas = array['North West']
  where name = 'Fulfilment & Sort';
update routes set areas = array['Greater London']
  where name = 'Greater London';
