// UI strings facade. Source of truth: public/_locales/en/messages.json.
// Recall is English-only, so call sites use this facade instead of branching on locale.
//
// In a real extension page (side panel, onboarding) chrome.i18n.getMessage is synchronous and
// always available. In a plain Node context (vitest) there is no `chrome`, so we fall back to
// the bundled EN messages and substitute placeholders ourselves - the canary test thus reads the
// SAME en/messages.json the extension ships.

import enMessages from '../../../public/_locales/en/messages.json'

type MessageEntry = { message: string; placeholders?: Record<string, { content: string }> }
const EN_MESSAGES = enMessages as Record<string, MessageEntry>

// Fallback renderer for non-extension contexts. Mirrors chrome.i18n: replace each `$name$`
// placeholder with the substitution its `content` ("$1", "$2", ...) points at.
function renderFallback(key: string, subs?: string[]): string {
  const entry = EN_MESSAGES[key]
  if (!entry) return ''
  let out = entry.message
  if (entry.placeholders) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const idx = Number(def.content.replace('$', '')) - 1
      const value = subs?.[idx] ?? ''
      // Function replacer so `$`-sequences in the value ($&, $$, $1) are inserted LITERALLY,
      // matching real chrome.i18n.getMessage. A string replacement would special-case them.
      out = out.replace(new RegExp('\\$' + name + '\\$', 'gi'), () => value)
    }
  }
  return out
}

// One accessor used to build every entry below. Prefers chrome.i18n (the locale-aware path);
// falls back to the bundled EN messages when `chrome` is absent.
function msg(key: string, subs?: string[]): string {
  if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
    return chrome.i18n.getMessage(key, subs)
  }
  return renderFallback(key, subs)
}

export interface UIStrings {
  brand: string
  // Search
  searching: string
  answering: string
  noResults: string
  searchTabLabel: string
  searchButtonLabel: string
  searchButtonAria: string
  askModeLabel: string
  askButtonLabel: string
  askButtonAria: string
  askPlaceholder: string
  triedSearches: string
  downloadWebLlm: string
  webLlmReady: string
  webLlmLoading: (pct: number) => string
  webLlmRequired: string
  historyTabLabel: string
  settingsTabLabel: string
  historyEmpty: string
  loadMore: string
  // Capture + status
  captureButton: string
  updateButton: string
  cannotCaptureButton: string
  loadingSearchModel: string
  saving: string
  savingHint: string
  saveRetry: string
  nothingSubstantial: string
  nothingToCapture: string
  pausedNote: string
  notSavedDenylisted: string
  captureFailed: (err: string) => string
  cannotCapturePage: string
  reloadToCapture: string
  searchFailed: (err: string) => string
  askFailed: (err: string) => string
  // SAVED badge (PAGE-scoped)
  savedBadge: string
  notSavedBadge: string
  // Model status
  loadingPercent: (pct: number) => string
  modelReady: string
  modelError: string
  embedderUnavailable: string
  embedderSlow: string
  // Pause
  pauseLabel: string
  // Settings tab
  settingsCaptureHeading: string
  pauseHelp: string
  denylistHelp: string
  denylistEmpty: string
  // Site controls (SITE-scoped)
  dontRememberSite: string
  alreadyOnListShort: string
  wonRemember: (host: string) => string
  alreadyOnListHost: (host: string) => string
  forgetSiteHistory: string
  forgotEverythingFrom: (host: string) => string
  forgetConfirm: (host: string) => string
  // Denylist editor
  noRememberSitesHeader: string
  removeLabel: string
  // Error/status
  couldNotAdd: string
  couldNotRemove: string
  couldNotForget: string
  restrictedTabAdd: string
  restrictedTabForget: string
  // Side-panel chrome (icon button labels)
  helpTitle: string
  dismissAria: string
  // Onboarding try-it card (live action + status labels)
  obSeedButton: string
  obSeeding: string
  obSeeded: string
  obSearchPlaceholder: string
  obRemoveDemo: string
  obDemoRemoved: string
  // Onboarding inline prose (hero / how-it-works / search-by-meaning / open-recall / try-it)
  obHeroTagline: string
  obHeroCalm: string
  obHowTitle: string
  obHowAutomaticLabel: string
  obHowAutomaticText: string
  obHowManualLabel: string
  obHowManualText: string
  obHowPrivateLabel: string
  obHowPrivateText: string
  obMeaningTitle: string
  obMeaningText: string
  obExampleQueries: string[]
  obOpenRecall: string
  obOpenText: string
  obOpenTip: string
  obShortcutsTitle: string
  obMacTip: string
  obTryTitle: string
  obTryText: string
}

// The facade. Static entries resolve once at module load (the locale is fixed for the page's
// lifetime); dynamic entries resolve per call so their placeholder args substitute correctly.
export const t: UIStrings = {
  brand: msg('brand'),
  searching: msg('searching'),
  answering: msg('answering'),
  noResults: msg('noResults'),
  searchTabLabel: msg('searchTabLabel'),
  searchButtonLabel: msg('searchButtonLabel'),
  searchButtonAria: msg('searchButtonAria'),
  askModeLabel: msg('askModeLabel'),
  askButtonLabel: msg('askButtonLabel'),
  askButtonAria: msg('askButtonAria'),
  askPlaceholder: msg('askPlaceholder'),
  triedSearches: msg('triedSearches'),
  downloadWebLlm: msg('downloadWebLlm'),
  webLlmReady: msg('webLlmReady'),
  webLlmLoading: (pct) => msg('webLlmLoading', [String(pct)]),
  webLlmRequired: msg('webLlmRequired'),
  historyTabLabel: msg('historyTabLabel'),
  settingsTabLabel: msg('settingsTabLabel'),
  historyEmpty: msg('historyEmpty'),
  loadMore: msg('loadMore'),
  captureButton: msg('captureButton'),
  updateButton: msg('updateButton'),
  cannotCaptureButton: msg('cannotCaptureButton'),
  loadingSearchModel: msg('loadingSearchModel'),
  saving: msg('saving'),
  savingHint: msg('savingHint'),
  saveRetry: msg('saveRetry'),
  nothingSubstantial: msg('nothingSubstantial'),
  nothingToCapture: msg('nothingToCapture'),
  pausedNote: msg('pausedNote'),
  notSavedDenylisted: msg('notSavedDenylisted'),
  captureFailed: (err) => msg('captureFailed', [err]),
  cannotCapturePage: msg('cannotCapturePage'),
  reloadToCapture: msg('reloadToCapture'),
  searchFailed: (err) => msg('searchFailed', [err]),
  askFailed: (err) => msg('askFailed', [err]),
  savedBadge: msg('savedBadge'),
  notSavedBadge: msg('notSavedBadge'),
  loadingPercent: (pct) => msg('loadingPercent', [String(pct)]),
  modelReady: msg('modelReady'),
  modelError: msg('modelError'),
  embedderUnavailable: msg('embedderUnavailable'),
  embedderSlow: msg('embedderSlow'),
  pauseLabel: msg('pauseLabel'),
  settingsCaptureHeading: msg('settingsCaptureHeading'),
  pauseHelp: msg('pauseHelp'),
  denylistHelp: msg('denylistHelp'),
  denylistEmpty: msg('denylistEmpty'),
  dontRememberSite: msg('dontRememberSite'),
  alreadyOnListShort: msg('alreadyOnListShort'),
  wonRemember: (host) => msg('wonRemember', [host]),
  alreadyOnListHost: (host) => msg('alreadyOnListHost', [host]),
  forgetSiteHistory: msg('forgetSiteHistory'),
  forgotEverythingFrom: (host) => msg('forgotEverythingFrom', [host]),
  forgetConfirm: (host) => msg('forgetConfirm', [host]),
  noRememberSitesHeader: msg('noRememberSitesHeader'),
  removeLabel: msg('removeLabel'),
  couldNotAdd: msg('couldNotAdd'),
  couldNotRemove: msg('couldNotRemove'),
  couldNotForget: msg('couldNotForget'),
  restrictedTabAdd: msg('restrictedTabAdd'),
  restrictedTabForget: msg('restrictedTabForget'),
  helpTitle: msg('helpTitle'),
  dismissAria: msg('dismissAria'),
  obSeedButton: msg('obSeedButton'),
  obSeeding: msg('obSeeding'),
  obSeeded: msg('obSeeded'),
  obSearchPlaceholder: msg('obSearchPlaceholder'),
  obRemoveDemo: msg('obRemoveDemo'),
  obDemoRemoved: msg('obDemoRemoved'),
  obHeroTagline: msg('obHeroTagline'),
  obHeroCalm: msg('obHeroCalm'),
  obHowTitle: msg('obHowTitle'),
  obHowAutomaticLabel: msg('obHowAutomaticLabel'),
  obHowAutomaticText: msg('obHowAutomaticText'),
  obHowManualLabel: msg('obHowManualLabel'),
  obHowManualText: msg('obHowManualText'),
  obHowPrivateLabel: msg('obHowPrivateLabel'),
  obHowPrivateText: msg('obHowPrivateText'),
  obMeaningTitle: msg('obMeaningTitle'),
  obMeaningText: msg('obMeaningText'),
  obExampleQueries: [msg('obExampleQuery1'), msg('obExampleQuery2'), msg('obExampleQuery3'), msg('obExampleQuery4')],
  obOpenRecall: msg('obOpenRecall'),
  obOpenText: msg('obOpenText'),
  obOpenTip: msg('obOpenTip'),
  obShortcutsTitle: msg('obShortcutsTitle'),
  obMacTip: msg('obMacTip'),
  obTryTitle: msg('obTryTitle'),
  obTryText: msg('obTryText'),
}
