/**
 * Checkpoint 1 placeholder — proves the §7 theme tokens render correctly:
 * navy desk background, phone frame with bezel shadow, navy top bar with the
 * gold eyebrow / serif ref / mono barcode, paper surface, section labels.
 * Real screens land in Checkpoint 3.
 */
export default function App() {
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 px-4 pb-14 pt-7">
      <header className="max-w-[430px] text-center">
        <h1 className="font-serif text-[21px] font-semibold tracking-[0.2px] text-white">
          Electronic Proof of Delivery
        </h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#aeb8d4]">
          PoC scaffold — theme check. Screens arrive in Checkpoint 3.
        </p>
      </header>

      {/* Phone frame (§7): ~390px, 30px radius, layered bezel ring shadow */}
      <div className="relative w-[390px] max-w-full overflow-hidden rounded-phone bg-paper shadow-phone">
        {/* Top bar with gold gradient underline */}
        <div className="gold-underline relative bg-navy px-[18px] pb-4 pt-3.5 text-white">
          <div className="text-[10.5px] font-semibold uppercase tracking-[2px] text-gold-soft">
            Stop 7 of 14 · Domestic
          </div>
          <div className="mt-[3px] font-serif text-lg">CP-849213-GB</div>
          <div className="mt-[5px] font-mono text-xs tracking-[1px] text-[#9fb0d6]">
            ‖▌║▌‖║▌║‖ 3S CPGB 849213 002
          </div>
        </div>

        {/* Stop block */}
        <div className="border-b border-line bg-white px-[18px] py-3.5">
          <div className="text-[15px] font-semibold">Meridian Logistics</div>
          <div className="mt-0.5 text-[13px] leading-snug text-muted">
            Unit 4, Hailey Road Industrial Estate
            <br />
            Erith, DA18 4AA
          </div>
        </div>

        <div className="px-[18px] py-4">
          <p className="section-label mb-2.5">Theme tokens</p>
          <div className="grid grid-cols-2 gap-[9px]">
            <div className="rounded-[11px] border border-line bg-white px-[11px] py-[9px]">
              <div className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">Status</div>
              <div className="mt-[3px] text-[13px] font-semibold tabular-nums text-ok">Delivered</div>
            </div>
            <div className="rounded-[11px] border border-line bg-white px-[11px] py-[9px]">
              <div className="text-[10px] font-bold uppercase tracking-[0.6px] text-muted">
                GPS location (simulated)
              </div>
              <div className="mt-[3px] text-[13px] font-semibold tabular-nums text-gold">
                51.48400, 0.17700
              </div>
            </div>
          </div>

          <button
            className="mt-[18px] w-full rounded-[13px] bg-navy p-[15px] font-serif text-base tracking-[0.3px] text-white"
            type="button"
          >
            Complete delivery
          </button>
        </div>
      </div>
    </div>
  )
}
