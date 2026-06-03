import type { ReactNode } from 'react'

/** Responsive app shell — no mockup chrome.
 *  Mobile: the app fills the viewport edge-to-edge like a native app.
 *  Laptop: a single centred column on the navy backdrop, card elevation only. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center sm:px-4 sm:py-10">
      <div className="relative flex w-full flex-1 flex-col overflow-hidden bg-paper sm:max-w-[430px] sm:flex-none sm:rounded-2xl sm:shadow-[0_24px_70px_-28px_rgba(0,0,0,.8),0_0_0_1px_rgba(255,255,255,.07)]">
        {children}
      </div>
    </div>
  )
}
