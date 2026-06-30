# Side-Panel Migration: drop the popup, action opens the panel, Search v1, tab-ready

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Every code change is TDD where the logic is pure: failing test FIRST, watched fail, then implementation. Browser-glue steps (Chrome side-panel API, tab listeners, active-tab reactivity) carry a `Coverage: N/A` justification - never "manual check". Steps use checkbox (`- [ ]`).

**Goal:** Move the whole UI from a 360px popup to a persistent **side panel**. One surface, three structural pieces top-to-bottom:
1. A compact **"this page" bar** that REACTS to the active tab (host + SAVED badge + Capture + the page-scoped privacy controls).
2. A **Tabs scaffold** that renders a tab bar but ships only the **Search** tab in v1, wired so a **History** (and later Settings) tab is a tiny additive change.
3. **Search** as the hero (prominent input + accent Search button + rotating suggested-query placeholder + `<article>` result cards).

The toolbar icon now OPENS THE PANEL (no popup). The capture shortcut (Cmd/Ctrl+Shift+U) is unchanged. All existing handlers (search, capture, pause, denyHost, removeDeny, forgetHost) move into the panel with identical behavior; the page-scoped ones target the active tab the bar is showing.

**Tech Stack:** TypeScript, Vite+CRXJS, Preact, `@huggingface/transformers`, `@sqlite.org/sqlite-wasm` (OPFS), Vitest, Playwright. No new runtime deps.

**Current baseline (verify before starting):** `npm run test` green; `npx playwright test` green (8 e2e specs, all open `chrome-extension://<id>/src/ui/popup/index.html`).

---

## Confirmed decisions (bake these in - read first)

- **No popup.** Drop `action.default_popup`. Keep a bare `action` so the toolbar icon still exists and is clickable. Add the `sidePanel` permission and `"side_panel": { "default_path": "src/ui/sidepanel/index.html" }`. In the service worker, call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on `onInstalled` AND `onStartup` (the SW is not durable, so set it on both). Clicking the icon then opens the panel - no JS click handler needed for the common path.
- **Commands.** Keep `capture-page` (Cmd/Ctrl+Shift+U) exactly as-is (captures the active tab, no UI). Replace the reserved `_execute_action` (which only ever opened the popup) with a custom `open-panel` command (Cmd/Ctrl+Shift+K). Its SW handler calls `chrome.sidePanel.open({ windowId })` - a command IS a user gesture, so `open()` is allowed. Resolve `windowId` from the active tab in the handler.
- **One surface, controls VISIBLE (not in a closed menu).** The page-scoped controls (Capture, Pause, Don't remember this site, Forget this site's history, the no-remember list + each `remove`) render INLINE / always-visible in v1 - NOT inside a closed `<details>` or a closed `...` overflow. This is a hard requirement: the privacy e2e assert `toHaveCount(0)` and `.click()` against these controls, and a control hidden in a closed menu would make `toHaveCount(0)` falsely pass and `.click()` fail (the documented earlier lesson). A `...` overflow is a FUTURE enhancement; if it ever lands, the e2e must open it first.
- **Active-tab reactivity.** The panel persists across tab switches (unlike the popup, which re-read on each open). The bar must refresh on `chrome.tabs.onActivated` and `chrome.tabs.onUpdated`, plus once on mount. This is browser glue (Coverage N/A); the only pure piece (hostOf, the SAVED-badge query contract) is unit-tested.
- **Saved badge = a real backend round-trip.** "Saved" means the store already has this page. New `VectorSearchPort.hasPage(pageId)` -> memory impl + worker `hasPage` op + adapter + offscreen `has-page` op + messaging `{type:'has-page',url}` -> `{type:'page-status',exists}` + SW relay. The offscreen op normalizes the url with the SAME `pageIdFromUrl` that capture used to store the page, so the badge can't drift from what was saved.
- **Light styling reused.** The current `popup.css` is clean bespoke LIGHT CSS (NOT Pico). Rename/adapt it into `sidepanel.css`. The panel is wider than 360px, so the body uses a FLUID min-width layout (e.g. `min-width: 320px; max-width: 480px; width: 100%`), not a hard `width: 360px`.
- **i18n-readiness (light, NOT a task).** Keep all UI strings English for v1. Optionally collect them in a tiny `strings.ts` object so Korean can be added cheaply later. Do NOT build a real i18n system. Whatever path, the exact e2e-relied strings stay byte-identical (`Capture this page`, `Don't remember this site`, `Forget this site's history`, `not saved: this site is on the no-remember list`, `won't remember ...`, `Forgot everything from ...`, status `captured`/`indexed`, etc.).

---

## Tab extensibility (explicit - how History/Settings slot in later)

Structure the tab state so adding a tab is a 3-line change, not a refactor:

```tsx
// src/ui/sidepanel/Tabs.tsx (scaffold)
export type TabKey = 'search' // later: | 'history' | 'settings'
export const TABS: { key: TabKey; label: string }[] = [
  { key: 'search', label: 'Search' },
  // later: { key: 'history', label: 'History' },
]
```
`SidePanel` holds `const [tab, setTab] = useState<TabKey>('search')`, renders the bar from `TABS.map(...)`, and switches content:
```tsx
{tab === 'search' && <SearchTab />}
// later: {tab === 'history' && <HistoryTab />}
```
**Adding History later = (1) extend the `TabKey` union, (2) push one row into `TABS`, (3) add one `{tab === 'history' && ...}` line + the new component.** No change to the bar, the switch wiring, or any other file. The tab bar renders even with a single tab so the scaffold is visible and the wiring is exercised from day one.

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `manifest.config.ts` | Modify | Drop `action.default_popup` (keep bare `action`); add `sidePanel` permission + `side_panel.default_path`; replace `_execute_action` command with `open-panel`; keep `capture-page`. |
| `src/background/index.ts` | Modify | `setPanelBehavior({openPanelOnActionClick:true})` on install+startup; `open-panel` command -> `chrome.sidePanel.open({windowId})`; relay `has-page` -> offscreen `has-page` -> `page-status`; add `has-page` to the handled-types guard. |
| `src/messaging.ts` | Modify | Add `Msg` `{type:'has-page';url}` and `MsgResult` `{type:'page-status';exists:boolean}`. Rename the popup-facing comments to "panel". |
| `src/core/ports.ts` | Modify | Add `hasPage(pageId: string): Promise<boolean>` to `VectorSearchPort`. |
| `src/adapters/memory-vector-store.ts` | Modify | Implement `hasPage` = `this.pages.has(pageId)`. |
| `src/offscreen/sqlite-worker.ts` | Modify | Add `opHasPage` (`SELECT 1 FROM pages WHERE id=? LIMIT 1`) + a `hasPage` row in the handler map. |
| `src/offscreen/worker-vector-store.ts` | Modify | Add `hasPage = (pageId) => this.c.request<boolean>('hasPage', pageId)`. |
| `src/offscreen/offscreen.ts` | Modify | Add `has-page` op: `pageIdFromUrl(url)` -> `store.hasPage(pageId)` -> `{exists}`. |
| `src/core/capture-service.ts` | Modify | `export` `pageIdFromUrl` (so the offscreen badge query uses the identical normalization). Behavior unchanged. |
| `src/ui/sidepanel/index.html` | Create | Mount node `#app` + module script; fluid width; `lang="en"`. |
| `src/ui/sidepanel/main.tsx` | Create | Import `./sidepanel.css`, render `<SidePanel/>` into `#app`. |
| `src/ui/sidepanel/SidePanel.tsx` | Create | Root: holds model status + the `tab` state; renders `ThisPageBar`, the tab bar from `TABS`, and the active tab's content. |
| `src/ui/sidepanel/ThisPageBar.tsx` | Create | Active-tab-reactive bar: host + SAVED badge + Capture + Pause + Don't-remember + Forget + no-remember list (all visible). Owns the page-scoped handlers + `has-page` round-trip + tab listeners. |
| `src/ui/sidepanel/Tabs.tsx` | Create | `TabKey` union + `TABS` array + the presentational tab bar. The single extension point for future tabs. |
| `src/ui/sidepanel/SearchTab.tsx` | Create | Search hero: searchbox + accent Search button (icon), Enter-to-search, rotating suggested-query placeholder, `<article>` result cards. |
| `src/ui/sidepanel/suggestions.ts` | Create | Pure: `SUGGESTIONS: string[]` (~10 English), `randomIndex(len, rng)`, `nextIndex(cur, len)`. |
| `src/ui/sidepanel/sidepanel.css` | Create | Adapted from `popup.css`; fluid width (no fixed 360px); same clean light look + accent Search button. |
| `src/ui/sidepanel/strings.ts` | Create (optional, light) | English UI strings object (i18n-readiness only; exact e2e strings preserved). Skip if it adds noise. |
| `src/ui/popup/App.tsx` | Delete | Replaced by the sidepanel components. |
| `src/ui/popup/main.tsx` | Delete | Replaced by `src/ui/sidepanel/main.tsx`. |
| `src/ui/popup/popup.css` | Delete | Renamed/adapted into `sidepanel.css`. |
| `src/ui/popup/index.html` | Delete | Replaced by `src/ui/sidepanel/index.html`. |
| `tests/core/memory-vector-store.test.ts` | Modify | Add `hasPage` contract tests (RED first). |
| `tests/core/suggestions.test.ts` | Create | Pure tests for `randomIndex`/`nextIndex` (RED first). |
| `tests/e2e/recall-flow.spec.ts` | Modify | popup path -> sidepanel path; `getByPlaceholder('recall...')` -> `getByRole('searchbox')`. |
| `tests/e2e/persistence.spec.ts` | Modify | Same path + searchbox swap (2 popup pages). |
| `tests/e2e/hybrid-search.spec.ts` | Modify | Same path + searchbox swap. |
| `tests/e2e/forget-history.spec.ts` | Modify | Same path + searchbox swap (keeps the `toHaveCount(0)` privacy asserts). |
| `tests/e2e/user-controls.spec.ts` | Modify | Same path + searchbox swap; deny/forget/remove locators stay (controls are visible). |
| `tests/e2e/spa-navigation.spec.ts` | Modify | Same path + searchbox swap. |
| `tests/e2e/auto-capture.spec.ts` | Modify | Same path + searchbox swap. |
| `tests/e2e/serp-skip.spec.ts` | Modify | Same path + searchbox swap. |

**NOT touched:** `src/core/recall-service.ts`, `src/core/ranking.ts`, `src/core/cosine.ts`, `src/core/rrf.ts`, the content script, `offscreen-rpc.ts`, the chunker/gate. Results markup stays `<article>` (no e2e result-locator churn).

---

## Task 1: Manifest + service worker (panel opens on icon click; commands)

Browser glue only - no pure logic - so this task has no unit test; it is exercised by the migrated e2e (which load the built extension and drive the side panel page) and by the build.

**Files:** Modify `manifest.config.ts`, `src/background/index.ts`.

- [ ] **Step 1: manifest (`manifest.config.ts`)**
  - Replace `action: { default_popup: 'src/ui/popup/index.html' }` with `action: {}` (bare; keeps a clickable toolbar icon, no popup).
  - Add `"side_panel": { default_path: 'src/ui/sidepanel/index.html' }`.
  - Add `'sidePanel'` to `permissions` (now `['unlimitedStorage', 'activeTab', 'offscreen', 'sidePanel']`).
  - In `commands`, delete `_execute_action`; add:
    ```ts
    'open-panel': {
      suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
      description: 'Open the Recall side panel',
    },
    ```
    Keep `capture-page` unchanged. Update the comment block (it currently says "_execute_action opens the popup").

- [ ] **Step 2: SW panel behavior + open-panel command (`src/background/index.ts`)**
  - Add, inside both `onInstalled` and `onStartup` listeners (alongside `prewarm`):
    ```ts
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
    ```
  - Extend the existing `chrome.commands.onCommand` listener so `open-panel` opens the panel for the active window (a command is a user gesture, so `open()` is allowed). Resolve `windowId` from the active tab:
    ```ts
    if (command === 'open-panel') {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId })
      })
      return
    }
    ```
    Keep the `capture-page` branch exactly as-is. Update the stale `_execute_action` comment.

- [ ] **Step 3: relay `has-page` (depends on Task 2's messaging types)**
  - Add `'has-page'` to the handled-types guard (the `msg.type !== ...` chain).
  - Add a dispatch branch:
    ```ts
    } else if (msg.type === 'has-page') {
      const r = await callOffscreen<{ exists: boolean }>({ op: 'has-page', url: msg.url })
      sendResponse({ type: 'page-status', exists: r.exists } satisfies MsgResult)
    }
    ```
  (Do this after Task 2 Step 1 adds the types, or `tsc` will complain.)

  > Scenario: clicking the toolbar icon / pressing Cmd+Shift+K opens the panel, and the SW answers the badge's `has-page` query.
  > Coverage: N/A - pure Chrome-API glue (`sidePanel`, `commands`, message relay); no real-path unit harness exists (mirrors the existing capture/recall relay, which is also covered only by e2e + build). Exercised end-to-end by the migrated Playwright specs and `npm run build`.

---

## Task 2: Saved-badge backend (vertical slice, TDD where pure)

The badge needs a true/false answer: does the store already have this page? Add it as a port method, TDD the pure memory impl, then mirror it through the worker / offscreen / messaging / SW glue.

**Files:** Modify `tests/core/memory-vector-store.test.ts` (test FIRST), `src/core/ports.ts`, `src/adapters/memory-vector-store.ts`, `src/offscreen/sqlite-worker.ts`, `src/offscreen/worker-vector-store.ts`, `src/offscreen/offscreen.ts`, `src/core/capture-service.ts`, `src/messaging.ts`.

- [ ] **Step 1 (RED): hasPage contract test (`tests/core/memory-vector-store.test.ts`)**

  ```ts
  // Scenario: the side panel shows a SAVED badge for the current tab. The badge asks the
  // store "do we already have this page?"; it is false before capture and true after.
  // Coverage: integration (real MemoryVectorStore - the VectorSearchPort contract).
  test('hasPage is false until a page is upserted, then true', async () => {
    const store = new MemoryVectorStore()
    expect(await store.hasPage('p1')).toBe(false)
    await store.upsertPage({ id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 })
    expect(await store.hasPage('p1')).toBe(true)
    expect(await store.hasPage('nope')).toBe(false)
  })
  ```
  Run `npx vitest run tests/core/memory-vector-store.test.ts` -> fails (no `hasPage` yet; TS/`undefined` error).

- [ ] **Step 2 (GREEN): port + memory impl**
  - `src/core/ports.ts`: add to `VectorSearchPort`:
    ```ts
    // True if this page id is already stored (drives the panel's SAVED badge).
    hasPage(pageId: string): Promise<boolean>
    ```
  - `src/adapters/memory-vector-store.ts`:
    ```ts
    async hasPage(pageId: string): Promise<boolean> {
      return this.pages.has(pageId)
    }
    ```
  Re-run Step 1 -> green.

- [ ] **Step 3: worker op + adapter**
  - `src/offscreen/sqlite-worker.ts`: add a handler. A single-row existence probe:
    ```ts
    function opHasPage(db: any, pageId: string): boolean {
      let exists = false
      db.exec({ sql: `SELECT 1 FROM pages WHERE id = ? LIMIT 1`, bind: [pageId],
        rowMode: 'array', callback: () => { exists = true } })
      return exists
    }
    ```
    Add `hasPage: (db, args) => opHasPage(db, args as string),` to the `handlers` map.
  - `src/offscreen/worker-vector-store.ts`: add
    ```ts
    hasPage = (pageId: string) => this.c.request<boolean>('hasPage', pageId)
    ```

  > Scenario: the persistent OPFS store answers the badge query for a saved page.
  > Coverage: N/A - sqlite-wasm + OPFS only run inside the offscreen document; the unit env has no OPFS. This is the mirror of the memory-store contract test (Step 1), which pins the same behavior on the pure adapter. (Same justification the existing worker ops carry.)

- [ ] **Step 4: export `pageIdFromUrl` (`src/core/capture-service.ts`)**
  Change `function pageIdFromUrl` to `export function pageIdFromUrl`. No behavior change. The offscreen badge op imports THIS so the badge's id matches exactly what capture stored (hash/credentials stripped identically).

- [ ] **Step 5: offscreen op (`src/offscreen/offscreen.ts`)**
  ```ts
  if (op === 'has-page') {
    const pageId = pageIdFromUrl(p.url as string)
    return { exists: await store.hasPage(pageId) }
  }
  ```
  Add `import { pageIdFromUrl } from '../core/capture-service'`.

  > Scenario: the offscreen normalizes the tab url the same way capture did, then asks the store.
  > Coverage: N/A - offscreen RPC dispatch glue; `pageIdFromUrl` itself is pure and already covered by capture tests.

- [ ] **Step 6: messaging types (`src/messaging.ts`)**
  - Add to `Msg`: `| { type: 'has-page'; url: string }`.
  - Add to `MsgResult`: `| { type: 'page-status'; exists: boolean }`.
  (Task 1 Step 3 consumes these.)

---

## Task 3: Suggestions helper (pure, TDD)

The search box rotates through example queries: random on mount, then a gentle 1-step rotation every ~5s while the box is empty and unfocused. The index math is pure and testable; the timer + focus/empty gating is glue.

**Files:** Create `tests/core/suggestions.test.ts` (test FIRST), `src/ui/sidepanel/suggestions.ts`.

- [ ] **Step 1 (RED): `tests/core/suggestions.test.ts`**

  ```ts
  import { SUGGESTIONS, nextIndex, randomIndex } from '../../src/ui/sidepanel/suggestions'

  // Scenario: the placeholder cycles through example queries; rotation must wrap, never
  // run off the end of the list.
  // Coverage: integration (pure index math).
  test('nextIndex advances by one and wraps at the end', () => {
    expect(nextIndex(0, SUGGESTIONS.length)).toBe(1)
    expect(nextIndex(SUGGESTIONS.length - 1, SUGGESTIONS.length)).toBe(0)
  })

  // Scenario: a fresh panel starts on a RANDOM suggestion (not always the first), but the
  // chosen index must be a valid position in the list.
  // Coverage: integration (pure; injected rng makes it deterministic).
  test('randomIndex maps rng into an in-range position', () => {
    expect(randomIndex(SUGGESTIONS.length, () => 0)).toBe(0)
    expect(randomIndex(SUGGESTIONS.length, () => 0.999)).toBe(SUGGESTIONS.length - 1)
  })

  // Scenario: there must actually be a list to rotate (guards an empty-array regression
  // that would make the placeholder blank forever).
  // Coverage: integration (pure).
  test('ships about ten English suggestions', () => {
    expect(SUGGESTIONS.length).toBeGreaterThanOrEqual(8)
    for (const s of SUGGESTIONS) expect(s.length).toBeGreaterThan(0)
  })
  ```
  Run -> fails (module missing). Stub the module first to see clean assertion-RED if preferred.

- [ ] **Step 2 (GREEN): `src/ui/sidepanel/suggestions.ts`**
  ```ts
  // Rotating example queries for the search placeholder. Kept ASCII/English for v1.
  export const SUGGESTIONS = [
    'that article about sleep and cortisol',
    'double entry bookkeeping basics',
    'how photosynthesis works',
    'the marsupial reproduction page',
    'notes on RRF hybrid search',
    'local-first browser extensions',
    'OPFS sqlite performance',
    'WebGPU embedding models',
    'paragraph chunking strategy',
    'that thing about service workers',
  ]

  // Pure index helpers so the rotation logic is testable without a timer or a DOM.
  export function randomIndex(len: number, rng: () => number = Math.random): number {
    return Math.min(len - 1, Math.floor(rng() * len))
  }
  export function nextIndex(cur: number, len: number): number {
    return (cur + 1) % len
  }
  ```
  Re-run -> green. `rg "chrome" src/ui/sidepanel/suggestions.ts` is empty (pure).

---

## Task 4: Side panel UI

Build the new surface. Reuse the popup handlers and the exact e2e-relied strings; only the structure/markup/styling change. The panel is built from `SidePanel` (root) + `ThisPageBar` + `Tabs` + `SearchTab`.

**Files:** Create `src/ui/sidepanel/{index.html,main.tsx,SidePanel.tsx,ThisPageBar.tsx,Tabs.tsx,SearchTab.tsx,sidepanel.css}` (+ optional `strings.ts`).

- [ ] **Step 1: `index.html` + `main.tsx`**
  - `index.html`: `lang="en"`, `<title>Recall</title>`, `<div id="app"></div>`, `<script type="module" src="./main.tsx">`. No hard width on `<body>` (the panel sizes itself); width is governed by CSS min/max.
  - `main.tsx`:
    ```tsx
    import { render } from 'preact'
    import './sidepanel.css'
    import { SidePanel } from './SidePanel'
    render(<SidePanel />, document.getElementById('app')!)
    ```

- [ ] **Step 2: `sidepanel.css`** - copy `popup.css`, then change ONLY the width model and add the Search-button styling:
  - `body`: replace `width: 360px` with a fluid block, e.g. `min-width: 320px; max-width: 520px; width: 100%; margin: 0 auto;`. Keep the light palette/vars.
  - Add a `.searchbar` row (input grows, accent button fixed) and a `.tabbar` strip. Add a `.badge` / `.badge.saved` style for the SAVED pill. Add a `.page-actions` block (always visible). Keep `.card`, `.toggle`, `.linkbtn`, `.denylist` as-is.

- [ ] **Step 3: `Tabs.tsx`** - the scaffold from "Tab extensibility" above: export `TabKey`, `TABS`, and a presentational `<TabBar active onSelect>` that maps `TABS`. Renders even with one entry.

- [ ] **Step 4: `ThisPageBar.tsx`** - the active-tab-reactive bar. Move `denyHost`, `removeDeny`, `forgetHost`, `capture`, `togglePause` here UNCHANGED (same strings, same message types). Add:
  - active-tab state: on mount + on `chrome.tabs.onActivated` + `chrome.tabs.onUpdated` (filter to the active tab / `status==='complete'`), read `chrome.tabs.query({active,currentWindow})`, store `{ url, host }`, and fire a `has-page` round-trip to set the SAVED badge.
  - render: `host` text + a SAVED / "not saved yet" `.badge`, the Capture button (`Capture this page`), the Pause toggle (`getByLabel(/pause/i)` must still match - keep the `<label>`+checkbox), the two link buttons (`Don't remember this site`, `Forget this site's history`), and the no-remember list with per-row `remove`. ALL visible (no closed menu).
  - the page-scoped actions target the bar's current tab (same `chrome.tabs.query` the popup used).

  > Scenario: user switches tabs; the bar updates host + SAVED badge without reopening anything; Capture/Deny/Forget act on the tab now shown.
  > Coverage: N/A - `chrome.tabs` listeners + `sendMessage` glue; no real-path unit harness (mirrors the dwell-visibility precedent). `hostOf` is pure (trivial; covered implicitly by the search-card host render and reused from the old popup). Exercised by the migrated capture/deny/forget e2e.

- [ ] **Step 5: `SearchTab.tsx`** - the hero. Keep `search`, `q`, `results`, `searching`, `hasSearched`, the `recall` message (`k: 5`), and the `<article>` card markup (title link + `<p>` snippet + host + score) EXACTLY as the popup had them (e2e target `<article>` and `getByText`/`toContainText` on card text). Changes:
  - input is `type="search"` (implicit role `searchbox`) with a DYNAMIC placeholder from `suggestions.ts`: `randomIndex` on mount, then `setInterval(5000)` advancing with `nextIndex` ONLY while the input is empty AND unfocused; clear on unmount.
  - add an accent **Search button** (icon) to the right of the input that calls `search()`; Enter still calls `search()`.
  - keep the `searching` / `no results` hints.

  > Scenario: a user types a query and clicks Search (or presses Enter) and sees one card per matching page.
  > Coverage: integration via the migrated e2e (real build, real recall). The placeholder rotation's index math is unit-tested (Task 3); the timer/focus gating is glue (Coverage N/A).

- [ ] **Step 6: `SidePanel.tsx`** - root. Hold model status (the `model-status` query + `model-progress`/`indexing-progress`/`indexing-error` listener moved from the popup, unchanged), the `tab` state, render `<ThisPageBar/>`, the `<TabBar/>`, and `{tab === 'search' && <SearchTab/>}`. The status strings (`indexed`, `indexing... N done`, `captured ...`) that e2e watch must still render somewhere visible (keep them in the bar/status line as today).

- [ ] **Step 7 (optional, light): `strings.ts`** - if it stays tidy, collect the English UI strings into one object and import them; otherwise skip. Hard rule: the exact e2e strings are unchanged.

---

## Task 5: Remove the popup

**Files:** Delete `src/ui/popup/{App.tsx,main.tsx,popup.css,index.html}` (the whole `src/ui/popup/` dir).

- [ ] **Step 1:** Delete the four popup files. Confirm nothing imports them: `rg "ui/popup" src` is empty; `rg "default_popup|_execute_action" .` is empty (outside docs).
- [ ] **Step 2:** `npm run build` - CRXJS must emit `src/ui/sidepanel/index.html` as the side-panel entry and NO popup entry. Confirm `dist-ext/manifest.json` has `side_panel.default_path` and no `action.default_popup`.

  > Scenario: the build no longer references a deleted popup entry; the panel HTML is bundled.
  > Coverage: N/A - build output check (no unit harness for CRXJS emit). Verified by `npm run build` exit 0 + manifest inspection.

---

## Task 6: e2e migration (all 8 specs)

Every spec opens `chrome-extension://<id>/src/ui/popup/index.html` and drives it. The "dance" is unchanged: open the panel page as a normal tab, `page.bringToFront()` the article tab so `chrome.tabs.query({active})` returns the article, then click the panel's controls via CDP. Two mechanical swaps per spec:

1. `.../src/ui/popup/index.html` -> `.../src/ui/sidepanel/index.html`.
2. `getByPlaceholder('recall...')` -> `getByRole('searchbox')` (the placeholder is now dynamic, so it can't be a locator; the input is `type="search"` -> role `searchbox`).

Everything else stays: `getByText('Capture this page')`, `getByText("Don't remember this site")`, `getByText("Forget this site's history")`, `getByLabel(/pause/i)`, `getByRole('button', { name: 'remove' })`, `locator('article')` counts, and all status `getByText`. These resolve because the v1 layout keeps every page-control VISIBLE (no closed menu) - the explicit guard against the `toHaveCount(0)` false-green.

> Scenario (shared): the product's promises (capture -> recall, persistence, hybrid ranking, privacy controls, SERP skip, SPA re-capture, auto-capture) all still work against the side panel surface.
> Coverage: integration (built extension loaded in Chrome; real Readability + e5 + sqlite + side panel page). Full real path.

- [ ] **`tests/e2e/recall-flow.spec.ts`** - path + searchbox swap. Counts already `toHaveCount(1)` (document-level); keep.
- [ ] **`tests/e2e/persistence.spec.ts`** - path + searchbox swap on BOTH popup pages (`popup1`, `popup2`); pause `getByLabel(/pause/i)` unchanged.
- [ ] **`tests/e2e/hybrid-search.spec.ts`** - path + searchbox swap; the 3 `.first()` content asserts unchanged.
- [ ] **`tests/e2e/forget-history.spec.ts`** - path + searchbox swap; KEEP `Forget this site's history` click and BOTH post-forget `locator('article').toHaveCount(0)` privacy asserts (now meaningful because the search input + results live in the visible panel).
- [ ] **`tests/e2e/user-controls.spec.ts`** - path + searchbox swap; `Don't remember this site`, `not saved...`, `won't remember ...`, and `getByRole('button', { name: 'remove' })` all unchanged (controls visible).
- [ ] **`tests/e2e/spa-navigation.spec.ts`** - path + searchbox swap; the 3 `.first()` asserts unchanged.
- [ ] **`tests/e2e/auto-capture.spec.ts`** - path + searchbox swap; the `.first()` Cortisol assert unchanged.
- [ ] **`tests/e2e/serp-skip.spec.ts`** - path + searchbox swap; `toHaveCount(0)` + the marsupial `.first()` assert unchanged.

(The `popup` variable name may stay for minimal churn, or be renamed `panel` - cosmetic. Do NOT rename if it inflates the diff.)

---

## Verification (run all)

- [ ] `npx tsc --noEmit` - clean (new messaging types, port method, exported `pageIdFromUrl` all line up).
- [ ] `npm run test` - full unit suite green (+`hasPage` contract test, +`suggestions` tests).
- [ ] `rg "chrome" src/core` - EMPTY (core stays pure; the new port method is an interface only, no Chrome use).
- [ ] `rg "ui/popup" src` and `rg "default_popup|_execute_action" .` (outside `docs/`) - EMPTY.
- [ ] `npm run build` - exit 0; `dist-ext/manifest.json` has `side_panel.default_path = src/ui/sidepanel/index.html`, `permissions` includes `sidePanel`, no `action.default_popup`, command `open-panel` present.
- [ ] `npx playwright test` - ALL 8 e2e green (config runs serial workers:1 + retries:1). A hard failure (not a single retry-absorbed flake) means a missed path/searchbox swap or a control accidentally hidden behind a menu.
- [ ] Eyeball: load `dist-ext/`, click the toolbar icon -> the side panel opens; switch tabs -> the bar's host + SAVED badge update; search shows one card per page; the placeholder rotates while empty/unfocused; Cmd+Shift+U captures; Cmd+Shift+K opens the panel.

---

## Self-Review Checklist

- [ ] `hasPage` test watched FAIL before the port/impl existed; memory + worker impls both return the existence boolean; offscreen `has-page` uses the SAME `pageIdFromUrl` capture used (no badge drift).
- [ ] Manifest: `default_popup` GONE, `side_panel.default_path` + `sidePanel` permission ADDED, `_execute_action` REPLACED by `open-panel`, `capture-page` UNCHANGED.
- [ ] SW: `setPanelBehavior({openPanelOnActionClick:true})` set on BOTH install and startup (SW not durable); `open-panel` resolves a real `windowId`; `has-page` added to the handled-types guard AND dispatch.
- [ ] Page controls render VISIBLE (no closed `<details>`/overflow) so the privacy `toHaveCount(0)` and `.click()` asserts stay meaningful (no false-green).
- [ ] e2e: every one of the 8 specs swapped path + searchbox; `<article>` result locators and all exact strings unchanged.
- [ ] Tab scaffold renders from `TABS`; adding History later = union + one `TABS` row + one content line (no other file touched).
- [ ] Popup dir deleted; build emits the sidepanel entry only; `rg "ui/popup" src` empty.
- [ ] Suggestions index math unit-tested; the timer/focus gating left as glue (Coverage N/A), never claimed as tested.

---

## Tradeoffs / risks

- **Discoverability: side panel vs popup.** A popup pops in your face; a side panel can hide until opened. Mitigations baked in: (1) `openPanelOnActionClick` so the toolbar icon opens it with one click (the muscle-memory spot), (2) the `capture-page` shortcut still captures with zero UI, (3) the `open-panel` shortcut. A future first-run onboarding hint ("click the icon to open Recall") is noted but out of scope for v1.
- **Active-tab reactivity cost.** The panel persists, so it must listen to `tabs.onActivated`/`onUpdated` and re-query + re-run `has-page` on each switch. Cheap (`SELECT 1 ... LIMIT 1`), but it is per-switch chatter the popup never had. Debounce `onUpdated` to `status==='complete'`/active tab to avoid a query storm on noisy pages.
- **e2e dance for a panel-opened-as-a-tab.** Playwright can't drive a real Chrome side panel, so the specs open `sidepanel/index.html` as an ordinary tab and rely on `bringToFront()` to keep the article active. This works because the side panel page is just an extension-origin page with `chrome.tabs` access - identical to how the popup page was driven. The risk: the panel page in the e2e is NOT a true side panel, so the e2e validate the panel's CONTENT/handlers, not the `sidePanel.open` plumbing (that part is build- and eyeball-verified). Documented, accepted.
- **Chrome version floor.** `chrome.sidePanel` needs Chrome 114+ (`setPanelBehavior`/`open` landed by 116). Older Chrome would have no panel and a dead icon. Acceptable for a walking-skeleton local-first extension; note it in the store listing. The `?.` guards on `chrome.sidePanel` keep the SW from throwing on an unsupported build.
- **SAVED badge accuracy.** The badge is only as right as `pageIdFromUrl` - if capture and the badge ever normalized differently, a saved page could read "not saved." Sharing the exported `pageIdFromUrl` removes that drift by construction.
