// Source of truth is now public/_locales/en/messages.json, surfaced through the typed `t`
// facade in src/ui/sidepanel/strings.ts. In this Node (vitest) context there is no `chrome`,
// so `t` renders from the bundled EN messages - the SAME file the extension ships as the
// en locale. This test is the canary: if an EN string drifts, an e2e assertion below breaks.
import { t } from '../../src/ui/sidepanel/strings'

const STATIC_KEYS = [
  'brand', 'searching', 'noResults', 'searchTabLabel', 'searchButtonLabel', 'searchButtonAria',
  'historyTabLabel', 'settingsTabLabel', 'historyEmpty', 'loadMore',
  'captureButton', 'updateButton', 'cannotCaptureButton', 'saving', 'savingHint', 'saveRetry', 'nothingSubstantial', 'nothingToCapture',
  'pausedNote', 'notSavedDenylisted', 'savedBadge', 'notSavedBadge',
  'cannotCapturePage', 'reloadToCapture',
  'modelReady', 'modelError', 'embedderUnavailable', 'embedderSlow', 'pauseLabel',
  'settingsCaptureHeading', 'pauseHelp', 'denylistHelp', 'denylistEmpty',
  'dontRememberSite', 'alreadyOnListShort', 'forgetSiteHistory',
  'noRememberSitesHeader', 'removeLabel',
  'couldNotAdd', 'couldNotRemove', 'couldNotForget', 'restrictedTabAdd', 'restrictedTabForget',
  'helpTitle', 'dismissAria',
  'obSeedButton', 'obSeeding', 'obSeeded',
  'obSearchPlaceholder', 'obRemoveDemo', 'obDemoRemoved',
  'obHeroTagline', 'obHeroCalm', 'obHowTitle',
  'obHowAutomaticLabel', 'obHowAutomaticText', 'obHowManualLabel', 'obHowManualText',
  'obHowPrivateLabel', 'obHowPrivateText',
  'obMeaningTitle', 'obMeaningText', 'obOpenRecall', 'obOpenText', 'obOpenTip',
  'obShortcutsTitle', 'obMacTip', 'obTryTitle', 'obTryText',
] as const
const FUNCTION_KEYS = [
  'captureFailed', 'searchFailed',
  'loadingPercent', 'wonRemember', 'alreadyOnListHost', 'forgotEverythingFrom', 'forgetConfirm',
] as const

// Scenario: a component references a string key that has no en/messages.json entry, so the
// facade renders '' and the panel shows a blank; this pins every static key as a non-empty string.
// Coverage: integration (real `t` facade over the shipped EN messages).
test('t exposes all static keys as non-empty strings', () => {
  for (const k of STATIC_KEYS) {
    expect(typeof t[k], k).toBe('string')
    expect((t[k] as string).length, k).toBeGreaterThan(0)
  }
})
// Scenario: a dynamic string (e.g. capturedChunks(n)) is mistyped as a plain string, so
// calling it throws at runtime; this pins every dynamic key as a function.
// Coverage: integration (real `t` facade).
test('t exposes all dynamic keys as functions', () => {
  for (const k of FUNCTION_KEYS) expect(typeof t[k], k).toBe('function')
})
// Scenario: the search-by-meaning chips render from an array; an empty array would show no
// chips. Pin it as a 4-entry array of non-empty strings.
// Coverage: integration (real `t` facade).
test('t.obExampleQueries is a 4-entry non-empty string array', () => {
  expect(Array.isArray(t.obExampleQueries)).toBe(true)
  expect(t.obExampleQueries.length).toBe(4)
  for (const q of t.obExampleQueries) expect(q.length).toBeGreaterThan(0)
})
// The e2e suite (Playwright launches en-US Chrome, so chrome.i18n returns these EN messages)
// asserts these EXACT strings. They must stay byte-identical; this test is the canary if an EN
// wording change ever sneaks into messages.json. ASCII apostrophes only.
test('byte-identical e2e strings are preserved', () => {
  expect(t.captureButton).toBe('Capture this page')
  expect(t.updateButton).toBe('Update this page')
  expect(t.cannotCaptureButton).toBe("Can't save this page")
  expect(t.saving).toBe('Saving...')
  expect(t.savingHint).toBe('Saving can take a moment.')
  expect(t.saveRetry).toBe("Couldn't finish saving - it'll retry shortly.")
  expect(t.savedBadge).toBe('saved')
  expect(t.notSavedBadge).toBe('not saved yet')
  expect(t.pausedNote).toBe('Paused - nothing is being saved')
  expect(t.notSavedDenylisted).toBe('not saved: this site is on the no-remember list')
  expect(t.dontRememberSite).toBe("Don't remember this site")
  expect(t.forgetSiteHistory).toBe("Forget this site's history")
  expect(t.removeLabel).toBe('remove')
  expect(t.pauseLabel).toBe('Pause capturing')
  expect(t.wonRemember('example.com')).toBe("Won't remember example.com")
  expect(t.forgotEverythingFrom('example.com')).toBe('Forgot everything from example.com')
  expect(t.forgetConfirm('example.com'))
    .toBe('Delete ALL captured history from example.com and its subdomains? This cannot be undone.')
  expect(t.historyTabLabel).toBe('History')
  expect(t.loadMore).toBe('Load more')
  expect(t.settingsTabLabel).toBe('Settings')
  expect(t.searchTabLabel).toBe('Search')
  expect(t.cannotCapturePage).toBe("This page can't be saved")
  expect(t.reloadToCapture).toBe('Reload this page, then save it')
  expect(t.obSeedButton).toBe('Add 3 sample pages')
  expect(t.obSeeded).toBe('Sample pages added')
  expect(t.obRemoveDemo).toBe('Remove demo data')
  expect(t.obDemoRemoved).toBe('Demo data removed')
  expect(t.embedderUnavailable).toBe("On-device search isn't available on this device")
  expect(t.embedderSlow).toBe('Running in slow mode')
  // Onboarding inline prose pinned by onboarding.spec: the first example chip + the "side
  // panel" mention in the open-recall section.
  expect(t.obExampleQueries[0]).toBe('that article about sleep and cortisol')
  expect(t.obOpenText).toContain('side panel')
})
