// Pure-function tests for the enrichment transforms (no DB/stack). Node 24
// type-stripping imports the real src/lib modules under test.
//   node scripts/test-enrich.mjs
import {
  composeAddressLine, composeRecipient, deriveArea, shipmentToParcelInput,
} from '../src/lib/enrich.ts'
import { buildParcelInputs, splitRowsForEnrichment } from '../src/lib/manifest.ts'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

const row = {
  tracking_number: 'TRK1',
  recipient_full_name: 'Jane Doe',
  recipient_company: 'Acme Optics',
  recipient_address1: '1 High St',
  recipient_address2: 'Unit 4',
  recipient_address3: '',
  recipient_city: 'Bromley',
  recipient_county: 'Kent',
  recipient_postcode: 'BR1 1AA',
}

console.log('compose')
check('address joins non-empty parts with ", "',
  composeAddressLine(row) === '1 High St, Unit 4, Bromley, Kent', composeAddressLine(row))
check('recipient prefers full name', composeRecipient(row) === 'Jane Doe')
check('recipient falls back to company',
  composeRecipient({ ...row, recipient_full_name: '' }) === 'Acme Optics')
check('recipient falls back to placeholder',
  composeRecipient({ ...row, recipient_full_name: '', recipient_company: '' }) === '(no name)')

console.log('deriveArea')
check('BR → Kent', deriveArea('BR1 1AA') === 'Kent')
check('SE → South London', deriveArea('SE10 9AB') === 'South London')
check('KT → Surrey', deriveArea('KT1 1AA') === 'Surrey')
check('WC → Central London', deriveArea('WC2N 5DU') === 'Central London')
check('lowercase + extra spaces tolerated', deriveArea('  br1 1aa ') === 'Kent')
check('unknown prefix → Other', deriveArea('ZZ1 1ZZ') === 'Other')
check('East London (no home) → Other', deriveArea('E1 6AN') === 'Other')
check('blank → Other', deriveArea('') === 'Other')
check('null → Other', deriveArea(null) === 'Other')
// Regression: a 2-letter area must NOT fall back to its 1-letter London
// namesake. WA=Warrington (not London W), NE=Newcastle (not London N).
check('WA → Other, not West London', deriveArea('WA1 1AA') === 'Other')
check('WD → Other, not West London', deriveArea('WD17 1AA') === 'Other')
check('NE → Other, not North London', deriveArea('NE1 1AA') === 'Other')
check('NP → Other, not North London', deriveArea('NP10 8XG') === 'Other')
// …while the genuine 1-letter London areas still resolve.
check('W → West London', deriveArea('W1A 0AX') === 'West London')
check('N → North London', deriveArea('N1 9GU') === 'North London')

console.log('shipmentToParcelInput')
const pi = shipmentToParcelInput(row)
check('maps tracking/recipient/address/postcode/area',
  pi.tracking_number === 'TRK1' && pi.recipient_name === 'Jane Doe' &&
  pi.address_line === '1 High St, Unit 4, Bromley, Kent' && pi.postcode === 'BR1 1AA' &&
  pi.area === 'Kent', JSON.stringify(pi))
check('raw row kept in meta', pi.meta.recipient_city === 'Bromley')

console.log('manifest relaxation')
// A tracking-only mapping (no address column). Address row is now an enrichment
// candidate, NOT a "missing address" error.
const rows = [
  { Track: 'A1' }, { Track: 'A2' }, { Track: '' /* blank skipped */ }, { Track: 'A1' /* dupe */ },
]
const split = splitRowsForEnrichment(rows, { tracking_number: 'Track' })
check('two unique tracking numbers extracted',
  split.toEnrich.length === 2 && split.toEnrich[0] === 'A1', JSON.stringify(split.toEnrich))
check('rows with address still build normally', (() => {
  const r = [{ T: 'B1', N: 'Bob', A: '2 Road' }]
  const { parcels, errors } = buildParcelInputs(r, { tracking_number: 'T', recipient_name: 'N', address_line: 'A' })
  return parcels.length === 1 && errors.length === 0 && parcels[0].area === 'Other'
})())

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
