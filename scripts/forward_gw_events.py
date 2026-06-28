"""Forward ePOD tracking events into GWOptical's intake table.

ePOD (the driver PWA + dispatcher portal) captures four kinds of tracking
event — collection / warehouse scans (parcel_events) and delivered / failed
PODs (pod_records). This script hands each one to GWOptical the same way the
Lens "Manual Events" forwarder does: it INSERTs into the intake table
`dbo.TrackingLogExport`, and GWOptical's own 5-minute pull job maps the
CarrierCode via CarrierHub and lands the event in `dbo.TrackingLog`.

Why an intake table and not a direct TrackingLog write, how each carrier is
branded, and the full event journey: see
docs/superpowers/specs/2026-06-16-gwoptical-tracking-forwarder-design.md
and specsavers-report/docs/adr/0005-tracking-events-span-five-carriers.md.

GWOptical (sqlaggw.citipost.co.uk) sits on a private 10.x network — reachable
only from the automation host, never from Vercel/Supabase. So this runs here,
on a ~5-minute cron alongside the Lens loader/forwarder.

Two phases, each idempotent and committed per-row, so a GW link flap mid-run
leaves clean state and the next run resumes where this one stopped:

  push    ePOD events with no gw_forward_log row -> INSERT dbo.TrackingLogExport,
                                                    then record the handover
  sync    forwarded-but-not-exported rows        -> copy GW's Exported flag back

System of record: ePOD's parcel_events / pod_records (Supabase). GWOptical owns
the events once ingested. public.gw_forward_log is forwarding bookkeeping only.

Crash-safety: if the GW INSERT commits but the gw_forward_log INSERT doesn't,
the next run re-inserts the event. That duplicate is harmless — GWOptical's
intake dedupes on (CarrierCode + TrackingNumber + TrackingDateTime), so it's
ingested-but-ignored. (Same guarantee ePOD relies on internally: every write is
keyed on a client-generated UUID.)

Usage:
    cd scripts && python forward_gw_events.py [--dry-run]
"""
import os
import pathlib
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg2
import pyodbc
from dotenv import load_dotenv

LONDON = ZoneInfo("Europe/London")
ADVISORY_LOCK_KEY = 7242116003  # loader holds ...001, Lens forwarder ...002 — distinct so they never collide
DRY = "--dry-run" in sys.argv

# --- Per-carrier branding & codes ---------------------------------------------
# Each event is forwarded under its TRUE CarrierProviderName + that carrier's own
# CarrierCode, so other GWOptical consumers see the correct carrier (not a blanket
# "DHL Parcel UK").
#
# ePOD has no carrier column, so carrier is DERIVED from the tracking-number
# prefix — which mirrors GWOptical's service-based model (Lens migration 069):
# I2IAD… -> I2I, I2IOA… -> Oceanair, 7086… -> DX, everything else -> DHL. ePOD
# handles no Menzies parcels, so the "else" bucket is DHL (confirmed 2026-06-16).
#
# Codes verified against CarrierHub's code master (Audrius export, 2026-06-16);
# see Lens ADR 0005. A code of None means no CarrierHub code exists for that
# (carrier, event) yet -> the event is SKIPPED, NOT recorded as forwarded, so it
# self-heals the moment Audrius supplies one. Oceanair has no codes at all, so
# every Oceanair event is skipped.
CLIENT_REFERENCE = "EPOD"  # origin marker (Lens uses 'LENS')

CARRIER_RULES = {
    "DHL Parcel UK": {
        "collection": "CTCL",   # Driver Collection Scan
        "warehouse":  "WH10",   # In Delivering Warehouse Scan
        "delivered":  "DT15",   # Accepted at delivery point
        "failed":     "DF48",   # 48 - No Contact / Access Available
    },
    "I2I": {
        "collection": "I2I04",  # Assigned to driver (= our driver takes custody)
        "warehouse":  "I2I03",  # Arrived at hub
        "delivered":  "I2I05",  # Delivered
        "failed":     "I2I06",  # Exception
    },
    "DX": {
        "collection": "VS",     # Collected from customer
        "warehouse":  "OR",     # On the Road
        "delivered":  "V",      # Signed For (-> VL when left safe; see resolve_code)
        "failed":     "D",      # No Access
    },
    "Oceanair": {},             # no CarrierHub codes — every event suppressed
}


def derive_carrier(tracking_number):
    """GWOptical tracking number -> carrier (CarrierProviderName).

    Prefixes mirror Lens migration 069's service-based model. ePOD carries no
    Menzies parcels, so the fallback is DHL Parcel UK.
    """
    tn = (tracking_number or "").upper()
    if tn.startswith("I2IAD"):
        return "I2I"
    if tn.startswith("I2IOA"):
        return "Oceanair"
    if tn.startswith("7086"):
        return "DX"
    return "DHL Parcel UK"


def resolve_code(carrier, kind, signed):
    """CarrierCode for this (carrier, event), or None to suppress.

    DX deliveries split by evidence: a captured signature -> V (Signed For); a
    leave-safe drop (no signature) -> VL (Package Left in a Suitable Location).
    """
    code = CARRIER_RULES.get(carrier, {}).get(kind)
    if carrier == "DX" and kind == "delivered" and code == "V" and not signed:
        return "VL"
    return code

# Discover un-forwarded events. Two arms unioned so they process in time order:
#   - parcel_events stage IN (collection, warehouse). The 'delivered' parcel_event
#     (id = podId, written by the POD sync) is excluded here and forwarded once,
#     from its pod_records row.
#   - pod_records (delivered/failed), parcel-linked only (JOIN parcels excludes
#     site/store captures — those aren't parcels GWOptical tracks).
# captured_at is stored UTC; AT TIME ZONE 'Europe/London' yields the tz-naive
# UK-local datetime GWOptical expects. Lat/Lng come straight off the captured fix.
DISCOVER_SQL = """
SELECT source, source_id, tracking_number, kind, event_local, lat, lng, loc_text, info, signed
FROM (
  SELECT 'event' AS source, e.id AS source_id, p.tracking_number,
         e.stage AS kind,
         (e.captured_at AT TIME ZONE 'Europe/London') AS event_local,
         ST_Y(e.location::geometry) AS lat, ST_X(e.location::geometry) AS lng,
         COALESCE(p.postcode, p.delivery_area) AS loc_text,
         NULL::text AS info,
         NULL::boolean AS signed
  FROM parcel_events e
  JOIN parcels p ON p.id = e.parcel_id
  WHERE e.stage IN ('collection', 'warehouse')
    AND NOT EXISTS (SELECT 1 FROM gw_forward_log g
                    WHERE g.source = 'event' AND g.source_id = e.id)
  UNION ALL
  SELECT 'pod' AS source, r.id AS source_id, p.tracking_number,
         r.status AS kind,
         (r.captured_at AT TIME ZONE 'Europe/London') AS event_local,
         ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng,
         COALESCE(p.postcode, p.delivery_area) AS loc_text,
         CASE WHEN r.status = 'delivered' THEN r.received_by ELSE r.failure_reason END AS info,
         (r.signature_path IS NOT NULL) AS signed
  FROM pod_records r
  JOIN parcels p ON p.id = r.parcel_id
  WHERE r.status IN ('delivered', 'failed')
    AND NOT EXISTS (SELECT 1 FROM gw_forward_log g
                    WHERE g.source = 'pod' AND g.source_id = r.id)
) q
ORDER BY event_local
"""

INSERT_INTAKE_SQL = """
INSERT INTO dbo.TrackingLogExport
  (CarrierProviderName, TrackingNumber, ClientReference, CarrierCode,
   TrackingDate, TrackingDateTime, TrackingLocation, TrackingAdditionalInfo,
   Latitude, Longitude, AddedDate, Exported)
OUTPUT INSERTED.Id
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
"""


def log(msg: str) -> None:
    print(f"[{datetime.now(LONDON):%H:%M:%S}] {msg}", flush=True)


def clip(value, length):
    """Trim to the intake column width (defensive — ePOD text is usually short)."""
    if value is None:
        return None
    s = str(value)
    return s[:length]


def preflight_schema(cur) -> None:
    """Fail fast and legibly if the ePOD schema has drifted under DISCOVER_SQL.

    DISCOVER_SQL is raw SQL, outside the app's TypeScript types, so a renamed or
    dropped column otherwise surfaces only as a cryptic UndefinedColumn crash on
    every 5-minute tick (this is exactly how parcels.area -> delivery_area, shipped
    2026-06-19 with no migration, broke us). Planning the query with LIMIT 0
    resolves every column reference without fetching a single row — turning the
    next drift into one actionable line instead of a recurring stack trace.
    """
    try:
        cur.execute(f"SELECT 1 FROM ({DISCOVER_SQL}) _preflight LIMIT 0")
    except (psycopg2.errors.UndefinedColumn, psycopg2.errors.UndefinedTable) as e:
        detail = str(e).splitlines()[0].strip()
        sys.exit(
            "ePOD schema drift: DISCOVER_SQL references a column/table that no "
            f"longer exists -> {detail}\n"
            "Update DISCOVER_SQL in this script to match the current "
            "parcels / parcel_events / pod_records schema."
        )


def main() -> None:
    load_dotenv(pathlib.Path(__file__).with_name(".env"))

    epod_url = os.environ.get("EPOD_DATABASE_URL")
    gw_conn = os.environ.get("GWOPTICAL_CONN")
    if not epod_url:
        sys.exit("Set EPOD_DATABASE_URL in scripts/.env (the ePOD Supabase Session Pooler URI).")
    if not gw_conn:
        sys.exit("Set GWOPTICAL_CONN in scripts/.env (the GWOptical ODBC string).")

    empties = [f"{c}/{k}" for c, codes in CARRIER_RULES.items() for k, v in codes.items() if not v]
    if empties:
        sys.exit(f"Empty CarrierCode in CARRIER_RULES for: {', '.join(empties)}")

    pg = psycopg2.connect(epod_url)
    cur = pg.cursor()
    cur.execute("SELECT pg_try_advisory_lock(%s)", (ADVISORY_LOCK_KEY,))
    if not cur.fetchone()[0]:
        log("another forwarder run holds the lock; exiting")
        pg.close()
        return

    gw = None
    pushed = skipped = synced = 0
    try:
        preflight_schema(cur)  # bail with a clear message if the ePOD schema drifted
        gw = pyodbc.connect(gw_conn, timeout=15)
        gwc = gw.cursor()

        # ---- push ----
        cur.execute(DISCOVER_SQL)
        events = cur.fetchall()
        pg.commit()  # close the read transaction before per-row writes

        for source, source_id, tracking, kind, event_local, lat, lng, loc_text, info, signed in events:
            carrier = derive_carrier(tracking)
            code = resolve_code(carrier, kind, bool(signed))
            if code is None:
                skipped += 1
                log(f"skip {source} {source_id} {tracking} ({carrier}/{kind}) - no CarrierHub code")
                continue
            if DRY:
                log(f"[dry] would push {source} {source_id} {tracking} {carrier}/{kind} ({code}) @ {event_local}")
                continue
            gwc.execute(
                INSERT_INTAKE_SQL,
                carrier,                       # CarrierProviderName = the parcel's true carrier
                clip(tracking, 50),
                CLIENT_REFERENCE,
                clip(code, 100),
                event_local.date(),
                event_local,
                clip(loc_text, 200),
                clip(info, 200),
                round(float(lat), 7) if lat is not None else None,
                round(float(lng), 7) if lng is not None else None,
                datetime.now(LONDON).replace(tzinfo=None),
            )
            gw_id = gwc.fetchone()[0]
            gw.commit()
            cur.execute(
                """INSERT INTO gw_forward_log
                     (source, source_id, tracking_number, carrier_provider, carrier_code, event_at, gw_export_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (source, source_id) DO UPDATE
                     SET carrier_provider = EXCLUDED.carrier_provider,
                         carrier_code = EXCLUDED.carrier_code,
                         gw_export_id = EXCLUDED.gw_export_id, forwarded_at = now()""",
                (source, source_id, tracking, carrier, code, event_local, gw_id),
            )
            pg.commit()
            pushed += 1
            log(f"pushed {source} {source_id} {tracking} {carrier}/{kind} ({code}) -> TrackingLogExport Id {gw_id}")

        # ---- sync: copy GW's Exported flag back into the bookkeeping ----
        cur.execute(
            """SELECT source, source_id, gw_export_id FROM gw_forward_log
               WHERE exported_at IS NULL AND gw_export_id IS NOT NULL"""
        )
        for source, source_id, gw_id in cur.fetchall():
            gwc.execute(
                "SELECT Exported, ExportedDateTime FROM dbo.TrackingLogExport WHERE Id = ?", gw_id
            )
            row = gwc.fetchone()
            if DRY:
                log(f"[dry] sync {source} {source_id}: intake says {row}")
                continue
            if row is None:
                # Intake row gone (GW housekeeping after ingest) — treat as exported.
                cur.execute(
                    "UPDATE gw_forward_log SET exported_at = now() WHERE source = %s AND source_id = %s",
                    (source, source_id),
                )
                pg.commit()
                synced += 1
                log(f"sync {source} {source_id}: intake row gone, assuming ingested")
            elif row[0]:
                exported_local = row[1]  # GW datetimes are UK-local naive
                cur.execute(
                    """UPDATE gw_forward_log
                       SET exported_at = COALESCE(%s::timestamp AT TIME ZONE 'Europe/London', now())
                       WHERE source = %s AND source_id = %s""",
                    (exported_local, source, source_id),
                )
                pg.commit()
                synced += 1
                log(f"sync {source} {source_id}: exported at {exported_local}")

        log(f"done - pushed {pushed}, skipped {skipped}, synced {synced}{' (dry-run)' if DRY else ''}")
    finally:
        # Always release the advisory lock and close cleanly — a leaked lock on a
        # pooler-held session would silently wedge every later tick.
        try:
            pg.rollback()  # clear any open/aborted txn
            cur.execute("SELECT pg_advisory_unlock(%s)", (ADVISORY_LOCK_KEY,))
            pg.commit()
        except Exception:
            pass
        if gw is not None:
            try:
                gw.close()
            except Exception:
                pass
        pg.close()


if __name__ == "__main__":
    main()
