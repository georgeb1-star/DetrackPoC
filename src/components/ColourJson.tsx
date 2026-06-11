import { useMemo } from 'react'

/**
 * Syntax-coloured JSON panel from the reference design: keys gold, strings
 * green, numbers orange, booleans/null blue. Regex colouring over stringified
 * JSON (same approach as design-reference.html) — the input is always our own
 * record object, never user-controlled markup, and & / < are escaped first.
 */
function colourJson(obj: unknown): string {
  let j = JSON.stringify(obj, null, 2) ?? ''
  j = j.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  j = j.replace(/"([^"]+)":/g, '<span class="key">"$1"</span>:')
  j = j.replace(/: "([^"]*)"/g, ': <span class="str">"$1"</span>')
  j = j.replace(/: (-?\d+\.?\d*)/g, ': <span class="num">$1</span>')
  j = j.replace(/: (true|false|null)/g, ': <span class="bool">$1</span>')
  return j
}

export function ColourJson({ header, value }: { header: string; value: unknown }) {
  const html = useMemo(() => colourJson(value), [value])
  return (
    <div className="overflow-hidden rounded-[13px] bg-navy">
      <div className="border-b border-white/10 px-3.5 py-2.5 text-[10.5px] font-bold uppercase tracking-[1.4px] text-gold-soft">
        {header}
      </div>
      <pre
        className="m-0 overflow-x-auto whitespace-pre p-3.5 font-mono text-[11.5px] leading-[1.6] text-[#c3cbda]"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
