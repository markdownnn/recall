export interface UIStrings {
  brand: string
  // Search
  searching: string
  noResults: string
  searchTabLabel: string       // the 'Search' tab label
  searchButtonLabel: string    // the accent Search button label
  searchButtonAria: string     // its aria-label
  historyTabLabel: string      // the 'History' tab label
  historyEmpty: string         // empty-state line when nothing is captured yet
  loadMore: string             // the load-more button
  // Capture + status
  captureButton: string
  updateButton: string          // label when the active page is already saved
  cannotCaptureButton: string   // disabled-button label for non-capturable schemes (chrome://, etc.)
  saving: string                // button + badge label while THIS page still has un-embedded chunks
  savingHint: string            // low-key note shown only while saving (first save can take a moment)
  indexed: string
  capturing: string
  capturedChunks: (n: number) => string
  nothingSubstantial: string
  nothingToCapture: string
  pausedNote: string
  notSavedDenylisted: string
  indexingProgress: (embedded: number) => string
  indexingAria: string          // aria-label for the indeterminate indexing indicator (NEW; additive)
  indexingFailed: (err: string) => string
  captureFailed: (err: string) => string
  cannotCapturePage: string     // friendly line for restricted pages (chrome://, etc.)
  reloadToCapture: string       // friendly line when a capturable tab has no content script yet
  searchFailed: (err: string) => string
  // SAVED badge (new; PAGE-scoped)
  savedBadge: string
  notSavedBadge: string
  // Model status
  loadingPercent: (pct: number) => string
  modelReady: string
  modelError: string
  // Embedder degraded banners (persistent). unavailable = no on-device search on this hardware;
  // slow = granite fell back to single-thread WASM.
  embedderUnavailable: string
  embedderSlow: string
  // Pause
  pauseLabel: string
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
  // Onboarding try-it card chrome (section prose lives inline in its renderer; these are the
  // live-card action + status labels)
  obSeedButton: string
  obSeeding: string
  obSeeded: string
  obSearchPlaceholder: string
  obRemoveDemo: string
  obDemoRemoved: string
}

export const EN: UIStrings = {
  brand: 'Recall',
  searching: 'searching...',
  noResults: 'no results',
  searchTabLabel: 'Search',
  searchButtonLabel: 'Search',
  searchButtonAria: 'Search',
  historyTabLabel: 'History',
  historyEmpty: 'Nothing captured yet - pages you save will show up here.',
  loadMore: 'Load more',
  captureButton: 'Capture this page',
  updateButton: 'Update this page',
  cannotCaptureButton: "Can't save this page",
  saving: 'Saving...',
  savingHint: 'Saving can take a moment.',
  indexed: 'indexed',
  capturing: 'capturing...',
  capturedChunks: (n) => `captured (indexing ${n} chunks...)`,
  nothingSubstantial: 'nothing substantial to capture',
  nothingToCapture: 'nothing to capture',
  pausedNote: 'Paused - nothing is being saved',
  notSavedDenylisted: 'not saved: this site is on the no-remember list',
  indexingProgress: (embedded) => `indexing... ${embedded} done`,
  indexingAria: 'Indexing in progress',
  indexingFailed: (err) => `indexing failed: ${err}`,
  captureFailed: (err) => `capture failed: ${err}`,
  cannotCapturePage: "This page can't be saved",
  reloadToCapture: "Reload this page, then save it",
  searchFailed: (err) => `search failed: ${err}`,
  savedBadge: 'saved',
  notSavedBadge: 'not saved yet',
  loadingPercent: (pct) => `Loading ${pct}%`,
  modelReady: 'Ready',
  modelError: 'Model error',
  embedderUnavailable: "On-device search isn't available on this device",
  embedderSlow: 'Running in slow mode',
  pauseLabel: 'Pause capturing',
  dontRememberSite: "Don't remember this site",
  alreadyOnListShort: 'Already on no-remember list',
  wonRemember: (host) => `Won't remember ${host}`,
  alreadyOnListHost: (host) => `Already on the no-remember list: ${host}`,
  forgetSiteHistory: "Forget this site's history",
  forgotEverythingFrom: (host) => `Forgot everything from ${host}`,
  forgetConfirm: (host) => `Delete ALL captured history from ${host} and its subdomains? This cannot be undone.`,
  noRememberSitesHeader: 'No-remember sites',
  removeLabel: 'remove',
  couldNotAdd: 'Could not add to no-remember list - please try again',
  couldNotRemove: 'Could not remove - please try again',
  couldNotForget: 'Could not forget - please try again',
  restrictedTabAdd: 'Cannot add this page (restricted tab)',
  restrictedTabForget: 'Cannot forget this page (restricted tab)',
  obSeedButton: 'Add 3 sample pages',
  obSeeding: 'adding sample pages...',
  obSeeded: 'Sample pages added',
  obSearchPlaceholder: 'Search what you just added...',
  obRemoveDemo: 'Remove demo data',
  obDemoRemoved: 'Demo data removed',
}

// English ships. Korean later = add a KO object + a two-line locale switch; no API now.
export const t: UIStrings = EN
