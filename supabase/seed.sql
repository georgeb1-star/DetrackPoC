-- Demo dataset: 3 drivers, each running one English region, and 8 parcels
-- across those regions — two left unallocated so the dispatcher's allocation
-- flow has something to do. Tracking numbers are listed in README.md for
-- type-in scanning. Parcel CP-849213-GB is the parcel shown in
-- design-reference.html.

-- Drivers. id is text to match pod_records.driver_id; drv_demo = the
-- design-reference driver, kept as the app's default identity.
insert into drivers (id, name) values
  ('drv_demo',  'Sam Okafor'),
  ('drv_priya', 'Priya Nair'),
  ('drv_dan',   'Dan Whitlock');

-- Routes — one English region per driver; `areas` is the region it covers
-- (drives auto-allocate-by-area).
insert into routes (name, driver_id, areas) values
  ('Greater London', 'drv_demo',  array['Greater London']),
  ('South East',     'drv_priya', array['South East']),
  ('North West',     'drv_dan',   array['North West']);

-- 8 parcels across the three regions (all English locations).
insert into parcels (tracking_number, recipient_name, address_line, postcode, destination, area) values
  ('CP-849213-GB', 'Meridian Logistics',          'Unit 4, Hailey Road Industrial Estate, Erith', 'DA18 4AA',
   st_setsrid(st_makepoint(0.17700, 51.48400), 4326)::geography, 'Greater London'),

  ('CP-100002-GB', 'Patricia Holloway',           '14 Larkspur Close, Maidstone',                 'ME14 9QT',
   st_setsrid(st_makepoint(0.53940, 51.28790), 4326)::geography, 'South East'),

  ('CP-100003-GB', 'Dev & Sons Hardware',         '88 Roman Road, Bethnal Green, London',         'E2 0QJ',
   st_setsrid(st_makepoint(-0.04900, 51.53090), 4326)::geography, 'Greater London'),

  ('CP-200004-GB', 'Brightwell Imports Ltd',      '22 Deansgate, Manchester',                     'M3 2BW',
   st_setsrid(st_makepoint(-2.24860, 53.47950), 4326)::geography, 'North West'),

  ('CP-200005-GB', 'Atlantique Wines (UK)',       '8 Marine Parade, Brighton',                    'BN2 1TL',
   st_setsrid(st_makepoint(-0.13720, 50.81980), 4326)::geography, 'South East'),

  ('CP-300006-GB', 'Acme Home Goods — J. Mercer', '3 Dale Street, Liverpool',                     'L2 2HF',
   st_setsrid(st_makepoint(-2.98800, 53.40840), 4326)::geography, 'North West'),

  ('CP-300007-GB', 'Tillys Toy Shop',             '27 Deansgate, Bolton',                         'BL1 1BL',
   st_setsrid(st_makepoint(-2.42820, 53.57800), 4326)::geography, 'North West'),

  ('CP-400008-GB', 'Thames Valley Depot',         'Unit 9, Saddlers Way, Reading',                'RG1 1AX',
   st_setsrid(st_makepoint(-0.97810, 51.45430), 4326)::geography, 'South East');

-- One stop left over from yesterday's run, so the ROLLOVER state is visible
-- on first load.
update parcels set due_date = current_date - 1 where tracking_number = 'CP-100003-GB';

-- Allocate by region, but leave two parcels unallocated (one South East, one
-- North West) so the dispatcher can demo manual + auto allocation. The
-- design-reference parcel and the rollover both land on Sam's run.
update parcels p set route_id = r.id
  from routes r
  where p.area = any (r.areas)
    and p.tracking_number not in ('CP-100002-GB', 'CP-300007-GB');

-- Sites: stores/depots a driver scans-and-captures at without a per-item
-- manifest. One per region route so every demo login has a site on their run,
-- plus one unallocated so the admin Sites view has an allocation to demo.
insert into sites (name, address_line, postcode, kind, destination, route_id) values
  ('Citipost Collect — Camden',  '112 Camden High Street, London',     'NW1 0LU',
   'store', st_setsrid(st_makepoint(-0.14260, 51.53900), 4326)::geography,
   (select id from routes where name = 'Greater London')),

  ('Gatwick Parcel Depot',       'Beehive Ring Road, Gatwick, Crawley', 'RH6 0PA',
   'depot', st_setsrid(st_makepoint(-0.18210, 51.15370), 4326)::geography,
   (select id from routes where name = 'South East')),

  ('Trafford Park Fulfilment',   'Mosley Road, Trafford Park, Manchester', 'M17 1AB',
   'both',  st_setsrid(st_makepoint(-2.32000, 53.46700), 4326)::geography,
   (select id from routes where name = 'North West')),

  ('Citipost Collect — Reading', '5 Broad Street, Reading',            'RG1 2BH',
   'store', st_setsrid(st_makepoint(-0.97500, 51.45520), 4326)::geography,
   null);
