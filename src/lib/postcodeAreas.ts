/** UK postcode AREA → post-town name. Routes store their collect/deliver
 *  coverage as postcode-area prefixes (BR, DA, SE…); the admin UI shows the
 *  code and reveals this full name on hover. Canonical list of the ~124 UK
 *  postcode areas. Unknown codes fall back to the code itself. */
const POSTCODE_AREA_NAMES: Record<string, string> = {
  AB: 'Aberdeen', AL: 'St Albans', B: 'Birmingham', BA: 'Bath', BB: 'Blackburn',
  BD: 'Bradford', BH: 'Bournemouth', BL: 'Bolton', BN: 'Brighton', BR: 'Bromley',
  BS: 'Bristol', BT: 'Belfast', CA: 'Carlisle', CB: 'Cambridge', CF: 'Cardiff',
  CH: 'Chester', CM: 'Chelmsford', CO: 'Colchester', CR: 'Croydon', CT: 'Canterbury',
  CV: 'Coventry', CW: 'Crewe', DA: 'Dartford', DD: 'Dundee', DE: 'Derby',
  DG: 'Dumfries', DH: 'Durham', DL: 'Darlington', DN: 'Doncaster', DT: 'Dorchester',
  DY: 'Dudley', E: 'London E (Eastern)', EC: 'London EC (East Central)', EH: 'Edinburgh',
  EN: 'Enfield', EX: 'Exeter', FK: 'Falkirk', FY: 'Blackpool (Fylde)', G: 'Glasgow',
  GL: 'Gloucester', GU: 'Guildford', GY: 'Guernsey', HA: 'Harrow', HD: 'Huddersfield',
  HG: 'Harrogate', HP: 'Hemel Hempstead', HR: 'Hereford', HS: 'Outer Hebrides',
  HU: 'Hull', HX: 'Halifax', IG: 'Ilford', IP: 'Ipswich', IV: 'Inverness',
  JE: 'Jersey', KA: 'Kilmarnock', KT: 'Kingston upon Thames', KW: 'Kirkwall',
  KY: 'Kirkcaldy', L: 'Liverpool', LA: 'Lancaster', LD: 'Llandrindod Wells',
  LE: 'Leicester', LL: 'Llandudno', LN: 'Lincoln', LS: 'Leeds', LU: 'Luton',
  M: 'Manchester', ME: 'Medway', MK: 'Milton Keynes', ML: 'Motherwell',
  N: 'London N (Northern)', NE: 'Newcastle upon Tyne', NG: 'Nottingham',
  NN: 'Northampton', NP: 'Newport', NR: 'Norwich', NW: 'London NW (North Western)',
  OL: 'Oldham', OX: 'Oxford', PA: 'Paisley', PE: 'Peterborough', PH: 'Perth',
  PL: 'Plymouth', PO: 'Portsmouth', PR: 'Preston', RG: 'Reading', RH: 'Redhill',
  RM: 'Romford', S: 'Sheffield', SA: 'Swansea', SE: 'London SE (South Eastern)',
  SG: 'Stevenage', SK: 'Stockport', SL: 'Slough', SM: 'Sutton', SN: 'Swindon',
  SO: 'Southampton', SP: 'Salisbury', SR: 'Sunderland', SS: 'Southend-on-Sea',
  ST: 'Stoke-on-Trent', SW: 'London SW (South Western)', SY: 'Shrewsbury',
  TA: 'Taunton', TD: 'Galashiels', TF: 'Telford', TN: 'Tunbridge Wells',
  TQ: 'Torquay', TR: 'Truro', TS: 'Teesside', TW: 'Twickenham', UB: 'Southall',
  W: 'London W (Western)', WA: 'Warrington', WC: 'London WC (West Central)',
  WD: 'Watford', WF: 'Wakefield', WN: 'Wigan', WR: 'Worcester', WS: 'Walsall',
  WV: 'Wolverhampton', YO: 'York', ZE: 'Lerwick (Shetland)',
}

/** Full post-town name for a postcode-area code (e.g. "BR" → "Bromley"), or the
 *  code itself when it isn't a recognised UK area. */
export function postcodeAreaName(code: string): string {
  return POSTCODE_AREA_NAMES[code.trim().toUpperCase()] ?? code
}
