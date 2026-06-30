# Side-Panel Migration: drop the popup, action opens the panel, Search v1, tab-ready

> **Supersedes `docs/superpowers/plans/2026-06-30-i18n-readiness.md` (folded in).** The i18n-readiness work is now part of THIS plan: `src/ui/sidepanel/strings.ts` is a required module the side-panel components import as they are first written (Task 5), and its shape test lives at `tests/core/strings.test.ts`. Do not execute the standalone i18n plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Every code change is TDD where the logic is pure: failing test FIRST, watched fail, then implementation. Browser-glue steps (Chrome side-panel API, tab listeners, active-tab reactivity) carry a `Coverage: N/A` justification - never "manual check". Steps use checkbox (`- [ ]`).

**Goal:** Move the whole UI from a 360px popup to a persistent **side panel**. One surface, three structural pieces top-to-bottom:
1. A compact **"this page" bar** that REACTS to the active tab (active tab's TITLE + host + SAVED badge + Capture + the privacy controls). The bar makes the two scopes legible: PAGE-scoped (Capture + SAVED badge target the specific URL / pageId) vs SITE-scoped (Don't remember / Forget target the host).
2. A **Tabs scaffold** that renders a tab bar but ships only the **Search** tab in v1, wired so a **History** (and later Settings) tab is a tiny additive change.
3. **Search** as the hero (prominent input + accent Search button + rotating suggested-query placeholder + `<article>` result cards).

The toolbar icon now OPENS THE PANEL (no popup). The capture shortcut (Cmd/Ctrl+Shift+U) is unchanged. All existing handlers (search, capture, pause, denyHost, removeDeny, forgetHost) move into the panel with identical behavior; the page-scoped ones target the active tab the bar is showing.

**Tech Stack:** TypeScript, Vite+CRXJS, Preact, `@huggingface/transformers`, `@sqlite.org/sqlite-wasm` (OPFS), Vitest, Playwright. No new runtime deps.

**Current baseline (verify before starting):** `npm run test` green; `npx playwright test` green. A spike (`c08e1be`) already landed an additive minimal side panel under `src/ui/sidepanel/*` (it proved build emit, messaging, active-tab reactivity, and the capture round-trip from a panel-origin page). **That spike's minimal panel is the SEED this plan expands** into `SidePanel` + `ThisPageBar` + `Tabs` + `SearchTab` (the spike's single `SidePanel.tsx` is split apart and its inline strings move into `strings.ts`). The popup still exists until Task 6 deletes it.

---

## Confirmed decisions (bake these in - read first)

- **No popup.** Drop `action.default_popup`. Keep a bare `action` so the toolbar icon still exists and is clickable. Add the `sidePanel` permission and `"side_panel": { "default_path": "src/ui/sidepanel/index.html" }`. In the service worker, call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on `onInstalled` AND `onStartup` (the SW is not durable, so set it on both). Clicking the icon then opens the panel - no JS click handler needed for the common path.
- **Commands.** Keep `capture-page` (Cmd/Ctrl+Shift+U) exactly as-is (captures the active tab, no UI). Replace the reserved `_execute_action` (which only ever opened the popup) with a custom `open-panel` command (Cmd/Ctrl+Shift+K). Its SW handler calls `chrome.sidePanel.open({ windowId })` - a command IS a user gesture, so `open()` is allowed. Read `windowId` from the `tab` argument the command listener already passes (`onCommand` fires with `(command, tab)`); do NOT hop through an async `chrome.tabs.query` callback, which would lose the gesture and make `open()` throw.
- **One surface, controls VISIBLE (not in a closed menu).** The page-scoped + site-scoped controls (Capture, Pause, Don't remember this site, Forget this site's history, the no-remember list + each `remove`) render INLINE / always-visible in v1 - NOT inside a closed `<details>` or a closed `...` overflow. This is a hard requirement: the privacy e2e assert `toHaveCount(0)` and `.click()` against these controls, and a control hidden in a closed menu would make `toHaveCount(0)` falsely pass and `.click()` fail (the documented earlier lesson). A `...` overflow is a FUTURE enhancement; if it ever lands, the e2e must open it first.
- **Active-tab reactivity.** The panel persists across tab switches (unlike the popup, which re-read on each open). The bar must refresh on `chrome.tabs.onActivated` and `chrome.tabs.onUpdated`, plus once on mount. This is browser glue (Coverage N/A); the only pure piece (hostOf, the SAVED-badge query contract) is unit-tested. **Active-tab state now carries the title too** (`{ url, host, title }` from `chrome.tabs.query`), because the bar shows the title as its primary line.
- **"This page" bar = TITLE + host + scope-legible controls.** The active tab's TITLE is the primary line; the host is a secondary label under it. Capture + the SAVED badge are PAGE-scoped (this exact URL / pageId). Don't-remember + Forget are SITE-scoped (the host). The bar's copy/grouping must make those two scopes obvious to the user.
- **Saved badge = a real backend round-trip.** "Saved" means the store already has this page. New `VectorSearchPort.hasPage(pageId)` -> memory impl + worker `hasPage` op + adapter + offscreen `has-page` op + messaging `{type:'has-page',url}` -> `{type:'page-status',exists}` + SW relay. Capture stores the page under `pageIdFromUrl(sanitizeUrl(href))` (the content script sanitizes the url first, then capture normalizes). The offscreen `has-page` op applies the EXACT same two steps in the same order - `pageIdFromUrl(sanitizeUrl(url))` - so the badge id can't drift from the stored id, even for token-bearing urls (OAuth callbacks). (After Task 2, `pageIdFromUrl` also strips tracking params, so the badge ignores `?utm_*` junk too - see below.)
- **Page identity ignores tracking junk (Task 2).** `pageIdFromUrl` and `sanitizeUrl` strip known tracking query params (`utm_*`, `gclid`, `fbclid`, ...). So `/article?utm_source=x` and `/article` are the SAME page: no duplicate captures, no SAVED-badge confusion when a user lands on a campaign link.
- **Full-width layout (NOT a centered column).** The spike centered content in a ~480px column (`max-width:480px; margin:0 auto`), which left big empty side margins in the wide panel. v1 STRETCHES to fill the panel width: the body/container is FULL-WIDTH with side padding (`width:100%; padding:12px 14px; box-sizing:border-box`), responsive to the user resizing the panel - NOT a fixed/max-width centered block. The search bar, capture button, and result cards span the full width; results fill down the body. Keep the spike's clean light palette/vars; change only the width model.
- **i18n-readiness, FOLDED IN (now a real piece of Task 5, not optional).** `src/ui/sidepanel/strings.ts` is the single canonical home for UI strings: a typed `UIStrings` interface + an English `EN` object + `export const t = EN`. `SidePanel` / `ThisPageBar` / `SearchTab` / `Tabs` import `t` from it AS THEY ARE FIRST WRITTEN - no write-then-replace later. A shape test lives at `tests/core/strings.test.ts` (repo convention is flat `tests/core/`, not `tests/ui/`). Do NOT build a real i18n system (no `chrome.i18n`, no locale switch) - just the typed-EN seam so Korean is a cheap add later. HARD rule: every e2e-asserted string stays BYTE-IDENTICAL (see the list under Task 5). The rotating example queries (`SUGGESTIONS`) stay in `suggestions.ts` (English data, fine to keep out of `strings.ts`).

---

## Tab extensibility (explicit - how History/Settings slot in later)

Structure the tab state so adding a tab is a 3-line change, not a refactor:

```tsx
// src/ui/sidepanel/Tabs.tsx (scaffold)
export type TabKey = 'search' // later: | 'history' | 'settings'
export const TABS: { key: TabKey; label: string }[] = [
  { key: 'search', label: t.searchTabLabel }, // 'Search'
  // later: { key: 'history', label: t.historyTabLabel },
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
| `src/core/strip-tracking-params.ts` | Create | Pure `stripTrackingParams(url): string` - removes known tracking query params (case-insensitive keys), preserves real params, returns a bad url as-is. The one source of the tracking-param list. |
| `tests/core/strip-tracking-params.test.ts` | Create | RED-first pure tests: tracking stripped, real params kept, no-query url unchanged, bad url returned as-is, case-insensitive. |
| `src/core/sanitize-url.ts` | Modify | After stripping token params, also strip tracking params (call `stripTrackingParams`) so the STORED url is clean. |
| `tests/core/sanitize-url.test.ts` | Modify | Add a case proving tracking params are stripped while real params survive (existing token/clean-url cases still pass). |
| `src/core/ports.ts` | Modify | Add `hasPage(pageId: string): Promise<boolean>` to `VectorSearchPort`. |
| `src/adapters/memory-vector-store.ts` | Modify | Implement `hasPage` = `this.pages.has(pageId)`. |
| `src/offscreen/sqlite-worker.ts` | Modify | Add `opHasPage` (`SELECT 1 FROM pages WHERE id=? LIMIT 1`) + a `hasPage` row in the handler map. |
| `src/offscreen/worker-vector-store.ts` | Modify | Add `hasPage = (pageId) => this.c.request<boolean>('hasPage', pageId)`. |
| `src/offscreen/offscreen.ts` | Modify | Add `has-page` op: `pageIdFromUrl(sanitizeUrl(url))` -> `store.hasPage(pageId)` -> `{exists}` (same `sanitizeUrl`+`pageIdFromUrl` order capture uses, so no badge drift). Add the `sanitizeUrl` import. |
| `src/core/capture-service.ts` | Modify | `export` `pageIdFromUrl` (so the offscreen badge query uses the identical normalization) AND make it strip tracking params via `stripTrackingParams` (page identity ignores `?utm_*`). |
| `tests/core/capture-service.test.ts` | Modify | If any existing assertion pins a pageId for a tracking-laden url, update it to the stripped id (pure-logic change). Add a dedup-identity test: `pageIdFromUrl(...utm_source...&id=1)` equals `pageIdFromUrl(...id=1)`. |
| `src/ui/sidepanel/index.html` | Modify | Mount node `#app` + module script (from the spike); full-width body; `lang="en"`. |
| `src/ui/sidepanel/main.tsx` | Keep/Modify | Import `./sidepanel.css`, render `<SidePanel/>` into `#app` (spike already does this). |
| `src/ui/sidepanel/SidePanel.tsx` | Modify (split) | Root: holds model status, the `tab` state, AND the single combined capture/index `status` state (written by both `capture()` and the indexing listener, rendered once here); owns `capture()` and passes it to `ThisPageBar` as `onCapture`. Renders `ThisPageBar`, the tab bar from `TABS`, the active tab's content, and the one status line. The spike's monolith splits into the four components below; imports `t`. |
| `src/ui/sidepanel/ThisPageBar.tsx` | Create | Active-tab-reactive bar. Active-tab state `{ url, host, title }`. Renders TITLE (primary, host/url fallback when title empty) + host (secondary) + SAVED badge (page-scoped) + Capture (page-scoped, fires the `onCapture` prop) + Pause + Don't-remember (site-scoped) + Forget (site-scoped) + no-remember list (all visible). Owns the site-scoped handlers, the `get-settings` seed, the `has-page` round-trip (skipped on non-http(s) tabs) + tab listeners. Does NOT own capture status (SidePanel does) and uses no `<article>` element. Imports `t`. |
| `src/ui/sidepanel/Tabs.tsx` | Create | `TabKey` union + `TABS` array (label from `t`) + the presentational tab bar. The single extension point for future tabs. Imports `t`. |
| `src/ui/sidepanel/SearchTab.tsx` | Create | Search hero: searchbox + accent Search button (label/aria from `t`), Enter-to-search, rotating suggested-query placeholder (`SUGGESTIONS`), `<article>` result cards. Imports `t`. |
| `src/ui/sidepanel/suggestions.ts` | Create | Pure: `SUGGESTIONS: string[]` (~10 English), `randomIndex(len, rng)`, `nextIndex(cur, len)`. (English data stays here, not in `strings.ts`.) |
| `src/ui/sidepanel/strings.ts` | Create (REQUIRED) | Canonical UI strings: typed `UIStrings` interface + English `EN` object + `export const t = EN`. Every side-panel component imports `t`. Drops the dead `searchPlaceholder` (placeholder is now the rotating suggestions). |
| `tests/core/strings.test.ts` | Create | Shape test (RED first): all expected static/function keys present; the byte-identical e2e strings asserted exactly (guards an accidental wording change). |
| `src/ui/sidepanel/sidepanel.css` | Modify | From the spike's css; change the width model to FULL-WIDTH (no max-width centering) + add Search-button / tabbar / badge / page-actions styles. Same clean light look. |
| `src/ui/popup/App.tsx` | Delete | Replaced by the sidepanel components. |
| `src/ui/popup/main.tsx` | Delete | Replaced by `src/ui/sidepanel/main.tsx`. |
| `src/ui/popup/popup.css` | Delete | Light look carried into `sidepanel.css`. |
| `src/ui/popup/index.html` | Delete | Replaced by `src/ui/sidepanel/index.html`. |
| `tests/core/memory-vector-store.test.ts` | Modify | Add `hasPage` contract tests (RED first). |
| `tests/core/suggestions.test.ts` | Create | Pure tests for `randomIndex`/`nextIndex` (RED first). |
| `tests/e2e/recall-flow.spec.ts` | Modify | popup path -> sidepanel path; `getByPlaceholder('recall...')` -> `getByRole('searchbox')`; ADD a SAVED-badge false->true flip assert (`getByText('saved', { exact: true })`) after capture. |
| `tests/e2e/persistence.spec.ts` | Modify | Same path + searchbox swap (2 popup pages). |
| `tests/e2e/hybrid-search.spec.ts` | Modify | Same path + searchbox swap. |
| `tests/e2e/forget-history.spec.ts` | Modify | Same path + searchbox swap (keeps the `toHaveCount(0)` privacy asserts). |
| `tests/e2e/user-controls.spec.ts` | Modify | Same path + searchbox swap; deny/forget/remove locators stay (controls are visible). |
| `tests/e2e/spa-navigation.spec.ts` | Modify | Same path + searchbox swap. |
| `tests/e2e/auto-capture.spec.ts` | Modify | Same path + searchbox swap. |
| `tests/e2e/serp-skip.spec.ts` | Modify | Same path + searchbox swap. |
| `tests/e2e/sidepanel-spike.spec.ts` | Delete | The spike's smoke test; its concerns are now covered by the migrated specs. |

**NOT touched:** `src/core/recall-service.ts`, `src/core/ranking.ts`, `src/core/cosine.ts`, `src/core/rrf.ts`, the content script's behavior (it already calls `sanitizeUrl`, which now also strips tracking - no code change there), `offscreen-rpc.ts`, the chunker/gate. Results markup stays `<article>` (no e2e result-locator churn).

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
  - Extend the existing `chrome.commands.onCommand` listener so `open-panel` opens the panel for the active window. `chrome.sidePanel.open()` MUST be called SYNCHRONOUSLY in the gesture handler - wrapping it in an async `chrome.tabs.query(...)` callback loses the user gesture and Chrome throws `"sidePanel.open() may only be called in response to a user gesture"`. So do NOT use `tabs.query`; use the `tab` argument the command listener already provides (the listener signature is `(command, tab)`):
    ```ts
    chrome.commands?.onCommand.addListener((command, tab) => {
      if (command === 'open-panel') {
        if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId })
        return
      }
      // capture-page branch unchanged (the existing chrome.tabs.query + sendMessage)
    })
    ```
    Keep the `capture-page` branch exactly as-is. Update the stale `_execute_action` comment.

- [ ] **Step 3: relay `has-page` (depends on Task 3's messaging types)**
  - Add `'has-page'` to the handled-types guard (the `msg.type !== ...` chain).
  - Add a dispatch branch:
    ```ts
    } else if (msg.type === 'has-page') {
      const r = await callOffscreen<{ exists: boolean }>({ op: 'has-page', url: msg.url })
      sendResponse({ type: 'page-status', exists: r.exists } satisfies MsgResult)
    }
    ```
  (Do this after Task 3 Step 6 adds the types, or `tsc` will complain.)

  > Scenario: clicking the toolbar icon / pressing Cmd+Shift+K opens the panel, and the SW answers the badge's `has-page` query.
  > Coverage: N/A - pure Chrome-API glue (`sidePanel`, `commands`, message relay); no real-path unit harness exists (mirrors the existing capture/recall relay, which is also covered only by e2e + build). Exercised end-to-end by the migrated Playwright specs and `npm run build`.

---

## Task 2: Tracking-param stripping (pure, TDD)

Page identity must ignore campaign/tracking junk so `/article?utm_source=x` and `/article` are the SAME page - no duplicate captures and no SAVED-badge confusion when a user arrives via a marketing link. A pure helper removes a known list of tracking params; both `sanitizeUrl` (for the stored url) and `pageIdFromUrl` (for identity, incl. the badge's `has-page` query against the RAW tab url) use it.

**Files:** Create `tests/core/strip-tracking-params.test.ts` (test FIRST), `src/core/strip-tracking-params.ts`; Modify `src/core/sanitize-url.ts`, `src/core/capture-service.ts`, `tests/core/sanitize-url.test.ts`, `tests/core/capture-service.test.ts`.

- [ ] **Step 1 (RED): `tests/core/strip-tracking-params.test.ts`**

  ```ts
  import { stripTrackingParams } from '../../src/core/strip-tracking-params'

  // Scenario: a user lands via a campaign link; the tracking params must not become part
  // of the page's identity, or the same article saves twice and the badge misreads.
  // Coverage: integration (real pure helper).
  test('strips known tracking params', () => {
    const r = stripTrackingParams('https://x.com/article?utm_source=a&utm_medium=b&gclid=c&fbclid=d')
    expect(r).toBe('https://x.com/article')
  })

  // Scenario: real query params (the ones that change WHICH page you see) must survive.
  // Coverage: integration (pure).
  test('keeps real query params, drops only tracking', () => {
    const r = stripTrackingParams('https://shop.com/items?id=5&utm_campaign=sale&page=2')
    expect(r).toBe('https://shop.com/items?id=5&page=2')
  })

  // Scenario: tracking keys arrive in mixed case from some sites.
  // Coverage: integration (pure).
  test('matches tracking keys case-insensitively', () => {
    expect(stripTrackingParams('https://x.com/a?UTM_SOURCE=a&GcLiD=b&id=1')).toBe('https://x.com/a?id=1')
  })

  // Scenario: a plain url with no query must be returned untouched (no trailing '?').
  // Coverage: integration (pure).
  test('leaves a no-query url unchanged', () => {
    expect(stripTrackingParams('https://en.wikipedia.org/wiki/Cortisol')).toBe('https://en.wikipedia.org/wiki/Cortisol')
  })

  // Scenario: a non-url string must not throw; return it as-is (matches sanitizeUrl).
  // Coverage: integration (pure).
  test('returns a bad url as-is', () => {
    expect(stripTrackingParams('not a url')).toBe('not a url')
  })
  ```
  Run `npx vitest run tests/core/strip-tracking-params.test.ts` -> fails (module missing).

- [ ] **Step 2 (GREEN): `src/core/strip-tracking-params.ts`**
  ```ts
  // Known tracking/analytics query params that never change WHICH page you see, so they
  // must not be part of a page's identity. Case-insensitive keys. Pure + testable.
  // NOTE: deliberately NO 'ref'/'ref_src'. Those are real CONTENT params on some sites
  // (e.g. ?ref=<author> on docs/blogs, ?ref_src on Twitter embeds) - stripping them would
  // merge two genuinely-different pages, breaking the "never merge distinct pages" guarantee.
  // Only params that never change WHICH page you see belong here.
  const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'msclkid', 'mc_eid', 'igshid',
    '_hsenc', '_hsmi', 'vero_id', 'oly_enc_id',
  ])

  export function stripTrackingParams(url: string): string {
    try {
      const u = new URL(url)
      for (const k of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k)
      }
      return u.toString()
    } catch {
      return url
    }
  }
  ```
  Re-run -> green.

- [ ] **Step 3: apply to the STORED url (`src/core/sanitize-url.ts`)**
  After the existing token-param strip, also strip tracking params so the saved url is clean:
  ```ts
  import { stripTrackingParams } from './strip-tracking-params'
  // ... inside sanitizeUrl, before `return`, or wrap the result:
  return stripTrackingParams(u.toString())
  ```
  Add a `tests/core/sanitize-url.test.ts` case proving the STORED url drops tracking but keeps real params:
  ```ts
  // Scenario: a campaign link is captured; the url we STORE must drop ?utm_* but keep the
  // real ?id=1, so the stored url is clean yet still points at the right page.
  // Coverage: integration (real sanitizeUrl, which now composes stripTrackingParams).
  test('strips tracking params from the stored url, keeps real params', () => {
    expect(sanitizeUrl('https://x.com/a?utm_source=s&id=1')).toBe('https://x.com/a?id=1')
  })
  ```
  The existing token-strip / clean-url / bad-url cases still pass (none of them use tracking params).

- [ ] **Step 4: apply to page IDENTITY (`src/core/capture-service.ts`)**
  Change `function pageIdFromUrl` to `export function pageIdFromUrl` AND strip tracking params inside it (so capture's stored id and the badge's `has-page` id - which normalizes the RAW tab url - agree, and tracking-laden urls don't make duplicates):
  ```ts
  import { stripTrackingParams } from './strip-tracking-params'

  export function pageIdFromUrl(url: string): string {
    const u = new URL(stripTrackingParams(url))
    u.hash = ''
    u.username = ''
    u.password = ''
    return u.toString()
  }
  ```
  If any existing `capture-service` test pins a pageId for a tracking-laden url, update it to the stripped value (a pure-logic change).

  Add a dedup-identity assertion to `tests/core/capture-service.test.ts` (import the now-exported `pageIdFromUrl`). Step 1 tests `stripTrackingParams` in isolation, but nothing yet PINS the actual product guarantee on `pageIdFromUrl` - that a campaign link and a clean link are the SAME page id:
  ```ts
  // Scenario: a user saves an article via a clean link, then re-visits it via a campaign
  // link (?utm_source=...). The page must dedup to ONE id, or it saves twice and the
  // SAVED badge misreads. Pins the guarantee directly on pageIdFromUrl (not just the helper).
  // Coverage: integration (real exported pageIdFromUrl).
  test('pageIdFromUrl gives a campaign link and a clean link the same id', () => {
    expect(pageIdFromUrl('https://x.com/a?utm_source=s&id=1')).toBe(pageIdFromUrl('https://x.com/a?id=1'))
  })
  ```

  > Scenario: capture and the SAVED badge both ignore `?utm_*`, so a campaign-link visit and a clean-link visit are one page.
  > Coverage: integration (the pure helper is unit-tested in Step 1; the dedup guarantee is pinned directly on `pageIdFromUrl` above; `sanitizeUrl` composes the helper too). The badge round-trip itself is exercised by Task 3 + the migrated e2e.

  > **Migration note:** this changes `pageIdFromUrl` output for tracking-laden URLs. Pages captured BEFORE this change keep their old (tracking-laden) ids; new captures use the stripped id. This is acceptable for the walking skeleton - no data migration is needed. The only visible effect is that a pre-change duplicate could linger: there is no TTL or eviction, so the pre-change duplicate persists harmlessly until the user forgets the host; a full re-index would unify them (out of scope). It never corrupts new captures.

---

## Task 3: Saved-badge backend (vertical slice, TDD where pure)

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
  Already done in Task 2 Step 4 (export + tracking-strip). Confirm the offscreen op imports THIS `pageIdFromUrl` AND wraps its input in `sanitizeUrl` first (Step 5), so the badge's id matches exactly what capture stored: capture does `pageIdFromUrl(sanitizeUrl(href))`, the badge does `pageIdFromUrl(sanitizeUrl(url))` - token params, hash/credentials, AND tracking params all stripped identically.

- [ ] **Step 5: offscreen op (`src/offscreen/offscreen.ts`)**
  The badge sends the RAW tab url. Capture stored the page under `pageIdFromUrl(sanitizeUrl(href))` - the content script (`src/content/capture.ts`) sanitizes FIRST, then capture normalizes. The badge MUST apply the SAME two steps in the SAME order, or a token-bearing url (e.g. an OAuth callback `?code=...`) yields a different id and the badge wrongly reads "not saved" for a saved page. The offscreen `has-page` op is the single choke point, so do BOTH `sanitizeUrl` then `pageIdFromUrl` here:
  ```ts
  if (op === 'has-page') {
    const pageId = pageIdFromUrl(sanitizeUrl(p.url as string))
    return { exists: await store.hasPage(pageId) }
  }
  ```
  Add `import { pageIdFromUrl } from '../core/capture-service'` AND `import { sanitizeUrl } from '../core/sanitize-url'`. (`ThisPageBar` therefore sends the raw `tab.url`; the offscreen owns the normalization so there is one choke point and the bar stays dumb.)

  > Scenario: a saved page visited via a token/tracking-bearing url (OAuth callback, campaign link) still reads SAVED, because the badge normalizes identically to capture (`sanitizeUrl` then `pageIdFromUrl`).
  > Coverage: N/A - offscreen RPC dispatch glue; `sanitizeUrl` + `pageIdFromUrl` are pure and already covered by their unit tests. The false->true badge flip is asserted e2e (Task 7 recall-flow).

- [ ] **Step 6: messaging types (`src/messaging.ts`)**
  - Add to `Msg`: `| { type: 'has-page'; url: string }`.
  - Add to `MsgResult`: `| { type: 'page-status'; exists: boolean }`.
  (Task 1 Step 3 consumes these.)

---

## Task 4: Suggestions helper (pure, TDD)

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

## Task 5: Side panel UI (expand the spike + fold in strings.ts)

Expand the spike's single `SidePanel.tsx` into `SidePanel` (root) + `ThisPageBar` + `Tabs` + `SearchTab`, and move every inline string into the new required `strings.ts`. Reuse the spike/popup handlers and the exact e2e-relied strings; only the structure/markup/styling change.

**Files:** Create `src/ui/sidepanel/{ThisPageBar.tsx,Tabs.tsx,SearchTab.tsx,strings.ts}` + `tests/core/strings.test.ts`; Modify `src/ui/sidepanel/{index.html,main.tsx,SidePanel.tsx,sidepanel.css}`.

- [ ] **Step 1 (RED then GREEN): `strings.ts` + `tests/core/strings.test.ts`** - the canonical strings home, written FIRST so every component below imports `t` from day one (no write-then-replace).

  Write the shape test first (`tests/core/strings.test.ts`, ASCII-only) - it proves the keys exist AND pins the byte-identical e2e strings:
  ```ts
  import { EN } from '../../src/ui/sidepanel/strings'

  const STATIC_KEYS = [
    'brand', 'searching', 'noResults', 'searchTabLabel', 'searchButtonLabel', 'searchButtonAria',
    'captureButton', 'indexed', 'capturing', 'nothingSubstantial', 'nothingToCapture',
    'pausedNote', 'notSavedDenylisted', 'savedBadge', 'notSavedBadge',
    'modelReady', 'modelError', 'pauseLabel',
    'dontRememberSite', 'alreadyOnListShort', 'forgetSiteHistory',
    'noRememberSitesHeader', 'removeLabel',
    'couldNotAdd', 'couldNotRemove', 'couldNotForget', 'restrictedTabAdd', 'restrictedTabForget',
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
  })
  ```
  Run `npx vitest run tests/core/strings.test.ts` -> FAIL (module missing). Then create `src/ui/sidepanel/strings.ts`:
  ```ts
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
  ```
  Re-run -> green. NOTE: there is deliberately NO `searchPlaceholder` (the placeholder is the rotating `SUGGESTIONS` from `suggestions.ts`). If the migration surfaces any string not here, add it to `EN` + the test's key list BEFORE referencing it.

- [ ] **Step 2: `index.html` + `main.tsx`** (already exist from the spike)
  - `index.html`: `lang="en"`, `<title>Recall</title>`, `<div id="app"></div>`, `<script type="module" src="./main.tsx">`. No hard/centered width on `<body>` - the body is FULL-WIDTH (CSS below).
  - `main.tsx`: keep the spike's `render(<SidePanel/>, ...)` with `import './sidepanel.css'`.

- [ ] **Step 3: `sidepanel.css`** - keep the spike's light palette/vars; change the WIDTH MODEL to full-width + add the new component styles:
  - `body`: drop `max-width` + `margin: 0 auto` (the spike centered a ~480px column). Use `width: 100%;` so it STRETCHES to fill the panel and reflows when the user resizes it.
  - container/`.app`: `width: 100%; padding: 12px 14px; box-sizing: border-box;` (side padding, no centered column). The search bar, capture button, and result cards all span the full width; results fill straight down the body.
  - Add a `.searchbar` row (input grows, accent button fixed), a `.tabbar` strip, a `.badge` / `.badge.saved` style for the SAVED pill, and a `.page-actions` block (always visible). Keep `.card`, the link buttons, and the denylist styling.

- [ ] **Step 4: `Tabs.tsx`** - the scaffold from "Tab extensibility" above: export `TabKey`, `TABS` (label `t.searchTabLabel`), and a presentational `<TabBar active onSelect>` that maps `TABS`. Renders even with one entry. Imports `t`.

- [ ] **Step 5: `ThisPageBar.tsx`** - the active-tab-reactive bar. Move `denyHost`, `removeDeny`, `forgetHost`, `togglePause` here UNCHANGED in behavior (same message types; strings now via `t`).

  **Capture status ownership (ONE status, owned by `SidePanel`).** There is exactly ONE combined capture/index `status` variable, and it lives in `SidePanel` (Step 7), NOT in `ThisPageBar`. `SidePanel` already owns the `indexing-progress`/`indexing-error` broadcast listener that overwrites this same line (`captured (indexing N chunks...)` -> `indexing... N done` -> `indexed`), so the capture write and the indexing write MUST share one state or the two would fight (two status lines, or a `getByText('captured'...)`/`getByText('indexed')` that can't find its target). Therefore `capture()` lives in `SidePanel` too, and `ThisPageBar` receives it as an `onCapture` callback prop wired to its Capture button. `ThisPageBar` renders NO capture status of its own - it only triggers the SidePanel-owned status. (The site/deny/forget/pause handlers stay local to `ThisPageBar`; only the capture/index status is hoisted.)

  - the `get-settings` mount effect that seeds `paused` + `userDenyHosts` MOVES here from the spike/popup root, since the pause toggle + deny list it feeds now live in `ThisPageBar`.
  - **badge READ guard:** skip the `has-page` round-trip when `tab.url` is missing or not `http(s)` (chrome://, extension, blank, or restricted tabs). The offscreen `pageIdFromUrl` has no try/catch and `new URL(undefined)` would throw; on a guarded tab just render "not saved yet" (or blank) without a round-trip.
  - **empty title fallback:** if `tab.title` is empty, the PRIMARY line falls back to the host (or, if host is also empty, the url) so the bar is never blank.
  - **NO `<article>` element:** `ThisPageBar` uses no `<article>` tag (that element is reserved for `SearchTab` result cards), so the e2e `locator('article').toHaveCount(...)` privacy/count asserts stay accurate.

  Add:
  - active-tab state: on mount + on `chrome.tabs.onActivated` + `chrome.tabs.onUpdated` (filter to the active tab / `status==='complete'`), read `chrome.tabs.query({active,currentWindow})`, store **`{ url, host, title }`** (title is NEW - the bar shows it), and fire a `has-page` round-trip to set the SAVED badge.
  - render, scope-legible:
    - PRIMARY line = the active tab's **TITLE**; SECONDARY label = the **host**.
    - PAGE-scoped group: a SAVED / "not saved yet" `.badge` (`t.savedBadge` / `t.notSavedBadge`) + the Capture button (`t.captureButton` = `Capture this page`). Make clear these act on THIS exact URL.
    - SITE-scoped group: the Pause toggle (`t.pauseLabel`; keep the `<label>`+checkbox so `getByLabel(/pause/i)` matches), `Don't remember this site` (`t.dontRememberSite`), `Forget this site's history` (`t.forgetSiteHistory`), and the no-remember list with per-row `remove` (`t.removeLabel`). Make clear these act on the HOST.
  - the forget confirm uses `t.forgetConfirm(host)` (byte-identical to today's `window.confirm` text).
  - ALL controls visible (no closed menu). Page-scoped actions target the bar's current tab.

  > Scenario: user switches tabs; the bar updates TITLE + host + SAVED badge without reopening anything; Capture acts on this page, Deny/Forget act on this site.
  > Coverage: N/A - `chrome.tabs` listeners + `sendMessage` glue; no real-path unit harness (mirrors the dwell-visibility precedent). `hostOf` is pure (trivial; reused from the spike). Exercised by the migrated capture/deny/forget e2e.

- [ ] **Step 6: `SearchTab.tsx`** - the hero. Keep `search`, `q`, `results`, `searching`, `hasSearched`, the `recall` message (`k: 5`), and the `<article>` card markup (title link + `<p>` snippet + host + score) EXACTLY as the spike had them (e2e target `<article>` and `getByText`/`toContainText` on card text). Changes:
  - input is `type="search"` (implicit role `searchbox`) with a DYNAMIC placeholder from `suggestions.ts`: `randomIndex` on mount, then `setInterval(5000)` advancing with `nextIndex` ONLY while the input is empty AND unfocused; clear on unmount.
  - add an accent **Search button** (`t.searchButtonLabel` / `aria-label={t.searchButtonAria}`) to the right of the input that calls `search()`; Enter still calls `search()`.
  - keep the `searching` (`t.searching`) / `no results` (`t.noResults`) hints. `search` errors use `t.searchFailed(...)`.

  > Scenario: a user types a query and clicks Search (or presses Enter) and sees one card per matching page.
  > Coverage: integration via the migrated e2e (real build, real recall). The placeholder rotation's index math is unit-tested (Task 4); the timer/focus gating is glue (Coverage N/A).

- [ ] **Step 7: `SidePanel.tsx`** - root. Holds:
  - model status (the `model-status` query + `model-progress`/`indexing-progress`/`indexing-error` listener from the spike, strings now via `t` - `t.indexed`, `t.indexingProgress`, `t.indexingFailed`, `t.loadingPercent`, `t.modelReady`, `t.modelError`);
  - the `tab` state;
  - **the ONE combined capture/index `status` state** (`const [status, setStatus] = useState('')`). This single variable is written by BOTH the indexing broadcast listener (`indexing-progress` -> `t.indexingProgress`/`t.indexed`, `indexing-error` -> `t.indexingFailed`) AND `capture()` (`t.capturing`, `t.capturedChunks`, `t.captureFailed`, `t.pausedNote`, `t.notSavedDenylisted`, `t.nothingSubstantial`, `t.nothingToCapture`), exactly like the spike/popup did - so the line replaces in sequence (`captured (indexing N chunks...)` -> `indexing... N done` -> `indexed`). `capture()` lives HERE (it reads the active tab via `chrome.tabs.query` itself, so it needs nothing from `ThisPageBar`).
  - renders `<ThisPageBar onCapture={capture} />`, the `<TabBar/>`, `{tab === 'search' && <SearchTab/>}`, and the SINGLE `status` line ONCE (rendered by `SidePanel`, not `ThisPageBar`). The status strings e2e watch (`indexed`, `indexing... N done`, `captured ...`) render here, in this one place.

---

## Task 6: Remove the popup

**Files:** Delete `src/ui/popup/{App.tsx,main.tsx,popup.css,index.html}` (the whole `src/ui/popup/` dir).

- [ ] **Step 1:** Delete the four popup files. Confirm nothing imports them: `rg "ui/popup" src` is empty; `rg "default_popup|_execute_action" .` is empty (outside docs).
- [ ] **Step 2:** `npm run build` - CRXJS must emit `src/ui/sidepanel/index.html` as the side-panel entry and NO popup entry. Confirm `dist-ext/manifest.json` has `side_panel.default_path` and no `action.default_popup`.

  > Scenario: the build no longer references a deleted popup entry; the panel HTML is bundled.
  > Coverage: N/A - build output check (no unit harness for CRXJS emit). Verified by `npm run build` exit 0 + manifest inspection.

---

## Task 7: e2e migration (all 8 specs)

Every spec opens `chrome-extension://<id>/src/ui/popup/index.html` and drives it. The "dance" is unchanged: open the panel page as a normal tab, `page.bringToFront()` the article tab so `chrome.tabs.query({active})` returns the article, then click the panel's controls via CDP. Two mechanical swaps per spec:

1. `.../src/ui/popup/index.html` -> `.../src/ui/sidepanel/index.html`.
2. `getByPlaceholder('recall...')` -> `getByRole('searchbox')` (the placeholder is now dynamic, so it can't be a locator; the input is `type="search"` -> role `searchbox`).

Everything else stays: `getByText('Capture this page')`, `getByText("Don't remember this site")`, `getByText("Forget this site's history")`, `getByLabel(/pause/i)`, `getByRole('button', { name: 'remove' })`, `locator('article')` counts, and all status `getByText`. These resolve because the v1 layout keeps every page-control VISIBLE (no closed menu) - the explicit guard against the `toHaveCount(0)` false-green. The strings did NOT change wording; they only moved into `EN` (Task 5), so these locators still match byte-for-byte.

Also delete `tests/e2e/sidepanel-spike.spec.ts` (its concerns - build emit, messaging, active-tab, capture - are now covered by the migrated specs against the real panel UI).

> Scenario (shared): the product's promises (capture -> recall, persistence, hybrid ranking, privacy controls, SERP skip, SPA re-capture, auto-capture) all still work against the side panel surface.
> Coverage: integration (built extension loaded in Chrome; real Readability + e5 + sqlite + side panel page). Full real path.

- [ ] **`tests/e2e/recall-flow.spec.ts`** - path + searchbox swap. Counts already `toHaveCount(1)` (document-level); keep. ALSO add a SAVED-badge flip assertion (the badge is the payoff of Task 3 and nothing else proves its false->true flip end to end). After the manual capture + `page.bringToFront()` on the article tab so `chrome.tabs.query({active})` returns it, assert the panel shows the saved badge:
  ```ts
  // Scenario: after capturing the active article, the panel's PAGE-scoped SAVED badge must
  // flip to "saved" for that exact tab - the visible payoff of the has-page round-trip.
  // Coverage: integration (built extension; real capture + offscreen has-page + panel render).
  await expect(panel.getByText('saved', { exact: true })).toBeVisible()
  ```
  The asserted text is `EN.savedBadge` (= `'saved'`). Use `{ exact: true }` deliberately: the pre-capture badge reads `'not saved yet'` (`EN.notSavedBadge`), which CONTAINS the substring "saved" - an `exact:false` match would be green even before capture, defeating the flip assertion. `exact:true` matches the saved-badge text node only. (Use the `panel`/`popup` page variable the spec already drives.)
- [ ] **`tests/e2e/persistence.spec.ts`** - path + searchbox swap on BOTH popup pages (`popup1`, `popup2`); pause `getByLabel(/pause/i)` unchanged. Both `locator('article').toHaveCount(1)` asserts are preserved untouched - the result-card markup stays `<article>` (and `ThisPageBar` adds none), so the counts still mean "one result card".
- [ ] **`tests/e2e/hybrid-search.spec.ts`** - path + searchbox swap; the 3 `.first()` content asserts unchanged.
- [ ] **`tests/e2e/forget-history.spec.ts`** - path + searchbox swap; KEEP `Forget this site's history` click and BOTH post-forget `locator('article').toHaveCount(0)` privacy asserts (now meaningful because the search input + results live in the visible panel).
- [ ] **`tests/e2e/user-controls.spec.ts`** - path + searchbox swap; `Don't remember this site`, `not saved...`, `Won't remember ...`, and `getByRole('button', { name: 'remove' })` all unchanged (controls visible).
- [ ] **`tests/e2e/spa-navigation.spec.ts`** - path + searchbox swap; the 3 `.first()` asserts unchanged.
- [ ] **`tests/e2e/auto-capture.spec.ts`** - path + searchbox swap; the `.first()` Cortisol assert unchanged.
- [ ] **`tests/e2e/serp-skip.spec.ts`** - path + searchbox swap; `toHaveCount(0)` + the marsupial `.first()` assert unchanged.

(The `popup` variable name may stay for minimal churn, or be renamed `panel` - cosmetic. Do NOT rename if it inflates the diff.)

---

## Verification (run all)

- [ ] `npx tsc --noEmit` - clean (new messaging types, port method, exported `pageIdFromUrl`, `strings.ts` `t` references all line up).
- [ ] `npm run test` - full unit suite green (+`stripTrackingParams` tests, +`hasPage` contract test, +`suggestions` tests, +`strings` shape/byte-identical test).
- [ ] `rg "chrome" src/core` - EMPTY (core stays pure; the new port method is an interface only; `stripTrackingParams`/`pageIdFromUrl`/`sanitizeUrl` use only `URL`).
- [ ] `rg "ui/popup" src` and `rg "default_popup|_execute_action" .` (outside `docs/`) - EMPTY.
- [ ] `rg "searchPlaceholder" src` - EMPTY (the dead static is gone; placeholder is the rotating suggestions).
- [ ] `npm run build` - exit 0; `dist-ext/manifest.json` has `side_panel.default_path = src/ui/sidepanel/index.html`, `permissions` includes `sidePanel`, no `action.default_popup`, command `open-panel` present.
- [ ] `npx playwright test` - ALL 8 e2e green (config runs serial workers:1 + retries:1). A hard failure (not a single retry-absorbed flake) means a missed path/searchbox swap, a changed string, or a control accidentally hidden behind a menu.
- [ ] Eyeball: load `dist-ext/`, click the toolbar icon -> the side panel opens FULL-WIDTH (no big side margins); resize the panel -> content reflows; the bar shows the active tab's TITLE + host; switch tabs -> TITLE + host + SAVED badge update; a `?utm_source=...` link reads the SAME SAVED state as the clean url; search shows one card per page; the placeholder rotates while empty/unfocused; Cmd+Shift+U captures; Cmd+Shift+K opens the panel.

---

## Self-Review Checklist

- [ ] `stripTrackingParams` test watched FAIL first; tracking params stripped, real params kept, no-query url unchanged, bad url returned as-is, keys case-insensitive. `sanitizeUrl` (stored url) AND `pageIdFromUrl` (identity + badge) both compose it; migration note recorded (old captures keep old ids, no migration).
- [ ] `hasPage` test watched FAIL before the port/impl existed; memory + worker impls both return the existence boolean; offscreen `has-page` applies BOTH `sanitizeUrl` THEN `pageIdFromUrl` (the same two steps, same order, capture uses) - so token-bearing/tracking-laden urls read the same id as the stored page, no badge drift. The false->true badge flip is asserted e2e (recall-flow).
- [ ] `strings.ts` is REQUIRED and the single strings home; `SidePanel`/`ThisPageBar`/`SearchTab`/`Tabs` import `t` AS FIRST WRITTEN (no write-then-replace). Shape test at `tests/core/strings.test.ts` (flat convention, not `tests/ui/`), ASCII-only, and PINS the byte-identical e2e strings. `searchPlaceholder` dropped; `SUGGESTIONS` stays in `suggestions.ts`. New strings present: `capturing`, `captureFailed`, `searchFailed`, `forgetConfirm`, `savedBadge`/`notSavedBadge`, `searchTabLabel`, `searchButtonLabel`/`searchButtonAria`.
- [ ] Layout is FULL-WIDTH with side padding (no `max-width`/`margin:0 auto` centered column); search bar, capture, result cards span the full width; reflows on resize.
- [ ] `ThisPageBar` carries `{ url, host, title }`; renders TITLE (primary) + host (secondary); SAVED badge + Capture are PAGE-scoped, Don't-remember + Forget are SITE-scoped, and the bar reads so the user understands which is which.
- [ ] Manifest: `default_popup` GONE, `side_panel.default_path` + `sidePanel` permission ADDED, `_execute_action` REPLACED by `open-panel`, `capture-page` UNCHANGED.
- [ ] SW: `setPanelBehavior({openPanelOnActionClick:true})` set on BOTH install and startup (SW not durable); `open-panel` calls `chrome.sidePanel.open()` SYNCHRONOUSLY using the `tab` argument from `onCommand(command, tab)` (NO async `tabs.query` hop, which would lose the gesture and throw); `has-page` added to the handled-types guard AND dispatch.
- [ ] Page controls render VISIBLE (no closed `<details>`/overflow) so the privacy `toHaveCount(0)` and `.click()` asserts stay meaningful (no false-green).
- [ ] e2e: every one of the 8 specs swapped path + searchbox; spike spec deleted; `<article>` result locators and all exact strings unchanged (wording byte-identical, only the literal's HOME moved into `EN`). recall-flow ALSO asserts the SAVED-badge false->true flip (`getByText('saved', { exact: true })` - `exact:true` so it doesn't false-match `'not saved yet'`). persistence's two `toHaveCount(1)` preserved.
- [ ] Capture/index status: there is exactly ONE `status` variable, owned by `SidePanel`, written by BOTH `capture()` and the indexing-progress/error listener, and rendered ONCE in `SidePanel`. `ThisPageBar` renders no capture status; its Capture button fires an `onCapture` prop. So `getByText('captured'...)`/`getByText('indexed')` resolve to a single line. The `get-settings` seed moved to `ThisPageBar`; the badge READ skips non-http(s) tabs; empty title falls back to host/url; `ThisPageBar` has no `<article>`.
- [ ] Tab scaffold renders from `TABS`; adding History later = union + one `TABS` row + one content line (no other file touched).
- [ ] Popup dir deleted; build emits the sidepanel entry only; `rg "ui/popup" src` empty.
- [ ] Suggestions index math unit-tested; the timer/focus gating left as glue (Coverage N/A), never claimed as tested.

---

## Tradeoffs / risks

- **Discoverability: side panel vs popup.** A popup pops in your face; a side panel can hide until opened. Mitigations baked in: (1) `openPanelOnActionClick` so the toolbar icon opens it with one click (the muscle-memory spot), (2) the `capture-page` shortcut still captures with zero UI, (3) the `open-panel` shortcut. A future first-run onboarding hint ("click the icon to open Recall") is noted but out of scope for v1.
- **Tracking-param list is a denylist, not exhaustive.** New tracking params appear all the time; the fixed list catches the common ones (`utm_*`, `gclid`, `fbclid`, ...). A url with an unknown tracker still makes a distinct page id - acceptable (it only risks a rare duplicate, never data loss). The list lives in one pure file so it is cheap to extend, and it stays a DENYLIST (we never strip an unknown param, so we never accidentally merge two genuinely-different pages).
- **pageId change has no migration.** Pre-change captures of tracking-laden urls keep their old ids; only new captures use the stripped id. For a walking skeleton this is fine - no user data is lost and new captures are correct. There is no TTL or eviction, so the pre-change duplicate persists harmlessly until the user forgets the host; a full re-index would unify them (out of scope).
- **Active-tab reactivity cost.** The panel persists, so it must listen to `tabs.onActivated`/`onUpdated` and re-query + re-run `has-page` on each switch. Cheap (`SELECT 1 ... LIMIT 1`), but it is per-switch chatter the popup never had. Debounce `onUpdated` to `status==='complete'`/active tab to avoid a query storm on noisy pages. The bar now also reads the tab TITLE, but that comes from the same `chrome.tabs.query` - no extra round-trip.
- **Full-width vs readable line length.** Stretching to the full panel width can make long lines hard to scan on a very wide panel. v1 accepts this (the owner wants the stretch); if it ever reads poorly, a max line-length on the result `<p>` (not the whole body) is a contained future tweak.
- **e2e dance for a panel-opened-as-a-tab.** Playwright can't drive a real Chrome side panel, so the specs open `sidepanel/index.html` as an ordinary tab and rely on `bringToFront()` to keep the article active. This works because the side panel page is just an extension-origin page with `chrome.tabs` access - identical to how the popup page was driven. The risk: the panel page in the e2e is NOT a true side panel, so the e2e validate the panel's CONTENT/handlers, not the `sidePanel.open` plumbing (that part is build- and eyeball-verified). Documented, accepted.
- **Chrome version floor.** `chrome.sidePanel` needs Chrome 114+ (`setPanelBehavior`/`open` landed by 116). Older Chrome would have no panel and a dead icon. Acceptable for a walking-skeleton local-first extension; note it in the store listing. The `?.` guards on `chrome.sidePanel` keep the SW from throwing on an unsupported build.
- **SAVED badge accuracy.** The badge is only as right as the normalization - if capture and the badge ever ran a DIFFERENT pipeline, a saved page could read "not saved." Capture stores under `pageIdFromUrl(sanitizeUrl(href))`; the badge's offscreen op runs the identical `pageIdFromUrl(sanitizeUrl(url))`. Sharing the exact same two pure functions in the same order (one offscreen choke point, the bar sends the raw url) removes that drift by construction - including for token-bearing urls (OAuth `?code=`) and tracking-laden campaign links.
- **i18n seam, not a system.** `strings.ts` is typed EN only - no runtime locale switch, no `chrome.i18n`. That keeps v1 simple while making Korean a cheap, type-checked add later. The manifest `name`/`description` localization (Chrome's `_locales` + `__MSG_x__`) is a separate, later deliverable, untouched here.
