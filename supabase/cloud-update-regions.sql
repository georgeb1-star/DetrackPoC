-- Paste into the Supabase dashboard SQL Editor of the EXISTING cloud project
-- to switch areas from service categories to English regions (Greater London /
-- South East / North West). Mirrors migration 20260610170000 and relocates the
-- demo parcels/sites to English towns. Safe to re-run.

-- 1. Swap the area value check + remap existing rows.
alter table parcels drop constraint if exists parcels_area_check;
update parcels set area = case area
    when 'Domestic'     then 'Greater London'
    when 'International' then 'South East'
    when 'Fulfilment'   then 'North West'
    when 'Sortation'    then 'North West'
    else area
  end
  where area in ('Domestic', 'International', 'Fulfilment', 'Sortation');
alter table parcels alter column area set default 'Greater London';
alter table parcels add constraint parcels_area_check
  check (area in ('Greater London', 'South East', 'North West'));

-- 2. Rename the two functional routes to regions + align coverage.
update routes set name = 'South East', areas = array['South East'] where name = 'International & Air';
update routes set name = 'North West', areas = array['North West'] where name = 'Fulfilment & Sort';
update routes set areas = array['Greater London'] where name = 'Greater London';

-- 3. Relocate the non-English demo parcels to English towns (idempotent).
update parcels set address_line = '22 Deansgate, Manchester', postcode = 'M3 2BW',
  destination = st_setsrid(st_makepoint(-2.24860, 53.47950), 4326)::geography where tracking_number = 'CP-200004-GB';
update parcels set address_line = '8 Marine Parade, Brighton', postcode = 'BN2 1TL',
  destination = st_setsrid(st_makepoint(-0.13720, 50.81980), 4326)::geography where tracking_number = 'CP-200005-GB';
update parcels set address_line = '3 Dale Street, Liverpool', postcode = 'L2 2HF',
  destination = st_setsrid(st_makepoint(-2.98800, 53.40840), 4326)::geography where tracking_number = 'CP-300006-GB';
update parcels set address_line = '27 Deansgate, Bolton', postcode = 'BL1 1BL',
  destination = st_setsrid(st_makepoint(-2.42820, 53.57800), 4326)::geography where tracking_number = 'CP-300007-GB';
update parcels set recipient_name = 'Thames Valley Depot', address_line = 'Unit 9, Saddlers Way, Reading',
  postcode = 'RG1 1AX', destination = st_setsrid(st_makepoint(-0.97810, 51.45430), 4326)::geography
  where tracking_number = 'CP-400008-GB';

-- 4. Relocate the region-mismatched demo sites (idempotent, matches old names).
update sites set name = 'Gatwick Parcel Depot', address_line = 'Beehive Ring Road, Gatwick, Crawley',
  postcode = 'RH6 0PA', kind = 'depot', destination = st_setsrid(st_makepoint(-0.18210, 51.15370), 4326)::geography,
  route_id = (select id from routes where name = 'South East') where name = 'Heathrow Air Freight Depot';
update sites set name = 'Trafford Park Fulfilment', address_line = 'Mosley Road, Trafford Park, Manchester',
  postcode = 'M17 1AB', kind = 'both', destination = st_setsrid(st_makepoint(-2.32000, 53.46700), 4326)::geography,
  route_id = (select id from routes where name = 'North West') where name = 'Leeds Fulfilment Centre';
update sites set name = 'Citipost Collect — Reading', address_line = '5 Broad Street, Reading', postcode = 'RG1 2BH',
  destination = st_setsrid(st_makepoint(-0.97500, 51.45520), 4326)::geography where name = 'Citipost Collect — Norwich';
