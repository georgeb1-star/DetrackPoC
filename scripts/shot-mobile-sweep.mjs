// Mobile sweep: screenshot every screen at a phone viewport (390x844) so
// layout/usability problems are visible. Drives driver + admin sessions.
//   node scripts/shot-mobile-sweep.mjs
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const TEMP = process.env.TEMP ?? '.'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

async function mobilePage(ctx) {
  const page = await ctx.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  return page
}
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(TEMP, `mob-${name}.png`) })
  console.log(`mob-${name}.png`)
}
const waitText = (page, t, timeout = 25000) =>
  page.waitForFunction(
    (x) => document.body.innerText.toLowerCase().includes(x.toLowerCase()),
    { timeout },
    t,
  )
const clickText = async (page, sel, text) => {
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
const login = async (page, email, hash = '#/') => {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=text]', { timeout: 25000 })
  await page.type('input[type=text]', email)
  await page.type('input[type=password]', 'citipost')
  await page.click('button[type=submit]')
}
// Detect horizontal overflow — the classic mobile breakage
const overflow = (page) =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth
    const bad = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > w + 1 && el.offsetParent !== null)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`)
    return { scrollW: document.documentElement.scrollWidth, clientW: w, bad }
  })

// ── Login ───────────────────────────────────────────────────────────────────
const ctx1 = await browser.createBrowserContext()
const p1 = await mobilePage(ctx1)
await p1.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
await p1.waitForSelector('input[type=text]', { timeout: 25000 })
await shot(p1, '01-login')
console.log('login overflow:', JSON.stringify(await overflow(p1)))

// ── Driver (sam) ────────────────────────────────────────────────────────────
await ctx1.overridePermissions(BASE, ['geolocation'])
await p1.setGeolocation({ latitude: 51.48132, longitude: 0.16505, accuracy: 8 })
await p1.type('input[type=text]', 'sam@citipost.test')
await p1.type('input[type=password]', 'citipost')
await p1.click('button[type=submit]')
await waitText(p1, "Today's stops")
await pause(1200)
await shot(p1, '02-driver-stops')
console.log('stops overflow:', JSON.stringify(await overflow(p1)))

await clickText(p1, 'button', 'Scan label')
await waitText(p1, 'Or type the tracking number')
await clickText(p1, 'button', 'Collect')
await pause(1200)
await shot(p1, '03-scan-sheet-collect')
console.log('sheet overflow:', JSON.stringify(await overflow(p1)))
await clickText(p1, 'button', 'Done')

// open a capture for any active stop (tap the first stop card)
await p1.evaluate(() => {
  const card = [...document.querySelectorAll('button')].find((b) => /TJOB|CP-|DBM-/.test(b.textContent))
  card?.click()
})
await waitText(p1, 'Photograph the parcel')
await pause(800)
await shot(p1, '04-capture')
console.log('capture overflow:', JSON.stringify(await overflow(p1)))

// ── Admin portal ────────────────────────────────────────────────────────────
const ctx2 = await browser.createBrowserContext()
const p2 = await mobilePage(ctx2)
await login(p2, 'admin@citipost.test', '#/allocate')
await waitText(p2, 'Allocate')
await pause(1500)
await shot(p2, '05-admin-allocate')
console.log('allocate overflow:', JSON.stringify(await overflow(p2)))

await p2.goto(`${BASE}/#/jobs`, { waitUntil: 'networkidle2' })
await waitText(p2, 'Import a manifest')
await pause(1200)
// open the first job if present
await p2.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /job|manifest/i.test(b.textContent) && b.querySelector('svg'))
  btn?.click()
})
await pause(800)
await shot(p2, '06-admin-jobs')
console.log('jobs overflow:', JSON.stringify(await overflow(p2)))

await p2.goto(`${BASE}/#/sites`, { waitUntil: 'networkidle2' })
await waitText(p2, 'Add a site')
await pause(1200)
await shot(p2, '07-admin-sites')
console.log('sites overflow:', JSON.stringify(await overflow(p2)))

await p2.goto(`${BASE}/#/dispatch`, { waitUntil: 'networkidle2' })
await waitText(p2, 'Captured PODs')
await pause(2000)
await shot(p2, '08-admin-pods')
console.log('pods overflow:', JSON.stringify(await overflow(p2)))

await browser.close()
console.log('sweep done')
