export interface UIStrings {
  brand: string
  // Search
  searching: string
  noResults: string
  searchTabLabel: string       // the 'Search' tab label
  searchButtonLabel: string    // the accent Search button label
  searchButtonAria: string     // its aria-label
  // Capture + status
  captureButton: string
  indexed: string
  capturing: string
  capturedChunks: (n: number) => string
  nothingSubstantial: string
  nothingToCapture: string
  pausedNote: string
  notSavedDenylisted: string
  indexingProgress: (embedded: number) => string
  indexingFailed: (err: string) => string
  captureFailed: (err: string) => string
  searchFailed: (err: string) => string
  // SAVED badge (new; PAGE-scoped)
  savedBadge: string
  notSavedBadge: string
  // Model status
  loadingPercent: (pct: number) => string
  modelReady: string
  modelError: string
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
}

export const EN: UIStrings = {
  brand: 'Recall',
  searching: 'searching...',
  noResults: 'no results',
  searchTabLabel: 'Search',
  searchButtonLabel: 'Search',
  searchButtonAria: 'Search',
  captureButton: 'Capture this page',
  indexed: 'indexed',
  capturing: 'capturing...',
  capturedChunks: (n) => `captured (indexing ${n} chunks...)`,
  nothingSubstantial: 'nothing substantial to capture',
  nothingToCapture: 'nothing to capture',
  pausedNote: 'Paused - nothing is being saved',
  notSavedDenylisted: 'not saved: this site is on the no-remember list',
  indexingProgress: (embedded) => `indexing... ${embedded} done`,
  indexingFailed: (err) => `indexing failed: ${err}`,
  captureFailed: (err) => `capture failed: ${err}`,
  searchFailed: (err) => `search failed: ${err}`,
  savedBadge: 'saved',
  notSavedBadge: 'not saved yet',
  loadingPercent: (pct) => `Loading ${pct}%`,
  modelReady: 'Ready',
  modelError: 'Model error',
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
}

// English ships. Korean later = add a KO object + a two-line locale switch; no API now.
export const t: UIStrings = EN
