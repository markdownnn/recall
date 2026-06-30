# Flexible Interactive Onboarding (declarative steps + real capture/search demo)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Every code change is TDD where the logic is pure: failing test FIRST, watched fail, then implementation. Browser/offscreen-glue steps (the `capture-text` offscreen op, the SW relay, the Preact renderers) carry a `Coverage: N/A` or `Coverage: integration (e2e)` justification - never "manual check". Steps use checkbox (`- [ ]`) syntax for tracking. Test source is ASCII-only (repo rule).

**Goal:** Replace the static first-run onboarding page with a FLEXIBLE, declarative **step wizard** where every step is data in one array (`STEPS`), so a step can be added / removed / reordered / re-worded by editing that array - and let a brand-new user RIDE THE REAL engine once: seed 2-3 bundled sample pages through the real capture pipeline, then search them with the real on-device model and see real `<article>` result cards.

**Why this shape (the owner's intent):** The onboarding must NOT be hardcoded JSX. It must mirror the spirit of the repo's `Tabs.tsx` scaffold - UI defined as a data list rendered through a `map`, where extension is an N-line additive change, not a refactor. Here the data list is `STEPS: OnboardingStep[]` and the renderer is a `STEP_RENDERERS` map keyed by `kind`. Adding a step = push one object into `STEPS` (+ one renderer entry only if the `kind` is brand-new). The existing static sections (hero, how-it-works, pin guide) become `info` / `pin-guide` steps in that same array, so the whole onboarding is unified under the flexible system - not a demo bolted onto a static page.

**Architecture:** Hexagonal + declarative, same as the rest of the repo.
- The **navigation math** (next / back / skip / clamp / progress) lives in a PURE module `flow.ts` with no DOM and no Preact - unit-tested RED-first.
- The **step content** lives as data in `steps.ts` (the discriminated union + the `STEPS` array). The migrated static copy lives here as data, not JSX.
- The **bundled sample docs** live as data in `samples.ts` with a pure `isValidSample` guard (unit-tested).
- The **driver** `OnboardingFlow.tsx` holds only `currentIndex` and renders `STEPS[currentIndex]` through `STEP_RENDERERS[step.kind]`; all nav and the progress dots derive from `STEPS.length` + `currentIndex` via `flow.ts`.
- The interactive steps talk to the REAL engine through messaging. A small NEW backend slice - a `capture-text` message -> SW relay -> offscreen `capture-text` op - lets the page seed PROVIDED text (no active tab) by reusing the existing `CaptureService.capture()` unchanged. **`src/core` stays pure** (the capture-service, chunker, and store are reused as-is; zero core edits).

**Tech Stack:** TypeScript, Vite+CRXJS, Preact (+ `preact/hooks`), `@sqlite.org/sqlite-wasm` (OPFS) + WebGPU embedder via the offscreen document, Vitest, Playwright. No new runtime deps.

**Current baseline (verify before starting):** `npm run test` green (142 tests). Branch `recall-walking-skeleton`. The static onboarding (`src/ui/onboarding/Onboarding.tsx`) renders five hardcoded `<section>` blocks in one scroll; `main.tsx` mounts `<Onboarding/>`; the install trigger (`src/background/index.ts` `onInstalled`, `details.reason === 'install'`) opens `src/ui/onboarding/index.html` in a new tab. `tests/e2e/onboarding.spec.ts` asserts the static content (brand, a chip, the "How photosynthesis works" mock link, "wikipedia.org", "side panel"). The capture pipeline is: content `capture` message -> SW relay -> offscreen `capture` op -> `gate.decide` -> `CaptureService.capture()` -> `runDrainWithProgress()` (async embed). Search is: `recall` message -> SW -> offscreen `recall` op -> `RecallService`. Demo-data cleanup already exists: `forget-host` message -> offscreen `forget-host` op -> `store.deletePagesByHost(host)` (host is derived from the page url at upsert: `new URL(url).hostname.toLowerCase()`).

---

## Confirmed decisions (the 5 resolutions - bake these in, read first)

**1. Demo writes to the REAL index, tagged with a demo host, removable. (NOT an ephemeral store.)**
The sample docs go through the real `capture-text` -> `CaptureService.capture()` path and land in the real OPFS store, so the search-demo returns genuine on-device results. Every sample url uses the host **`recall-demo.example`** (a clearly-fake, reserved-style host), so the host column on every seeded page is exactly `recall-demo.example` and the existing forget-by-host delete removes them in one call (`forget-host` with `recall-demo.example`).
*Tradeoff:* an ephemeral/second store would avoid polluting the real index but means building and wiring a whole parallel VectorSearchPort + embedder path just for onboarding - heavy, and it would NOT exercise the real engine (the whole point of the ride). Real+removable is lighter and authentic; the only cost is 2-3 tagged rows that the finish step offers to remove in one click.

**2. Wizard (step-by-step next / back / skip), NOT single-scroll.**
The interactive ride wants focus: seed, then search, one thing at a time, with a clear "you are here" progress. A wizard gives that and makes the declarative driver trivial (render one step). The migrated static sections simply become early steps in the same wizard.
*Tradeoff:* single-scroll is marginally less clicking, but it can't gate "seed before you search" cleanly and it muddies the declarative driver (it would render ALL steps, losing the one-renderer simplicity). Wizard wins; users who just want to read can click Next quickly or Skip to the end.

**3. Replace the static page; unify everything under the step system. (NOT static page + separate demo.)**
`OnboardingFlow` replaces `<Onboarding/>` in `main.tsx`. The five static `<section>`s become `info` / `pin-guide` steps; the "search by meaning" chips and "what results look like" mock become the REAL `search-demo` step. `Onboarding.tsx` is deleted.
*Tradeoff:* this changes what `tests/e2e/onboarding.spec.ts` sees (a wizard shows one step at a time, not all content at once), so that test is updated (Task 7) - a known, planned cost. The payoff is one unified, editable system instead of two parallel onboarding surfaces drifting apart.

**4. Bundled sample content: 3 short real-ish ASCII docs (~150-200 words each), one per demo query.**
Topics chosen so each maps cleanly to one example query (a satisfying demo): (a) photosynthesis, (b) sleep & cortisol, (c) HTTP caching. Full text is in Task 2 (no placeholders). ~150-200 words each so the embedding has real signal (the thin-page gate is bypassed for seeded demo docs anyway - see Task 4).

**5. Keep the existing install trigger; the flow is re-runnable; no "completed" persistence in v1.**
`onInstalled` still opens `index.html` on first install. Because the wizard is just a page with `currentIndex` state starting at 0, re-opening the page (or a future "show onboarding again" entry) simply re-runs it. v1 stores no "done" flag - YAGNI; if a sample already exists, re-seeding is idempotent (capture upserts by pageId).

---

## How the declarative step system delivers "easily add / remove / edit steps" (explicit)

This is the heart of the plan, the same promise the `Tabs.tsx` scaffold makes ("adding a tab is a 3-line change"). Concretely, after this plan ships:

- **Add a step (existing kind):** push ONE object into `STEPS` in `steps.ts`. Example - a second info screen:
  ```ts
  { kind: 'info', id: 'privacy', title: 'Your data stays here', body: 'Nothing is uploaded...' },
  ```
  That is the ENTIRE change. The driver renders it, the progress dots become one longer, next/back/skip all re-derive from the new `STEPS.length`. No edit to `OnboardingFlow.tsx`, `flow.ts`, or any renderer.
- **Add a step with a brand-new kind:** push the object AND add ONE entry to the `STEP_RENDERERS` map (a 2-line change total) - exactly the scaffold's "+ a renderer if a brand-new kind" rule. Example - a `video` kind: add `{ kind:'video', id, title, src }` to the union, push one into `STEPS`, add `video: VideoStep` to the map, write the tiny `VideoStep` renderer.
- **Remove a step:** delete its object from `STEPS`. Nothing else.
- **Reorder steps:** move objects within the `STEPS` array. The wizard order, the dots, and the progress fraction all follow the array order automatically.
- **Edit copy / order of demo queries / which samples seed:** edit the string or list literal inside the relevant `STEPS` object (or `SAMPLES`). No component touched.

The driver NEVER hardcodes a step. It renders `STEPS[currentIndex]` through `STEP_RENDERERS[step.kind]`. Task 5's `OnboardingFlow` body is the proof: it references `STEPS` and `STEP_RENDERERS` only - it names no individual step.

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `src/ui/onboarding/flow.ts` | Create | PURE navigation math: `clampIndex`, `nextIndex`, `prevIndex`, `lastIndex` (skip target), `isFirst`, `isLast`, `progress`. No DOM, no Preact. |
| `tests/core/onboarding-flow.test.ts` | Create | RED-first pure tests: cannot advance past the end, cannot go back past 0, skip jumps to the last index, progress fraction = (index+1)/len. ASCII-only. |
| `src/ui/onboarding/samples.ts` | Create | `SampleDoc` type, `DEMO_HOST = 'recall-demo.example'`, `SAMPLES: SampleDoc[]` (3 bundled docs), pure `isValidSample(d)` guard. |
| `tests/core/onboarding-samples.test.ts` | Create | RED-first pure tests: every SAMPLE passes `isValidSample`, each url host equals `DEMO_HOST`, each text has >= 80 words, ids/urls unique. ASCII-only. |
| `src/ui/onboarding/steps.ts` | Create | The discriminated union `OnboardingStep` + `export const STEPS: OnboardingStep[]` (migrated static copy as `info`/`pin-guide` data + the `capture-demo`, `search-demo`, `finish` steps). |
| `tests/core/onboarding-steps.test.ts` | Create | RED-first pure tests: `STEPS` non-empty, ids unique, every `kind` has a `STEP_KINDS` entry, the last step is `finish`, the `capture-demo` step's samples === `SAMPLES`. ASCII-only. |
| `src/messaging.ts` | Modify | Add `Msg` `{ type: 'capture-text'; url: string; title: string; text: string }`. Result reuses the existing `{ type: 'captured'; captured; chunkCount; reason? }`. |
| `src/offscreen/offscreen.ts` | Modify | Add `op === 'capture-text'` branch: `capture.capture({url,title,text})` (NO gate - seeded demo always stores) then `runDrainWithProgress()`; return `{ captured: true, chunkCount }`. |
| `src/background/index.ts` | Modify | Add `'capture-text'` to the handled-types guard chain; add a dispatch branch relaying to offscreen `capture-text` -> `{ type:'captured', ... }`. |
| `tests/core/capture-service.test.ts` | Modify | Add a contract test: `capture()` of provided sample text (a `recall-demo.example` url) stores chunks as pending - mirrors the existing capture tests, pins the provided-text path on the real service. |
| `src/ui/sidepanel/strings.ts` | Modify | Add onboarding CHROME strings (nav + status labels): `obNext`, `obBack`, `obSkip`, `obSeedButton`, `obSeeding`, `obSeeded`, `obSearchPlaceholder`, `obOpenRecall`, `obRemoveDemo`, `obDemoRemoved`, `obStepProgress(i,n)`. (Step CONTENT stays in `steps.ts` data.) |
| `tests/core/strings.test.ts` | Modify | Add the new static keys to `STATIC_KEYS`, `obStepProgress` to `FUNCTION_KEYS`; pin `obStepProgress(1,5) === 'Step 1 of 5'` as a byte-identical e2e string. |
| `src/ui/onboarding/OnboardingFlow.tsx` | Create | The driver. Holds `currentIndex`; renders `STEPS[currentIndex]` via `STEP_RENDERERS[step.kind]`; renders progress dots + Back/Next/Skip from `flow.ts`. References `STEPS` + `STEP_RENDERERS` only. |
| `src/ui/onboarding/steps/InfoStep.tsx` | Create | Renders an `info` step: title + body (reuses `.section` card look). |
| `src/ui/onboarding/steps/PinGuideStep.tsx` | Create | Renders a `pin-guide` step: title + body + the existing `<PinIllustration/>`. |
| `src/ui/onboarding/steps/CaptureDemoStep.tsx` | Create | Renders a `capture-demo` step: a "Seed sample pages" button that sends one `capture-text` per sample, then waits for the indexing-done broadcast; shows seeding/seeded status; lists the sample titles. |
| `src/ui/onboarding/steps/SearchDemoStep.tsx` | Create | Renders a `search-demo` step: an inline searchbox (the `recall` round-trip, k:5) + example-query chips that fill the box + `<article class="card">` result cards (markup identical to `SearchTab`). |
| `src/ui/onboarding/steps/FinishStep.tsx` | Create | Renders a `finish` step: title + body + "Open Recall" button (reuses the existing `openRecall()` logic) + a one-click "Remove demo data" button (`forget-host` with `DEMO_HOST`). |
| `src/ui/onboarding/main.tsx` | Modify | Mount `<OnboardingFlow/>` instead of `<Onboarding/>`. |
| `src/ui/onboarding/Onboarding.tsx` | Delete | Static page superseded by the step wizard; its copy now lives as data in `steps.ts`. |
| `src/ui/onboarding/onboarding.css` | Modify | Add wizard chrome: `.wizard`, `.dots`/`.dot`/`.dot.active`, `.nav`, `.nav button`, `.demo-status`. Reuse the existing `.card`, `.section`, `.chips`/`.chip`, `.result-mock`/`.results`/`.meta`, `.primary` rules. |
| `tests/e2e/onboarding.spec.ts` | Modify | Update for the wizard: assert the FIRST step renders (brand + tagline) and a progress/Next control exists. Move the deep content asserts into the new interactive e2e. |
| `tests/e2e/onboarding-interactive.spec.ts` | Create | The full ride: open onboarding, advance to the capture-demo step, seed samples, wait for indexed, advance to search-demo, query, assert a real `<article>` result appears; then remove demo data and assert it clears. Reuses the sidepanel e2e launch pattern. |

**NOT touched:** `src/core/capture-service.ts`, `src/core/paragraph-chunker.ts`, `src/core/recall-service.ts`, the embedder, the sqlite worker, `offscreen-rpc.ts`, `src/ui/sidepanel/*` components. The `pages`/`chunks` schema is unchanged (the host column already exists and is already written at upsert).

---

## Task 1: Pure navigation math (`flow.ts`, TDD)

The wizard's next/back/skip/clamp/progress is pure arithmetic. TDD it with zero DOM so the driver later just wires state to these functions.

**Files:** Create `tests/core/onboarding-flow.test.ts` (test FIRST), `src/ui/onboarding/flow.ts`.

- [ ] **Step 1 (RED): write the failing tests (`tests/core/onboarding-flow.test.ts`)**

```ts
import {
  clampIndex, nextIndex, prevIndex, lastIndex, isFirst, isLast, progress,
} from '../../src/ui/onboarding/flow'

// Scenario: a user on the LAST step clicks Next; the wizard must not advance into a
// non-existent step and crash - it clamps at the end.
// Coverage: integration (real flow.ts).
test('nextIndex clamps at the last index', () => {
  expect(nextIndex(0, 5)).toBe(1)
  expect(nextIndex(4, 5)).toBe(4)
  expect(nextIndex(99, 5)).toBe(4)
})

// Scenario: a user on the FIRST step clicks Back; the wizard must not go to index -1.
// Coverage: integration (real flow.ts).
test('prevIndex clamps at zero', () => {
  expect(prevIndex(2, 5)).toBe(1)
  expect(prevIndex(0, 5)).toBe(0)
  expect(prevIndex(-3, 5)).toBe(0)
})

// Scenario: a user clicks Skip; the wizard must jump straight to the final (finish) step.
// Coverage: integration (real flow.ts).
test('lastIndex is the final step index', () => {
  expect(lastIndex(5)).toBe(4)
  expect(lastIndex(1)).toBe(0)
})

// Scenario: the progress dots must light "you are here" and the bar fill must be index+1 of len.
// Coverage: integration (real flow.ts).
test('progress reports current index and a 1-based fraction', () => {
  expect(progress(0, 5)).toEqual({ current: 0, total: 5, fraction: 1 / 5 })
  expect(progress(4, 5)).toEqual({ current: 4, total: 5, fraction: 1 })
})

// Scenario: Back must hide on the first step and Next must turn into Finish on the last;
// the boolean edges drive that and must be exact.
// Coverage: integration (real flow.ts).
test('isFirst and isLast mark the edges', () => {
  expect(isFirst(0)).toBe(true)
  expect(isFirst(1)).toBe(false)
  expect(isLast(4, 5)).toBe(true)
  expect(isLast(3, 5)).toBe(false)
})

// Scenario: a malformed/empty STEPS array must not divide-by-zero or return a negative index.
// Coverage: integration (real flow.ts).
test('clampIndex is safe for an empty list', () => {
  expect(clampIndex(3, 0)).toBe(0)
  expect(clampIndex(-1, 0)).toBe(0)
})
```

  Run: `npx vitest run tests/core/onboarding-flow.test.ts`
  Expected: FAIL ("Cannot find module .../flow" / functions undefined).

- [ ] **Step 2 (GREEN): implement `src/ui/onboarding/flow.ts`**

```ts
// Pure wizard navigation math: no DOM, no Preact, so it is unit-tested in isolation.
// The driver (OnboardingFlow) wires currentIndex state to these functions; all of
// next/back/skip and the progress dots derive from here + STEPS.length.

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0
  return Math.max(0, Math.min(i, len - 1))
}

export function nextIndex(i: number, len: number): number { return clampIndex(i + 1, len) }
export function prevIndex(i: number, len: number): number { return clampIndex(i - 1, len) }

// Skip target = the final (finish) step.
export function lastIndex(len: number): number { return clampIndex(len - 1, len) }

export function isFirst(i: number): boolean { return i <= 0 }
export function isLast(i: number, len: number): boolean { return i >= len - 1 }

export interface Progress { current: number; total: number; fraction: number }

export function progress(i: number, len: number): Progress {
  const total = Math.max(len, 1)
  const current = clampIndex(i, len)
  // 1-based fill so the first step already shows some progress (1/total), the last shows full.
  return { current, total, fraction: (current + 1) / total }
}
```

- [ ] **Step 3: run the tests, verify PASS**

  Run: `npx vitest run tests/core/onboarding-flow.test.ts`
  Expected: PASS (6 tests).

- [ ] **Step 4: commit**

```bash
git add src/ui/onboarding/flow.ts tests/core/onboarding-flow.test.ts
git commit -m "feat(onboarding): pure wizard navigation math (flow.ts)"
```

---

## Task 2: Bundled sample docs + validation (`samples.ts`, TDD)

The demo seeds 3 short real-ish ASCII docs. They are data with a pure `isValidSample` guard so a bad edit (empty text, wrong host) is caught by a unit test, not in the browser.

**Files:** Create `tests/core/onboarding-samples.test.ts` (test FIRST), `src/ui/onboarding/samples.ts`.

- [ ] **Step 1 (RED): write the failing tests (`tests/core/onboarding-samples.test.ts`)**

```ts
import { SAMPLES, DEMO_HOST, isValidSample } from '../../src/ui/onboarding/samples'

// Scenario: the demo seeds bundled docs; if one were empty or mis-hosted, the seed would
// store garbage or the demo-data cleanup (forget-host on DEMO_HOST) would miss it.
// Coverage: integration (real samples.ts).
test('every bundled sample is valid and hosted on the demo host', () => {
  expect(SAMPLES.length).toBeGreaterThanOrEqual(2)
  for (const s of SAMPLES) {
    expect(isValidSample(s)).toBe(true)
    expect(new URL(s.url).hostname).toBe(DEMO_HOST)
  }
})

// Scenario: embedding needs real signal; a one-line sample would make the search-demo
// return nothing. Pin a minimum word count per sample.
// Coverage: integration (real samples.ts).
test('every sample has enough words for a meaningful embedding', () => {
  for (const s of SAMPLES) {
    expect(s.text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(80)
  }
})

// Scenario: two samples sharing a url would dedup to one page (capture upserts by pageId),
// silently dropping a demo doc. Ids and urls must be unique.
// Coverage: integration (real samples.ts).
test('sample urls are unique', () => {
  const urls = SAMPLES.map((s) => s.url)
  expect(new Set(urls).size).toBe(urls.length)
})

// Scenario: isValidSample must REJECT a blank or mis-hosted doc, or the guard is useless.
// Coverage: integration (real samples.ts).
test('isValidSample rejects blank and off-host docs', () => {
  expect(isValidSample({ url: 'https://recall-demo.example/x', title: '', text: 'hi there' })).toBe(false)
  expect(isValidSample({ url: 'https://evil.example/x', title: 'T', text: 'some words here' })).toBe(false)
  expect(isValidSample({ url: 'not a url', title: 'T', text: 'some words here' })).toBe(false)
})
```

  Run: `npx vitest run tests/core/onboarding-samples.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 2 (GREEN): implement `src/ui/onboarding/samples.ts`**

  Full file (ASCII only; ~150-200 words per doc):

```ts
// Bundled demo docs seeded through the REAL capture pipeline during onboarding, so a new
// user can search real on-device results immediately. Every url is on DEMO_HOST so the
// finish step's "Remove demo data" (forget-host on DEMO_HOST) cleans them in one call.

export interface SampleDoc {
  url: string
  title: string
  text: string
}

// A clearly-fake, reserved-style host. The pages table stores host = new URL(url).hostname,
// so every seeded page gets host === DEMO_HOST and forget-by-host removes exactly these.
export const DEMO_HOST = 'recall-demo.example'

export const SAMPLES: SampleDoc[] = [
  {
    url: 'https://recall-demo.example/photosynthesis',
    title: 'How photosynthesis works',
    text:
      'Photosynthesis is how a green plant makes its own food from sunlight. Inside the ' +
      'leaves there is a green pigment called chlorophyll, and chlorophyll is very good at ' +
      'catching light energy. The plant pulls water up through its roots and takes in carbon ' +
      'dioxide gas from the air through tiny holes in its leaves. Using the energy it caught ' +
      'from the sun, the plant joins the water and the carbon dioxide together to build a ' +
      'simple sugar called glucose, which is the food it lives on and uses to grow. As a ' +
      'side effect of making that sugar, the plant releases oxygen back into the air, and ' +
      'that is the same oxygen that people and animals need to breathe. The first part of ' +
      'the process, the light reactions, happens in tiny structures called thylakoids, where ' +
      'the captured light energy is stored. The second part, the sugar building steps, can ' +
      'then run using that stored energy. So a quiet leaf is really a small solar powered ' +
      'food factory working all day long.',
  },
  {
    url: 'https://recall-demo.example/sleep-and-cortisol',
    title: 'Sleep, cortisol, and the body clock',
    text:
      'Cortisol is a stress hormone made by the adrenal glands, two small organs that sit ' +
      'on top of the kidneys. It follows a daily rhythm: it is high in the morning to help ' +
      'you wake up and feel alert, and it slowly falls through the day so that by night it is ' +
      'low. When cortisol is low at night, another signal called melatonin can rise, and ' +
      'melatonin is the chemical that tells the body it is time to sleep. The trouble starts ' +
      'when stress or bright screen light late in the evening keeps cortisol high when it ' +
      'should be dropping. High evening cortisol blocks melatonin from rising, and that is ' +
      'the hormone problem that ruins sleep. People then have trouble falling asleep and they ' +
      'wake up through the night. Keeping the evening calm and dim, and getting bright light ' +
      'in the morning, helps the body clock keep cortisol and melatonin on their normal ' +
      'schedule, so sleep comes more easily and stays deeper.',
  },
  {
    url: 'https://recall-demo.example/http-caching',
    title: 'How HTTP caching speeds up the web',
    text:
      'When your browser loads a web page it has to fetch many files: the page itself, the ' +
      'styles, the scripts, and the images. Downloading all of those again every single ' +
      'visit would be slow and would waste data. HTTP caching solves this by letting the ' +
      'browser keep a local copy of a file and reuse it instead of asking the server again. ' +
      'The server controls this with response headers. A Cache-Control header can say how ' +
      'long a copy stays fresh, for example one hour, and during that time the browser uses ' +
      'its stored copy with no network request at all. After the copy goes stale the browser ' +
      'can make a quick conditional request using an ETag or a Last-Modified value; if ' +
      'nothing changed the server answers with a tiny 304 Not Modified and the old copy is ' +
      'reused, saving the full download. Good caching makes a site feel fast, lowers the load ' +
      'on the server, and lets pages work even on a weak connection, which is why almost ' +
      'every fast website tunes its cache headers carefully.',
  },
]

// Pure guard: a sample is valid only if it has a non-empty title, real text, and its url
// is parseable AND hosted on DEMO_HOST (so cleanup by host can never miss it).
export function isValidSample(d: SampleDoc): boolean {
  if (!d.title.trim() || !d.text.trim()) return false
  try {
    return new URL(d.url).hostname === DEMO_HOST
  } catch {
    return false
  }
}
```

- [ ] **Step 3: run the tests, verify PASS**

  Run: `npx vitest run tests/core/onboarding-samples.test.ts`
  Expected: PASS (4 tests).

- [ ] **Step 4: commit**

```bash
git add src/ui/onboarding/samples.ts tests/core/onboarding-samples.test.ts
git commit -m "feat(onboarding): bundled demo samples + isValidSample guard"
```

---

## Task 3: The declarative step model (`steps.ts`, TDD)

The discriminated union + the `STEPS` array. The migrated static copy (hero, how-it-works, pin guide) lives here as `info`/`pin-guide` data; the interactive `capture-demo`, `search-demo`, and `finish` steps complete the ride. A small pure test pins the array's invariants.

**Files:** Create `tests/core/onboarding-steps.test.ts` (test FIRST), `src/ui/onboarding/steps.ts`.

- [ ] **Step 1 (RED): write the failing tests (`tests/core/onboarding-steps.test.ts`)**

```ts
import { STEPS, STEP_KINDS } from '../../src/ui/onboarding/steps'
import { SAMPLES } from '../../src/ui/onboarding/samples'

// Scenario: the wizard renders STEPS[currentIndex] through a renderer keyed by kind; a step
// whose kind has no renderer entry would crash at render. Pin every kind as known.
// Coverage: integration (real steps.ts).
test('every step kind is a known, renderable kind', () => {
  expect(STEPS.length).toBeGreaterThan(0)
  for (const s of STEPS) expect(STEP_KINDS).toContain(s.kind)
})

// Scenario: duplicate ids would make the React-style key collide and the progress dots
// ambiguous. Ids must be unique.
// Coverage: integration (real steps.ts).
test('step ids are unique', () => {
  const ids = STEPS.map((s) => s.id)
  expect(new Set(ids).size).toBe(ids.length)
})

// Scenario: the wizard ends on the finish step (Open Recall + Remove demo data); if the
// last step were something else the user could never finish cleanly.
// Coverage: integration (real steps.ts).
test('the last step is the finish step', () => {
  expect(STEPS[STEPS.length - 1].kind).toBe('finish')
})

// Scenario: the capture-demo step must seed the SAME bundled SAMPLES the validation guards;
// a divergent inline list would seed unvalidated docs.
// Coverage: integration (real steps.ts).
test('the capture-demo step seeds the bundled SAMPLES', () => {
  const demo = STEPS.find((s) => s.kind === 'capture-demo')
  expect(demo).toBeDefined()
  if (demo && demo.kind === 'capture-demo') expect(demo.samples).toBe(SAMPLES)
})
```

  Run: `npx vitest run tests/core/onboarding-steps.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 2 (GREEN): implement `src/ui/onboarding/steps.ts`**

```ts
// The declarative step model. The whole onboarding is THIS array. Adding a step = push one
// object here (+ a renderer in STEP_RENDERERS only if the kind is brand-new). Removing =
// delete the object. Reordering = move objects. Editing copy = edit the strings here.
// The driver (OnboardingFlow) renders STEPS[currentIndex] through STEP_RENDERERS[kind] and
// names no individual step - this array is the single source of truth.

import { SAMPLES } from './samples'
import type { SampleDoc } from './samples'

export type OnboardingStep =
  | { kind: 'info'; id: string; title: string; body: string }
  | { kind: 'capture-demo'; id: string; title: string; body: string; samples: SampleDoc[] }
  | { kind: 'search-demo'; id: string; title: string; body: string; exampleQueries: string[] }
  | { kind: 'pin-guide'; id: string; title: string; body: string }
  | { kind: 'finish'; id: string; title: string; body: string }

// The set of kinds that have a renderer. The steps test pins every STEPS entry against this
// so a new kind without a renderer is caught before it can crash at render.
export const STEP_KINDS = ['info', 'capture-demo', 'search-demo', 'pin-guide', 'finish'] as const

export const STEPS: OnboardingStep[] = [
  // --- migrated static "hero" ---
  {
    kind: 'info',
    id: 'hero',
    title: 'Remember everything you read - find it later in plain language.',
    body: 'The model and search run entirely on your device. Nothing leaves it.',
  },
  // --- migrated static "how it works" ---
  {
    kind: 'info',
    id: 'how-it-works',
    title: 'How it works',
    body:
      'Pages you actually read are saved automatically - on-device machine learning decides ' +
      'what is worth keeping. You can also save any page yourself. Sensitive sites (banking, ' +
      'email, and so on) are skipped automatically, and you can pause anytime.',
  },
  // --- interactive: seed real sample pages ---
  {
    kind: 'capture-demo',
    id: 'capture-demo',
    title: 'Try it: save a few sample pages',
    body:
      'Add three short example pages to your private on-device index, so you can search them ' +
      'in the next step. You can remove them again at the end.',
    samples: SAMPLES,
  },
  // --- interactive: search the seeded pages with the real engine ---
  {
    kind: 'search-demo',
    id: 'search-demo',
    title: 'Now search by meaning',
    body: 'You do not need the exact words. Try one of these, or type your own.',
    exampleQueries: [
      'how plants turn sunlight into food',
      'the hormone that ruins sleep',
      'why a browser keeps a copy of a page',
    ],
  },
  // --- migrated static "how to open Recall" (with the pin illustration) ---
  {
    kind: 'pin-guide',
    id: 'pin-guide',
    title: 'How to open Recall',
    body:
      'Click the Recall icon in your toolbar to open the side panel. Tip: pin it for ' +
      'one-click access - click the puzzle-piece icon, then the pin next to Recall.',
  },
  // --- finish: open Recall + offer to remove the demo data ---
  {
    kind: 'finish',
    id: 'finish',
    title: 'You are all set',
    body:
      'That is the whole idea: read, and find it later in plain language. You can remove the ' +
      'sample pages now, or keep exploring them first.',
  },
]
```

- [ ] **Step 3: run the tests, verify PASS**

  Run: `npx vitest run tests/core/onboarding-steps.test.ts`
  Expected: PASS (4 tests).

- [ ] **Step 4: commit**

```bash
git add src/ui/onboarding/steps.ts tests/core/onboarding-steps.test.ts
git commit -m "feat(onboarding): declarative STEPS model (static copy migrated to data)"
```

---

## Task 4: The `capture-text` backend slice (messaging + offscreen op + SW relay)

A new message lets the onboarding page seed PROVIDED text with no active tab, reusing `CaptureService.capture()` unchanged. **`src/core` is not touched** - the slice is messaging glue plus one offscreen op. The pure contract (provided text -> stored chunks) is pinned on the real capture-service.

**Files:** Modify `tests/core/capture-service.test.ts` (test FIRST), `src/messaging.ts`, `src/offscreen/offscreen.ts`, `src/background/index.ts`.

- [ ] **Step 1 (RED): add the contract test (`tests/core/capture-service.test.ts`)**

  Append this test (it imports are already present in the file):

```ts
// Scenario: onboarding seeds a bundled demo doc by PROVIDED text (no tab). The same capture
// service must store its chunks as pending, hosted on the demo url, exactly like a real page.
// Coverage: integration (real chunker + real MemoryVectorStore via the exported CaptureService).
test('capture of provided demo text stores chunks as pending', async () => {
  const store = new MemoryVectorStore()
  const svc = new CaptureService(new ParagraphChunker(220), store)

  const result = await svc.capture({
    url: 'https://recall-demo.example/photosynthesis',
    title: 'How photosynthesis works',
    text: 'A green plant makes food from sunlight using chlorophyll in its leaves.',
  })

  expect(result.chunkCount).toBeGreaterThan(0)
  const pending = await store.pendingChunks(100)
  expect(pending.length).toBe(result.chunkCount)
})
```

  Run: `npx vitest run tests/core/capture-service.test.ts`
  Expected: PASS immediately - the capture service ALREADY supports provided text (this test documents/pins the path the slice reuses; no core change is needed). If it fails, stop: a core regression is present.

  > Note: this step is GREEN-on-write by design. It exists to lock the contract the new message relies on, mirroring the existing capture tests. The remaining steps in this task are messaging glue with no pure logic to TDD.

- [ ] **Step 2: extend `src/messaging.ts`**

  Add to the `Msg` union (after the `capture` line):

```ts
  | { type: 'capture-text'; url: string; title: string; text: string }
```

  The result reuses the existing `{ type: 'captured'; captured: boolean; chunkCount: number; reason?: ... }` - no new `MsgResult` member.

- [ ] **Step 3: add the offscreen op (`src/offscreen/offscreen.ts`)**

  In the RPC handler, directly after the `if (op === 'capture') { ... }` block, add:

```ts
  // --- capture-text: seed PROVIDED text (onboarding demo, no active tab). Unlike `capture`
  //     this skips the gate on purpose: a seeded demo doc is always stored (the user asked
  //     for it). Reuses the SAME CaptureService.capture() + drain as a real capture. ---
  if (op === 'capture-text') {
    const url = p.url as string
    const title = p.title as string
    const text = p.text as string
    const { chunkCount } = await capture.capture({ url, title, text })
    console.log(`[recall] capture-text seeded ${chunkCount} chunks`)
    runDrainWithProgress()
    return { captured: true, chunkCount }
  }
```

  *Coverage: N/A (offscreen RPC glue - it dispatches to the already-tested `CaptureService.capture()` and the already-tested `runDrainWithProgress`; there is no real-path unit harness for the offscreen document. The end-to-end behavior is covered by `tests/e2e/onboarding-interactive.spec.ts` in Task 7.)*

- [ ] **Step 4: relay it in the SW (`src/background/index.ts`)**

  4a. Add `'capture-text'` to the handled-types guard chain (the `if (msg.type !== 'capture' && ...)` block):

```ts
    msg.type !== 'capture-text' &&
```

  4b. In the `(async () => { ... })()` dispatch body, after the `if (msg.type === 'capture') { ... }` branch, add:

```ts
      } else if (msg.type === 'capture-text') {
        const r = await callOffscreen<{ captured: boolean; chunkCount: number }>({
          op: 'capture-text',
          url: msg.url,
          title: msg.title,
          text: msg.text,
        })
        sendResponse({ type: 'captured', captured: r.captured, chunkCount: r.chunkCount } satisfies MsgResult)
```

  *Coverage: N/A (SW relay glue - a thin forward to the offscreen op; covered end-to-end by the Task 7 e2e).*

- [ ] **Step 5: typecheck + unit run**

  Run: `npx tsc --noEmit && npx vitest run tests/core/capture-service.test.ts`
  Expected: typecheck clean; capture-service tests PASS.

- [ ] **Step 6: commit**

```bash
git add src/messaging.ts src/offscreen/offscreen.ts src/background/index.ts tests/core/capture-service.test.ts
git commit -m "feat(onboarding): capture-text backend slice (seed provided text, reuse capture-service)"
```

---

## Task 5: Onboarding chrome strings (`strings.ts`, TDD)

The nav + status LABELS (Next, Back, Skip, seed/seeded, search placeholder, Open Recall, Remove demo data, step progress) are reusable UI chrome, so they go through the existing `strings.ts` i18n pattern. Step CONTENT stays in `steps.ts` data.

**Files:** Modify `tests/core/strings.test.ts` (test FIRST), `src/ui/sidepanel/strings.ts`.

- [ ] **Step 1 (RED): extend `tests/core/strings.test.ts`**

  1a. Add the new static keys to `STATIC_KEYS`:

```ts
  'obNext', 'obBack', 'obSkip', 'obSeedButton', 'obSeeding', 'obSeeded',
  'obSearchPlaceholder', 'obOpenRecall', 'obRemoveDemo', 'obDemoRemoved',
```

  1b. Add the dynamic key to `FUNCTION_KEYS`:

```ts
  'obStepProgress',
```

  1c. Add a byte-identical assertion in the "byte-identical e2e strings are preserved" test:

```ts
  expect(EN.obStepProgress(1, 5)).toBe('Step 1 of 5')
  expect(EN.obSeeded).toBe('Sample pages added')
```

  Run: `npx vitest run tests/core/strings.test.ts`
  Expected: FAIL (keys missing on EN).

- [ ] **Step 2 (GREEN): extend `src/ui/sidepanel/strings.ts`**

  2a. Add to the `UIStrings` interface (a new "Onboarding" block):

```ts
  // Onboarding wizard chrome (step CONTENT lives in steps.ts; these are the nav + status labels)
  obNext: string
  obBack: string
  obSkip: string
  obSeedButton: string
  obSeeding: string
  obSeeded: string
  obSearchPlaceholder: string
  obOpenRecall: string
  obRemoveDemo: string
  obDemoRemoved: string
  obStepProgress: (i: number, n: number) => string
```

  2b. Add to the `EN` object:

```ts
  obNext: 'Next',
  obBack: 'Back',
  obSkip: 'Skip',
  obSeedButton: 'Seed sample pages',
  obSeeding: 'adding sample pages...',
  obSeeded: 'Sample pages added',
  obSearchPlaceholder: 'Search what you just added...',
  obOpenRecall: 'Open Recall',
  obRemoveDemo: 'Remove demo data',
  obDemoRemoved: 'Demo data removed',
  obStepProgress: (i, n) => `Step ${i} of ${n}`,
```

- [ ] **Step 3: run the tests, verify PASS**

  Run: `npx vitest run tests/core/strings.test.ts`
  Expected: PASS.

- [ ] **Step 4: commit**

```bash
git add src/ui/sidepanel/strings.ts tests/core/strings.test.ts
git commit -m "feat(onboarding): add wizard chrome strings (i18n-ready)"
```

---

## Task 6: Renderers + the driver + mount + CSS

The five tiny renderer components, the `OnboardingFlow` driver (which names no individual step), the `main.tsx` mount swap, and the wizard CSS. This is Preact/DOM glue - no pure logic to TDD here (the pure parts were Tasks 1-3); correctness is proven end-to-end by Task 7's e2e.

**Files:** Create `src/ui/onboarding/steps/{InfoStep,PinGuideStep,CaptureDemoStep,SearchDemoStep,FinishStep}.tsx`, `src/ui/onboarding/OnboardingFlow.tsx`; modify `src/ui/onboarding/main.tsx`, `src/ui/onboarding/onboarding.css`; delete `src/ui/onboarding/Onboarding.tsx`.

- [ ] **Step 1: `src/ui/onboarding/steps/InfoStep.tsx`**

```tsx
import type { OnboardingStep } from '../steps'

export function InfoStep({ step }: { step: Extract<OnboardingStep, { kind: 'info' }> }) {
  return (
    <section class="card section">
      <h2>{step.title}</h2>
      <p>{step.body}</p>
    </section>
  )
}
```

- [ ] **Step 2: `src/ui/onboarding/steps/PinGuideStep.tsx`**

```tsx
import type { OnboardingStep } from '../steps'
import { PinIllustration } from '../PinIllustration'

export function PinGuideStep({ step }: { step: Extract<OnboardingStep, { kind: 'pin-guide' }> }) {
  return (
    <section class="card section">
      <h2>{step.title}</h2>
      <p>{step.body}</p>
      <PinIllustration />
    </section>
  )
}
```

- [ ] **Step 3: `src/ui/onboarding/steps/CaptureDemoStep.tsx`**

  Seeds each sample via `capture-text`, then waits for the indexing-done broadcast (`indexing-progress` with `pending === 0`, the same signal the side panel uses) before declaring "seeded". Lists sample titles so the user sees what was added.

```tsx
import { useState, useEffect, useRef } from 'preact/hooks'
import type { OnboardingStep } from '../steps'
import type { MsgResult } from '../../../messaging'
import { t } from '../../sidepanel/strings'

type Phase = 'idle' | 'seeding' | 'seeded'

export function CaptureDemoStep({ step }: { step: Extract<OnboardingStep, { kind: 'capture-demo' }> }) {
  const [phase, setPhase] = useState<Phase>('idle')
  // True once all capture-text sends have resolved; we then wait for the drain-done event.
  const sentRef = useRef(false)

  useEffect(() => {
    // The SW broadcasts {type:'indexing-progress', pending, embedded}; pending===0 means the
    // drain finished. Only flip to 'seeded' AFTER we have sent (sentRef), so an unrelated
    // idle broadcast cannot mark us seeded early.
    const listener = (msg: { type?: string; pending?: number }) => {
      if (msg?.type === 'indexing-progress' && msg.pending === 0 && sentRef.current) {
        setPhase('seeded')
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const seed = async () => {
    if (phase === 'seeding') return
    setPhase('seeding')
    for (const s of step.samples) {
      const res: MsgResult = await chrome.runtime.sendMessage({
        type: 'capture-text', url: s.url, title: s.title, text: s.text,
      })
      if (res?.type === 'error') { setPhase('idle'); return }
    }
    sentRef.current = true
    // If embedding is already warm the drain can finish before the listener attaches; the
    // listener also catches the later pending===0. As a floor, mark seeded after sends if no
    // event arrives within a short grace is NOT needed - the e2e waits on the event/text.
  }

  return (
    <section class="card section">
      <h2>{step.title}</h2>
      <p>{step.body}</p>
      <ul class="sample-list">
        {step.samples.map((s) => <li key={s.url}>{s.title}</li>)}
      </ul>
      {phase !== 'seeded' && (
        <button class="primary" disabled={phase === 'seeding'} onClick={() => void seed()}>
          {phase === 'seeding' ? t.obSeeding : t.obSeedButton}
        </button>
      )}
      {phase === 'seeded' && <p class="demo-status">{t.obSeeded}</p>}
    </section>
  )
}
```

- [ ] **Step 4: `src/ui/onboarding/steps/SearchDemoStep.tsx`**

  Inline searchbox (the `recall` round-trip, k:5) + example-query chips that fill the box + `<article class="card">` result cards. The card markup is byte-identical to `SearchTab` so the e2e `locator('article')` asserts resolve.

```tsx
import { useState } from 'preact/hooks'
import type { OnboardingStep } from '../steps'
import type { MsgResult } from '../../../messaging'
import type { RankedResult } from '../../../core/model'
import { t } from '../../sidepanel/strings'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export function SearchDemoStep({ step }: { step: Extract<OnboardingStep, { kind: 'search-demo' }> }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const runSearch = async (text: string) => {
    if (!text.trim() || searching) return
    setSearching(true)
    setHasSearched(true)
    try {
      const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text, k: 5 })
      if (res.type === 'recalled') setResults(res.results)
    } finally {
      setSearching(false)
    }
  }

  return (
    <section class="card section">
      <h2>{step.title}</h2>
      <p>{step.body}</p>

      <div class="chips">
        {step.exampleQueries.map((eq) => (
          <button class="chip" key={eq} onClick={() => { setQ(eq); void runSearch(eq) }}>{eq}</button>
        ))}
      </div>

      <div class="searchbar">
        <input
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch(q)}
          placeholder={t.obSearchPlaceholder}
        />
        <button class="searchbtn" aria-label={t.searchButtonAria} onClick={() => runSearch(q)}>
          {t.searchButtonLabel}
        </button>
      </div>

      {searching && <div class="hint">{t.searching}</div>}
      {!searching && hasSearched && results.length === 0 && <div class="hint">{t.noResults}</div>}

      {results.length > 0 && (
        <div class="results">
          {results.map((r) => (
            <article class="card" key={r.chunk.id}>
              <a href={r.page.url} target="_blank" rel="noopener noreferrer">{r.page.title}</a>
              <p>{r.chunk.text}</p>
              <div class="meta">{hostOf(r.page.url)}</div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 5: `src/ui/onboarding/steps/FinishStep.tsx`**

  Open Recall (reuses the existing `openRecall()` logic, copied here since `Onboarding.tsx` is deleted) + one-click Remove demo data (`forget-host` on `DEMO_HOST`).

```tsx
import { useState } from 'preact/hooks'
import type { OnboardingStep } from '../steps'
import { DEMO_HOST } from '../samples'
import { t } from '../../sidepanel/strings'

async function openRecall(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent()
    if (win?.id != null) await chrome.sidePanel.open({ windowId: win.id })
  } catch {
    // sidePanel.open can be unreliable; the pin-guide step is the reliable fallback.
  }
}

export function FinishStep({ step }: { step: Extract<OnboardingStep, { kind: 'finish' }> }) {
  const [removed, setRemoved] = useState(false)

  const removeDemo = async () => {
    await chrome.runtime.sendMessage({ type: 'forget-host', host: DEMO_HOST })
    setRemoved(true)
  }

  return (
    <section class="card section">
      <h2>{step.title}</h2>
      <p>{step.body}</p>
      <div class="nav-actions">
        <button class="primary" onClick={() => void openRecall()}>{t.obOpenRecall}</button>
        {!removed
          ? <button class="linkbtn" onClick={() => void removeDemo()}>{t.obRemoveDemo}</button>
          : <span class="demo-status">{t.obDemoRemoved}</span>}
      </div>
    </section>
  )
}
```

- [ ] **Step 6: `src/ui/onboarding/OnboardingFlow.tsx` (the driver - names NO individual step)**

```tsx
import { useState } from 'preact/hooks'
import { STEPS } from './steps'
import type { OnboardingStep } from './steps'
import { nextIndex, prevIndex, lastIndex, isFirst, isLast, progress } from './flow'
import { t } from '../sidepanel/strings'
import { InfoStep } from './steps/InfoStep'
import { PinGuideStep } from './steps/PinGuideStep'
import { CaptureDemoStep } from './steps/CaptureDemoStep'
import { SearchDemoStep } from './steps/SearchDemoStep'
import { FinishStep } from './steps/FinishStep'

// One renderer per kind. Adding a brand-new kind = add ONE entry here (+ push to STEPS).
// The cast keeps each renderer typed to its own narrowed step.
const STEP_RENDERERS: Record<OnboardingStep['kind'], (props: { step: any }) => preact.JSX.Element> = {
  'info': InfoStep,
  'capture-demo': CaptureDemoStep,
  'search-demo': SearchDemoStep,
  'pin-guide': PinGuideStep,
  'finish': FinishStep,
}

export function OnboardingFlow() {
  const [i, setI] = useState(0)
  const len = STEPS.length
  const step = STEPS[i]
  const Renderer = STEP_RENDERERS[step.kind]
  const { fraction } = progress(i, len)

  return (
    <main class="page wizard">
      {/* Progress: dots derived from STEPS.length + a fill bar from flow.progress */}
      <div class="dots" role="progressbar" aria-valuenow={i + 1} aria-valuemin={1} aria-valuemax={len}>
        {STEPS.map((s, idx) => <span key={s.id} class={idx === i ? 'dot active' : 'dot'} />)}
      </div>

      <Renderer step={step} />

      <div class="nav">
        {!isFirst(i) && <button class="navbtn" onClick={() => setI((n) => prevIndex(n, len))}>{t.obBack}</button>}
        <span class="nav-progress">{t.obStepProgress(i + 1, len)}</span>
        {!isLast(i, len)
          ? (
            <>
              <button class="navbtn ghost" onClick={() => setI(() => lastIndex(len))}>{t.obSkip}</button>
              <button class="navbtn primary" onClick={() => setI((n) => nextIndex(n, len))}>{t.obNext}</button>
            </>
          )
          : null}
      </div>
      {/* the fill bar uses the derived fraction so reordering/adding steps updates it for free */}
      <div class="bar"><div class="bar-fill" style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
    </main>
  )
}
```

- [ ] **Step 7: swap the mount (`src/ui/onboarding/main.tsx`)**

  Change the import and render from `Onboarding` to `OnboardingFlow`:

```tsx
import { OnboardingFlow } from './OnboardingFlow'
// ... render(<OnboardingFlow />, ...) where it previously rendered <Onboarding />
```

- [ ] **Step 8: delete the static page**

```bash
git rm src/ui/onboarding/Onboarding.tsx
```

- [ ] **Step 9: add wizard CSS (`src/ui/onboarding/onboarding.css`)**

  Append (reuses the existing `.card`, `.section`, `.chips`/`.chip`, `.results`/`.meta`, `.primary` rules):

```css
/* Wizard chrome ----------------------------------------------------------- */
.wizard { min-height: 100vh; justify-content: flex-start; }

/* Progress dots, one per step (count derived from STEPS in the driver). */
.dots { display: flex; gap: var(--space-2); justify-content: center; margin: var(--space-3) 0; }
.dot { width: 8px; height: 8px; border-radius: 999px; background: var(--border-strong); }
.dot.active { background: var(--accent); }

/* The searchbar + chip buttons reuse the side-panel look; chips here are buttons. */
.chip { cursor: pointer; font-family: inherit; }
.searchbar { display: flex; gap: var(--space-2); margin-top: var(--space-3); }
.searchbar input {
  flex: 1; padding: 10px 12px; font: inherit; color: var(--text);
  border: 1px solid var(--border-strong); border-radius: var(--radius); background: #fff;
}
.searchbtn {
  padding: 10px 16px; font: inherit; font-weight: 550; color: #fff;
  background: var(--accent); border: 0; border-radius: var(--radius); cursor: pointer;
}
.results { margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-3); }
.results .card { padding: var(--space-4); }
.results .card > a { display: block; color: var(--accent); font-weight: 600; text-decoration: none; }
.results .card > p { margin: var(--space-2) 0 0; color: #374151; font-size: 14px; }
.results .meta { margin-top: var(--space-2); font-size: 12px; color: var(--faint); }
.hint { margin-top: var(--space-3); color: var(--muted); font-size: 13px; }

.sample-list { margin: var(--space-3) 0 0; padding-left: var(--space-5); color: #374151; }
.demo-status { margin-top: var(--space-3); color: var(--accent); font-weight: 550; }

/* Nav row: Back ... Skip Next */
.nav { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-4); }
.nav-progress { color: var(--faint); font-size: 13px; }
.navbtn {
  padding: 9px 16px; font: inherit; font-weight: 550; border-radius: var(--radius); cursor: pointer;
  border: 1px solid var(--border-strong); background: #fff; color: var(--text);
}
.navbtn.primary { margin-left: auto; background: var(--accent); color: #fff; border: 0; }
.navbtn.ghost { border: 0; background: transparent; color: var(--muted); }
.nav-actions { display: flex; align-items: center; gap: var(--space-4); margin-top: var(--space-4); }
.linkbtn { background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }

/* Thin fill bar under the nav. */
.bar { height: 4px; background: var(--border); border-radius: 999px; margin-top: var(--space-4); overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); transition: width 0.2s; }
```

- [ ] **Step 10: typecheck + build**

  Run: `npx tsc --noEmit && npm run build`
  Expected: typecheck clean; `dist-ext` builds without error.

- [ ] **Step 11: commit**

```bash
git add src/ui/onboarding/
git commit -m "feat(onboarding): wizard driver + per-kind renderers + CSS (replaces static page)"
```

---

## Task 7: e2e - update the existing onboarding test + add the full interactive ride

The static onboarding test asserted all content on one scroll; the wizard shows one step at a time, so it is updated to the first step + a nav control. The new test drives the full ride against the real engine.

**Files:** Modify `tests/e2e/onboarding.spec.ts`; create `tests/e2e/onboarding-interactive.spec.ts`.

- [ ] **Step 1: update `tests/e2e/onboarding.spec.ts` for the wizard**

  Replace the body's content asserts (everything after `await page.goto(...)`) with first-step + nav asserts. The deep content moves to the interactive test.

```ts
  // Scenario: after install, the onboarding wizard's FIRST step renders (brand tagline) and
  // shows a Next control - so the first-run page is not blank/broken.
  // Coverage: integration (built extension; real CRXJS-emitted page rendered by Preact).
  await expect(page.getByText('Remember everything you read', { exact: false })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Next' })).toBeVisible()
```

  Also update the header Scenario/Coverage comment to describe the wizard first step (drop the chip/mock-link/wikipedia asserts - those are now the interactive test's job).

  Run: `npx playwright test tests/e2e/onboarding.spec.ts`
  Expected: PASS.

- [ ] **Step 2: create `tests/e2e/onboarding-interactive.spec.ts` (the full ride)**

```ts
// Scenario: a brand-new user rides the real flow once - the onboarding seeds bundled sample
// pages through the REAL capture pipeline, then searches them with the REAL on-device model
// and sees a real result card. This is the interactive onboarding's whole promise, end to end.
// Coverage: integration (built extension in Chrome; real capture-text -> capture-service ->
// embed -> sqlite -> recall, rendered by the real wizard). Full real path.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

test('onboarding seeds samples then searches them with the real engine', async () => {
  // First run downloads the e5-small model (~23 MB) then indexes 3 docs.
  test.setTimeout(300_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${extId}/src/ui/onboarding/index.html`)

  // Step 1 (hero) is shown. Advance to the capture-demo step.
  await expect(page.getByText('Remember everything you read', { exact: false })).toBeVisible({ timeout: 10_000 })
  // hero -> how-it-works -> capture-demo : click Next twice.
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  // Capture-demo: seed the samples and wait for indexing to finish.
  await expect(page.getByText('Try it: save a few sample pages')).toBeVisible()
  await page.getByRole('button', { name: 'Seed sample pages' }).click()
  // "Sample pages added" appears only after the drain broadcasts pending===0 (model download
  // happens here on first run, so allow the long budget).
  await expect(page.getByText('Sample pages added')).toBeVisible({ timeout: 240_000 })

  // Advance to the search-demo step and run an example query.
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Now search by meaning')).toBeVisible()
  await page.getByRole('searchbox').fill('the hormone that ruins sleep')
  await page.getByRole('searchbox').press('Enter')

  // A REAL result card must appear, and the cortisol sample must be the match.
  const cards = page.locator('article')
  await expect(cards.first()).toContainText('cortisol', { timeout: 30_000 })

  // Walk to the finish step and remove the demo data in one click.
  await page.getByRole('button', { name: 'Next' }).click() // search-demo -> pin-guide
  await page.getByRole('button', { name: 'Next' }).click() // pin-guide -> finish
  await expect(page.getByText('You are all set')).toBeVisible()
  await page.getByRole('button', { name: 'Remove demo data' }).click()
  await expect(page.getByText('Demo data removed')).toBeVisible({ timeout: 10_000 })

  await ctx.close()
})
```

  > Note on the search assertion text: the cortisol sample text uses the word "cortisol" in lower case mid-sentence, so `toContainText('cortisol')` (case-sensitive substring) matches the chunk body. If chunking ever changes, assert on `'melatonin'` or the page title `'Sleep, cortisol, and the body clock'` instead.

  Run: `npx playwright test tests/e2e/onboarding-interactive.spec.ts`
  Expected: PASS (may be slow on first run - model download).

- [ ] **Step 3: commit**

```bash
git add tests/e2e/onboarding.spec.ts tests/e2e/onboarding-interactive.spec.ts
git commit -m "test(onboarding): wizard first-step e2e + full interactive ride e2e"
```

---

## Task 8: Full verification + final commit

- [ ] **Step 1: full unit suite**

  Run: `npm run test`
  Expected: all green (the prior 142 + the new flow/samples/steps/strings/capture-service tests).

- [ ] **Step 2: full e2e suite**

  Run: `npx playwright test`
  Expected: green, including the updated `onboarding.spec.ts` and the new `onboarding-interactive.spec.ts`. (If the existing `recall-flow` / `forget-history` tests are slow, they are unaffected by this change - they do not touch onboarding.)

- [ ] **Step 3: typecheck + build sanity**

  Run: `npx tsc --noEmit && npm run build`
  Expected: clean.

- [ ] **Step 4: final commit (the plan itself was committed up front; this is the safety net if any cleanup remains)**

```bash
git add -A
git commit -m "chore(onboarding): finalize flexible interactive onboarding" || echo "nothing to finalize"
```

---

## Self-Review

**1. Spec coverage** (each spec requirement -> task):
- Declarative step model (discriminated union + `STEPS`) -> Task 3. Driver with `STEP_RENDERERS` + currentIndex + next/back/skip + dots, all derived from `STEPS` -> Task 6 (`OnboardingFlow`) on top of pure `flow.ts` -> Task 1.
- Add/remove/reorder = N-line change, spelled out -> "How the declarative step system delivers..." section + Task 3 file header comment.
- Static sections become `info`/`pin-guide` steps (content reused) -> Task 3 `STEPS` (hero, how-it-works, pin-guide). The "search by meaning"/"results preview" static sections become the REAL `search-demo` -> Task 3 + Task 6 `SearchDemoStep`.
- `capture-text` message + SW relay + offscreen op, core stays pure -> Task 4 (with the explicit "skips the gate, reuses capture-service" note). Message types specified in Task 4 Step 2/3/4.
- Samples tagged with demo host, easy to clean -> Task 2 (`DEMO_HOST`).
- `search-demo` reuses `recall` + the `<article>` card markup -> Task 6 `SearchDemoStep`.
- Cleanup decision (forget-by-host, one-click) -> Decision 1 + Task 5 string + Task 6 `FinishStep`.
- Strings via `strings.ts` -> Task 5. Pin illustration reused -> Task 6 `PinGuideStep`.
- Five resolved decisions (real+removable, wizard, unify, samples, re-openable/install) -> "Confirmed decisions" section.
- TDD where pure (flow, capture-service contract, sample validation) -> Tasks 1, 2, 4. e2e full ride -> Task 7. Existing `onboarding.spec.ts` update -> Task 7 Step 1.
- File Map (create/modify all listed) -> File Map table.
- Tradeoffs -> Decisions section + Tradeoffs section below.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step shows full code; sample prose is written out in Task 2; all asserted strings are byte-identical to Task 5's `EN`.

**3. Type consistency:** `OnboardingStep` union (Task 3) is referenced by `Extract<..., {kind:'x'}>` in every renderer (Task 6) - kinds match (`info`, `capture-demo`, `search-demo`, `pin-guide`, `finish`). `STEP_RENDERERS` keys === `OnboardingStep['kind']` === `STEP_KINDS` (Task 3). `capture-text` Msg shape (Task 4) matches the sends in `CaptureDemoStep` (Task 6). `MsgResult` `captured` reused, not redefined. `flow.ts` exports (`nextIndex`, `prevIndex`, `lastIndex`, `isFirst`, `isLast`, `progress`, `clampIndex`) match Task 1 tests and Task 6 driver imports. String keys in Task 5 (`obNext`...`obStepProgress`) match `OnboardingFlow`/renderer usage and the `strings.test.ts` key lists.

One watch-item for the implementer: the `STEP_RENDERERS` value type uses `props: { step: any }` to sidestep the union-narrowing-across-a-map limitation in TS; each renderer still narrows its own `step` via `Extract`. This is the one deliberate `any` - keep it local to the map; do not let `step` stay `any` inside a renderer.

---

## Tradeoffs

- **Demo-data pollution + cleanup.** The demo writes 3 real rows tagged `recall-demo.example`. Upside: the search-demo is authentic (real engine, real results). Downside: if the user never clicks "Remove demo data", those rows linger in their index and could appear in a later real search. Mitigations: (a) one-click removal on the finish step, (b) the rows are clearly demo-hosted, (c) the History/forget-site features already let a user remove them later. Chosen over an ephemeral store because a second store/embedder path is heavy and would not exercise the real engine. Chosen over auto-clean-on-finish because that would delete pages the user might still be exploring and because tab-close cleanup is unreliable; explicit removal also matches the repo's user-control ethos (pause, forget-site are all explicit).
- **`capture-text` reuses `capture-service` (core stays pure).** The new slice is messaging glue + one offscreen op; it calls the unchanged `CaptureService.capture()`. It deliberately SKIPS the capture gate (a seeded demo is always stored). Risk: a future gate concern (e.g. global pause) won't apply to seeds - acceptable, because seeds are explicit user-initiated demo content, not auto-capture. The pure contract is pinned by the Task 4 capture-service test; the glue is covered by the Task 7 e2e.
- **Wizard vs single-scroll.** Wizard adds clicking and one more piece of state (`currentIndex`), but it keeps the declarative driver trivial (render ONE step) and lets the flow gate "seed before search". Single-scroll would render all steps and lose that one-renderer simplicity. Mitigated by a visible Skip (jump to finish) for users who just want to read.
- **Keeping the existing onboarding e2e green.** Replacing the static page changes what that test sees, so Task 7 Step 1 rewrites it to the wizard's first step + a Next control, and the removed deep-content asserts are re-homed (stronger) in the interactive ride. Net: same coverage intent, now against the real flow.
- **DRY tension on the result card.** `SearchDemoStep` replicates `SearchTab`'s ~6-line `<article class="card">` markup rather than importing a shared component. Extracting a shared `ResultCard` would be DRY-er but means refactoring `SearchTab` (risk to a tested surface) for a tiny gain. The markup is kept byte-identical and noted; a shared component is a clean future refactor if a third caller appears.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-interactive-onboarding.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
