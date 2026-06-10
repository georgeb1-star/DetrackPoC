-- Apply to an existing hosted project to add the parcel completion timestamp
-- (see migrations/20260610140000_completed_at.sql). Safe to run more than once.
alter table parcels add column if not exists completed_at timestamptz;
