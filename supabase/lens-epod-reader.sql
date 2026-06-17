-- Lens-side objects the ePOD `enrich-shipments` Edge Function depends on.
--
-- IMPORTANT: this DDL is applied to the **Lens / specsavers-report** Supabase
-- project (ref `eivbxinppkwhqtglusmh`), NOT to ePOD. It lives in this repo only
-- as the version-controlled source of truth for the cross-project read path, so
-- the security scoping below is visible, auditable, and survives view edits.
-- Applied 2026-06-17. If you change the view, change it HERE and re-apply.
--
-- Security boundary (why this is shaped the way it is):
--   * `epod_reader` is a dedicated LOGIN role with NO superuser / createdb /
--     createrole and (deliberately) NO bypassrls. It has SELECT on the VIEW
--     ONLY — never on the base `public.shipments` table.
--   * `epod_shipment_lookup` is a plain (owner-evaluated, i.e. NOT
--     security_invoker) view owned by a role that clears `shipments`' RLS, so
--     `epod_reader` can read through it despite the base table's RLS.
--   * The view enforces BOTH scopings the function relies on:
--       - COLUMN scope: only the 9 recipient fields the function needs — no
--         phone / email / tax / IOSS / sender / return-to columns.
--       - ROW scope: `where is_deleted = false` excludes soft-deleted shipments
--         (stale / withdrawn jobs whose PII must not resurface).
--   The `enrich-shipments` function comments point back to this file.

-- Read-only role. Password is set out-of-band and stored ONLY in the ePOD
-- function secret `LENS_DB_URL`; it is intentionally NOT committed here.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'epod_reader') then
    create role epod_reader login password '<set-out-of-band>'
      nosuperuser nocreatedb nocreaterole;
  end if;
end $$;

-- The role reaches data only through the view — never the base table.
revoke select on public.shipments from epod_reader;
grant usage on schema public to epod_reader;

create or replace view public.epod_shipment_lookup as
  select tracking_number,
         recipient_full_name, recipient_company,
         recipient_address1, recipient_address2, recipient_address3,
         recipient_city, recipient_county, recipient_postcode
  from public.shipments
  where is_deleted = false;        -- row scope: exclude soft-deleted shipments

grant select on public.epod_shipment_lookup to epod_reader;
