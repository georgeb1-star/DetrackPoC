import { useEffect, useRef, useState } from 'react'

type Status = 'starting' | 'scanning' | 'error'

/**
 * Camera viewfinder that decodes barcodes continuously (§3): the native
 * BarcodeDetector API where the platform supports it, otherwise
 * @zxing/library (lazy-loaded so the heavy decoder stays out of the main
 * bundle). Fires onDecode with each raw value; the parent dedupes/matches.
 */
export function BarcodeScanner({ onDecode }: { onDecode: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<Status>('starting')
  const [engine, setEngine] = useState<'native' | 'zxing' | null>(null)
  const [errMsg, setErrMsg] = useState('')
  // Keep the latest callback without re-running the camera effect
  const onDecodeRef = useRef(onDecode)
  onDecodeRef.current = onDecode

  useEffect(() => {
    const video = videoRef.current!
    let cancelled = false
    let stream: MediaStream | null = null
    let pollId: number | undefined
    let reader: { reset(): void } | null = null

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('camera not available in this browser/context')
      }

      // Native path — BarcodeDetector exists AND actually supports formats
      // (on some desktop platforms it exists but supports none).
      const formats = window.BarcodeDetector
        ? await window.BarcodeDetector.getSupportedFormats().catch(() => [])
        : []
      if (formats.length > 0) {
        const detector = new window.BarcodeDetector!()
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (cancelled) return
        video.srcObject = stream
        await video.play()
        setEngine('native')
        setStatus('scanning')
        pollId = window.setInterval(async () => {
          if (video.readyState < 2) return
          try {
            const codes = await detector.detect(video)
            const value = codes[0]?.rawValue
            if (value) onDecodeRef.current(value)
          } catch {
            /* per-frame detect failures are routine — keep scanning */
          }
        }, 200)
        return
      }

      // Fallback: ZXing drives the camera itself and calls back per frame
      const { BrowserMultiFormatReader } = await import('@zxing/library')
      const zxing = new BrowserMultiFormatReader()
      reader = zxing
      await zxing.decodeFromConstraints(
        { video: { facingMode: 'environment' }, audio: false },
        video,
        (result) => {
          if (result) onDecodeRef.current(result.getText())
        },
      )
      if (cancelled) {
        zxing.reset()
        return
      }
      setEngine('zxing')
      setStatus('scanning')
    }

    start().catch((e) => {
      if (!cancelled) {
        setStatus('error')
        setErrMsg(e instanceof Error ? e.message : String(e))
      }
    })

    return () => {
      cancelled = true
      if (pollId) clearInterval(pollId)
      reader?.reset()
      stream?.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
  }, [])

  if (status === 'error') {
    return (
      <div className="rounded-2xl border border-line bg-white px-3 py-3 text-center text-[12.5px] text-muted">
        Camera unavailable ({errMsg}) — type the tracking number below instead.
      </div>
    )
  }

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-navy">
      <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />

      {/* §7-styled viewfinder: gold corner brackets + drifting scan line */}
      <div className="pointer-events-none absolute inset-[14%]">
        <Corner className="left-0 top-0 border-l-2 border-t-2" />
        <Corner className="right-0 top-0 border-r-2 border-t-2" />
        <Corner className="bottom-0 left-0 border-b-2 border-l-2" />
        <Corner className="bottom-0 right-0 border-b-2 border-r-2" />
        <div className="scanline absolute left-1 right-1 h-px bg-gold-soft/80 shadow-[0_0_8px_rgba(227,199,102,.9)]" />
      </div>

      <div
        className="absolute bottom-2 left-0 right-0 text-center text-[10.5px] uppercase tracking-[1.4px] text-white/70"
        title={engine ?? undefined}
      >
        {status === 'starting' ? 'Starting camera…' : 'Point the camera at the barcode'}
      </div>
    </div>
  )
}

function Corner({ className }: { className: string }) {
  return <span className={`absolute h-5 w-5 border-gold-soft ${className}`} />
}
