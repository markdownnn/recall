# Auto-Capture + Gates (Plan 2, increment 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension automatically captures pages the user actually reads (not just on a manual button): a page load or SPA navigation starts a 10s dwell timer; if the user stays, the page is extracted and sent through a capture gate (hard privacy gate + permissive soft gate) before storing. Auto-capture is ON by default.

**Architecture:** Hexagonal, unchanged shape. The GATE is pure core (`CaptureGate` + `Denylist`), unit-tested with zero browser deps. Candidate detection (page load + SPA URL change via polling) and the dwell timer live in the content script (driving adapter). The offscreen `capture` op runs the gate before `CaptureService.capture`. Manual save bypasses the soft gate but still respects the hard gate. Incognito tabs are never captured.

**Tech Stack:** TypeScript · existing offscreen/SW/content-script architecture · Vitest (pure-core gate) · Playwright (auto-capture e2e).

**Decisions (from ADR 0005 + grilling):**
- Hard gate (privacy, aggressive): denylist URL patterns + incognito. Applies even to manual save.
- Soft gate (permissive): thin-page (word count). Skipped for manual save.
- Dwell: 10s, cancel on URL change (bounce filter + SPA render wait).
- Auto-capture default ON.
- Deferred to increment 2 (NOT in this plan): user-editable denylist, global pause, settings UI, SERP/scroll signals.

---

## File Structure

```
src/core/
  denylist.ts          # NEW: default denylist patterns + matcher (pure)
  capture-gate.ts      # NEW: CaptureGate.decide() — hard + soft gate (pure)
src/messaging.ts       # MODIFY: capture msg gains `manual`; captured result gains captured:boolean + reason
src/offscreen/offscreen.ts   # MODIFY: capture op runs CaptureGate before CaptureService.capture
src/background/index.ts      # MODIFY: skip incognito; pass manual flag through
src/content/capture.ts       # MODIFY: SPA/load candidate detection + 10s dwell + auto-send; incognito skip; keep manual button
tests/core/denylist.test.ts          # NEW
tests/core/capture-gate.test.ts       # NEW
tests/e2e/auto-capture.spec.ts        # NEW
```

---

## Task 1: Denylist (pure)

**Files:** Create `src/core/denylist.ts`, `tests/core/denylist.test.ts`

- [ ] **Step 1: Write the failing test**

**Scenario:** The hard gate must never capture finance/auth/webmail/localhost pages — those are exactly the sensitive pages a privacy-first tool must not store.
**Coverage:** ✅ integration (pure function, real matching, no mock)

```ts
// tests/core/denylist.test.ts
import { DEFAULT_DENYLIST, isDenylisted } from '../../src/core/denylist'

test('blocks localhost and loopback', () => {
  expect(isDenylisted('http://localhost:3000/x', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('http://127.0.0.1/x', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks auth and payment paths', () => {
  expect(isDenylisted('https://site.com/login', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://site.com/checkout/pay', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://site.com/account/settings', DEFAULT_DENYLIST)).toBe(true)
})

test('blocks webmail and banking hosts', () => {
  expect(isDenylisted('https://mail.google.com/u/0', DEFAULT_DENYLIST)).toBe(true)
  expect(isDenylisted('https://www.paypal.com/home', DEFAULT_DENYLIST)).toBe(true)
})

test('allows ordinary article pages', () => {
  expect(isDenylisted('https://en.wikipedia.org/wiki/Cortisol', DEFAULT_DENYLIST)).toBe(false)
  expect(isDenylisted('https://someblog.com/posts/sleep-science', DEFAULT_DENYLIST)).toBe(false)
})
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `npx vitest run tests/core/denylist.test.ts`
Expected: FAIL — "isDenylisted is not a function"

- [ ] **Step 3: Implement**

```ts
// src/core/denylist.ts
// A denylist entry is a RegExp tested against the full URL (lowercased).
export const DEFAULT_DENYLIST: RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.local)([:/]|$)/,
  /\/(login|signin|sign-in|logout|checkout|payment|pay|billing|account|settings|password|auth)(\/|$|\?)/,
  /^https?:\/\/mail\./,
  /^https?:\/\/[^/]*(bank|paypal|stripe|venmo|wallet)/,
  /^https?:\/\/(outlook|accounts|login|signin|auth)\./,
]

export function isDenylisted(url: string, list: RegExp[] = DEFAULT_DENYLIST): boolean {
  const u = url.toLowerCase()
  return list.some((re) => re.test(u))
}
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `npx vitest run tests/core/denylist.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/denylist.ts tests/core/denylist.test.ts
git commit -m "feat(core): default denylist for the hard capture gate"
```

---

## Task 2: CaptureGate (pure)

**Files:** Create `src/core/capture-gate.ts`, `tests/core/capture-gate.test.ts`

- [ ] **Step 1: Write the failing test**

**Scenario:** Auto-capture must drop denylisted and thin pages, but a user's explicit manual save must still go through thin pages (intent overrides quality) while NEVER overriding the privacy denylist.
**Coverage:** ✅ integration (pure decide(), real denylist, no mock)

```ts
// tests/core/capture-gate.test.ts
import { CaptureGate } from '../../src/core/capture-gate'

const gate = new CaptureGate({ minWords: 5 })
const long = 'one two three four five six seven eight'
const short = 'too short here'

test('auto: denylisted url rejected', () => {
  expect(gate.decide({ url: 'https://site.com/login', text: long, manual: false }).capture).toBe(false)
})

test('auto: thin page rejected', () => {
  const d = gate.decide({ url: 'https://site.com/post', text: short, manual: false })
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('thin')
})

test('auto: normal page captured', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: long, manual: false }).capture).toBe(true)
})

test('manual: thin page IS captured (soft gate skipped)', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: short, manual: true }).capture).toBe(true)
})

test('manual: denylisted url STILL rejected (hard gate wins)', () => {
  const d = gate.decide({ url: 'https://site.com/login', text: long, manual: true })
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('denylisted')
})
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `npx vitest run tests/core/capture-gate.test.ts`
Expected: FAIL — "CaptureGate is not a constructor"

- [ ] **Step 3: Implement**

```ts
// src/core/capture-gate.ts
import { DEFAULT_DENYLIST, isDenylisted } from './denylist'

export interface GateInput {
  url: string
  text: string
  manual: boolean
}
export interface GateDecision {
  capture: boolean
  reason?: 'denylisted' | 'thin'
}

export class CaptureGate {
  private readonly denylist: RegExp[]
  private readonly minWords: number
  constructor(opts: { denylist?: RegExp[]; minWords?: number } = {}) {
    this.denylist = opts.denylist ?? DEFAULT_DENYLIST
    this.minWords = opts.minWords ?? 100
  }

  decide(input: GateInput): GateDecision {
    // Hard gate (privacy) — applies even to manual save.
    if (isDenylisted(input.url, this.denylist)) {
      return { capture: false, reason: 'denylisted' }
    }
    // Soft gate (quality) — skipped for explicit manual save.
    if (!input.manual) {
      const words = input.text.trim().split(/\s+/).filter(Boolean).length
      if (words < this.minWords) return { capture: false, reason: 'thin' }
    }
    return { capture: true }
  }
}
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `npx vitest run tests/core/capture-gate.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/capture-gate.ts tests/core/capture-gate.test.ts
git commit -m "feat(core): capture gate (hard denylist + soft thin-page, manual override)"
```

---

## Task 3: messaging — carry `manual`, return gate result

**Files:** Modify `src/messaging.ts`

- [ ] **Step 1: Update the capture message + result types**

In `src/messaging.ts`, the `Msg` capture variant gains `manual: boolean`, and the captured `MsgResult` reports whether the gate accepted it and why:

```ts
// In Msg union, change the capture variant to:
| { type: 'capture'; url: string; title: string; text: string; manual: boolean }

// In MsgResult union, change the captured variant to:
| { type: 'captured'; captured: boolean; chunkCount: number; reason?: 'denylisted' | 'thin' }
```

- [ ] **Step 2: Typecheck (callers will error until updated in later tasks)**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `offscreen.ts`, `background/index.ts`, `content/capture.ts`, `App.tsx` (the callers updated in Tasks 4-6). No errors elsewhere.

- [ ] **Step 3: Commit**

```bash
git add src/messaging.ts
git commit -m "feat(messaging): capture carries manual flag and gate result"
```

---

## Task 4: offscreen capture op runs the gate

**Files:** Modify `src/offscreen/offscreen.ts`

- [ ] **Step 1: Construct the gate and run it before capturing**

In `src/offscreen/offscreen.ts`, add `import { CaptureGate } from '../core/capture-gate'`, construct `const gate = new CaptureGate()` alongside the other services, and change the `capture` op handler so it gates first:

```ts
// inside the RPC op dispatch, the 'capture' case:
case 'capture': {
  const { url, title, text, manual } = payload
  const decision = gate.decide({ url, text, manual })
  if (!decision.capture) {
    return { captured: false, chunkCount: 0, reason: decision.reason }
  }
  const { chunkCount } = await capture.capture({ url, title, text })
  runDrainWithProgress()  // fire-and-forget, unchanged
  return { captured: true, chunkCount }
}
```

(Keep the existing recall/ensureLoaded/status/ping ops unchanged.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: the offscreen error is resolved; remaining errors only in background/content/popup (next tasks).

- [ ] **Step 3: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat(offscreen): run capture gate before storing"
```

---

## Task 5: SW relay — pass manual through, skip incognito

**Files:** Modify `src/background/index.ts`

- [ ] **Step 1: Forward manual + drop incognito senders, and shape the response**

In the `capture` message handler in `src/background/index.ts`:
- Drop incognito: if `sender.tab?.incognito` is true, respond `{ type:'captured', captured:false, chunkCount:0 }` and do not relay.
- Forward `manual` to the offscreen `capture` op.
- Return the offscreen's `{ captured, chunkCount, reason }` as the `captured` MsgResult.

```ts
// in onMessage, the capture branch (sketch — adapt to existing relay shape):
if (msg.type === 'capture') {
  if (sender.tab?.incognito) {
    sendResponse({ type: 'captured', captured: false, chunkCount: 0 })
    return true
  }
  ensureOffscreen()
    .then(() => callOffscreen({ op: 'capture', url: msg.url, title: msg.title, text: msg.text, manual: msg.manual }))
    .then((r) => sendResponse({ type: 'captured', captured: r.captured, chunkCount: r.chunkCount, reason: r.reason }))
    .catch((e) => sendResponse({ type: 'error', error: String(e) }))
  return true
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: background error resolved; only content/popup remain.

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat(sw): pass manual flag, skip incognito tabs"
```

---

## Task 6: content script — auto-capture (load + SPA + dwell)

**Files:** Modify `src/content/capture.ts`

- [ ] **Step 1: Implement candidate detection + dwell + manual**

Rewrite `src/content/capture.ts` so it:
- Skips entirely in incognito (`chrome.extension.inIncognitoContext`).
- Detects candidates: the initial page load, plus SPA URL changes by polling `location.href` every 1000ms (covers pushState/replaceState/popstate without main-world injection or the `scripting` permission).
- On each new candidate: clear any pending dwell timer, start a 10s timer. If the URL changes before it fires, it was a bounce — cancelled.
- On dwell fire: extract via Readability and send `{ type:'capture', ..., manual:false }`.
- Keeps the manual path: on `extract-and-capture` message, extract and send `{ ..., manual:true }` immediately and reply with the result.

```ts
import { Readability } from '@mozilla/readability'
import type { Msg, MsgResult } from '../messaging'

const DWELL_MS = 10_000
const POLL_MS = 1_000

function extract(): { title: string; text: string } | null {
  try {
    const docClone = document.cloneNode(true) as Document
    const article = new Readability(docClone).parse()
    const text = (article?.textContent?.trim()) || (document.body?.innerText ?? '')
    if (!text) return null
    return { title: article?.title ?? document.title, text }
  } catch {
    return null
  }
}

function sendCapture(manual: boolean): void {
  const ex = extract()
  if (!ex) return
  const capture: Msg = { type: 'capture', url: location.href, title: ex.title, text: ex.text, manual }
  chrome.runtime.sendMessage(capture, () => void chrome.runtime.lastError)
}

// --- auto-capture: candidate detection + dwell ---
if (!chrome.extension.inIncognitoContext) {
  let dwellTimer: ReturnType<typeof setTimeout> | undefined
  let currentUrl = ''

  function startCandidate(url: string): void {
    currentUrl = url
    if (dwellTimer) clearTimeout(dwellTimer)
    dwellTimer = setTimeout(() => sendCapture(false), DWELL_MS)
  }

  startCandidate(location.href)
  setInterval(() => {
    if (location.href !== currentUrl) startCandidate(location.href) // SPA navigation or bounce -> reset timer
  }, POLL_MS)
}

// --- manual save: explicit button from the popup ---
chrome.runtime.onMessage.addListener((msg: { type: 'extract-and-capture' }, _s, sendResponse) => {
  if (msg.type !== 'extract-and-capture') return
  const ex = extract()
  if (!ex) {
    sendResponse({ type: 'error', error: 'no extractable text' } satisfies MsgResult)
    return true
  }
  const capture: Msg = { type: 'capture', url: location.href, title: ex.title, text: ex.text, manual: true }
  chrome.runtime.sendMessage(capture, (res: MsgResult) => sendResponse(res))
  return true
})
```

- [ ] **Step 2: Update the popup result handling**

In `src/ui/popup/App.tsx`, the manual `capture()` now receives `{ type:'captured', captured, chunkCount, reason }`. Show:
- `captured && chunkCount>0` -> `captured (indexing ${chunkCount} chunks...)`
- `!captured && reason==='denylisted'` -> `not saved: this site is on the no-remember list`
- `!captured && reason==='thin'` -> shouldn't happen for manual (soft gate skipped) but handle: `nothing substantial to capture`
- `captured && chunkCount===0` -> `nothing to capture`

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/content/capture.ts src/ui/popup/App.tsx
git commit -m "feat(content): auto-capture on load + SPA with 10s dwell; manual still works"
```

---

## Task 7: e2e — auto-capture without clicking

**Files:** Create `tests/e2e/auto-capture.spec.ts`

- [ ] **Step 1: Write the e2e**

**Scenario:** A user who just reads an article (never clicks capture) should still be able to recall it — auto-capture is the core product loop. A denylisted page must NOT be captured.
**Coverage:** ✅ integration (built extension, real content-script dwell + gate + offscreen pipeline). Dwell waits the real 10s.

```ts
import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

test('auto-captures an article after dwell, recallable without clicking', async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // open the article and just WAIT (no capture click) past the 10s dwell + indexing
  const page = await ctx.newPage()
  await page.goto('file://' + path.resolve(dir, 'fixtures/article.html'))
  await page.waitForTimeout(14_000) // dwell(10s) + extract + send

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')
  await expect(popup.locator('li').first()).toContainText('Cortisol', { timeout: 60_000 })
  await ctx.close()
})
```

- [ ] **Step 2: Build + run**

Run: `npm run build && npx playwright test tests/e2e/auto-capture.spec.ts`
Expected: PASS — the article was captured WITHOUT any capture click, and is recallable.

- [ ] **Step 3: Run the full suite**

Run: `npm run test && npx playwright test tests/e2e/recall-flow.spec.ts tests/e2e/persistence.spec.ts tests/e2e/auto-capture.spec.ts`
Expected: all green (manual capture still works; auto-capture works).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/auto-capture.spec.ts
git commit -m "test(e2e): auto-capture an article after dwell without clicking"
```

---

## Self-Review

**Spec coverage:**
- Auto-capture on load + SPA: Task 6 (poll location.href) + Task 7 e2e. ✅
- Dwell 10s + bounce cancel: Task 6 (timer reset on URL change). ✅
- Hard gate (denylist) + incognito: Task 1, 2, 5. ✅
- Soft gate (thin-page), manual override: Task 2. ✅
- Manual save still works: Task 6 (extract-and-capture path) + Task 7 full suite. ✅
- Auto ON by default: Task 6 (runs unconditionally unless incognito). ✅

**Deferred (NOT in this plan, by decision):** user-editable denylist, global pause, settings UI, SERP/scroll engagement signals. Increment 2.

**Notes / risks:**
- SPA detection via 1s polling is simple and permission-free; it catches all URL changes. A page that changes content WITHOUT changing the URL won't re-trigger (acceptable — rare and ambiguous).
- The denylist is heuristic and imperfect (a perfect one is impossible); user-editable denylist in increment 2 lets users fix gaps. The hard gate erring toward NOT capturing sensitive pages is the right asymmetry (ADR 0005).
- The e2e waits the real 10s dwell (~14s test). If this is too slow, a follow-up can make DWELL_MS overridable for tests; kept simple here.
- `chrome.extension.inIncognitoContext` is available in content scripts; if undefined in some context, treat as non-incognito (auto-capture proceeds) — the SW also drops incognito senders (Task 5) as a backstop.
