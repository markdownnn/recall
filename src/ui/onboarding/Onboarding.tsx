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
import { t } from '../sidepanel/strings'

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
      <div class="brand">{t.brand}</div>
      <h1 class="tagline">{t.obHeroTagline}</h1>
      <p class="calm">{t.obHeroCalm}</p>
    </header>
  )
}

function HowItWorksSection() {
  return (
    <section class="card section">
      <h2>{t.obHowTitle}</h2>
      <ul class="features">
        <li><strong>{t.obHowAutomaticLabel}</strong> {t.obHowAutomaticText}</li>
        <li><strong>{t.obHowManualLabel}</strong> {t.obHowManualText}</li>
        <li><strong>{t.obHowPrivateLabel}</strong> {t.obHowPrivateText}</li>
      </ul>
    </section>
  )
}

function SearchByMeaningSection() {
  return (
    <section class="card section">
      <h2>{t.obMeaningTitle}</h2>
      <p>{t.obMeaningText}</p>
      <div class="chips">
        {t.obExampleQueries.map((q) => (
          <span class="chip" key={q}>{q}</span>
        ))}
      </div>
    </section>
  )
}

function AskSection() {
  return (
    <section class="card section">
      <h2>{t.obAskTitle}</h2>
      <p>{t.obAskText}</p>
      <p class="tip">{t.obAskNote}</p>
    </section>
  )
}

function OpenRecallSection() {
  return (
    <section class="card section">
      <h2>{t.obOpenRecall}</h2>
      <p>{t.obOpenText}</p>
      <PinIllustration />
      <p class="tip">{t.obOpenTip}</p>

      <div class="shortcuts">
        <h3 class="shortcuts-title">{t.obShortcutsTitle}</h3>
        <div class="shortcut">
          <span class="keys"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd></span>
          <span>{t.obOpenRecall}</span>
        </div>
        <p class="tip">{t.obMacTip}</p>
      </div>

      <button class="primary" onClick={() => void openRecall()}>{t.obOpenRecall}</button>
    </section>
  )
}

// One renderer per kind. Adding a brand-new kind = add ONE entry here (+ push to SECTIONS).
// The cast keeps each renderer typed to its own narrowed section.
const SECTION_RENDERERS: Record<OnboardingSection['kind'], (props: { section: any }) => preact.JSX.Element> = {
  'hero': HeroSection,
  'how-it-works': HowItWorksSection,
  'search-by-meaning': SearchByMeaningSection,
  'ask': AskSection,
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
