import { EN } from '../../src/ui/sidepanel/strings'

const STATIC_KEYS = [
  'brand', 'searching', 'noResults', 'searchTabLabel', 'searchButtonLabel', 'searchButtonAria',
  'historyTabLabel', 'historyEmpty', 'loadMore',
  'captureButton', 'updateButton', 'cannotCaptureButton', 'saving', 'savingHint', 'indexed', 'capturing', 'nothingSubstantial', 'nothingToCapture',
  'pausedNote', 'notSavedDenylisted', 'savedBadge', 'notSavedBadge',
  'cannotCapturePage', 'reloadToCapture',
  'modelReady', 'modelError', 'embedderUnavailable', 'embedderSlow', 'pauseLabel',
  'dontRememberSite', 'alreadyOnListShort', 'forgetSiteHistory',
  'noRememberSitesHeader', 'removeLabel',
  'couldNotAdd', 'couldNotRemove', 'couldNotForget', 'restrictedTabAdd', 'restrictedTabForget',
  'obSeedButton', 'obSeeding', 'obSeeded',
  'obSearchPlaceholder', 'obRemoveDemo', 'obDemoRemoved',
] as const
const FUNCTION_KEYS = [
  'capturedChunks', 'indexingProgress', 'indexingFailed', 'captureFailed', 'searchFailed',
  'loadingPercent', 'wonRemember', 'alreadyOnListHost', 'forgotEverythingFrom', 'forgetConfirm',
] as const

// Scenario: a component references a string key that was never added to EN, so the panel
// renders `undefined`; this pins every static key as a present, non-empty string.
// Coverage: integration (real EN object).
test('EN exposes all static keys as non-empty strings', () => {
  for (const k of STATIC_KEYS) {
    expect(typeof EN[k], k).toBe('string')
    expect((EN[k] as string).length, k).toBeGreaterThan(0)
  }
})
// Scenario: a dynamic string (e.g. capturedChunks(n)) is mistyped as a plain string, so
// calling it throws at runtime; this pins every dynamic key as a function.
// Coverage: integration (real EN object).
test('EN exposes all dynamic keys as functions', () => {
  for (const k of FUNCTION_KEYS) expect(typeof EN[k], k).toBe('function')
})
// The e2e suite asserts these EXACT strings. They must stay byte-identical; this test is
// the canary if a wording change ever sneaks into strings.ts.
test('byte-identical e2e strings are preserved', () => {
  expect(EN.captureButton).toBe('Capture this page')
  expect(EN.updateButton).toBe('Update this page')
  expect(EN.cannotCaptureButton).toBe("Can't save this page")
  // Scenario: the per-page "Saving..." button/badge label + its hint are asserted by the e2e
  // (per-page-state, recall-flow); a wording change here must fail loudly. ASCII only.
  // Coverage: integration (real EN object).
  expect(EN.saving).toBe('Saving...')
  expect(EN.savingHint).toBe('Saving can take a moment.')
  expect(EN.savedBadge).toBe('saved')
  expect(EN.notSavedBadge).toBe('not saved yet')
  expect(EN.indexed).toBe('indexed')
  expect(EN.capturedChunks(3)).toBe('captured (indexing 3 chunks...)')
  expect(EN.indexingProgress(5)).toBe('indexing... 5 done')
  expect(EN.pausedNote).toBe('Paused - nothing is being saved')
  expect(EN.notSavedDenylisted).toBe('not saved: this site is on the no-remember list')
  expect(EN.dontRememberSite).toBe("Don't remember this site")
  expect(EN.forgetSiteHistory).toBe("Forget this site's history")
  expect(EN.removeLabel).toBe('remove')
  expect(EN.pauseLabel).toBe('Pause capturing')
  expect(EN.wonRemember('example.com')).toBe("Won't remember example.com")
  expect(EN.forgotEverythingFrom('example.com')).toBe('Forgot everything from example.com')
  expect(EN.forgetConfirm('example.com'))
    .toBe('Delete ALL captured history from example.com and its subdomains? This cannot be undone.')
  // Scenario: the History tab label + Load-more button are asserted verbatim by the e2e;
  // a wording change here must fail loudly.
  // Coverage: integration (real EN object).
  expect(EN.historyTabLabel).toBe('History')
  expect(EN.loadMore).toBe('Load more')
  // Scenario: the two capture-guard lines are user-facing copy; pin them so a wording
  // drift is caught. ASCII apostrophes only.
  // Coverage: integration (real EN object).
  expect(EN.cannotCapturePage).toBe("This page can't be saved")
  expect(EN.reloadToCapture).toBe('Reload this page, then save it')
  // Scenario: the onboarding try-it card's seed button + status lines are asserted verbatim
  // by the interactive e2e; a wording change here must fail loudly.
  // Coverage: integration (real EN object).
  expect(EN.obSeedButton).toBe('Add 3 sample pages')
  expect(EN.obSeeded).toBe('Sample pages added')
  expect(EN.obRemoveDemo).toBe('Remove demo data')
  expect(EN.obDemoRemoved).toBe('Demo data removed')
  // Scenario: the degraded-embedder banners are user-facing copy that tell the user search is
  // broken / slow; pin them so a wording drift is caught. ASCII apostrophes only.
  // Coverage: integration (real EN object).
  expect(EN.embedderUnavailable).toBe("On-device search isn't available on this device")
  expect(EN.embedderSlow).toBe('Running in slow mode')
})
