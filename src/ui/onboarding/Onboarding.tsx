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
        <h1 class="tagline">Remember everything you read - find it later in plain language.</h1>
        <p class="calm">The model and search run entirely on your device. Nothing leaves it.</p>
      </header>

      {/* How it works */}
      <section class="card section">
        <h2>How it works</h2>
        <p>
          Pages you actually read are saved automatically - on-device machine learning
          decides what's worth keeping. You can also save any page yourself. Sensitive
          sites (banking, email, etc.) are skipped automatically, and you can pause anytime.
        </p>
      </section>

      {/* Search by meaning */}
      <section class="card section">
        <h2>Search by meaning</h2>
        <p>Don't remember the exact words? Search by meaning.</p>
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
          <div class="meta">wikipedia.org &middot; 0.84</div>
        </div>
        <p class="caption">One result per page - its best-matching paragraph.</p>
      </section>

      {/* How to open Recall */}
      <section class="card section">
        <h2>How to open Recall</h2>
        <p>Click the Recall icon in your toolbar to open the side panel.</p>
        <PinIllustration />
        <p class="tip">Tip: pin it for one-click access - click the puzzle-piece icon, then the pin next to Recall.</p>
        <button class="primary" onClick={() => void openRecall()}>Open Recall</button>
      </section>
    </main>
  )
}
