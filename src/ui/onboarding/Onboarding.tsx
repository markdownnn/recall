// Onboarding page shown in a full browser tab on first install.
//
// It is a SCROLL (not a wizard): SECTIONS is rendered top-to-bottom through a kind-keyed
// renderer map, so add/remove/reorder a section is a one-line edit in sections.ts. The static
// prose below is owner-approved and kept INLINE in each renderer on purpose - a one-off prose
// surface, distinct from the reusable UI strings in src/ui/sidepanel/strings.ts.

import { PinIllustration } from './PinIllustration'
import { SECTIONS } from './sections'
import type { OnboardingSection } from './sections'
import { TryItCard } from './TryItCard'

// Example "search by meaning" queries shown as illustrative pills (NOT clickable here - this
// is the explainer card; the live search lives in the try-it card below it).
const EXAMPLE_QUERIES = [
  'that article about sleep and cortisol',
  'the pricing page I saw',
  'react useEffect cleanup',
  'how photosynthesis works',
]

// Open the Recall side panel for the current window. A button click is a user gesture, so
// chrome.sidePanel.open is allowed here. We resolve the windowId via chrome.windows.getCurrent
// and swallow any failure so the click never throws - the printed instruction is the fallback.
async function openRecall(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent()
    if (win?.id != null) {
      await chrome.sidePanel.open({ windowId: win.id })
    }
  } catch {
    // sidePanel.open can be unreliable depending on Chrome/version/context.
  }
}

// --- per-kind static renderers (JSX migrated verbatim from the old single-function page) ---

function HeroSection() {
  return (
    <header class="hero">
      <div class="brand">Recall</div>
      <h1 class="tagline">Remember everything you read. Find it later in plain words.</h1>
      <p class="calm">Everything runs on your device. Nothing ever leaves it.</p>
    </header>
  )
}

function HowItWorksSection() {
  return (
    <section class="card section">
      <h2>How it works</h2>
      <ul class="features">
        <li><strong>Automatic.</strong> On-device AI saves the pages you actually read.</li>
        <li><strong>Manual.</strong> Save any page yourself in one click.</li>
        <li><strong>Private.</strong> Banking, email, and other sensitive sites are skipped - and you can pause anytime.</li>
      </ul>
    </section>
  )
}

function SearchByMeaningSection() {
  return (
    <section class="card section">
      <h2>Search by meaning</h2>
      <p>Forgot the exact words? Search by what it was about.</p>
      <div class="chips">
        {EXAMPLE_QUERIES.map((q) => (
          <span class="chip" key={q}>{q}</span>
        ))}
      </div>
    </section>
  )
}

function OpenRecallSection() {
  return (
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
        <p class="tip">On Mac, use &#8984; Cmd instead of Ctrl.</p>
      </div>

      <button class="primary" onClick={() => void openRecall()}>Open Recall</button>
    </section>
  )
}

// One renderer per kind. Adding a brand-new kind = add ONE entry here (+ push to SECTIONS).
// The cast keeps each renderer typed to its own narrowed section.
const SECTION_RENDERERS: Record<OnboardingSection['kind'], (props: { section: any }) => preact.JSX.Element> = {
  'hero': HeroSection,
  'how-it-works': HowItWorksSection,
  'search-by-meaning': SearchByMeaningSection,
  'try-it': TryItCard,
  'open-recall': OpenRecallSection,
}

export function Onboarding() {
  return (
    <main class="page">
      {SECTIONS.map((section) => {
        const Renderer = SECTION_RENDERERS[section.kind]
        return <Renderer key={section.id} section={section} />
      })}
    </main>
  )
}
