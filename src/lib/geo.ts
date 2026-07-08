/** PostgREST returns PostGIS geography columns as EWKB hex. For a PoC we
 *  only ever store SRID-tagged 2D points, so a tiny parser beats pulling in a
 *  geometry library. Layout (little-endian):
 *    byte 0       endian flag (01)
 *    bytes 1-4    geometry type with SRID flag (01000020)
 *    bytes 5-8    SRID (E6100000 = 4326)
 *    bytes 9-16   lng (float64 LE)
 *    bytes 17-24  lat (float64 LE)
 */
/** Great-circle distance in metres (haversine — ample accuracy for a
 *  "was this captured near the address?" geofence check). */
export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** "96 m" / "2.3 km" */
export function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

/** Greedy nearest-neighbour ordering — turns a set of stops into a sensible
 *  drive sequence instead of an arbitrary (e.g. tracking-number) order. Items
 *  with no point sort to the end (can't be placed). Deterministic: starts from
 *  the northernmost located item (westernmost tiebreak), then repeatedly hops to
 *  the nearest unvisited. O(n²) — trivial for a driver's run (dozens of stops).
 *  Not an optimal TSP, but it clusters nearby drops so the driver stops
 *  crisscrossing the area. */
export function orderByProximity<T>(
  items: T[],
  getPoint: (t: T) => { lat: number; lng: number } | null,
): T[] {
  const located = items
    .map((it) => ({ it, pt: getPoint(it) }))
    .filter((x): x is { it: T; pt: { lat: number; lng: number } } => x.pt != null)
  const unlocated = items.filter((it) => getPoint(it) == null)
  if (located.length <= 2) return [...located.map((x) => x.it), ...unlocated]
  located.sort((a, b) => b.pt.lat - a.pt.lat || a.pt.lng - b.pt.lng) // deterministic start
  const remaining = located.slice()
  const ordered = [remaining.shift()!]
  while (remaining.length) {
    const last = ordered[ordered.length - 1].pt
    let bestI = 0
    let bestD = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineM(last, remaining[i].pt)
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    ordered.push(remaining.splice(bestI, 1)[0])
  }
  return [...ordered.map((x) => x.it), ...unlocated]
}

export function parseEwkbPoint(hex: unknown): { lat: number; lng: number } | null {
  if (typeof hex !== 'string' || hex.length < 50 || !hex.startsWith('01')) return null
  try {
    const readDouble = (hexOffset: number): number => {
      const dv = new DataView(new ArrayBuffer(8))
      for (let i = 0; i < 8; i++) {
        dv.setUint8(i, parseInt(hex.slice(hexOffset + i * 2, hexOffset + i * 2 + 2), 16))
      }
      return dv.getFloat64(0, true)
    }
    const lng = readDouble(18)
    const lat = readDouble(34)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null
    return { lat, lng }
  } catch {
    return null
  }
}
