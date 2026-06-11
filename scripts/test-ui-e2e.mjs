// Comprehensive UI end-to-end suite, driven through real Chrome: dispatcher
// imports + allocates a manifest, a driver runs the full lifecycle (including
// failures, offline, bad scans), a second driver proves isolation, and the
// dispatcher reviews + exports. Asserts at every step; exits non-zero on any
// failure. Run with dev server + local stack up, auth seeded, and a fresh DB:
//   node scripts/make-sample-manifest.mjs "%TEMP%\sample-manifest.xlsx"
//   node scripts/test-ui-e2e.mjs
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.argv[2] ?? 'http://localhost:5190'
const TEMP = process.env.TEMP ?? '.'
const MANIFEST = path.join(TEMP, 'sample-manifest.xlsx')
const PHOTO = path.resolve('public', 'i2i-logo.png')
const DOWNLOADS = path.join(TEMP, 'epod-e2e-downloads')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` -- ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })

// On any uncaught failure: screenshot every page + dump its text for triage
process.on('uncaughtException', (e) => diagnose(e))
process.on('unhandledRejection', (e) => diagnose(e))
async function diagnose(err) {
  console.error(String(err).split('\n')[0])
  try {
    const pages = await browser.pages()
    for (const [i, p] of pages.entries()) {
      await p.screenshot({ path: path.join(TEMP, `e2e-fail-${i}.png`) }).catch(() => {})
      const text = await p.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '')
      console.error(`--- page ${i} (${p.url()}):\n${text}`)
    }
  } catch {}
  process.exit(1)
}

function helpers(page) {
  const clickText = async (sel, text) => {
    await page.waitForFunction(
      (s, t) => [...document.querySelectorAll(s)].some((el) => el.textContent.trim() === t),
      { timeout: 25000 },
      sel,
      text,
    )
    await page.evaluate(
      (s, t) => [...document.querySelectorAll(s)].find((el) => el.textContent.trim() === t).click(),
      sel,
      text,
    )
  }
  const waitText = (t, timeout = 25000) =>
    page.waitForFunction(
      (x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()),
      { timeout },
      t,
    )
  const hasText = (t) =>
    page.evaluate((x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()), t)
  // Replace an input's value the React-safe way (native setter + input event)
  // -- simulated triple-click+type loses its selection when the sheet re-renders.
  const setInput = (sel, val) =>
    page.evaluate(
      (s, v) => {
        const el = document.querySelector(s)
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      },
      sel,
      val,
    )
  const login = async (email, hash = '#/') => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('input[type=email]', { timeout: 25000 })
    await page.type('input[type=email]', email)
    await page.type('input[type=password]', 'citipost')
    await page.click('button[type=submit]')
  }
  // Count session-log ticks (the scan sheet renders one check glyph per scan)
  const tickCount = () =>
    page.evaluate(() => (document.body.innerText.match(/✓/g) ?? []).length)
  return { clickText, waitText, hasText, login, setInput, tickCount }
}

// ==== ADMIN: import + allocate =============================================
console.log('-- U1/U2: dispatcher imports a job and allocates it --')
const adminCtx = await browser.createBrowserContext()
const admin = await adminCtx.newPage()
await admin.setViewport({ width: 1440, height: 950 })
const A = helpers(admin)

await A.login('admin@citipost.test', '#/jobs')
await A.waitText('Import a manifest', 60000) // first load after a stack reset can lag
const importInput = await admin.$('input[type=file]')
await importInput.uploadFile(MANIFEST)
await A.waitText('8 parcels ready')
check('U1a manifest parses: 8 parcels ready, columns auto-matched', await A.hasText('Columns matched automatically'))
await A.clickText('button', 'Import 8 parcels')
await A.waitText('sample-manifest') // the job named after the file
await pause(800)
check('U1b job appears with 8 parcels', await A.hasText('8 parcels'))

await admin.goto(`${BASE}/#/allocate`, { waitUntil: 'networkidle2' })
await A.waitText('DBM-260610-001') // imported parcels land in the unallocated column
check(
  'U2a imported parcels start unallocated',
  await admin.evaluate(() => !/\b0 unallocated/.test(document.body.innerText)),
)
await A.clickText('button', 'Auto-allocate by area')
await admin.waitForFunction(() => /\b0 unallocated/.test(document.body.innerText), { timeout: 25000 })
check('U2b auto-allocate empties the unallocated column', true)
check('U2c Greater London run holds the GL parcels', await A.hasText('DBM-260610-001'))

// ==== DRIVER SAM: scanning edge cases + full lifecycle =====================
console.log('-- U3-U8: driver lifecycle --')
const samCtx = await browser.createBrowserContext()
await samCtx.overridePermissions(BASE, ['geolocation'])
const sam = await samCtx.newPage()
await sam.setViewport({ width: 430, height: 1100 })
await sam.setGeolocation({ latitude: 51.48132, longitude: 0.16505, accuracy: 8 })
const S = helpers(sam)

await S.login('sam@citipost.test')
await S.waitText("Today's stops")
await S.waitText('DBM-260610-001') // allocation reached the driver (realtime/reload)
check('U3 allocated manifest parcels appear on the right driver run', await S.hasText('DBM-260610-008'))

await S.clickText('button', 'Scan label')
await S.waitText('Or type the tracking number')

// U7: unknown barcode
await S.setInput('input[placeholder="CP-849213-GB"]', 'NOPE-000-XX')
await S.clickText('button', 'Find parcel')
await S.waitText('Unknown parcel')
check('U7 unknown tracking surfaces clearly', true)

// U8: out-of-order scan warns but records
await S.clickText('button', 'Warehouse')
await S.setInput('input[placeholder="CP-849213-GB"]', 'CP-849213-GB')
await S.clickText('button', 'Record scan')
await S.waitText('Skipped collection')
check('U8 skipping a stage warns but records', true)

// U4: full lifecycle for DBM-260610-001 -- collect...
await S.clickText('button', 'Collect')
await S.setInput('input[placeholder="CP-849213-GB"]', 'DBM-260610-001')
await S.clickText('button', 'Record scan')
await sam.waitForFunction(
  () => document.body.innerText.includes('DBM-260610-001') && document.body.innerText.includes('Collection'),
  { timeout: 25000 },
)
check('U4a collection quick scan logs with time + GPS', await S.hasText('51.48132'))

// ...warehouse...
await S.clickText('button', 'Warehouse')
await S.setInput('input[placeholder="CP-849213-GB"]', 'DBM-260610-001')
await S.clickText('button', 'Record scan')
await sam.waitForFunction(
  () => (document.body.innerText.match(/✓/g) ?? []).length >= 3,
  { timeout: 25000 },
)
check('U4b warehouse quick scan logs', true)

// ...deliver (via scan-to-capture)
await S.clickText('button', 'Deliver')
await S.setInput('input[placeholder="CP-849213-GB"]', 'DBM-260610-001')
await S.clickText('button', 'Find parcel')
await S.waitText('Photograph the parcel')
check('U4c deliver-mode scan opens the capture for the right parcel',
  await sam.evaluate(() => document.querySelector('h1').textContent.includes('DBM-260610-001')))
const photoInput = await sam.$('input[type=file]')
await photoInput.uploadFile(PHOTO)
await S.waitText('Retake')
check('U4d photo stamped (GPS row shows the burned-in fix)', await S.hasText('stamped in photo'))
await S.clickText('button', 'Confirm delivery')
await S.waitText('Synced to dispatch')
check('U4e delivery synced -- server trust stamp on the receipt', true)
await S.clickText('button', "Back to today's stops")
await S.waitText('delivered')
check('U4f stop moves to Completed as delivered', true)

// U5: failed x3 -> returned
console.log('-- U5: three failed attempts -> returned --')
for (let attempt = 1; attempt <= 3; attempt++) {
  await S.clickText('button', 'Scan label')
  await S.waitText('Or type the tracking number')
  await S.setInput('input[placeholder="CP-849213-GB"]', 'DBM-260610-008')
  await S.clickText('button', 'Find parcel')
  await S.waitText('Photograph the parcel')
  await S.clickText('button', 'Couldn’t deliver')
  await sam.select('select', 'No access')
  const input = await sam.$('input[type=file]')
  await input.uploadFile(PHOTO)
  await S.waitText('Retake')
  await S.clickText('button', 'Log failed delivery')
  await S.waitText('Synced to dispatch')
  await S.clickText('button', "Back to today's stops")
  await pause(1500)
  if (attempt < 3) {
    await sam.waitForFunction(
      (a) => document.body.innerText.includes(`Attempt ${a + 1} of 3`),
      { timeout: 25000 },
      attempt,
    )
    check(`U5${attempt === 1 ? 'a' : 'b'} attempt ${attempt} recorded, parcel stays on the run`, true)
  }
}
await S.waitText('Return to sender')
check('U5c third failure goes terminal: Return to sender', await S.hasText('3 failed attempts'))

// U6: offline queue + drain
console.log('-- U6: offline capture -> queue -> drain --')
await sam.setOfflineMode(true)
await S.clickText('button', 'Scan label')
await S.waitText('Or type the tracking number')
await S.clickText('button', 'Collect')
await S.setInput('input[placeholder="CP-849213-GB"]', 'CP-100003-GB')
await S.clickText('button', 'Record scan')
await sam.waitForFunction(() => /1 queued/i.test(document.body.innerText), { timeout: 25000 })
check('U6a offline scan records instantly and queues', true)
await S.clickText('button', 'Done')
await S.waitText('Collected · queued')
check('U6b stage chip advances locally with a queued marker', true)
await sam.setOfflineMode(false)
await sam.waitForFunction(
  () => /0 queued/i.test(document.body.innerText) && !/· queued/i.test(document.body.innerText),
  { timeout: 30000 },
)
check('U6c queue drains on reconnect; chip confirmed by the server', true)

// ==== DRIVER PRIYA: isolation ==============================================
console.log('-- U9: driver isolation + admin-route bounce --')
const priyaCtx = await browser.createBrowserContext()
const priya = await priyaCtx.newPage()
await priya.setViewport({ width: 430, height: 1100 })
const P = helpers(priya)
await P.login('priya@citipost.test')
await P.waitText("Today's stops")
await P.waitText('DBM-260610-002') // a South East parcel -- hers
check('U9a priya sees her run', true)
check("U9b priya cannot see sam's parcels", !(await P.hasText('DBM-260610-001')))
await priya.goto(`${BASE}/#/dispatch`, { waitUntil: 'networkidle2' })
await pause(1500)
check('U9c driver deep-linking to dispatch is bounced to the run',
  (await P.hasText("Today's stops")) && !(await P.hasText('Captured PODs')))

// ==== ADMIN: evidence review + export ======================================
console.log('-- U10/U11: dispatcher evidence + export --')
await admin.goto(`${BASE}/#/dispatch`, { waitUntil: 'networkidle2' })
await A.waitText('DBM-260610-001')
check('U10a delivered POD visible to dispatch', true)
check('U10b failed attempts visible with the reason', await A.hasText('No access'))
await pause(1000)
const imgOk = await admin.evaluate(() => {
  const img = document.querySelector('article img')
  return !!img && img.naturalWidth > 0
})
check('U10c evidence photo loads via signed URL', imgOk)
check('U10d geofence flag shows when capture is far from address', await A.hasText('from address'))

// stage track on the job
await admin.goto(`${BASE}/#/jobs`, { waitUntil: 'networkidle2' })
await A.waitText('sample-manifest')
await admin.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('sample-manifest'))
  btn?.click()
})
await A.waitText('DBM-260610-001')
check('U10e job rows show lifecycle stage', await A.hasText('Delivered'))
check('U10f returned parcel marked on the job', await A.hasText('Returned'))

// U11: tracking CSV export
rmSync(DOWNLOADS, { recursive: true, force: true })
mkdirSync(DOWNLOADS, { recursive: true })
const cdp = await admin.createCDPSession()
// browserContextId matters: the admin page lives in a non-default context
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: DOWNLOADS,
  browserContextId: adminCtx.id,
})
await A.clickText('button', 'Export all tracking')
let csvFile = null
for (let i = 0; i < 20 && !csvFile; i++) {
  await pause(500)
  csvFile = readdirSync(DOWNLOADS).find((f) => f.endsWith('.csv'))
}
const csv = csvFile ? readFileSync(path.join(DOWNLOADS, csvFile), 'utf8') : ''
check('U11a export downloads a CSV', !!csvFile, csvFile ?? 'no file')
check('U11b CSV contains the delivered + failed tracking events',
  csv.includes('DBM-260610-001') && csv.includes('DBM-260610-008'))

await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
