// Phase 4 — printable LABELS for the coupon runs. Renders one label per shop
// (Freight-Modern style, matching public/label-TJOB-0004-GB.html) with a CODE128
// barcode + QR of the parcel's tracking number, so the real packs can be scanned
// in testing until Audrius's real coupon-pack barcode makeup lands.
//
// Reads the live parcels (so the printed barcode == the seeded tracking_number,
// which the driver app resolves to that exact stop). One HTML sheet per route.
//
//   node scripts/generate-coupon-labels.mjs [URL] [KEY]
//   env: DATE=YYYY-MM-DD (run to label; default today), OUTDIR (default coupon-labels/)
//
// Output goes to a git-ignored local folder (NOT public/) — the labels carry
// real shop addresses and public/ is served unauthenticated. Open the .html in a
// browser to scan off-screen, or Ctrl+P to print.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const DATE = process.env.DATE || new Date().toISOString().slice(0, 10)
const OUTDIR = process.env.OUTDIR || 'coupon-labels'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One label card. `p` is a parcel row; `route` is its route name. */
function labelCard(p, route) {
  const m = p.meta || {}
  const customer = m.customer || p.recipient_name
  const shop = m.shop ? `Shop ${esc(m.shop)}` : ''
  return `    <article class="label" data-tn="${esc(p.tracking_number)}">
      <div class="head"><div class="brand">CITI<span>POST</span></div><div class="svc">Coupons · ePOD</div></div>
      <div class="underline"></div>
      <div class="to">
        <div class="k">Deliver to</div>
        <div class="who">${esc(customer)}</div>
        <div class="addr">${esc(p.address_line)}</div>
        <div class="pc">${esc(p.postcode || '')}</div>
      </div>
      <div class="meta"><span class="region">${esc(route)}</span><span>${shop}</span></div>
      <div class="codes"><svg class="bc"></svg><div class="qr"></div></div>
      <div class="tn">${esc(p.tracking_number)}</div>
    </article>`
}

function sheetHtml(route, date, parcels) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Coupon labels — ${esc(route)} · ${esc(date)}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;600;700&family=IBM+Plex+Mono:wght@600&display=swap" rel="stylesheet">
<style>
  :root { --chrome:#0e1218; --ultra:#2d5bff; --amber:#f5a30b; --amber-soft:#ffce6b; --ink:#101620; --muted:#5b6573; --line:rgba(13,19,32,.14); }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 16px 60px; background:#e7eaf0; background-image:radial-gradient(rgba(13,19,32,.07) 1px,transparent 1px); background-size:22px 22px; font-family:Barlow,-apple-system,'Segoe UI',sans-serif; color:var(--ink); }
  .intro { max-width:760px; margin:0 auto 20px; text-align:center; }
  .intro h1 { font-family:'Barlow Condensed','Arial Narrow',sans-serif; font-size:24px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 6px; color:var(--chrome); }
  .intro p { margin:0; font-size:13px; color:var(--muted); line-height:1.6; }
  .sheet { display:flex; flex-wrap:wrap; gap:16px; justify-content:center; }
  .label { width:360px; background:#fff; border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:0 1px 2px rgba(13,19,32,.05),0 18px 40px -18px rgba(13,19,32,.35); break-inside:avoid; }
  .head { background:var(--chrome); background-image:radial-gradient(120% 200% at 85% -50%,#1d2d56 0%,#0e1218 55%); color:#fff; padding:9px 14px; display:flex; justify-content:space-between; align-items:center; }
  .brand { font-family:'Barlow Condensed',sans-serif; font-weight:700; font-size:16px; letter-spacing:2px; text-transform:uppercase; }
  .brand span { color:var(--amber-soft); }
  .svc { font-size:9px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:var(--amber-soft); }
  .underline { height:3px; background:linear-gradient(90deg,var(--amber),transparent); }
  .to { padding:11px 14px 9px; border-bottom:1px dashed var(--line); }
  .k { font-size:9px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:var(--muted); }
  .who { font-family:'Barlow Condensed',sans-serif; font-weight:700; font-size:20px; letter-spacing:.4px; margin-top:2px; }
  .addr { font-size:12.5px; color:#38415a; margin-top:2px; line-height:1.45; }
  .pc { font-family:'IBM Plex Mono',monospace; font-size:15px; font-weight:600; letter-spacing:2px; margin-top:4px; }
  .meta { display:flex; justify-content:space-between; align-items:center; padding:7px 14px; border-bottom:1px dashed var(--line); font-size:10px; font-weight:700; letter-spacing:1.1px; text-transform:uppercase; color:var(--muted); }
  .region { color:var(--chrome); border:1px solid rgba(245,163,11,.55); background:rgba(245,163,11,.12); border-radius:999px; padding:2px 9px; }
  .codes { display:flex; align-items:center; gap:12px; padding:11px 14px 4px; }
  .codes .bc { flex:1; max-width:220px; }
  .qr { flex:none; padding:3px; border:1px solid var(--line); border-radius:6px; }
  .tn { text-align:center; font-family:'IBM Plex Mono',monospace; font-size:14px; font-weight:600; letter-spacing:2px; color:var(--ultra); padding:2px 0 12px; }
  @media print { body { background:#fff; padding:6mm; } .intro { display:none; } .label { box-shadow:none; } }
</style></head>
<body>
  <div class="intro">
    <h1>Coupon labels · ${esc(route)} · ${esc(date)}</h1>
    <p>${parcels.length} drops. Open the driver app → <b>Scan label</b> and point the camera at a barcode or QR (scanning off-screen works), or Ctrl+P to print. Interim <b>CPN-…</b> codes — swap for the real coupon-pack barcode once confirmed.</p>
  </div>
  <div class="sheet">
${parcels.map((p) => labelCard(p, route)).join('\n')}
  </div>
<script>
  document.querySelectorAll('.label').forEach((el) => {
    const tn = el.dataset.tn
    try { JsBarcode(el.querySelector('.bc'), tn, { format:'CODE128', width:1.6, height:50, displayValue:false, margin:0 }) } catch (e) {}
    new QRCode(el.querySelector('.qr'), { text: tn, width:66, height:66, correctLevel: QRCode.CorrectLevel.M })
  })
</script>
</body></html>`
}

async function main() {
  const env = Object.fromEntries(
    (() => { try { return readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')) } catch { return [] } })()
      .map((l) => l.split('=', 2).map((s) => s.trim())),
  )
  const URL = positionals[0] || process.env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const KEY = positionals[1] || process.env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!URL || !KEY) { console.error('Need <URL> <KEY>.'); process.exitCode = 1; return }
  const db = createClient(URL, KEY, { auth: { persistSession: false } })
  const { error: authErr } = await db.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL || 'admin@citipost.test', password: process.env.ADMIN_PASSWORD || 'citipost',
  })
  if (authErr) console.log(`(admin sign-in skipped: ${authErr.message} — assuming service_role key)`)

  const { data: routes } = await db.from('routes').select('id,name')
  const routeName = Object.fromEntries((routes || []).map((r) => [r.id, r.name]))
  const { data: parcels, error } = await db.from('parcels')
    .select('tracking_number,recipient_name,address_line,postcode,route_id,meta,due_date')
    .eq('meta->>source', 'coupon-pilot').eq('due_date', DATE)
    .order('route_id').order('tracking_number')
  if (error) { console.error('parcel read failed:', error.message); process.exitCode = 1; return }
  if (!parcels.length) { console.error(`No coupon parcels for ${DATE}. Seed/generate that run first.`); process.exitCode = 1; return }

  const byRoute = {}
  for (const p of parcels) (byRoute[routeName[p.route_id] || 'Unrouted'] ??= []).push(p)

  mkdirSync(OUTDIR, { recursive: true })
  for (const [route, rows] of Object.entries(byRoute)) {
    const file = join(OUTDIR, `coupon-labels-${route}-${DATE}.html`)
    writeFileSync(file, sheetHtml(route, DATE, rows))
    console.log(`  ${file}  (${rows.length} labels)`)
  }
  console.log(`\nDone — ${parcels.length} labels for ${DATE} across ${Object.keys(byRoute).length} route(s).`)
}

await main()
