# i18n Readiness: Ship English, Strings Extracted, Korean-Ready

> **SUPERSEDED / FOLDED IN (2026-06-30):** This plan is redundant. Its work now lives inside `docs/superpowers/plans/2026-06-30-side-panel-migration.md` (`src/ui/sidepanel/strings.ts` is a required module; shape test at `tests/core/strings.test.ts`). Do not execute this plan; kept for history only.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Dependency: Execute AFTER the "side-panel migration" lands.** This plan extracts strings from the SIDE PANEL (`src/ui/sidepanel/App.tsx`) — not the popup (`src/ui/popup/App.tsx`) which that migration will delete. Do not start until the side-panel branch is merged into `recall-walking-skeleton`.

**Goal:** Extract every user-facing UI string from the side-panel components into a single typed module (`src/ui/strings.ts`), shipping byte-identical English while making Korean (or any locale) a cheap add-on later.

**Architecture:** UI-layer only. `src/core` is untouched — no new ports, no new messages, no background changes. `strings.ts` is a pure TypeScript data file. A typed `UIStrings` interface means adding `KO` later gets full type-checking for free. The `t` export is just `EN` for now; the two-line locale switch is the only future change needed.

**Tech Stack:** TypeScript (`as const` + interface), Vitest (unit test), Playwright (e2e gate).

**Critical constraint:** The rendered English text must be **byte-identical** to what it replaces. The e2e suite asserts on exact strings: `'Capture this page'`, `'indexed'`, `'not saved: this site is on the no-remember list'`, `'remove'`, `"Don't remember this site"`, `"Forget this site's history"`, `'recall...'`, `'Pause capturing'`, and others. This is a pure refactor of where a literal lives — not a wording change. If any e2e test fails after Task 2, a string value was accidentally changed; fix the `strings.ts` entry to match the original exactly.

**Out of scope (separate follow-up, do not plan here):** Localizing the extension manifest `name`/`description` and the Chrome Web Store listing. That requires Chrome's native `_locales/<lang>/messages.json` + `__MSG_x__` placeholder mechanism — a different deliverable, a different plan.

---

## File Map

```
src/ui/strings.ts                         CREATE: UIStrings interface + EN object + t accessor
tests/ui/strings.test.ts                  CREATE: shape/key presence unit test
src/ui/sidepanel/App.tsx                  MODIFY: inline literals -> t.x or t.x(arg) references
  (plus any sibling *.tsx files that carry user-facing copy after the migration)
```

---

## Task 1: Create src/ui/strings.ts (TDD-lite)

**Files:**
- Create: `src/ui/strings.ts`
- Create (test): `tests/ui/strings.test.ts`

- [ ] **Step 1: Write the failing test first**

**Scenario:** A contributor adding a new UI string must know which file to edit, and a future `KO` object must be type-checked against the same shape. This test proves the module exports the expected keys with non-empty string or function values.
**Coverage:** integration (real module import; structural key check).

```ts
// tests/ui/strings.test.ts
import { EN } from '../../src/ui/strings'

const STATIC_KEYS = [
  'brand',
  'searchPlaceholder',
  'searching',
  'noResults',
  'captureButton',
  'indexed',
  'nothingSubstantial',
  'nothingToCapture',
  'pausedNote',
  'notSavedDenylisted',
  'modelReady',
  'modelError',
  'pauseLabel',
  'dontRememberSite',
  'alreadyOnListShort',
  'forgetSiteHistory',
  'noRememberSitesHeader',
  'removeLabel',
  'couldNotAdd',
  'couldNotRemove',
  'couldNotForget',
  'restrictedTabAdd',
  'restrictedTabForget',
] as const

const FUNCTION_KEYS = [
  'capturedChunks',
  'indexingProgress',
  'indexingFailed',
  'loadingPercent',
  'wonRemember',
  'alreadyOnListHost',
  'forgotEverythingFrom',
] as const

test('EN exports all expected static string keys as non-empty strings', () => {
  for (const k of STATIC_KEYS) {
    expect(typeof EN[k], k).toBe('string')
    expect((EN[k] as string).length, k).toBeGreaterThan(0)
  }
})

test('EN exports all expected dynamic keys as functions', () => {
  for (const k of FUNCTION_KEYS) {
    expect(typeof EN[k], k).toBe('function')
  }
})

test('dynamic string functions return non-empty strings', () => {
  expect(EN.capturedChunks(3)).toBe('captured (indexing 3 chunks...)')
  expect(EN.indexingProgress(5)).toBe('indexing... 5 done')
  expect(EN.loadingPercent(42)).toBe('Loading 42%')
  expect(EN.wonRemember('example.com')).toBe("Won't remember example.com")
  expect(EN.forgotEverythingFrom('example.com')).toBe('Forgot everything from example.com')
  expect(EN.alreadyOnListHost('example.com')).toBe('Already on the no-remember list: example.com')
  expect(typeof EN.indexingFailed('boom')).toBe('string')
})
```

Run: `npx vitest run tests/ui/strings.test.ts`
Expected: FAIL (module does not exist yet).

- [ ] **Step 2: Create strings.ts**

```ts
// src/ui/strings.ts

export interface UIStrings {
  // Brand
  brand: string

  // Search
  searchPlaceholder: string
  searching: string
  noResults: string

  // Capture button + capture status
  captureButton: string
  indexed: string
  capturedChunks: (n: number) => string
  nothingSubstantial: string
  nothingToCapture: string
  pausedNote: string
  notSavedDenylisted: string
  indexingProgress: (embedded: number) => string
  indexingFailed: (err: string) => string

  // Model status
  loadingPercent: (pct: number) => string
  modelReady: string
  modelError: string

  // Pause toggle
  pauseLabel: string

  // Site controls
  dontRememberSite: string
  alreadyOnListShort: string
  wonRemember: (host: string) => string
  alreadyOnListHost: (host: string) => string
  forgetSiteHistory: string
  forgotEverythingFrom: (host: string) => string

  // Denylist editor
  noRememberSitesHeader: string
  removeLabel: string

  // Error/status messages
  couldNotAdd: string
  couldNotRemove: string
  couldNotForget: string
  restrictedTabAdd: string
  restrictedTabForget: string
}

export const EN: UIStrings = {
  brand: 'Recall',

  searchPlaceholder: 'recall...',
  searching: 'searching...',
  noResults: 'no results',

  captureButton: 'Capture this page',
  indexed: 'indexed',
  capturedChunks: (n) => `captured (indexing ${n} chunks...)`,
  nothingSubstantial: 'nothing substantial to capture',
  nothingToCapture: 'nothing to capture',
  pausedNote: 'Paused - nothing is being saved',
  notSavedDenylisted: 'not saved: this site is on the no-remember list',
  indexingProgress: (embedded) => `indexing... ${embedded} done`,
  indexingFailed: (err) => `indexing failed: ${err}`,

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

  noRememberSitesHeader: 'No-remember sites',
  removeLabel: 'remove',

  couldNotAdd: 'Could not add to no-remember list - please try again',
  couldNotRemove: 'Could not remove - please try again',
  couldNotForget: 'Could not forget - please try again',
  restrictedTabAdd: 'Cannot add this page (restricted tab)',
  restrictedTabForget: 'Cannot forget this page (restricted tab)',
}

// Trivial accessor — returns EN for now (English ships).
// To add Korean: add a KO object implementing UIStrings, then replace this line with:
//   export function t(): UIStrings {
//     return chrome.i18n.getUILanguage().startsWith('ko') ? KO : EN
//   }
// and update every call site from `t.x` to `t().x`.
export const t: UIStrings = EN
```

- [ ] **Step 3: Run, watch pass**

Run: `npx vitest run tests/ui/strings.test.ts`
Expected: PASS (all 3 tests green).

- [ ] **Step 4: Commit**

```bash
git add src/ui/strings.ts tests/ui/strings.test.ts
git commit -m "feat(ui): strings.ts typed EN object + shape test (i18n readiness)"
```

---

## Task 2: Replace inline literals in the side-panel UI

**Files:**
- Modify: `src/ui/sidepanel/App.tsx` (and any sibling `*.tsx` files with user-facing copy)

This task is a mechanical substitution. Nothing should change in the browser — the rendered text is byte-identical. The e2e suite is the proof.

- [ ] **Step 1: Import t at the top of App.tsx**

Add at the top of `src/ui/sidepanel/App.tsx` (adjust relative path to match actual file location):

```ts
import { t } from '../strings'
```

- [ ] **Step 2: Replace every inline literal**

Go through the file and swap each English literal for its `t` reference. Use this mapping:

| Old inline literal | New reference |
|---|---|
| `'Recall'` (brand span) | `{t.brand}` |
| `placeholder="recall..."` | `placeholder={t.searchPlaceholder}` |
| `'searching...'` | `{t.searching}` |
| `'no results'` | `{t.noResults}` |
| `'Capture this page'` (button) | `{t.captureButton}` |
| `setStatus('indexed')` | `setStatus(t.indexed)` |
| `` setStatus(`indexing... ${msg.embedded} done`) `` | `setStatus(t.indexingProgress(msg.embedded))` |
| `` setStatus(`indexing failed: ${msg.error}`) `` | `setStatus(t.indexingFailed(msg.error))` |
| `` setStatus(`captured (indexing ${res.chunkCount} chunks...)`) `` | `setStatus(t.capturedChunks(res.chunkCount))` |
| `'Paused - nothing is being saved'` (status) | `t.pausedNote` |
| `'not saved: this site is on the no-remember list'` | `t.notSavedDenylisted` |
| `'nothing substantial to capture'` | `t.nothingSubstantial` |
| `'nothing to capture'` | `t.nothingToCapture` |
| `` `Loading ${modelStatus.percent}%` `` | `t.loadingPercent(modelStatus.percent)` |
| `'Model error'` | `t.modelError` |
| `'Ready'` | `t.modelReady` |
| `'Pause capturing'` (label) | `{t.pauseLabel}` |
| `'Paused - nothing is being saved'` (note div) | `{t.pausedNote}` |
| `"Don't remember this site"` | `{t.dontRememberSite}` |
| `'Already on no-remember list'` | `{t.alreadyOnListShort}` |
| `"Forget this site's history"` | `{t.forgetSiteHistory}` |
| `` setDenyStatus(`Won't remember ${host}`) `` | `setDenyStatus(t.wonRemember(host))` |
| `` setDenyStatus(`Already on the no-remember list: ${host}`) `` | `setDenyStatus(t.alreadyOnListHost(host))` |
| `` setDenyStatus(`Forgot everything from ${host}`) `` | `setDenyStatus(t.forgotEverythingFrom(host))` |
| `'Could not add to no-remember list - please try again'` | `t.couldNotAdd` |
| `'Could not remove - please try again'` | `t.couldNotRemove` |
| `'Could not forget - please try again'` | `t.couldNotForget` |
| `'Cannot add this page (restricted tab)'` | `t.restrictedTabAdd` |
| `'Cannot forget this page (restricted tab)'` | `t.restrictedTabForget` |
| `'No-remember sites'` (denylist header) | `{t.noRememberSitesHeader}` |
| `'remove'` (denylist button) | `{t.removeLabel}` |

If the side-panel migration landed any strings not in this table, add them to `EN` in `strings.ts` first (following the same pattern), add a key check to the test, then reference them here. Do not skip the test update.

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: zero errors. Any error here means a key name was misspelled or the type of `t.x` doesn't match what the JSX attribute expects (string vs function) — fix accordingly.

- [ ] **Step 4: Unit test suite**

Run: `npm run test`
Expected: all green. No core tests were touched; the strings shape test should still pass.

- [ ] **Step 5: Full e2e suite (the real gate)**

Run: `npm run build && npx playwright test`
Expected: all green.

The e2e tests assert on exact rendered text. If any test fails here, it means a string value was accidentally changed (not just moved). Diff the failure message against the original literal, find the mismatch in `strings.ts`, and correct it. Do not change the test — fix the string.

- [ ] **Step 6: Commit**

```bash
git add src/ui/sidepanel/App.tsx  # add any other modified .tsx files
git commit -m "refactor(ui): replace inline literals with t references (i18n readiness)"
```

---

## Self-Review

**Spec coverage:**
- Single typed strings module at `src/ui/strings.ts`: Task 1. Done.
- English ships unchanged (byte-identical): Task 1 (values) + Task 2 (e2e gate). Done.
- Every user-facing string covered: `UIStrings` interface + Task 2 mapping table. Done.
- `src/core` untouched: no core files in File Map. Done.
- Test code ASCII-only: test file uses only ASCII. Done.
- Future Korean path documented: inline comment in `strings.ts` + Self-Review note below. Done.
- Manifest/store-listing out of scope: stated in header + note below. Done.

**Adding Korean later (not now):**
1. Add `export const KO: UIStrings = { ... }` in `src/ui/strings.ts` — TypeScript enforces the same shape via the interface.
2. Replace `export const t: UIStrings = EN` with:
   ```ts
   export function t(): UIStrings {
     return chrome.i18n.getUILanguage().startsWith('ko') ? KO : EN
   }
   ```
3. Update every call site from `t.x` / `t.x(arg)` to `t().x` / `t().x(arg)`. That is the entire change.

**Separate follow-up (manifest + Web Store listing):** Chrome's `__MSG_x__` mechanism requires `_locales/en/messages.json` and `_locales/ko/messages.json` files, and `__MSG_appName__` placeholders in `manifest.json`. This is independent of the `strings.ts` approach (which only covers UI strings rendered by React/Preact components) and needs its own plan when the time comes.

**Risks:**
- If the side-panel migration adds new strings not listed in the mapping table above, Task 2 Step 2 directs the implementor to add them to `strings.ts` and the test before referencing them. The TypeScript interface enforces shape consistency.
- The `t().x` refactor in the future Korean step touches every call site. That is a search-replace — straightforward but mechanical. Plan it as its own task when Korean ships.
