# History Tab: browse captured pages (reverse-chronological, paginated)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Every code change is TDD where the logic is pure: failing test FIRST, watched fail, then implementation. Browser/OPFS-glue steps (sqlite-wasm op, offscreen RPC, SW relay) carry a `Coverage: N/A` justification - never "manual check". Steps use checkbox (`- [ ]`) syntax for tracking. Test source is ASCII-only (repo rule).

**Goal:** Add a second tab to the side panel - **History** - that lists every captured page newest-first, so the user can BROWSE their memory (distinct from Search, which queries it). v1 is a scrollable list: each row is the page title (a link that opens the page) + its host + a relative "captured N ago" label. It has an empty state, and a **Load more** button so a large corpus pages in instead of loading thousands of rows at once.

**Why this plan is small:** the side-panel migration built a Tabs scaffold *specifically* so a second tab is a ~3-line additive change (extend the `TabKey` union, push one row into `TABS`, add one `{tab === 'history' && <HistoryTab/>}` line). This plan is the first real exercise of that extensibility - it validates that the scaffold's promise holds. No change to `Tabs.tsx`'s presentational bar, no refactor of the switch wiring.

**Architecture:** Hexagonal + declarative, same as the rest of the repo. The browse query is a new pure port method (`recentPages`) with a RED contract test on the in-memory adapter; the real implementation is one more declarative op in the sqlite worker, mirrored through the worker adapter / offscreen RPC / messaging / SW relay - **the exact vertical-slice shape the existing `hasPage` / `has-page` badge feature already uses** (read it as the template). The relative-time formatter is a pure, `now`-injected helper unit-tested in isolation.

**Tech Stack:** TypeScript, Vite+CRXJS, Preact, `@sqlite.org/sqlite-wasm` (OPFS), Vitest, Playwright. No new runtime deps.

**Current baseline (verify before starting):** `npm run test` green; `npx playwright test` green. Branch `recall-walking-skeleton`. The Tabs scaffold (`src/ui/sidepanel/Tabs.tsx`) already ships a single `search` tab and renders its bar from `TABS.map(...)`; `SidePanel.tsx` holds `const [tab, setTab] = useState<TabKey>('search')` and switches on `{tab === 'search' && <SearchTab/>}`. The `pages` table is `(id, url, title, capturedAt, host)`. `CapturedPage` is `{ id, url, title, capturedAt }` (host is NOT a model field - the UI derives host from the url, exactly as `SearchTab` does with `hostOf`).

---

## Confirmed decisions (bake these in - read first)

- **One new port method, cursor-paginated.** `VectorSearchPort.recentPages(limit: number, beforeTs?: number): Promise<CapturedPage[]>`. Newest-first. `beforeTs` is the keyset cursor: omit it for the first page; pass the `capturedAt` of the last row you already have to fetch the next page. This is a keyset (cursor) page, NOT `OFFSET` - it stays O(limit) no matter how deep the user scrolls and never shifts rows when a new capture lands mid-browse.
- **Worker SQL (get the bind/rowMode right for sqlite-wasm):**
  ```sql
  SELECT id, url, title, capturedAt, host FROM pages
  WHERE (?2 IS NULL OR capturedAt < ?2)
  ORDER BY capturedAt DESC
  LIMIT ?1
  ```
  Numbered params with a positional bind array: `bind: [limit, beforeTs ?? null]` (array index 0 -> `?1`, index 1 -> `?2`). `rowMode: 'object'`, push each row mapped to a `CapturedPage` (`{ id, url, title, capturedAt }`). The `host` column is selected (it is the stored host) but the returned object stays a `CapturedPage`; the UI derives the displayed host from the url via `hostOf` to match `SearchTab` exactly. When `beforeTs` is `undefined` the adapter sends `null`, and `(?2 IS NULL OR ...)` makes the filter a no-op for the first page.
- **Load-more, not infinite scroll, for v1.** A "Load more" button is simpler and far easier to test deterministically (no IntersectionObserver timing in Playwright). It fetches the next keyset page (`beforeTs` = last row's `capturedAt`) and appends. When a fetch returns fewer than `limit` rows, hide the button (end of list). IntersectionObserver is a future enhancement; the button stays the testable fallback.
- **Empty state.** When the very first fetch returns zero rows, render a single calm line (`historyEmpty`) instead of an empty list - so a fresh install does not look broken.
- **Reuse existing styling.** Rows reuse the `.results` / `.card` / `.card > a` / `.meta` look the Search results already use (title link on top, a muted meta line under it). No new visual language; just a host + relative-time meta line instead of host + score.
- **Relative time is pure + injected.** `relativeTime(then: number, now: number): string` returns ASCII: `just now` (< 60s), `5m` (< 60min), `3h` (< 24h), `2d` (< ~30d), else a short calendar date `Mar 4`. Pure, `now` injected, unit-tested - no `Date.now()` inside the formatter. The component passes `Date.now()` at render.
- **String key naming follows the scaffold.** The Tabs scaffold's own commented placeholder is `t.historyTabLabel`, and the existing search label is `searchTabLabel`. So the new label key is **`historyTabLabel: 'History'`** (NOT `historyTab`), to match the established `*TabLabel` convention and the scaffold's literal placeholder. Plus `historyEmpty` (empty-state line) and `loadMore` (`'Load more'`).

---

## How this validates tab-extensibility (explicit)

The side-panel migration plan claimed: *"Adding History later = (1) extend the `TabKey` union, (2) push one row into `TABS`, (3) add one `{tab === 'history' && ...}` line + the new component. No change to the bar, the switch wiring, or any other file."* This plan is the proof. Task 5's edits to `Tabs.tsx` and `SidePanel.tsx` are exactly those three lines - nothing else in either file changes, and `TabBar` (the presentational bar) is untouched. The tab bar already renders from `TABS.map(...)`, so the moment the row is pushed it shows **two** tabs (Search + History) with zero bar changes. If those three edits turn out to need more, that is a scaffold regression worth flagging.

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `tests/core/memory-vector-store.test.ts` | Modify | Add `recentPages` contract tests (RED first): newest-first order, `limit` slice, `beforeTs` cursor paging, empty store. |
| `src/core/ports.ts` | Modify | Add `recentPages(limit: number, beforeTs?: number): Promise<CapturedPage[]>` to `VectorSearchPort`. |
| `src/adapters/memory-vector-store.ts` | Modify | Implement `recentPages`: all pages sorted by `capturedAt` desc, optionally filtered to `capturedAt < beforeTs`, sliced to `limit`. |
| `src/offscreen/sqlite-worker.ts` | Modify | Add `opRecentPages` (the keyset SQL above) + a `recentPages` row in the handler map. |
| `src/offscreen/worker-vector-store.ts` | Modify | Add `recentPages = (limit, beforeTs) => this.c.request<CapturedPage[]>('recentPages', { limit, beforeTs })`. |
| `src/offscreen/offscreen.ts` | Modify | Add `recent-pages` op: `return { pages: await store.recentPages(limit, beforeTs) }`. |
| `src/messaging.ts` | Modify | Add `Msg` `{ type: 'recent-pages'; limit: number; beforeTs?: number }` and `MsgResult` `{ type: 'pages'; pages: CapturedPage[] }`. Import `CapturedPage`. |
| `src/background/index.ts` | Modify | Add `'recent-pages'` to the handled-types guard chain; add a dispatch branch relaying to offscreen `recent-pages` -> `{ type:'pages', pages }`. |
| `src/ui/sidepanel/relative-time.ts` | Create | Pure `relativeTime(then, now): string` (ASCII buckets: `just now` / `Nm` / `Nh` / `Nd` / `Mon D`). No `Date.now()` inside. |
| `tests/core/relative-time.test.ts` | Create | RED-first pure tests for each bucket boundary, injected `now`, ASCII-only. |
| `src/ui/sidepanel/strings.ts` | Modify | Add `historyTabLabel`, `historyEmpty`, `loadMore` to `UIStrings` + `EN`. |
| `tests/core/strings.test.ts` | Modify | Add the three new keys to the static-key list; pin `historyTabLabel === 'History'` and `loadMore === 'Load more'` as byte-identical e2e strings. |
| `src/ui/sidepanel/Tabs.tsx` | Modify (1 line in union + 1 row) | Extend `TabKey` to `'search' \| 'history'`; uncomment/add the `{ key: 'history', label: t.historyTabLabel }` row in `TABS`. The presentational `TabBar` is untouched. |
| `src/ui/sidepanel/SidePanel.tsx` | Modify (2 lines) | Import `HistoryTab`; add `{tab === 'history' && <HistoryTab />}` next to the existing search switch line. Nothing else changes. |
| `src/ui/sidepanel/HistoryTab.tsx` | Create | Browse list. Fetches `recent-pages` (no cursor) on mount; renders rows (title link + host + relative time), the empty state, and a Load-more button that fetches the next keyset page (`beforeTs` = last row's `capturedAt`) and appends. Derives host via a local `hostOf`. Imports `t` + `relativeTime`. |
| `src/ui/sidepanel/sidepanel.css` | Modify (optional, tiny) | Reuse `.results`/`.card`/`.meta`. Add only a `.loadmore` button rule if the existing `.linkbtn` does not already fit. |
| `tests/e2e/history-tab.spec.ts` | Create | Capture 2 distinct thin-fixture pages, open the History tab, assert both titles appear newest-first, and assert a row's link points at the page url. Reuses thin-fixture + sidepanel-path + bringToFront. |

**NOT touched:** `src/core/model.ts` (`CapturedPage` already has the four fields the UI needs), `src/core/recall-service.ts`, `SearchTab.tsx`, `ThisPageBar.tsx`, the chunker/gate/embedder, `offscreen-rpc.ts`. The `pages` table schema is unchanged (the column the SQL reads, `capturedAt`, already exists and is already written by `opUpsertPage`).

---

## Task 1: `recentPages` port + memory adapter (pure, TDD)

The browse query is a pure contract first: given upserted pages, return them newest-first, sliced by `limit`, paged by a `beforeTs` cursor. TDD it on `MemoryVectorStore` (the in-env adapter), then add the port method.

**Files:** Modify `tests/core/memory-vector-store.test.ts` (test FIRST), `src/core/ports.ts`, `src/adapters/memory-vector-store.ts`.

- [ ] **Step 1 (RED): contract tests (`tests/core/memory-vector-store.test.ts`)**

  ```ts
  // Scenario: the History tab lists captured pages newest-first; a fresh install has none,
  // and after capturing pages they come back in reverse-chronological order.
  // Coverage: integration (real MemoryVectorStore - the VectorSearchPort contract).
  test('recentPages returns pages newest-first', async () => {
    const store = new MemoryVectorStore()
    expect(await store.recentPages(10)).toEqual([])
    await store.upsertPage({ id: 'a', url: 'http://a', title: 'A', capturedAt: 100 })
    await store.upsertPage({ id: 'b', url: 'http://b', title: 'B', capturedAt: 300 })
    await store.upsertPage({ id: 'c', url: 'http://c', title: 'C', capturedAt: 200 })
    const ids = (await store.recentPages(10)).map((p) => p.id)
    expect(ids).toEqual(['b', 'c', 'a'])
  })

  // Scenario: a large corpus must page in, not load all at once; limit caps the first page.
  // Coverage: integration (real MemoryVectorStore).
  test('recentPages caps the result at limit', async () => {
    const store = new MemoryVectorStore()
    for (let i = 0; i < 5; i++) await store.upsertPage({ id: String(i), url: 'http://x/' + i, title: 'P' + i, capturedAt: i })
    expect((await store.recentPages(2)).map((p) => p.id)).toEqual(['4', '3'])
  })

  // Scenario: "Load more" asks for the next page using the last row's capturedAt as a cursor;
  // only strictly-older pages come back, so paging never repeats or skips a row.
  // Coverage: integration (real MemoryVectorStore).
  test('recentPages pages by the beforeTs cursor', async () => {
    const store = new MemoryVectorStore()
    for (let i = 1; i <= 5; i++) await store.upsertPage({ id: String(i), url: 'http://x/' + i, title: 'P' + i, capturedAt: i * 10 })
    const page1 = await store.recentPages(2)              // [50, 40]
    expect(page1.map((p) => p.id)).toEqual(['5', '4'])
    const page2 = await store.recentPages(2, page1[page1.length - 1].capturedAt) // before 40 -> [30, 20]
    expect(page2.map((p) => p.id)).toEqual(['3', '2'])
  })
  ```
  Run `npx vitest run tests/core/memory-vector-store.test.ts` -> FAILS (`recentPages` missing; TS/`undefined` error).

- [ ] **Step 2 (GREEN): port + memory impl**
  - `src/core/ports.ts`, add to `VectorSearchPort` (near `hasPage`):
    ```ts
    // Reverse-chronological browse for the History tab. `beforeTs` is a keyset cursor:
    // omit for the first page, pass the last row's capturedAt for the next page.
    recentPages(limit: number, beforeTs?: number): Promise<CapturedPage[]>
    ```
    (`CapturedPage` is already imported in `ports.ts` via `model`.)
  - `src/adapters/memory-vector-store.ts`:
    ```ts
    async recentPages(limit: number, beforeTs?: number): Promise<CapturedPage[]> {
      return [...this.pages.values()]
        .filter((p) => beforeTs === undefined || p.capturedAt < beforeTs)
        .sort((a, b) => b.capturedAt - a.capturedAt)
        .slice(0, limit)
    }
    ```
  Re-run Step 1 -> green.

- [ ] **Step 3: Commit**
  ```bash
  git add src/core/ports.ts src/adapters/memory-vector-store.ts tests/core/memory-vector-store.test.ts
  git commit -m "feat(core): recentPages port + memory adapter (reverse-chron browse, keyset cursor)"
  ```

---

## Task 2: worker op + adapter + offscreen + messaging + SW relay (vertical slice glue)

Mirror the `hasPage` / `has-page` slice exactly: one declarative worker op, one adapter line, one offscreen op, two messaging types, one SW relay branch. No pure logic here, so no new unit test - the behavior is pinned by Task 1's contract test (same `recentPages` semantics) on the in-env adapter, and exercised end-to-end by Task 6's e2e + `npm run build`.

**Files:** Modify `src/offscreen/sqlite-worker.ts`, `src/offscreen/worker-vector-store.ts`, `src/offscreen/offscreen.ts`, `src/messaging.ts`, `src/background/index.ts`.

- [ ] **Step 1: worker op (`src/offscreen/sqlite-worker.ts`)**
  Add the handler (keyset SQL; numbered params + positional bind array). Place it near `opHasPage`:
  ```ts
  function opRecentPages(db: any, { limit, beforeTs }: { limit: number; beforeTs?: number }): CapturedPage[] {
    const pages: CapturedPage[] = []
    db.exec({
      sql: `SELECT id, url, title, capturedAt, host FROM pages
            WHERE (?2 IS NULL OR capturedAt < ?2)
            ORDER BY capturedAt DESC
            LIMIT ?1`,
      bind: [limit, beforeTs ?? null],   // array index 0 -> ?1, index 1 -> ?2
      rowMode: 'object',
      callback: (r: any) => pages.push({ id: r.id, url: r.url, title: r.title, capturedAt: r.capturedAt }),
    })
    return pages
  }
  ```
  Add to the `handlers` map: `recentPages: (db, args) => opRecentPages(db, args),`. (`CapturedPage` is already imported in this file.)

  > Scenario: the persistent OPFS store returns captured pages newest-first, paged by the capturedAt cursor.
  > Coverage: N/A - sqlite-wasm + OPFS only run inside the offscreen document; the unit env has no OPFS. This mirrors Task 1's `recentPages` contract test (same semantics on the pure adapter), the same justification every other worker op carries.

- [ ] **Step 2: worker adapter (`src/offscreen/worker-vector-store.ts`)**
  ```ts
  recentPages = (limit: number, beforeTs?: number) =>
    this.c.request<CapturedPage[]>('recentPages', { limit, beforeTs })
  ```

- [ ] **Step 3: offscreen op (`src/offscreen/offscreen.ts`)**
  Add a branch in the RPC handler (near `has-page`):
  ```ts
  if (op === 'recent-pages') {
    const limit = p.limit as number
    const beforeTs = p.beforeTs as number | undefined
    return { pages: await store.recentPages(limit, beforeTs) }
  }
  ```

- [ ] **Step 4: messaging types (`src/messaging.ts`)**
  - Import `CapturedPage`: `import type { CapturedPage, RankedResult } from './core/model'`.
  - Add to `Msg`: `| { type: 'recent-pages'; limit: number; beforeTs?: number }`.
  - Add to `MsgResult`: `| { type: 'pages'; pages: CapturedPage[] }`.

- [ ] **Step 5: SW relay (`src/background/index.ts`)**
  - Add `'recent-pages'` to the handled-types guard (the `msg.type !== ...` chain).
  - Add a dispatch branch (alongside `has-page`):
    ```ts
    } else if (msg.type === 'recent-pages') {
      const r = await callOffscreen<{ pages: import('../core/model').CapturedPage[] }>(
        { op: 'recent-pages', limit: msg.limit, beforeTs: msg.beforeTs },
      )
      sendResponse({ type: 'pages', pages: r.pages } satisfies MsgResult)
    }
    ```

  > Scenario: the History tab asks the SW for recent pages; the SW relays to the offscreen and returns the list.
  > Coverage: N/A - pure Chrome-API message relay (mirrors the existing capture/recall/has-page relay, covered only by e2e + build). Exercised end-to-end by Task 6 + `npm run build`.

- [ ] **Step 6: typecheck + build, then commit**
  ```bash
  npx tsc --noEmit && npm run build
  git add src/offscreen/sqlite-worker.ts src/offscreen/worker-vector-store.ts src/offscreen/offscreen.ts src/messaging.ts src/background/index.ts
  git commit -m "feat(offscreen): recent-pages op + SW relay (history browse vertical slice)"
  ```

---

## Task 3: pure relative-time helper (TDD)

Each history row shows how long ago the page was captured (`just now`, `5m`, `3h`, `2d`, `Mar 4`). The bucketing is pure and `now`-injected so it is unit-testable without a clock; the component passes `Date.now()` at render.

**Files:** Create `tests/core/relative-time.test.ts` (test FIRST), `src/ui/sidepanel/relative-time.ts`. (Lives under `src/ui/sidepanel` next to its only consumer, mirroring how `suggestions.ts` lives there but is tested under `tests/core/`.)

- [ ] **Step 1 (RED): `tests/core/relative-time.test.ts`** (ASCII-only)

  ```ts
  import { relativeTime } from '../../src/ui/sidepanel/relative-time'

  const SEC = 1000
  const MIN = 60 * SEC
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  // Scenario: a page captured seconds ago should read "just now", not "0m".
  // Coverage: integration (pure function, injected now).
  test('under a minute reads just now', () => {
    expect(relativeTime(1_000_000, 1_000_000 + 5 * SEC)).toBe('just now')
  })

  // Scenario: minutes/hours/days each get a compact ASCII label.
  // Coverage: integration (pure function, injected now).
  test('minutes, hours, and days bucket compactly', () => {
    const t = 1_000_000_000
    expect(relativeTime(t, t + 5 * MIN)).toBe('5m')
    expect(relativeTime(t, t + 3 * HOUR)).toBe('3h')
    expect(relativeTime(t, t + 2 * DAY)).toBe('2d')
  })

  // Scenario: bucket boundaries must not overlap or gap (59s is still "just now"; 60s is "1m";
  // 60m is "1h"; 24h is "1d").
  // Coverage: integration (pure function, injected now).
  test('boundaries are exact', () => {
    const t = 2_000_000_000
    expect(relativeTime(t, t + 59 * SEC)).toBe('just now')
    expect(relativeTime(t, t + 60 * SEC)).toBe('1m')
    expect(relativeTime(t, t + 60 * MIN)).toBe('1h')
    expect(relativeTime(t, t + 24 * HOUR)).toBe('1d')
  })

  // Scenario: anything older than ~30 days falls back to a short calendar date (no "400d").
  // Coverage: integration (pure function, injected now; assert ASCII month + day, fixed UTC input).
  test('old captures show a short calendar date', () => {
    // 2021-03-04T00:00:00Z, read from far in the future so it is in the calendar bucket.
    const then = Date.UTC(2021, 2, 4)
    const out = relativeTime(then, then + 90 * DAY)
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/) // e.g. "Mar 4"
  })
  ```
  Run `npx vitest run tests/core/relative-time.test.ts` -> FAILS (module missing).

- [ ] **Step 2 (GREEN): `src/ui/sidepanel/relative-time.ts`**
  ```ts
  // Compact ASCII "time since" for the History list. Pure + now-injected so it is testable
  // without a clock. Buckets: <60s just now, <60m Nm, <24h Nh, <~30d Nd, else "Mon D".
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  export function relativeTime(then: number, now: number): string {
    const s = Math.max(0, Math.floor((now - then) / 1000))
    if (s < 60) return 'just now'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d}d`
    const dt = new Date(then)
    return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`
  }
  ```
  Re-run -> green. `rg "chrome|Date.now" src/ui/sidepanel/relative-time.ts` finds only the `new Date(then)` construction (no `Date.now()`).

- [ ] **Step 3: Commit**
  ```bash
  git add src/ui/sidepanel/relative-time.ts tests/core/relative-time.test.ts
  git commit -m "feat(ui): pure relativeTime helper for the history list"
  ```

---

## Task 4: strings (RED shape test, then GREEN)

Add the three new UI strings to the canonical `strings.ts`, guarded by the existing shape test so a missing/renamed key fails fast and the e2e-asserted labels stay byte-identical.

**Files:** Modify `tests/core/strings.test.ts` (test FIRST), `src/ui/sidepanel/strings.ts`.

- [ ] **Step 1 (RED): extend `tests/core/strings.test.ts`**
  - Add `'historyTabLabel'`, `'historyEmpty'`, `'loadMore'` to the `STATIC_KEYS` list.
  - Add to the byte-identical block:
    ```ts
    // Scenario: the History tab label + Load-more button are asserted verbatim by the e2e;
    // a wording change here must fail loudly.
    // Coverage: integration (real EN object).
    expect(EN.historyTabLabel).toBe('History')
    expect(EN.loadMore).toBe('Load more')
    ```
  Run `npx vitest run tests/core/strings.test.ts` -> FAILS (keys missing).

- [ ] **Step 2 (GREEN): `src/ui/sidepanel/strings.ts`**
  - In `interface UIStrings`, add (under the Search group):
    ```ts
    historyTabLabel: string      // the 'History' tab label
    historyEmpty: string         // empty-state line when nothing is captured yet
    loadMore: string             // the load-more button
    ```
  - In `EN`:
    ```ts
    historyTabLabel: 'History',
    historyEmpty: 'Nothing captured yet - pages you save will show up here.',
    loadMore: 'Load more',
    ```
  Re-run -> green.

- [ ] **Step 3: Commit**
  ```bash
  git add src/ui/sidepanel/strings.ts tests/core/strings.test.ts
  git commit -m "feat(ui): history tab strings (label, empty state, load more)"
  ```

---

## Task 5: HistoryTab component + the 3-line scaffold wiring

Slot the new tab into the scaffold (the additive change it was designed for) and build the list component. Browser glue (Chrome messaging, render) - no pure logic beyond what Tasks 1/3 already cover - so this task is exercised by Task 6's e2e + the build, not a new unit test.

**Files:** Create `src/ui/sidepanel/HistoryTab.tsx`; Modify `src/ui/sidepanel/Tabs.tsx`, `src/ui/sidepanel/SidePanel.tsx`, `src/ui/sidepanel/sidepanel.css` (optional).

- [ ] **Step 1: extend the scaffold (`Tabs.tsx`) - 2 edits, bar untouched**
  - Union: `export type TabKey = 'search' | 'history'`.
  - `TABS`: add the row (uncommenting the placeholder):
    ```ts
    export const TABS: { key: TabKey; label: string }[] = [
      { key: 'search', label: t.searchTabLabel },
      { key: 'history', label: t.historyTabLabel },
    ]
    ```
  Do NOT touch `TabBar`. The bar now renders two tabs from `TABS.map(...)` automatically.

- [ ] **Step 2: switch line (`SidePanel.tsx`) - 2 edits**
  - Import: `import { HistoryTab } from './HistoryTab'`.
  - Next to the existing `{tab === 'search' && <SearchTab />}` line, add:
    ```tsx
    {tab === 'history' && <HistoryTab />}
    ```
  Nothing else in `SidePanel.tsx` changes. (This + Step 1 are the full "3-line additive change" the scaffold promised - the validation called out at the top of this plan.)

- [ ] **Step 3: `src/ui/sidepanel/HistoryTab.tsx`**
  Reverse-chron list with keyset paging. Mirrors `SearchTab`'s local `hostOf` and `.results`/`.card` markup.
  ```tsx
  import { useState, useEffect } from 'preact/hooks'
  import type { MsgResult } from '../../messaging'
  import type { CapturedPage } from '../../core/model'
  import { t } from './strings'
  import { relativeTime } from './relative-time'

  const PAGE_SIZE = 20

  function hostOf(url: string): string {
    try { return new URL(url).hostname } catch { return '' }
  }

  // Browse view: reverse-chronological list of captured pages, paged by the capturedAt
  // keyset cursor. Distinct from Search - this is "show me everything I saved, newest first".
  export function HistoryTab() {
    const [pages, setPages] = useState<CapturedPage[]>([])
    const [loaded, setLoaded] = useState(false)   // first fetch resolved (drives empty state)
    const [done, setDone] = useState(false)       // last fetch returned < PAGE_SIZE -> no more
    const [loading, setLoading] = useState(false)

    const fetchPage = async (beforeTs?: number) => {
      if (loading) return
      setLoading(true)
      try {
        const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recent-pages', limit: PAGE_SIZE, beforeTs })
        if (res.type === 'pages') {
          setPages((cur) => beforeTs === undefined ? res.pages : [...cur, ...res.pages])
          if (res.pages.length < PAGE_SIZE) setDone(true)
        }
      } catch {
        // Local-only: the capture/index status line is owned by SidePanel; a failed browse
        // just leaves the list as-is.
      } finally {
        setLoading(false)
        setLoaded(true)
      }
    }

    useEffect(() => { fetchPage() }, [])

    const loadMore = () => {
      if (pages.length === 0) return
      fetchPage(pages[pages.length - 1].capturedAt)
    }

    const now = Date.now()
    return (
      <div class="historytab">
        {loaded && pages.length === 0 && <div class="hint">{t.historyEmpty}</div>}
        {pages.length > 0 && (
          <div class="results">
            {pages.map((p) => (
              <article class="card" key={p.id}>
                <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title || p.url}</a>
                <div class="meta">{hostOf(p.url)} &middot; {relativeTime(p.capturedAt, now)}</div>
              </article>
            ))}
          </div>
        )}
        {pages.length > 0 && !done && (
          <button class="linkbtn loadmore" onClick={loadMore} disabled={loading}>{t.loadMore}</button>
        )}
      </div>
    )
  }
  ```
  Notes: title falls back to the url when empty (defensive); each row is a real `<a href>` so a click opens the page (and the e2e can assert the href). The list reuses the Search result markup so no e2e locator churn.

- [ ] **Step 4: CSS (optional, `sidepanel.css`)**
  Reuse `.results`/`.card`/`.meta`/`.linkbtn`. Add ONLY if the Load-more button needs spacing:
  ```css
  .historytab { display: flex; flex-direction: column; gap: 10px; }
  .loadmore { align-self: flex-start; }
  ```

- [ ] **Step 5: typecheck + build, then commit**
  ```bash
  npx tsc --noEmit && npm run build
  git add src/ui/sidepanel/HistoryTab.tsx src/ui/sidepanel/Tabs.tsx src/ui/sidepanel/SidePanel.tsx src/ui/sidepanel/sidepanel.css
  git commit -m "feat(ui): History tab - reverse-chron browse list with load-more"
  ```

---

## Task 6: e2e (light)

Prove the real path: two distinct captures show up under History, newest-first, and a row links to the page url. Reuse the thin-fixture (`page.route` + < 100-word body, so only deterministic MANUAL captures exist), sidepanel-path, and bringToFront patterns from `forget-history.spec.ts` / `recall-flow.spec.ts`.

**Files:** Create `tests/e2e/history-tab.spec.ts`.

- [ ] **Step 1: write the spec** (ASCII-only)

  ```ts
  import { test, expect, chromium } from '@playwright/test'
  import path from 'node:path'
  import { fileURLToPath } from 'node:url'

  const dir = path.dirname(fileURLToPath(import.meta.url))
  const distPath = path.resolve(dir, '../../dist-ext')

  // Two SHORT, distinct articles (< 100 words). Thin pages are blocked by the auto-capture
  // soft gate but MANUAL "Capture this page" bypasses it, so only the test's deterministic
  // captures exist (no dwell auto-capture races the browse). Distinct titles let us assert
  // newest-first ordering by title.
  const CORTISOL_HTML = `<!doctype html><html><head><title>Sleep and cortisol</title></head>
  <body><article><p>Cortisol is a stress hormone made by the adrenal glands. It follows a
  daily rhythm, high in the morning and falling at night so melatonin can rise and bring
  sleep, which is the hormone problem that ruins sleep.</p></article></body></html>`

  const PLANTS_HTML = `<!doctype html><html><head><title>How plants make food</title></head>
  <body><article><p>Photosynthesis is how a green plant makes its own food from sunlight. A
  green pigment called chlorophyll inside the leaves catches the light energy and joins water
  and carbon dioxide into sugar, releasing oxygen.</p></article></body></html>`

  // Scenario: a user captures two pages, opens History, and sees both newest-first; clicking
  // a row opens that page. This is the browse-my-memory payoff, distinct from Search.
  // Coverage: integration (built extension; real capture + offscreen recent-pages + panel render).
  test('History tab lists captured pages newest-first with working links', async () => {
    test.setTimeout(120_000)

    const ctx = await chromium.launchPersistentContext('', {
      headless: false,
      args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
    })
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
    const extId = sw.url().split('/')[2]

    // First capture: cortisol (older).
    const cortisolUrl = 'http://history-test.example/cortisol'
    const cortisol = await ctx.newPage()
    await cortisol.route(cortisolUrl, (r) => r.fulfill({ contentType: 'text/html', body: CORTISOL_HTML }))
    await cortisol.goto(cortisolUrl)

    // Second capture: plants (newer).
    const plantsUrl = 'http://history-test.example/plants'
    const plants = await ctx.newPage()
    await plants.route(plantsUrl, (r) => r.fulfill({ contentType: 'text/html', body: PLANTS_HTML }))
    await plants.goto(plantsUrl)

    const panel = await ctx.newPage()
    await panel.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)

    // Capture cortisol first (older), then plants (newer), so plants sorts to the top.
    await cortisol.bringToFront()
    await panel.getByText('Capture this page').click()
    await expect(panel.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })

    await plants.bringToFront()
    await panel.getByText('Capture this page').click()
    await expect(panel.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })

    // Open the History tab (the second tab the scaffold now renders).
    await panel.getByRole('tab', { name: 'History' }).click()

    // Both titles appear, plants (newer) above cortisol (older).
    const rows = panel.locator('article')
    await expect(rows).toHaveCount(2, { timeout: 10_000 })
    await expect(rows.nth(0)).toContainText('How plants make food')
    await expect(rows.nth(1)).toContainText('Sleep and cortisol')

    // The newest row's link points at the captured page url (clicking it opens that page).
    await expect(rows.nth(0).locator('a')).toHaveAttribute('href', plantsUrl)

    await ctx.close()
  })
  ```

- [ ] **Step 2: build + run**
  ```bash
  npm run build && npx playwright test tests/e2e/history-tab.spec.ts
  ```
  -> PASS.

- [ ] **Step 3: full suite (no regression)**
  ```bash
  npm run test && npx playwright test
  ```
  -> all green (existing recall-flow / persistence / user-controls / forget-history / hybrid / spa / auto-capture / serp-skip + new history-tab).

- [ ] **Step 4: Commit**
  ```bash
  git add tests/e2e/history-tab.spec.ts
  git commit -m "test(e2e): History tab lists captures newest-first with working links"
  ```

---

## Self-Review

**Spec coverage:**
- Backend vertical slice (`recentPages` port + memory contract test + worker op + adapter + offscreen + messaging + SW relay): Task 1 (pure, RED-first) + Task 2 (glue, mirrors `hasPage`). ✅
- Keyset (cursor) pagination by `capturedAt`: Task 1 Step 1 (cursor test) + Task 2 Step 1 (SQL `WHERE capturedAt < ?2`). ✅
- Pure relative-time helper, unit-tested with injected `now`, ASCII output: Task 3. ✅
- HistoryTab (list rows = title link + host + relative time, empty state, Load-more): Task 5. ✅
- Tab bar now shows 2 tabs via the scaffold's additive change: Task 5 Steps 1-2 (the explicit extensibility validation). ✅
- New strings (`historyTabLabel`, `historyEmpty`, `loadMore`): Task 4. ✅
- Light e2e (2 captures -> History -> newest-first titles + link href): Task 6. ✅

**Notes / risks:**
- `recentPages` returns `CapturedPage` (no `host` field); the UI derives the displayed host from the url via `hostOf`, matching `SearchTab`. The worker SELECT still reads the stored `host` column (cheap, already indexed-by-nothing scan) but discards it - kept in the SQL per the chosen query shape; a future per-row host label could use it without a URL parse.
- The keyset cursor uses strict `<` on `capturedAt`. If two pages share the exact same millisecond `capturedAt` AND that value straddles a page boundary, one could be skipped. `capturedAt` is a millisecond timestamp set per capture, so collisions are rare; see Tradeoffs for the composite-cursor fix if it ever bites.
- Load-more end-detection is "fewer than `PAGE_SIZE` rows came back" - correct for keyset paging and simple to test. A corpus that is an exact multiple of `PAGE_SIZE` shows the button once more, returns an empty page, then hides it - harmless.
- The History list does not live-update when a new capture lands while the tab is open (it fetches on mount + on Load-more). Acceptable for v1; a manual re-open or a future `savedRefresh`-style signal could refresh it.

---

## Tradeoffs

- **Pagination approach (keyset vs OFFSET).** Chose keyset (`WHERE capturedAt < ?cursor`) over `LIMIT/OFFSET`. Keyset stays O(limit) at any depth and never shifts rows when a new capture lands mid-browse; OFFSET re-scans skipped rows and can duplicate/skip when the corpus changes. Cost: keyset can only page forward (fine for an append-only "Load more"), and the cursor must be a sortable column (`capturedAt` is).
- **`capturedAt`-cursor stability.** A single `capturedAt` cursor is unstable only at exact-millisecond ties that straddle a page edge. The clean fix is a composite keyset `(capturedAt, id)` with the SQL comparing the pair (`capturedAt < ?ts OR (capturedAt = ?ts AND id < ?id)`) and a matching `ORDER BY capturedAt DESC, id DESC`. Deferred: it adds a second cursor field through the whole slice for a rare collision; v1 accepts the tiny risk and documents the upgrade path.
- **Per-row delete / "forget this page" later.** Out of scope for v1 (browse only). Today forgetting is SITE-scoped (`deletePagesByHost`). A per-row forget would need a new `deletePage(pageId)` port method + worker op (delete from `pages` + `chunks`, which already fires the FTS delete trigger) + a row affordance. The History list is the natural home for it - this plan leaves room (rows are self-contained) but does not build it.
- **Performance of listing thousands of pages.** The list never loads everything: it pages `PAGE_SIZE` (20) at a time, so the DOM and the round-trip stay bounded regardless of corpus size. The worker query is `ORDER BY capturedAt DESC LIMIT ?` - a full sort of the `pages` table per page-fetch (no index on `capturedAt`). For thousands of pages this sort is still sub-millisecond in sqlite; if a very large corpus ever makes it noticeable, add `CREATE INDEX pages_capturedAt ON pages(capturedAt DESC)` (a one-line idempotent migration, same pattern as the existing `host` column add). Deferred until measured.
- **Load-more button vs infinite scroll.** Chose a button: deterministic to test (no IntersectionObserver timing in Playwright), trivial to reason about, and honest about cost (the user opts into each page). Infinite scroll is a later UX polish that can reuse the exact same `fetchPage(beforeTs)` plumbing.
```
