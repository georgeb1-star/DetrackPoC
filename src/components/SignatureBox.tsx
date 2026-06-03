import { useEffect, useRef, useState, type RefObject } from 'react'
import SignaturePad from 'signature_pad'

export interface SignatureHandle {
  /** PNG blob, or null if the pad is untouched (signature is optional, §5) */
  getBlob(): Promise<Blob | null>
}

/** Canvas signature pad. The parent reads the result through `handleRef`
 *  at completion time. */
export function SignatureBox({ handleRef }: { handleRef: RefObject<SignatureHandle | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const padRef = useRef<SignaturePad | null>(null)
  const [signed, setSigned] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current!
    // Scale the backing store for the device pixel ratio or strokes land
    // offset from the pointer (signature_pad docs)
    const ratio = Math.max(window.devicePixelRatio || 1, 1)
    canvas.width = canvas.offsetWidth * ratio
    canvas.height = canvas.offsetHeight * ratio
    canvas.getContext('2d')!.scale(ratio, ratio)

    const pad = new SignaturePad(canvas, { penColor: '#10192e' })
    padRef.current = pad
    pad.addEventListener('endStroke', () => setSigned(true))

    handleRef.current = {
      getBlob: () =>
        pad.isEmpty()
          ? Promise.resolve(null)
          : new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png')),
    }

    return () => {
      pad.off()
      handleRef.current = null
    }
  }, [handleRef])

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="h-28 w-full touch-none rounded-[11px] border border-line bg-white"
      />
      <div className="mt-1 flex items-center justify-between text-[11.5px]">
        <span className="text-muted">{signed ? 'Signed' : 'Sign above, or leave blank'}</span>
        <button
          type="button"
          className="font-semibold text-navy-500 underline"
          onClick={() => {
            padRef.current?.clear()
            setSigned(false)
          }}
        >
          Clear
        </button>
      </div>
    </div>
  )
}
