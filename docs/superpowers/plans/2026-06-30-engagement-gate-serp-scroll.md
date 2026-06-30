# Engagement Gate: SERP skip + scroll signal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Every code change is TDD: failing test FIRST, watched fail, then implementation. Steps use checkbox (`- [ ]`).

**Goal:** Raise auto-capture PRECISION. Keep only pages the user actually READ; skip transient/junk pages. Two new signals, both AUTO-only (manual save = explicit intent, never gated by these):

1. **SERP skip** - search engine results pages are navigational link lists, not content worth recalling. New pure `isSerp(url)`, wired into `CaptureGate.decide` as a SOFT gate (new reason `'serp'`), mirroring how the existing `thin` gate is skipped for manual.
2. **Scroll engagement** - a long page left open 10s but never touched was probably not read. CONFIRMED model:

   ```
   auto-capture = (10s visible DWELL)  AND  engaged     // both; once per page candidate
   engaged = SHORT page (scrollHeight <= viewport*1.5)  OR  scrolled >= 50%  OR  selected text
   ```

   A page is ENGAGED if it is SHORT (fits ~1.5 screens, no real scrolling needed) OR the user scrolled at least halfway through a long page OR the user selected a few words of text. The 10s `DwellTracker` is UNCHANGED and still required; engagement is an ADDITIONAL gate. New pure `EngagementTracker` (mirrors `DwellTracker`), wired into the content script so auto-capture fires only when dwell AND engagement are both satisfied, exactly once per candidate via a synchronous `fired` flag.

**Tech Stack:** TypeScript, Vite+CRXJS, Preact, Vitest, Playwright. Hexagonal: `src/core/*` stays pure (no `chrome`, no DOM); browser glue lives in `src/content/*`.

**Current baseline (verify before starting):** `npx vitest run` green. `rg "chrome" src/core` = empty (core is pure). Confirm both before touching anything.

---

## Design decisions (baked in)

- **SERP = soft gate, reason `'serp'`, AUTO only.** Manual save of a SERP still works. Sits next to the existing `thin` soft gate inside the `if (!input.manual)` block of `CaptureGate.decide`.
- **Engagement gates AUTO only.** Manual capture ignores engagement entirely (the content script's manual path never consults the tracker).
- **Thresholds are named constants (tunable):**
  - `SHORT_PAGE_RATIO = 1.5` -> page is short when `scrollHeight <= viewport * 1.5`.
  - `ENGAGED_FRACTION = 0.5` -> scrolled-enough when `maxFrac >= 0.5`, where `maxFrac` is the max reached `(scrollY + viewport) / scrollHeight`.
  - `MIN_SELECTION_CHARS = 10` -> a selection of at least this many characters (a few words) counts as engagement; a stray single-word double-click does not.
- **`EngagementTracker` is pure with injected getters**, exactly like `DwellTracker`: no DOM reads, no `chrome`, unit-testable with plain numbers. Signals: `onScroll(scrollY, viewport, scrollHeight)` (sticky `maxFrac`), `onSelection(selectedChars)` (sticky `selected` once `>= MIN_SELECTION_CHARS`), `engaged(viewport, scrollHeight)`, `reset()`.
- **Combined firing rule in the content script:** capture happens at `max(dwell-met, engaged)`. Keep `DwellTracker` firing the "dwell reached" signal; gate the actual `sendCapture(false)` on `engagement.engaged(...)`. Re-evaluate on the existing 1s poll, on scroll events, AND on selectionchange, so a page that becomes engaged *after* dwell still captures (deferred capture).
- **Once-per-candidate dedup via a synchronous `fired` flag.** `maybeCapture()` does: `if (!fired && dwellMet && engagement.engaged(vp, sh)) { fired = true; sendCapture(false) }` - `fired` is set BEFORE the async `sendCapture` so concurrent signals (poll tick, scroll, selectionchange) can never double-fire. (Storage is idempotent - capture upserts by pageId - so even a slipped duplicate makes no duplicate page; `fired` just avoids the wasted re-embed.)
- **Reset engagement on SPA url change** in the same place `DwellTracker.reset()` is called: `tracker.reset()`, `engagement.reset()`, `dwellMet = false`, `fired = false`.

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `src/core/serp.ts` | Create | Pure `isSerp(url): boolean` matching major search-engine results URLs. No DOM, no chrome. |
| `src/core/capture-gate.ts` | Modify | Add `'serp'` to `GateDecision.reason`; inside the `!input.manual` soft-gate block, reject SERPs before the thin check. |
| `src/content/engagement-tracker.ts` | Create | Pure `EngagementTracker`: `onScroll(scrollY, viewport, scrollHeight)`, `onSelection(selectedChars)`, `engaged(viewport, scrollHeight): boolean`, `reset()`. Injected getters; no DOM. |
| `src/content/capture.ts` | Modify | Add a scroll listener + a selectionchange listener + an `EngagementTracker`; gate `sendCapture(false)` on dwell-met AND engaged; re-check on poll, scroll, and selection; synchronous `fired` flag for once-per-candidate; reset on SPA nav. |
| `tests/core/serp.test.ts` | Create | `isSerp` matches known SERPs, rejects non-SERPs (incl. content pages on the same hosts). |
| `tests/core/capture-gate.test.ts` | Modify | Add: SERP blocked for auto (reason `'serp'`), NOT for manual; non-SERP still allowed. All calls pass the `settings` arg. |
| `tests/core/engagement-tracker.test.ts` | Create | Short page engaged immediately; long page not engaged until scrolled >=50%; engaged via a >=10-char selection; selection under the minimum ignored; sticky max; `reset` clears both; injected-getter style. |
| `tests/e2e/serp-skip.spec.ts` | Create | A routed google.com/search page: auto-capture is skipped (reason `'serp'`); manual capture works. |

**NOT touched:** `src/core/denylist.ts` (SERP is a separate, softer concept than the privacy denylist - keep them apart), `src/offscreen/offscreen.ts` (it already calls `gate.decide({...}, s)` and just relays `decision.reason`; the new `'serp'` reason flows through unchanged), the search/index pipeline.

> Note on test location: `dwell-tracker.test.ts` lives in **`tests/core/`** even though the source is in `src/content/`. Create `engagement-tracker.test.ts` under **`tests/core/`** too, for consistency with `dwell-tracker.test.ts` - keep the relative import path `../../src/content/engagement-tracker` correct.

---

## Task 1: Pure `isSerp` + gate integration (reason `'serp'`, soft, auto-only)

A SERP is a search-results URL on a known engine. Pure string check on the URL; never reads page content. Wires into the gate next to `thin`, inside the `!input.manual` block, so manual save of a SERP still works.

**Files:** Create `tests/core/serp.test.ts` (test first), `src/core/serp.ts`; Modify `tests/core/capture-gate.test.ts`, `src/core/capture-gate.ts`.

- [ ] **Step 1 (RED): `tests/core/serp.test.ts`**

To get a clean assertion-RED (not a missing-module error), first stub `src/core/serp.ts` as `export function isSerp(_url: string): boolean { return false }`, then write the test and watch the "known SERP" cases fail.

```typescript
import { isSerp } from '../../src/core/serp'

// Scenario: the major engines' results pages are link lists, not readable content; each
// must be recognized so auto-capture skips them.
// Coverage: integration (pure URL check over real result-page URLs).
test('recognizes major search-engine result pages', () => {
  const serps = [
    'https://www.google.com/search?q=cortisol+sleep',
    'https://www.bing.com/search?q=double+entry+bookkeeping',
    'https://duckduckgo.com/?q=photosynthesis&ia=web',
    'https://search.yahoo.com/search?p=tax+basics',
    'https://search.brave.com/search?q=hexagonal+architecture',
    'https://www.ecosia.org/search?q=opfs',
    'https://www.startpage.com/sp/search?query=vitest',
    'https://kagi.com/search?q=playwright',
    'https://www.baidu.com/s?wd=typescript',
    'https://yandex.com/search/?text=preact',
  ]
  for (const url of serps) expect(isSerp(url)).toBe(true)
})

// Scenario: a normal article (even on a search-engine host) must NOT be mistaken for a
// SERP, or we would wrongly skip real content.
// Coverage: integration (pure URL check).
test('does not flag non-result pages', () => {
  const notSerps = [
    'https://example.com/article/cortisol',
    'https://www.google.com/maps/place/Paris',
    'https://news.ycombinator.com/item?id=1',
    'https://duckduckgo.com/about',
    'https://www.bing.com/news',
    'https://en.wikipedia.org/wiki/Search_engine',
  ]
  for (const url of notSerps) expect(isSerp(url)).toBe(false)
})

// Scenario: a malformed URL must not throw - the gate runs on every page.
// Coverage: integration (pure URL check, error path).
test('returns false for a malformed url', () => {
  expect(isSerp('not a url')).toBe(false)
})
```

Run `npx vitest run tests/core/serp.test.ts` -> the two positive/negative blocks MUST fail against the stub.

- [ ] **Step 2 (GREEN): `src/core/serp.ts`**

Pure host+path matcher. Parse the URL; match the engine host AND its results path (so `/maps`, `/about`, `/news` on the same host are NOT flagged). Return `false` on parse failure.

```typescript
// A SERP (search engine results page) is a navigational list of links to other pages,
// not readable content worth recalling. This is a SOFT signal for auto-capture only -
// manual save still works (the gate handles that). Pure URL check: host + results path,
// no page content, no DOM. Kept SEPARATE from the privacy denylist (different intent:
// "low value" vs "never store").
//
// Each entry: the engine's host (or host suffix) plus the path that means "results".
// Matching the path (not just the host) avoids flagging content sub-apps on the same
// host - e.g. google.com/maps, duckduckgo.com/about, bing.com/news are NOT SERPs.
export function isSerp(url: string): boolean {
  let host: string
  let path: string
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase()
    path = u.pathname.toLowerCase()
  } catch {
    return false
  }
  const hostIs = (suffix: string) => host === suffix || host.endsWith('.' + suffix)

  // /search engines (google, bing, yahoo, brave, ecosia, startpage, kagi).
  if (path === '/search' || path.startsWith('/search')) {
    if (
      hostIs('google.com') || hostIs('bing.com') || hostIs('yahoo.com') ||
      hostIs('brave.com') || hostIs('ecosia.org') || hostIs('startpage.com') ||
      hostIs('kagi.com')
    ) return true
  }
  // DuckDuckGo: results live at the site root with a ?q= query (duckduckgo.com/?q=...).
  if (hostIs('duckduckgo.com') && (path === '/' || path === '') && /[?&]q=/.test(url)) return true
  // Baidu results: /s
  if (hostIs('baidu.com') && path === '/s') return true
  // Yandex results: /search/ (note trailing slash)
  if (hostIs('yandex.com') && (path === '/search' || path === '/search/')) return true
  return false
}
```

(Implementer: tune the predicates so every Task 1 Step 1 positive matches and every negative does not - the test is the spec. The structure above is the intended shape, not a frozen string.)

- [ ] **Step 3 (RED): gate tests for the SERP soft gate (`tests/core/capture-gate.test.ts`)**

Add to the existing file (it already builds a `gate` with `minWords: 5` and an `open` settings object). All `decide` calls already pass the `settings` arg - keep that.

```typescript
// Scenario: a user who searched then bounced through results should NOT have the SERP
// auto-captured - it is a link list, not an article.
// Coverage: integration (real CaptureGate + isSerp, soft-gate path).
test('auto: SERP rejected with reason serp', () => {
  const d = gate.decide({ url: 'https://www.google.com/search?q=cortisol', text: long, manual: false }, open)
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('serp')
})

// Scenario: if the user EXPLICITLY clicks save on a results page, honor the intent -
// the SERP soft gate is skipped for manual, just like the thin gate.
// Coverage: integration (real CaptureGate, manual path).
test('manual: SERP IS captured (soft gate skipped)', () => {
  const d = gate.decide({ url: 'https://www.google.com/search?q=cortisol', text: long, manual: true }, open)
  expect(d.capture).toBe(true)
})

// Scenario: a normal article must still pass - the SERP gate must not over-block.
// Coverage: integration (real CaptureGate).
test('auto: non-SERP article still captured', () => {
  const d = gate.decide({ url: 'https://example.com/article/cortisol', text: long, manual: false }, open)
  expect(d.capture).toBe(true)
})
```

Run `npx vitest run tests/core/capture-gate.test.ts` -> the two SERP-block assertions MUST fail (today the SERP url passes as a normal page).

- [ ] **Step 4 (GREEN): wire into `CaptureGate.decide` (`src/core/capture-gate.ts`)**

Add the reason to the type and the check to the soft-gate block. Import at top: `import { isSerp } from './serp'`.

```typescript
export interface GateDecision { capture: boolean; reason?: 'paused' | 'denylisted' | 'thin' | 'serp' }
```
Inside `decide`, in the existing `if (!input.manual) { ... }` block, BEFORE the thin word-count check:
```typescript
    // Soft gate (quality): skipped for explicit manual save.
    if (!input.manual) {
      // SERPs are navigational link lists, not content worth recalling.
      if (isSerp(input.url)) return { capture: false, reason: 'serp' }
      const words = input.text.trim().split(/\s+/).filter(Boolean).length
      if (words < this.minWords) return { capture: false, reason: 'thin' }
    }
```
(Order vs `thin` does not change behavior - both block auto - but SERP-first gives the clearer reason for a results page, which `offscreen.ts` already relays unchanged.)

- [ ] **Step 5: verify Task 1**

`npx vitest run tests/core/serp.test.ts tests/core/capture-gate.test.ts` -> all green. `rg "chrome|document\." src/core/serp.ts` -> empty (pure).

---

## Task 2: Pure `EngagementTracker`

Mirror `DwellTracker`: a small pure object that the content script feeds raw numbers. It records the deepest scroll reached AND whether the user selected text, and answers "engaged?" = the page is short OR the user scrolled past halfway OR the user selected a few words. No DOM, no chrome - the content script reads `window.scrollY` / `innerHeight` / `scrollHeight` / the selection length and passes them in.

**Files:** Create `tests/core/engagement-tracker.test.ts` (test first), `src/content/engagement-tracker.ts`.

- [ ] **Step 1 (RED): `tests/core/engagement-tracker.test.ts`**

Stub `src/content/engagement-tracker.ts` first (export `MIN_SELECTION_CHARS` too, so the import resolves and you get assertion-RED, not a missing-name):
```typescript
export const MIN_SELECTION_CHARS = 10
export class EngagementTracker {
  onScroll(_y: number, _vp: number, _sh: number): void {}
  onSelection(_chars: number): void {}
  engaged(_vp: number, _sh: number): boolean { return false }
  reset(): void {}
}
```
Then the test (covers short page, scroll >=50%, selection >=MIN, selection <MIN ignored, sticky max, reset clears both):
```typescript
import { EngagementTracker, MIN_SELECTION_CHARS } from '../../src/content/engagement-tracker'

// Scenario: a short page (fits ~1.5 screens) needs no scrolling to be "read"; reaching
// dwell on it should count as engaged immediately, with zero scroll events.
// Coverage: integration (pure tracker, real ratio math, no mock).
test('short page is engaged immediately without scrolling', () => {
  const t = new EngagementTracker()
  // viewport 800, content 1000 -> 1000 <= 800 * 1.5 (1200) -> short.
  expect(t.engaged(800, 1000)).toBe(true)
})

// Scenario: a long page left open but never scrolled is probably NOT read; it must not
// count as engaged until the user actually scrolls through it.
// Coverage: integration (pure tracker).
test('long page is not engaged until scrolled past halfway', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000 // 4000 > 800 * 1.5 (1200) -> long page
  expect(t.engaged(vp, sh)).toBe(false) // no scroll yet
  t.onScroll(200, vp, sh) // (200 + 800) / 4000 = 0.25 -> under half
  expect(t.engaged(vp, sh)).toBe(false)
  t.onScroll(1400, vp, sh) // (1400 + 800) / 4000 = 0.55 -> past half
  expect(t.engaged(vp, sh)).toBe(true)
})

// Scenario: max-reached is sticky - scrolling back up must not undo "engaged" (the user
// already read down the page).
// Coverage: integration (pure tracker).
test('engagement sticks after scrolling back up', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000
  t.onScroll(1400, vp, sh) // 0.55 -> engaged
  t.onScroll(0, vp, sh) // back to top
  expect(t.engaged(vp, sh)).toBe(true)
})

// Scenario: a user who selects a few words on a long page engaged with it even without
// scrolling halfway; a single-word double-click (< MIN) must NOT count.
// Coverage: integration (pure tracker).
test('long page is engaged via a selection without scrolling', () => {
  const t = new EngagementTracker()
  expect(t.engaged(800, 4000)).toBe(false)
  t.onSelection(MIN_SELECTION_CHARS)
  expect(t.engaged(800, 4000)).toBe(true)
})
test('selection shorter than the minimum is ignored', () => {
  const t = new EngagementTracker()
  t.onSelection(MIN_SELECTION_CHARS - 1)
  expect(t.engaged(800, 4000)).toBe(false)
})

// Scenario: SPA navigation to a new page must restart engagement from zero, or a deep
// scroll or selection on page A would wrongly mark page B as read.
// Coverage: integration (pure tracker).
test('reset clears both scroll depth and selection', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000
  t.onScroll(1400, vp, sh) // engaged via scroll
  t.onSelection(MIN_SELECTION_CHARS) // engaged via selection
  t.reset()
  expect(t.engaged(vp, sh)).toBe(false)
})
```
Run `npx vitest run tests/core/engagement-tracker.test.ts` -> MUST fail (stub always returns false / never tracks).

- [ ] **Step 2 (GREEN): `src/content/engagement-tracker.ts`**

```typescript
// Tracks how far DOWN a page the user has scrolled and answers "did they engage with it?"
// Pure and deterministic: the content script reads window.scrollY / innerHeight /
// document scrollHeight and feeds them in, so this stays DOM-free and unit-testable.
//
// Model (CONFIRMED): a page is ENGAGED if it is SHORT (content fits ~1.5 screens, so no
// real scrolling is needed to read it) OR the user scrolled at least halfway through a
// long page. "Max reached fraction" = the deepest (scrollY + viewport) / scrollHeight the
// user ever reached; it is sticky (scrolling back up does not lower it). This gates
// AUTO-capture only - a long page left open but never scrolled is probably not read.
export const SHORT_PAGE_RATIO = 1.5 // short when scrollHeight <= viewport * 1.5
export const ENGAGED_FRACTION = 0.5 // long page counts as read once maxFrac >= 0.5
export const MIN_SELECTION_CHARS = 10 // a few words; avoids double-click-a-word false positives

export class EngagementTracker {
  private maxFrac = 0
  private selected = false

  // Call on every scroll event (and once after content settles). viewport = innerHeight,
  // scrollHeight = full document height. Records the deepest fraction seen.
  onScroll(scrollY: number, viewport: number, scrollHeight: number): void {
    if (scrollHeight <= 0) return
    const frac = (scrollY + viewport) / scrollHeight
    if (frac > this.maxFrac) this.maxFrac = frac
  }

  // Call on selection change with the trimmed length of the current selection. A few
  // words (>= MIN_SELECTION_CHARS) sticks; a stray single-word double-click does not.
  onSelection(selectedChars: number): void {
    if (selectedChars >= MIN_SELECTION_CHARS) this.selected = true
  }

  // Short pages are engaged with no scrolling; long pages need maxFrac >= ENGAGED_FRACTION
  // OR a sticky selection.
  engaged(viewport: number, scrollHeight: number): boolean {
    if (scrollHeight <= viewport * SHORT_PAGE_RATIO) return true
    return this.maxFrac >= ENGAGED_FRACTION || this.selected
  }

  // Start fresh for a new page/candidate (e.g. SPA navigation).
  reset(): void {
    this.maxFrac = 0
    this.selected = false
  }
}
```

- [ ] **Step 3: verify Task 2**

`npx vitest run tests/core/engagement-tracker.test.ts` -> green. `rg "chrome|document\.|window\." src/content/engagement-tracker.ts` -> only a comment mention (no real DOM use; the DOM reads live in the content script, Task 3).

---

## Task 3: Content-script wiring (scroll listener + combined dwell+engagement + SPA reset)

Browser glue: read the real DOM numbers, feed both trackers, and only `sendCapture(false)` when dwell is met AND the page is engaged. Because either condition can be satisfied last, re-evaluate on BOTH the existing 1s poll and on scroll events, and fire exactly once per candidate. The pure logic is already covered by Tasks 1-2; this step is the wiring.

**Files:** Modify `src/content/capture.ts`.

- [ ] **Step 1: add the engagement tracker + a "ready to capture" check**

In `src/content/capture.ts`, import the tracker:
```typescript
import { EngagementTracker } from './engagement-tracker'
```
Replace the auto-capture block (the `{ ... }` that builds `DwellTracker`, adds the visibilitychange listener, and runs the poll). Keep `DWELL_MS` / `POLL_MS` / `urlKey` as-is. The new wiring:
- Keep `DwellTracker`, but its `onDwell` now sets a flag `dwellMet = true` and calls a shared `maybeCapture()` instead of capturing directly.
- Add an `EngagementTracker`; on each scroll event read `window.scrollY`, `window.innerHeight`, `document.documentElement.scrollHeight`, call `engagement.onScroll(...)`, then `maybeCapture()`.
- Add a `selectionchange` listener that feeds `engagement.onSelection(window.getSelection()?.toString().trim().length ?? 0)`, then `maybeCapture()`.
- `maybeCapture()` reads the current viewport + scrollHeight, and if `!fired && dwellMet && engagement.engaged(vp, sh)`, sets `fired = true` SYNCHRONOUSLY (before the async send) and calls `sendCapture(false)`. The synchronous flag is the once-per-candidate dedup: concurrent signals (poll tick, scroll, selectionchange) can never double-fire.
- The 1s poll still resets the trackers on SPA url change, still calls `tracker.tick()`, and then calls `maybeCapture()` (so a short page becomes engaged-via-poll without needing a scroll event).
- On SPA url change: `tracker.reset()`, `engagement.reset()`, `dwellMet = false`, `fired = false`.

Sketch (implementer adapts to the exact existing block):
```typescript
{
  let currentUrlKey = urlKey(location.href)
  let dwellMet = false
  let fired = false
  const engagement = new EngagementTracker()

  const viewport = () => window.innerHeight
  const fullHeight = () => document.documentElement.scrollHeight

  const maybeCapture = () => {
    if (fired || !dwellMet) return
    if (!engagement.engaged(viewport(), fullHeight())) return
    fired = true // set BEFORE the async send so concurrent signals cannot double-fire
    sendCapture(false)
  }

  const tracker = new DwellTracker(
    DWELL_MS,
    () => Date.now(),
    () => document.visibilityState === 'visible',
    () => { dwellMet = true; maybeCapture() },
  )
  tracker.reset()

  document.addEventListener('visibilitychange', () => tracker.onVisibilityChange())
  window.addEventListener('scroll', () => {
    engagement.onScroll(window.scrollY, viewport(), fullHeight())
    maybeCapture()
  }, { passive: true })
  document.addEventListener('selectionchange', () => {
    engagement.onSelection(window.getSelection()?.toString().trim().length ?? 0)
    maybeCapture()
  })

  setInterval(() => {
    const nextKey = urlKey(location.href)
    if (nextKey !== currentUrlKey) {
      currentUrlKey = nextKey // SPA navigation or bounce -> new candidate
      tracker.reset()
      engagement.reset()
      dwellMet = false
      fired = false
      return
    }
    tracker.tick()
    maybeCapture()
  }, POLL_MS)
}
```
Note: storage is idempotent (capture upserts by pageId), so even a slipped duplicate makes no duplicate page - the `fired` flag just avoids the wasted re-embed. Leave the `extract-and-capture` message listener (manual capture) UNTOUCHED - manual ignores engagement.

- [ ] **Step 2 (Coverage note - no new automated test for the glue)**

**Scenario:** a long page read to the bottom auto-captures; a long page left open but never scrolled does not.
**Coverage:** N/A for this wiring step (justified). The decision logic is unit-tested end to end: `EngagementTracker` (Task 2) proves short-vs-long + 50% threshold + reset; `DwellTracker` (existing) proves the dwell signal; the combine is a 3-line `dwellMet && engaged` guard. A real scroll-driven e2e is genuinely flaky here - the repo already DELETED a dwell-visibility e2e for exactly this reason (headless visibility/scroll timing is non-deterministic, and `scrollHeight` in a test fixture depends on fonts/layout that vary by CI runner). Driving real scroll + 10s dwell + background embedding in one Playwright run is the same flaky shape. We cover the branch logic in the pure trackers and keep the glue thin. If a regression slips, it would be in the wiring (which getter feeds which tracker), reviewable by reading the ~25-line block.

- [ ] **Step 3: verify Task 3**

`npx tsc --noEmit` -> clean (the content script compiles with the new tracker + DOM reads). `npx vitest run` -> full unit suite still green (no unit test imports the content-script module; the trackers it composes are covered).

---

## Task 4: Light SERP e2e + full-suite verify

A small end-to-end that proves the SERP gate in the REAL built extension: a results-style page is NOT auto-captured, but a manual save of it IS. This exercises content-script -> offscreen -> gate with the new `'serp'` reason, which the unit tests cannot (they don't build the extension).

**Files:** Create `tests/e2e/serp-skip.spec.ts` (if feasible), `tests/e2e/fixtures/` (a SERP-style fixture if a local file works; otherwise route a `google.com/search` URL).

**DONE:** Implemented option (a) - routing a real `https://www.google.com/search?q=...` URL via `page.route(...)` to a deterministic results-style fixture (`tests/e2e/fixtures/serp.html`). Both legs are in `tests/e2e/serp-skip.spec.ts` and pass: the auto leg waits past the 10s dwell and asserts ZERO results (gate rejected it with reason `'serp'`), then the manual leg clicks "Capture this page" and recalls it. Routing works here because the content script matches `<all_urls>`, so it injects on the routed google host and `location.href` reads as the real SERP URL that `isSerp` parses.

- [ ] **Step 1: decide feasibility, then write the spec**

The existing `auto-capture.spec.ts` is the template (launch persistent context with `--load-extension`, open a fixture, wait for dwell, recall via popup). For SERP:

- **Manual-still-works leg** is robust: open a SERP-style page, trigger manual capture (the popup's "Capture this page" button -> `extract-and-capture`), then recall it from the popup -> it IS found. This proves the soft gate is skipped for manual.
- **Auto-skipped leg** is a NEGATIVE assertion (proving absence). To keep it non-flaky, make the fixture's URL look like a SERP to `isSerp`. Two options:
  - (a) **Route** a `https://www.google.com/search?q=...` request to a local results-style HTML via `page.route(...)` so `location.href` reads as the real SERP URL (what `isSerp` parses) while serving deterministic content. Preferred - it matches the production host/path.
  - (b) If routing the extension's content-script context proves unreliable, fall back to the unit gate test as the source of truth and SKIP the auto-leg e2e (justify below).

```typescript
// Scenario: a Google results page must NOT be auto-captured (it is a link list), but an
// EXPLICIT manual save of it still works.
// Coverage: integration (built extension, real content-script -> offscreen -> gate path)
//   IF routing the SERP url is reliable; otherwise see the gate unit test (Task 1) which
//   is the authoritative coverage for the soft-gate decision.
test('SERP is skipped by auto-capture but savable manually', async () => {
  // ... launch persistent context with --load-extension (see auto-capture.spec.ts) ...
  // ... route google.com/search?q=... to a local results-style HTML fixture ...
  // 1) open the SERP url, wait > DWELL_MS, open popup, recall the query -> expect NO result
  //    (auto-capture skipped).
  // 2) re-open the SERP url, click "Capture this page" (manual), recall -> expect a result
  //    (manual ignores the soft gate).
})
```

- [ ] **Step 2 (justification if Step 1 falls back to option (b))**

**Scenario:** SERP auto-skip in the real extension.
**Coverage:** N/A for the auto-leg e2e (justified) - the content script's `location.href` inside a loaded extension is hard to spoof to a real `google.com/search` URL deterministically without networked routing, and a network-dependent e2e is flaky by nature. The gate decision (`isSerp` -> reason `'serp'`, auto-only, manual-allowed) is fully unit-tested in Task 1, and `offscreen.ts` relays `decision.reason` with zero transform (verified: line ~112-114). The manual-still-works leg, which IS robust, stays in the e2e.

- [ ] **Step 3: full-suite verify**

- `npx vitest run` -> full unit suite green (new: `serp.test.ts`, `engagement-tracker.test.ts`; modified: `capture-gate.test.ts`).
- `npx tsc --noEmit` -> clean.
- `rg "chrome|document\.|window\." src/core` -> empty (core stays pure; `serp.ts` added no impurity).
- `npm run build` -> exit 0 (content script bundles the new `EngagementTracker`).
- `npx playwright test` -> all e2e green (the new `serp-skip.spec.ts` at whatever scope Step 1 settled on; the existing `auto-capture.spec.ts` still passes - a short article fixture stays engaged via the short-page branch, so adding engagement must NOT break it; CONFIRM the article fixture is short OR is scrolled, else fix the fixture/spec).

---

## Self-Review Checklist

- [ ] `isSerp` is pure (no chrome/DOM), matches every engine in the spec (google/bing/yahoo/brave/ecosia/startpage/kagi `/search`, duckduckgo `?q=` at root, baidu `/s`, yandex `/search/`), and rejects content pages on the SAME hosts (maps/about/news).
- [ ] SERP gate is SOFT + AUTO-only: blocked for `manual:false` with reason `'serp'`, allowed for `manual:true`; sits inside the existing `!input.manual` block. `offscreen.ts` relays `'serp'` unchanged (no code change needed there).
- [ ] `EngagementTracker` is pure with injected numbers (mirrors `DwellTracker`): short page engaged immediately, long page engaged at maxFrac >= 0.5 OR a >=10-char selection, both signals sticky, `reset()` clears both. Thresholds are NAMED constants (`SHORT_PAGE_RATIO`, `ENGAGED_FRACTION`, `MIN_SELECTION_CHARS`).
- [ ] Content script fires `sendCapture(false)` exactly once per candidate via a SYNCHRONOUS `fired` flag, only when `dwellMet && engaged`; re-checks on the 1s poll, scroll, AND selectionchange (deferred capture works); resets dwell + engagement + flags on SPA url change in the same place. Manual path untouched (ignores engagement).
- [ ] Each test step has the Scenario:/Coverage: 2 lines; the two glue/e2e gaps carry an honest N/A justification (real-path flakiness), not "manual check".
- [ ] All test code is ASCII-only - URL strings, no Hangul, no em-dash/smart quotes.
- [ ] Watched the RED: `serp.test.ts` positives fail on the stub; the two gate SERP asserts fail before the gate edit; `engagement-tracker.test.ts` fails on the stub.
- [ ] `rg "chrome" src/core` stays empty; existing `capture-gate` tests still pass (every `decide` call passes the `settings` arg).

---

## Known Constraints (honest)

- **`isSerp` is best-effort and host-pinned.** New engines or regional TLDs (e.g. `google.co.uk/search`) - the `hostIs` suffix match covers subdomains but NOT alternate TLDs; google `/search` on `google.co.uk` would need `host.includes('google.')`-style widening if that matters. Keep it tight to avoid false positives on content pages; widen only with a test.
- **Engagement uses scroll depth as a proxy for "read".** A user who reads a long page without scrolling (large monitor) or scrolls fast without reading is mis-judged. The dwell AND short-page branches soften both ends; this trades a little recall for precision, which is the stated goal.
- **`scrollHeight` is read live at capture time.** Lazy-loaded/infinite pages grow `scrollHeight` as you scroll, so `maxFrac` chases a moving denominator; on a true infinite feed the page may never reach 0.5 and never auto-capture. Acceptable - infinite feeds are exactly the transient/junk pages this feature aims to skip.
- **No new automated coverage for the content-script glue.** Justified by the deleted dwell-visibility e2e precedent; the branch logic lives in the unit-tested pure trackers.
