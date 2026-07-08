// Dev-time visual check: sign in as the demo admin and screenshot the dispatch
// pages at laptop width. Run with the dev server + Supabase up:
//   node scripts/screenshot-admin.mjs [baseUrl]   (default matches `npm run dev`)
// Requires puppeteer-core (npm i --no-save puppeteer-core) and local Chrome.
import puppeteer from 'puppeteer-core'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = process.env.TEMP ?? '.'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1600, height: 950 },
})
const page = await browser.newPage()

// Sign in via the demo-credentials button + form
await page.goto(`${BASE}/#/allocate`, { waitUntil: 'networkidle2' })
await page.waitForSelector('input[type=text]', { timeout: 15000 })
await page.type('input[type=text]', 'admin@citipost.test')
await page.type('input[type=password]', 'citipost')
await page.click('button[type=submit]')
await page.waitForFunction(() => document.body.innerText.includes('Allocate parcels'), {
  timeout: 20000,
})

const shots = [
  ['#/allocate', 'admin-allocate'],
  ['#/jobs', 'admin-jobs'],
  ['#/sites', 'admin-sites'],
  ['#/dispatch', 'admin-pods'],
  ['#/collections', 'admin-collections'],
  ['#/reconcile', 'admin-reconcile'],
]
for (const [hash, name] of shots) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1200)) // realtime/data settle
  await page.screenshot({ path: `${OUT}\\${name}.png`, fullPage: false })
  console.log(`${name}.png written`)
}

await browser.close()
