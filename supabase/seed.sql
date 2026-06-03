-- Demo dataset: 8 parcels across the four areas, realistic UK addresses,
-- unique tracking numbers (also listed in README.md for type-in scanning).
-- Parcel 1 is the exact parcel shown in design-reference.html.

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
