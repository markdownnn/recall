// Onboarding page shown in a full browser tab on first install.
//
// NOTE ON COPY: this prose is owner-approved and kept INLINE here on purpose -
// onboarding is a one-off prose surface, distinct from the reusable UI strings
// in src/ui/sidepanel/strings.ts. It can be folded into a shared i18n layer
// later if the product is localized; for now inline keeps it readable in one place.

import { PinIllustration } from './PinIllustration'

// Example "search by meaning" queries shown as pills.
const EXAMPLE_QUERIES = [
  'that article about sleep and cortisol',
  'the pricing page I saw',
  'react useEffect cleanup',
  'how photosynthesis works',
]

// Open the Recall side panel for the current window. A button click is a user
// gesture, so chrome.sidePanel.open is allowed here. We resolve the windowId via
// chrome.windows.getCurrent and swallow any failure so the click never throws -
// the printed instruction below is always the reliable fallback.
async function openRecall(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent()
    if (win?.id != null) {
      await chrome.sidePanel.open({ windowId: win.id })
    }
  } catch {
    // sidePanel.open can be unreliable depending on Chrome/version/context.
    // Fall back silently to the instruction text - never let this throw.
  }
}

export function Onboarding() {
  return (
    <main class="page">
      {/* Hero */}
      <header class="hero">
        <div class="brand">Recall</div>
        <h1 class="tagline">Remember everything you read. Find it later in plain words.</h1>
        <p class="calm">Everything runs on your device. Nothing ever leaves it.</p>
      </header>

      {/* How it works */}
      <section class="card section">
        <h2>How it works</h2>
        <ul class="features">
          <li><strong>Automatic.</strong> On-device AI saves the pages you actually read.</li>
          <li><strong>Manual.</strong> Save any page yourself in one click.</li>
          <li><strong>Private.</strong> Banking, email, and other sensitive sites are skipped - and you can pause anytime.</li>
        </ul>
      </section>

      {/* Search by meaning */}
      <section class="card section">
        <h2>Search by meaning</h2>
        <p>Forgot the exact words? Search by what it was about.</p>
        <div class="chips">
          {EXAMPLE_QUERIES.map((q) => (
            <span class="chip" key={q}>{q}</span>
          ))}
        </div>
      </section>

      {/* What results look like */}
      <section class="card section">
        <h2>What results look like</h2>
        <div class="card result-mock">
          <a href="#" onClick={(e) => e.preventDefault()}>How photosynthesis works</a>
          <p>
            Plants turn sunlight, water, and carbon dioxide into sugar and oxygen. The
            light-dependent reactions happen in the thylakoid membranes, where chlorophyll
            captures photons and the energy is stored before the sugar-building steps begin.
          </p>
          <div class="meta">wikipedia.org</div>
        </div>
      </section>

      {/* How to open Recall */}
      <section class="card section">
        <h2>Open Recall</h2>
        <p>Click the Recall icon in your toolbar to open the side panel.</p>
        <PinIllustration />
        <p class="tip">Tip: pin it for one-click access - click the puzzle-piece icon, then the pin next to Recall.</p>

        <div class="shortcuts">
          <h3 class="shortcuts-title">Keyboard shortcuts</h3>
          <div class="shortcut">
            <span class="keys"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd></span>
            <span>Open Recall</span>
          </div>
          <div class="shortcut">
            <span class="keys"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>U</kbd></span>
            <span>Save the current page</span>
          </div>
          <p class="tip">On Mac, use &#8984; Cmd instead of Ctrl.</p>
        </div>

        <button class="primary" onClick={() => void openRecall()}>Open Recall</button>
      </section>
    </main>
  )
}
