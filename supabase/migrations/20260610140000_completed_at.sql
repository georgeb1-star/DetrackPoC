-- Completion timestamp for a parcel's terminal status (delivered / returned).
-- The driver run sheet shows only stops completed *today* and lets older
-- completed stops drop off the page so it doesn't grow unbounded — the rows
-- stay in the table (still queryable and exportable), they're just hidden from
-- the run once the day rolls over. Set by the app at sync when a stop goes
-- terminal; null while a parcel is still pending (incl. failed re-attempts).
alter table parcels add column if not exists completed_at timestamptz;
