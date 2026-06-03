-- ePOD PoC: one-shot cloud setup (migration + seed combined).
-- Paste this whole file into the Supabase dashboard SQL Editor and Run.

-- ePOD PoC schema (Â§4 of the brief).
-- PoC posture: RLS is left DISABLED on these tables and the bucket is public â€”
-- there is no real auth (hardcoded demo driver). Do not ship this to prod.

create extension if not exists postgis;

-- The parcels / jobs a driver is delivering today
create table parcels (
  id              uuid primary key default gen_random_uuid(),
  tracking_number text unique not null,      -- the barcode value read off the label
  recipient_name  text not null,
  address_line    text not null,
  postcode        text,
  destination     geography(point, 4326),    -- where it *should* go
  area            text default 'Domestic'
                  check (area in ('Domestic','International','Fulfilment','Sortation')),
  status          text default 'pending'
                  check (status in ('pending','delivered','failed')),
  created_at      timestamptz default now()
);

-- One proof-of-delivery record per delivery attempt
create table pod_records (
  id              uuid primary key default gen_random_uuid(),
  parcel_id       uuid references parcels(id),
  tracking_scanned text not null,            -- what the driver actually scanned
  status          text not null check (status in ('delivered','failed')),
  failure_reason  text,                      -- required when status = failed
  received_by     text,                      -- name, or "left in porch", etc.
  captured_at     timestamptz not null,      -- device clock, at moment of capture (evidence time)
  -- Server clock = trust stamp. Rows are only ever inserted at upload time
  -- (directly when online, or by the sync worker draining the queue), so a
  -- plain default gives the server-side receive time without trusting the client.
  synced_at       timestamptz default now(),
  location        geography(point, 4326),
  gps_accuracy_m  int,
  gps_simulated   boolean default false,     -- true if the device couldn't get a real fix
  signature_path  text,                      -- storage path, nullable
  driver_id       text default 'drv_demo',
  created_at      timestamptz default now(),

  -- A failed delivery must say why (acceptance test 3 enforces this in the UI too)
  constraint failed_needs_reason check (status <> 'failed' or failure_reason is not null)
);

create index pod_records_parcel_idx on pod_records(parcel_id);

-- A POD can have multiple photos (label, where-left, etc.)
create table pod_photos (
  id            uuid primary key default gen_random_uuid(),
  pod_id        uuid references pod_records(id) on delete cascade,
  photo_type    text not null check (photo_type in ('label','where_left')),
  storage_path  text not null,
  orig_kb       int,
  compressed_kb int,

  -- One photo per type per POD; lets the sync worker upsert idempotently
  unique (pod_id, photo_type)
);

create index pod_photos_pod_idx on pod_photos(pod_id);

-- Evidence bucket. Public read keeps the dispatcher view simple (no signed
-- URLs in a PoC); uploads are allowed to this bucket only.
insert into storage.buckets (id, name, public)
values ('pod-evidence', 'pod-evidence', true)
on conflict (id) do nothing;

create policy "pod evidence read"
  on storage.objects for select
  using (bucket_id = 'pod-evidence');

create policy "pod evidence upload"
  on storage.objects for insert
  with check (bucket_id = 'pod-evidence');

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

  ('CP-300006-GB', 'Acme Home Goods â€” J. Mercer', '3 Foundry Lane, Holbeck, Leeds',             'LS11 9XE',
   st_setsrid(st_makepoint(-1.55800, 53.78900), 4326)::geography, 'Fulfilment'),

  ('CP-300007-GB', 'Tillys Toy Shop',           '27 St Giles Street, Norwich',                  'NR2 1JN',
   st_setsrid(st_makepoint(1.29230, 52.62880), 4326)::geography, 'Fulfilment'),

  ('CP-400008-GB', 'NN4 Regional Sort Hub',     'Unit 9, Saddlers Way, Northampton',            'NN4 7HD',
   st_setsrid(st_makepoint(-0.89320, 52.21510), 4326)::geography, 'Sortation');

-- Hosted-project gotcha: if RLS got enabled on these tables (dashboard
-- prompts encourage it), the anon key reads 0 rows and writes are rejected.
-- The PoC posture is RLS OFF (no auth, demo only) - enforce it explicitly:
alter table parcels     disable row level security;
alter table pod_records disable row level security;
alter table pod_photos  disable row level security;
