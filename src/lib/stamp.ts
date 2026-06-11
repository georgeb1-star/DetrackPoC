/** Canvas evidence stamping (§5): cap the longest edge at 1280px, burn the
 *  parcel ref + timestamp + GPS onto a gradient strip at the bottom, export
 *  as JPEG ~0.72. Maths and styling ported from design-reference.html. */
import type { Fix } from './types'

export interface StampedPhoto {
  blob: Blob
  /** Object URL of the stamped JPEG, for previews */
  url: string
  origKb: number
  compressedKb: number
}

const MAX_EDGE = 1280
const JPEG_QUALITY = 0.72

export async function stampAndCompress(
  file: File,
  parcelRef: string,
  takenAt: Date,
  fix: Fix | null,
): Promise<StampedPhoto> {
  const image = await decode(file)

  // Cap the longest edge for a sensible upload size
  let { width: w, height: h } = image
  if (Math.max(w, h) > MAX_EDGE) {
    const s = MAX_EDGE / Math.max(w, h)
    w = Math.round(w * s)
    h = Math.round(h * s)
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0, w, h)
  if ('close' in image) image.close()

  // Evidence strip: dark gradient over the bottom ~13% so text stays legible
  // on any photo
  const stripH = Math.max(58, Math.round(h * 0.13))
  const grad = ctx.createLinearGradient(0, h - stripH, 0, h)
  grad.addColorStop(0, 'rgba(8,16,34,0)')
  grad.addColorStop(0.35, 'rgba(8,16,34,.78)')
  grad.addColorStop(1, 'rgba(8,16,34,.92)')
  ctx.fillStyle = grad
  ctx.fillRect(0, h - stripH, w, stripH)

  // Text sizes scale with width, with floors so small images stay readable
  const pad = Math.round(w * 0.035)
  const big = Math.max(13, Math.round(w * 0.032))
  const sml = Math.max(11, Math.round(w * 0.024))
  // Provenance marker: (photo) = EXIF from the camera. No fix = say so —
  // the strip never carries a fabricated position.
  const srcMark = fix?.source === 'photo_exif' ? '  (photo)' : ''
  const acc = fix?.accuracyM != null ? `  ±${fix.accuracyM}m` : ''
  const loc = fix ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}${acc}${srcMark}` : 'GPS unavailable'

  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#ffce6b' // amber parcel ref in the display face
  ctx.font = `600 ${big}px 'Barlow Condensed', 'Arial Narrow', sans-serif`
  ctx.fillText(parcelRef, pad, h - stripH + big + pad * 0.4)
  ctx.fillStyle = '#d8dfec'
  ctx.font = `400 ${sml}px Barlow, -apple-system, sans-serif`
  ctx.fillText(fmt(takenAt), pad, h - stripH + big + sml + pad * 0.9)
  ctx.fillText(loc, pad, h - stripH + big + sml * 2 + pad * 1.2)

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))), 'image/jpeg', JPEG_QUALITY),
  )

  return {
    blob,
    url: URL.createObjectURL(blob),
    origKb: Math.round(file.size / 1024),
    compressedKb: Math.round(blob.size / 1024),
  }
}

/** Decode respecting EXIF rotation where supported, with an <img> fallback. */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('image decode failed'))
      img.src = URL.createObjectURL(file)
    })
  }
}

function fmt(d: Date): string {
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
