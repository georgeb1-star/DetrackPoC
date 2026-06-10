-- Demo dataset: 3 drivers each running one route, and 8 parcels across the
-- four areas allocated across those routes — two left unallocated so the
-- dispatcher's allocation flow has something to do. Tracking numbers are also
-- listed in README.md for type-in scanning. Parcel CP-849213-GB is the exact
-- parcel shown in design-reference.html.

-- Drivers. id is text to match pod_records.driver_id; drv_demo = the
-- design-reference driver, kept as the app's default identity.
insert into drivers (id, name) values
  ('drv_demo',  'Sam Okafor'),
  ('drv_priya', 'Priya Nair'),
  ('drv_dan',   'Dan Whitlock');

-- Routes — one per driver, each covering one or more areas.
insert into routes (name, driver_id, areas) values
  ('Greater London',     'drv_demo',  array['Domestic']),
  ('International & Air', 'drv_priya', array['International']),
  ('Fulfilment & Sort',  'drv_dan',   array['Fulfilment', 'Sortation']);

insert into parcels (tracking_number, recipient_name, address_line, postcode, destination, area) values
  ('CP-849213-GB', 'Meridian Logistics',        'Unit 4, Hailey Road Industrial Estate, Erith', 'DA18 4AA',
   st_setsrid(st_makepoint(0.17700, 51.48400), 4326)::geography, 'Domestic'),

  ('CP-100002-GB', 'Patricia Holloway',         '14 Larkspur Close, Maidstone',                 'ME14 9QT',
   st_setsrid(st_makepoint(0.53940, 51.28790), 4326)::geography, 'Domestic'),

  ('CP-100003-GB', 'Dev & Sons Hardware',       '88 Roman Road, Bethnal Green, London',         'E2 0QJ',
   st_setsrid(st_makepoint(-0.04900, 51.53090), 4326)::geography, 'Domestic'),

  ('CP-200004-GB', 'Brightwell Imports Ltd',    '22 Queen Street, Edinburgh',                   'EH2 1JX',
   st_setsrid(st_makepoint(-3.19900, 55.95330), 4326)::geography, 'International'),

  ('CP-200005-GB', 'Atlantique Wines (UK)',     '8 Harbour View, Cardiff Bay, Cardiff',         'CF10 5BZ',
   st_setsrid(st_makepoint(-3.16400, 51.46400), 4326)::geography, 'International'),

  ('CP-300006-GB', 'Acme Home Goods — J. Mercer', '3 Foundry Lane, Holbeck, Leeds',             'LS11 9XE',
   st_setsrid(st_makepoint(-1.55800, 53.78900), 4326)::geography, 'Fulfilment'),

  ('CP-300007-GB', 'Tillys Toy Shop',           '27 St Giles Street, Norwich',                  'NR2 1JN',
   st_setsrid(st_makepoint(1.29230, 52.62880), 4326)::geography, 'Fulfilment'),

  ('CP-400008-GB', 'NN4 Regional Sort Hub',     'Unit 9, Saddlers Way, Northampton',            'NN4 7HD',
   st_setsrid(st_makepoint(-0.89320, 52.21510), 4326)::geography, 'Sortation');

-- One stop left over from yesterday's run, so the ROLLOVER state is visible
-- on first load.
update parcels set due_date = current_date - 1 where tracking_number = 'CP-100003-GB';

-- Allocate by area, but leave two parcels unallocated (one Domestic, one
-- Fulfilment) so the dispatcher can demo manual + auto allocation. The
-- design-reference parcel and the rollover both land on Sam's run.
update parcels p set route_id = r.id
  from routes r
  where p.area = any (r.areas)
    and p.tracking_number not in ('CP-100002-GB', 'CP-300007-GB');

-- Sites: stores/depots a driver scans-and-captures at without a per-item
-- manifest. One per route so every demo login has a site on their run, plus
-- one unallocated so the admin Sites view has an allocation to demo.
insert into sites (name, address_line, postcode, kind, destination, route_id) values
  ('Citipost Collect — Camden',  '112 Camden High Street, London',     'NW1 0LU',
   'store', st_setsrid(st_makepoint(-0.14260, 51.53900), 4326)::geography,
   (select id from routes where name = 'Greater London')),

  ('Heathrow Air Freight Depot', 'Shoreham Road East, Hounslow',       'TW6 3UA',
   'depot', st_setsrid(st_makepoint(-0.44640, 51.46070), 4326)::geography,
   (select id from routes where name = 'International & Air')),

  ('Leeds Fulfilment Centre',    '40 Whitehall Road, Leeds',           'LS12 1BE',
   'both',  st_setsrid(st_makepoint(-1.56230, 53.79280), 4326)::geography,
   (select id from routes where name = 'Fulfilment & Sort')),

  ('Citipost Collect — Norwich', '5 Gentlemans Walk, Norwich',         'NR2 1NA',
   'store', st_setsrid(st_makepoint(1.29310, 52.62850), 4326)::geography,
   null);
