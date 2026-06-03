// Generates the PNG manifest icons (192/512) without any image library:
// a solid navy square with a centred gold square — enough for the PWA
// install prompt. The detailed icon is public/icon.svg.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const NAVY = [0x0e, 0x1c, 0x38]
const GOLD = [0xc9, 0xa2, 0x27]

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function makePng(size) {
  // RGB raster: navy field, gold square centred at 50% width
  const inset = Math.round(size * 0.25)
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3) // leading 0 = no PNG filter
    for (let x = 0; x < size; x++) {
      const gold = x >= inset && x < size - inset && y >= inset && y < size - inset
      const [r, g, b] = gold ? GOLD : NAVY
      row[1 + x * 3] = r
      row[2 + x * 3] = g
      row[3 + x * 3] = b
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
for (const size of [192, 512]) {
  writeFileSync(join(pub, `icon-${size}.png`), makePng(size))
  console.log(`wrote public/icon-${size}.png`)
}
