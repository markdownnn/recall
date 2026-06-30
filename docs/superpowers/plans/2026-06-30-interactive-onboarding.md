# Interactive Onboarding (keep the scroll page, declarative sections, one live Try-it card)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Every code change is TDD where the logic is pure: failing test FIRST, watched fail, then implementation. Browser/offscreen-glue steps (the `capture-text` offscreen op, the SW relay, the Preact renderers) carry a `Coverage: N/A` or `Coverage: integration (e2e)` justification - never "manual check". Steps use checkbox (`- [ ]`) syntax for tracking. Test source is ASCII-only (repo rule).

**Goal:** KEEP the existing single-scroll first-run onboarding page exactly as it reads today (hero, how-it-works, search-by-meaning, open-Recall with the pin guide + keyboard shortcuts), but make it **declarative**: render the page from a `SECTIONS` data array through a `kind`-keyed renderer map, so a section can be added / removed / reordered by editing that array. Then upgrade **only one** card - the old static "What results look like" mock - into a **live "Try it yourself" card**: a button seeds 3 bundled sample pages through the REAL capture pipeline, then reveals an inline search box that returns REAL on-device results from those samples, with one-click "Remove demo data".

**Why this shape (the owner's intent):** Two requirements, both honored:
1. **Flexibility without a rewrite.** The page must not be hardcoded JSX in one long function. It mirrors the spirit of the repo's `Tabs.tsx` scaffold - UI defined as a data list rendered through a `map`, where extension is an N-line additive change. Here the data list is `SECTIONS: OnboardingSection[]` and the renderer is a `SECTION_RENDERERS` map keyed by `kind`. Adding a section = push one object into `SECTIONS` (+ one renderer entry only if the `kind` is brand-new).
2. **It stays a SCROLL, not a wizard.** There is NO next/back/skip/progress driver. The page renders ALL sections top-to-bottom in array order, exactly like today. The owner confirmed this visually: the existing page is good; we keep it and only make one card live.

**Architecture:** Hexagonal + declarative, same as the rest of the repo.
- The **section model** lives as data in `sections.ts` (a discriminated union + the `SECTIONS` array) with a pure invariants test (ids unique, every kind renderable, the `try-it` section seeds the validated `SAMPLES`, hero first / open-recall last). This small pure module replaces the wizard's navigation state machine - there is no nav math to write, because there is no nav.
- The **bundled sample docs** live as data in `samples.ts` with a pure `isValidSample` guard (unit-tested).
- The **page** `Onboarding.tsx` becomes a thin driver: it maps `SECTIONS` to `SECTION_RENDERERS[section.kind]` and renders them in a single scrollable column. It names no individual section.
- The **one interactive card** `TryItCard.tsx` talks to the REAL engine through messaging. A small NEW backend slice - a `capture-text` message -> SW relay -> offscreen `capture-text` op - lets the card seed PROVIDED text (no active tab) by reusing the existing `CaptureService.capture()` unchanged. **`src/core` stays pure** (capture-service, chunker, store reused as-is; zero core edits).

**Tech Stack:** TypeScript, Vite+CRXJS, Preact (+ `preact/hooks`), `@sqlite.org/sqlite-wasm` (OPFS) + WebGPU embedder via the offscreen document, Vitest, Playwright. No new runtime deps.

**Current baseline (verify before starting):** `npm run test` green (142 tests). Branch `recall-walking-skeleton`. The onboarding (`src/ui/onboarding/Onboarding.tsx`) renders five hardcoded `<section>` blocks in one scroll: hero, "How it works" (Automatic / Manual / Private list), "Search by meaning" (chips), "What results look like" (a STATIC mock result card), and "Open Recall" (pin illustration + keyboard shortcuts + Open Recall button). `main.tsx` mounts `<Onboarding/>`; the install trigger (`src/background/index.ts` `onInstalled`, `details.reason === 'install'`) opens `src/ui/onboarding/index.html` in a new tab. `tests/e2e/onboarding.spec.ts` asserts: brand `Recall` (exact), the chip `that article about sleep and cortisol`, the mock link `How photosynthesis works`, `wikipedia.org`, and `side panel`. The capture pipeline is: content `capture` message -> SW relay -> offscreen `capture` op -> `gate.decide` -> `CaptureService.capture()` -> `runDrainWithProgress()` (async embed). Search is: `recall` message -> SW -> offscreen `recall` op -> `RecallService`. Demo-data cleanup already exists: `forget-host` message -> offscreen `forget-host` op -> `store.deletePagesByHost(host)` (host derived at upsert: `new URL(url).hostname.toLowerCase()`).

---

## Confirmed decisions (read first - bake these in)

**1. KEEP the scroll page. Do NOT delete it, do NOT build a wizard.**
The single-scroll onboarding stays. All of its current content - hero copy, the Automatic/Manual/Private "how it works" list, the search-by-meaning chips, the pin illustration, the keyboard shortcuts, the Open Recall button - is preserved verbatim. We do NOT add next/back/skip/progress. The page still renders every section top-to-bottom.
*Tradeoff:* a wizard would let us gate "seed before you search," but the owner visually confirmed the scroll page is the desired product and a wizard would throw away polished, approved UI for clicking. We keep the scroll; the one live card handles its own gating internally (the search box only appears after seeding).

**2. Make the page declarative via a `SECTIONS` array + `kind`-keyed renderer map (flexibility), still rendered as a scroll.**
`Onboarding.tsx` stops being one long hardcoded function. It maps `SECTIONS: OnboardingSection[]` to `SECTION_RENDERERS[kind]` and renders them in order. Each section is `{ id, kind, ... }`. The existing five sections migrate into the array verbatim (the static prose stays inside its renderer - it is owner-approved inline copy, kept byte-identical so the e2e strings still match).
*Tradeoff:* we could leave the JSX hardcoded (less churn), but the owner explicitly wants add/remove/reorder to be a one-line data edit. The renderer map costs ~20 lines of scaffolding and buys exactly that, with no behavior change to the rendered page.

**3. Upgrade ONLY the "What results look like" card into a live `try-it` card. (NOT every card.)**
The static mock result card (the fake "How photosynthesis works" / "wikipedia.org" card) is replaced by `TryItCard` (kind `try-it`): an "Add 3 sample pages" button seeds the bundled samples through the REAL `capture-text` path, then reveals an inline search box (the real `recall` round-trip + the real `<article class="card">` markup) so the user types a query and sees REAL results. After seeding, a "Remove demo data" link on the same card clears them (`forget-host` on `DEMO_HOST`). Every other section is untouched.
*Tradeoff:* this changes what the e2e sees for that one card (a real seed->search flow instead of a static mock), so `tests/e2e/onboarding.spec.ts` is repointed and a new interactive spec is added (Task 6). Known, planned cost; the payoff is the user rides the real engine once during onboarding instead of reading a fake screenshot.

**4. Demo writes to the REAL index, tagged with a demo host, removable. (NOT an ephemeral store.)**
Samples go through the real `capture-text` -> `CaptureService.capture()` path into the real OPFS store, so the search returns genuine on-device results. Every sample url uses host **`recall-demo.example`** (a clearly-fake, reserved-style host), so the host column on every seeded page is exactly `recall-demo.example` and the existing forget-by-host delete removes them in one call.
*Tradeoff:* an ephemeral/second store would avoid polluting the real index but means wiring a whole parallel VectorSearchPort + embedder path just for onboarding - heavy, and it would NOT exercise the real engine (the whole point). Real+removable is lighter and authentic; the only cost is 3 tagged rows that the card offers to remove in one click.

**5. Bundled sample content: 3 short real-ish ASCII docs (~150-200 words each), one per demo query.**
Topics so each maps cleanly to one example query: (a) photosynthesis, (b) sleep & cortisol, (c) HTTP caching. Full text in Task 1 (no placeholders). The thin-page gate is bypassed for seeded demo docs (the `capture-text` op skips the gate - see Task 3).

**6. Keep the existing install trigger; the page is re-runnable; no "completed" persistence in v1.**
`onInstalled` still opens `index.html` on first install. Re-opening the page simply re-renders it; seeding is idempotent (capture upserts by pageId). v1 stores no "done" flag - YAGNI.

---

## How the declarative section system delivers "easily add / remove / reorder sections" (explicit)

This is the flexibility requirement, now in a SCROLL context (no wizard). After this plan ships:

- **Add a section (existing kind):** push ONE object into `SECTIONS` in `sections.ts`. Example - a second info card using the hero/how-it-works look:
  ```ts
  { kind: 'how-it-works', id: 'privacy-note' },
  ```
  That is the ENTIRE change. The driver maps it to its renderer and it appears in the scroll at that array position. No edit to `Onboarding.tsx` or any renderer.
- **Add a section with a brand-new kind:** push the object AND add ONE entry to the `SECTION_RENDERERS` map (a 2-line change total) - exactly the scaffold's "+ a renderer if a brand-new kind" rule. Example - a `video` kind: add `{ kind:'video'; id; src }` to the union, push one into `SECTIONS`, add `video: VideoSection` to the map, write the tiny `VideoSection` renderer.
- **Remove a section:** delete its object from `SECTIONS`. Nothing else.
- **Reorder sections:** move objects within the `SECTIONS` array. The scroll order follows the array order automatically.
- **Edit which samples seed / the demo queries:** edit the `samples` or `exampleQueries` literal inside the `try-it` object (or `SAMPLES`). No component touched.

The driver NEVER hardcodes a section. It renders `SECTIONS.map((s) => SECTION_RENDERERS[s.kind])` and names no individual section. Task 5's `Onboarding` body is the proof: it references `SECTIONS` and `SECTION_RENDERERS` only.

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `src/ui/onboarding/samples.ts` | Create | `SampleDoc` type, `DEMO_HOST = 'recall-demo.example'`, `SAMPLES: SampleDoc[]` (3 bundled docs), pure `isValidSample(d)` guard. |
| `tests/core/onboarding-samples.test.ts` | Create | RED-first pure tests: every SAMPLE passes `isValidSample`, each url host equals `DEMO_HOST`, each text has >= 80 words, urls unique. ASCII-only. |
| `src/ui/onboarding/sections.ts` | Create | The discriminated union `OnboardingSection`, `SECTION_KINDS`, and `export const SECTIONS: OnboardingSection[]` (the five sections in scroll order; the `try-it` section carries `samples` + `exampleQueries`). |
| `tests/core/onboarding-sections.test.ts` | Create | RED-first pure tests: `SECTIONS` non-empty, ids unique, every `kind` is in `SECTION_KINDS`, first kind is `hero` and last is `open-recall`, exactly one `try-it` section whose `samples === SAMPLES`. ASCII-only. |
| `src/messaging.ts` | Modify | Add `Msg` `{ type: 'capture-text'; url: string; title: string; text: string }`. Result reuses the existing `{ type: 'captured'; captured; chunkCount; reason? }`. |
| `src/offscreen/offscreen.ts` | Modify | Add `op === 'capture-text'` branch: `capture.capture({url,title,text})` (NO gate - seeded demo always stores) then `runDrainWithProgress()`; return `{ captured: true, chunkCount }`. |
| `src/background/index.ts` | Modify | Add `'capture-text'` to the handled-types guard chain; add a dispatch branch relaying to offscreen `capture-text` -> `{ type:'captured', ... }`. |
| `tests/core/capture-service.test.ts` | Modify | Add a contract test: `capture()` of provided sample text (a `recall-demo.example` url) stores chunks as pending - pins the provided-text path the slice reuses on the real service. |
| `src/ui/sidepanel/strings.ts` | Modify | Add try-it card strings: `obSeedButton`, `obSeeding`, `obSeeded`, `obSearchPlaceholder`, `obRemoveDemo`, `obDemoRemoved`. (Section prose stays inline in renderers.) |
| `tests/core/strings.test.ts` | Modify | Add the new keys to `STATIC_KEYS`; pin `obSeedButton === 'Add 3 sample pages'` and `obSeeded === 'Sample pages added'` as byte-identical e2e strings. |
| `src/ui/onboarding/TryItCard.tsx` | Create | The one live card (kind `try-it`): "Add 3 sample pages" -> seeds each sample via `capture-text`, waits for the indexing-done broadcast, then reveals an inline searchbox (the `recall` round-trip, k:5) + `<article class="card">` result cards + a "Remove demo data" link (`forget-host` on `DEMO_HOST`). |
| `src/ui/onboarding/Onboarding.tsx` | Modify (KEEP, refactor) | Becomes the scroll driver: defines the per-kind static renderers (Hero, HowItWorks, SearchByMeaning, OpenRecall - JSX migrated VERBATIM from today's page) + the `SECTION_RENDERERS` map, and renders `SECTIONS.map(...)` in one `<main class="page">` column. Names no individual section. |
| `src/ui/onboarding/onboarding.css` | Modify | Add the live-card chrome: `.searchbar`, `.searchbtn`, `.results`, `.hint`, `.sample-list`, `.demo-status`, `.linkbtn`, and make `.chip` clickable inside the try-it card. Reuse existing `.card`, `.section`, `.chips`/`.chip`, `.meta`, `.primary`. |
| `tests/e2e/onboarding.spec.ts` | Modify | Keep the still-static asserts (brand `Recall` exact, chip `that article about sleep and cortisol`, `side panel`); add the seed button `Add 3 sample pages` is visible; DROP the static-mock asserts (`How photosynthesis works` link, `wikipedia.org`) - those move to the interactive spec. |
| `tests/e2e/onboarding-interactive.spec.ts` | Create | The seed->search ride: open onboarding, click `Add 3 sample pages`, wait for `Sample pages added`, type a query in the revealed box, assert a real `<article>` result; then `Remove demo data` and assert it clears. |

**NOT touched:** `src/core/capture-service.ts`, `src/core/paragraph-chunker.ts`, `src/core/recall-service.ts`, the embedder, the sqlite worker, `offscreen-rpc.ts`, `src/ui/sidepanel/*` components, `src/ui/onboarding/PinIllustration.tsx` (reused by the OpenRecall renderer), `src/ui/onboarding/main.tsx` (still mounts `<Onboarding/>`). The `pages`/`chunks` schema is unchanged.

**Deleted:** nothing. The static page is kept and refactored in place.

---

## Task 1: Bundled sample docs + validation (`samples.ts`, TDD)

The demo seeds 3 short real-ish ASCII docs. They are data with a pure `isValidSample` guard so a bad edit (empty text, wrong host) is caught by a unit test, not in the browser.

**Files:** Create `tests/core/onboarding-samples.test.ts` (test FIRST), `src/ui/onboarding/samples.ts`.

- [ ] **Step 1 (RED): write the failing tests (`tests/core/onboarding-samples.test.ts`)**

```ts
import { SAMPLES, DEMO_HOST, isValidSample } from '../../src/ui/onboarding/samples'

// Scenario: the try-it card seeds bundled docs; if one were empty or mis-hosted, the seed
// would store garbage or the cleanup (forget-host on DEMO_HOST) would miss it.
// Coverage: integration (real samples.ts).
test('every bundled sample is valid and hosted on the demo host', () => {
  expect(SAMPLES.length).toBeGreaterThanOrEqual(3)
  for (const s of SAMPLES) {
    expect(isValidSample(s)).toBe(true)
    expect(new URL(s.url).hostname).toBe(DEMO_HOST)
  }
})

// Scenario: embedding needs real signal; a one-line sample would make the search return
// nothing. Pin a minimum word count per sample.
// Coverage: integration (real samples.ts).
test('every sample has enough words for a meaningful embedding', () => {
  for (const s of SAMPLES) {
    expect(s.text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(80)
  }
})

// Scenario: two samples sharing a url would dedup to one page (capture upserts by pageId),
// silently dropping a demo doc. Urls must be unique.
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
// Bundled demo docs seeded through the REAL capture pipeline by the onboarding try-it card,
// so a new user can search real on-device results immediately. Every url is on DEMO_HOST so
// the card's "Remove demo data" (forget-host on DEMO_HOST) cleans them in one call.

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

## Task 2: The declarative section model (`sections.ts`, TDD)

The whole page is this array. The five existing sections become data; the `try-it` section carries the samples + demo queries. A small pure test pins the array's invariants (ordering, uniqueness, renderable kinds, the seeded-samples link). This is the small pure module that replaces a wizard's navigation state machine - there is no nav math here, only the data and its invariants.

**Files:** Create `tests/core/onboarding-sections.test.ts` (test FIRST), `src/ui/onboarding/sections.ts`.

- [ ] **Step 1 (RED): write the failing tests (`tests/core/onboarding-sections.test.ts`)**

```ts
import { SECTIONS, SECTION_KINDS } from '../../src/ui/onboarding/sections'
import { SAMPLES } from '../../src/ui/onboarding/samples'

// Scenario: the page renders each section through a renderer keyed by kind; a section whose
// kind has no renderer entry would crash at render. Pin every kind as known.
// Coverage: integration (real sections.ts).
test('every section kind is a known, renderable kind', () => {
  expect(SECTIONS.length).toBeGreaterThan(0)
  for (const s of SECTIONS) expect(SECTION_KINDS).toContain(s.kind)
})

// Scenario: duplicate ids would make the keyed map() collide and the scroll order ambiguous.
// Coverage: integration (real sections.ts).
test('section ids are unique', () => {
  const ids = SECTIONS.map((s) => s.id)
  expect(new Set(ids).size).toBe(ids.length)
})

// Scenario: the page must open on the hero and end on the Open Recall guide (the call to
// action); a reorder that broke that would ship a confusing first-run page.
// Coverage: integration (real sections.ts).
test('the scroll opens on hero and ends on open-recall', () => {
  expect(SECTIONS[0].kind).toBe('hero')
  expect(SECTIONS[SECTIONS.length - 1].kind).toBe('open-recall')
})

// Scenario: exactly one live try-it card, and it must seed the SAME bundled SAMPLES the
// validation guards; a divergent inline list would seed unvalidated docs.
// Coverage: integration (real sections.ts).
test('there is one try-it section and it seeds the bundled SAMPLES', () => {
  const tryIts = SECTIONS.filter((s) => s.kind === 'try-it')
  expect(tryIts.length).toBe(1)
  const t = tryIts[0]
  if (t.kind === 'try-it') expect(t.samples).toBe(SAMPLES)
})
```

  Run: `npx vitest run tests/core/onboarding-sections.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 2 (GREEN): implement `src/ui/onboarding/sections.ts`**

```ts
// The declarative section model. The whole onboarding scroll is THIS array, in order.
// Adding a section = push one object here (+ a renderer in SECTION_RENDERERS only if the
// kind is brand-new). Removing = delete the object. Reordering = move objects. The driver
// (Onboarding) maps SECTIONS to SECTION_RENDERERS[kind] and names no individual section -
// this array is the single source of truth for what shows and in what order.
//
// Static sections (hero, how-it-works, search-by-meaning, open-recall) carry only { id, kind }
// because their prose is owner-approved inline copy that lives in its renderer (kept byte-
// identical for the e2e). Only the live try-it card needs data: the samples to seed and the
// example queries to offer.

import { SAMPLES } from './samples'
import type { SampleDoc } from './samples'

export type OnboardingSection =
  | { kind: 'hero'; id: string }
  | { kind: 'how-it-works'; id: string }
  | { kind: 'search-by-meaning'; id: string }
  | { kind: 'try-it'; id: string; samples: SampleDoc[]; exampleQueries: string[] }
  | { kind: 'open-recall'; id: string }

// The set of kinds that have a renderer. The sections test pins every SECTIONS entry against
// this so a new kind without a renderer is caught before it can crash at render.
export const SECTION_KINDS = [
  'hero', 'how-it-works', 'search-by-meaning', 'try-it', 'open-recall',
] as const

export const SECTIONS: OnboardingSection[] = [
  { kind: 'hero', id: 'hero' },
  { kind: 'how-it-works', id: 'how-it-works' },
  { kind: 'search-by-meaning', id: 'search-by-meaning' },
  // The one live card: seed the bundled samples, then search them with the real engine.
  {
    kind: 'try-it',
    id: 'try-it',
    samples: SAMPLES,
    exampleQueries: [
      'how plants turn sunlight into food',
      'the hormone that ruins sleep',
      'why a browser keeps a copy of a page',
    ],
  },
  { kind: 'open-recall', id: 'open-recall' },
]
```

- [ ] **Step 3: run the tests, verify PASS**

  Run: `npx vitest run tests/core/onboarding-sections.test.ts`
  Expected: PASS (4 tests).

- [ ] **Step 4: commit**

```bash
git add src/ui/onboarding/sections.ts tests/core/onboarding-sections.test.ts
git commit -m "feat(onboarding): declarative SECTIONS model (scroll order as data)"
```

---

## Task 3: The `capture-text` backend slice (messaging + offscreen op + SW relay)

A new message lets the try-it card seed PROVIDED text with no active tab, reusing `CaptureService.capture()` unchanged. **`src/core` is not touched** - the slice is messaging glue plus one offscreen op. The pure contract (provided text -> stored chunks) is pinned on the real capture-service.

**Files:** Modify `tests/core/capture-service.test.ts` (test FIRST), `src/messaging.ts`, `src/offscreen/offscreen.ts`, `src/background/index.ts`.

- [ ] **Step 1 (RED): add the contract test (`tests/core/capture-service.test.ts`)**

  Append this test (the imports are already present in the file):

```ts
// Scenario: the try-it card seeds a bundled demo doc by PROVIDED text (no tab). The same
// capture service must store its chunks as pending, hosted on the demo url, exactly like a
// real page.
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
  Expected: PASS immediately - the capture service ALREADY supports provided text (this test documents/pins the path the slice reuses; no core change needed). If it fails, stop: a core regression is present.

  > Note: this step is GREEN-on-write by design. It locks the contract the new message relies on, mirroring the existing capture tests. The remaining steps in this task are messaging glue with no pure logic to TDD.

- [ ] **Step 2: extend `src/messaging.ts`**

  Add to the `Msg` union (after the `capture` line):

```ts
  | { type: 'capture-text'; url: string; title: string; text: string }
```

  The result reuses the existing `{ type: 'captured'; captured: boolean; chunkCount: number; reason?: ... }` - no new `MsgResult` member.

- [ ] **Step 3: add the offscreen op (`src/offscreen/offscreen.ts`)**

  In the RPC handler, directly after the `if (op === 'capture') { ... }` block, add:

```ts
  // --- capture-text: seed PROVIDED text (onboarding try-it card, no active tab). Unlike
  //     `capture` this skips the gate on purpose: a seeded demo doc is always stored (the
  //     user clicked "Add 3 sample pages"). Reuses the SAME CaptureService.capture() + drain
  //     as a real capture. ---
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

  *Coverage: N/A (offscreen RPC glue - it dispatches to the already-tested `CaptureService.capture()` and the already-tested `runDrainWithProgress`; there is no real-path unit harness for the offscreen document. The end-to-end behavior is covered by `tests/e2e/onboarding-interactive.spec.ts` in Task 6.)*

- [ ] **Step 4: relay it in the SW (`src/background/index.ts`)**

  4a. Add `'capture-text'` to the handled-types guard chain (the `if (msg.type !== 'capture' && ...)` block, alongside the existing `msg.type !== 'capture' &&` line):

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

  *Coverage: N/A (SW relay glue - a thin forward to the offscreen op; covered end-to-end by the Task 6 e2e).*

- [ ] **Step 5: typecheck + unit run**

  Run: `npx tsc --noEmit && npx vitest run tests/core/capture-service.test.ts`
  Expected: typecheck clean; capture-service tests PASS.

- [ ] **Step 6: commit**

```bash
git add src/messaging.ts src/offscreen/offscreen.ts src/background/index.ts tests/core/capture-service.test.ts
git commit -m "feat(onboarding): capture-text backend slice (seed provided text, reuse capture-service)"
```

---

## Task 4: Try-it card strings (`strings.ts`, TDD)

The try-it card's LABELS (seed button, seeding/seeded status, search placeholder, remove demo data) are reusable UI chrome, so they go through the existing `strings.ts` i18n pattern. Section prose stays inline in its renderer.

**Files:** Modify `tests/core/strings.test.ts` (test FIRST), `src/ui/sidepanel/strings.ts`.

- [ ] **Step 1 (RED): extend `tests/core/strings.test.ts`**

  1a. Add the new static keys to `STATIC_KEYS`:

```ts
  'obSeedButton', 'obSeeding', 'obSeeded',
  'obSearchPlaceholder', 'obRemoveDemo', 'obDemoRemoved',
```

  1b. Add byte-identical assertions in the "byte-identical e2e strings are preserved" test:

```ts
  expect(EN.obSeedButton).toBe('Add 3 sample pages')
  expect(EN.obSeeded).toBe('Sample pages added')
  expect(EN.obRemoveDemo).toBe('Remove demo data')
  expect(EN.obDemoRemoved).toBe('Demo data removed')
```

  Run: `npx vitest run tests/core/strings.test.ts`
  Expected: FAIL (keys missing on EN).

- [ ] **Step 2 (GREEN): extend `src/ui/sidepanel/strings.ts`**

  2a. Add to the `UIStrings` interface (a new "Onboarding try-it card" block):

```ts
  // Onboarding try-it card chrome (section prose lives inline in its renderer; these are the
  // live-card action + status labels)
  obSeedButton: string
  obSeeding: string
  obSeeded: string
  obSearchPlaceholder: string
  obRemoveDemo: string
  obDemoRemoved: string
```

  2b. Add to the `EN` object:

```ts
  obSeedButton: 'Add 3 sample pages',
  obSeeding: 'adding sample pages...',
  obSeeded: 'Sample pages added',
  obSearchPlaceholder: 'Search what you just added...',
  obRemoveDemo: 'Remove demo data',
  obDemoRemoved: 'Demo data removed',
```

- [ ] **Step 3: run the tests, verify PASS**

  Run: `npx vitest run tests/core/strings.test.ts`
  Expected: PASS.

- [ ] **Step 4: commit**

```bash
git add src/ui/sidepanel/strings.ts tests/core/strings.test.ts
git commit -m "feat(onboarding): add try-it card strings (i18n-ready)"
```

---

## Task 5: The live `TryItCard` + the declarative scroll driver + CSS

The one live card, plus the refactor of `Onboarding.tsx` into a `SECTIONS`-driven scroll. The static section renderers carry the EXISTING JSX verbatim (byte-identical copy), so the kept e2e strings still match. This is Preact/DOM glue - no pure logic to TDD here (the pure parts were Tasks 1-2); correctness is proven end-to-end by Task 6's e2e.

**Files:** Create `src/ui/onboarding/TryItCard.tsx`; modify `src/ui/onboarding/Onboarding.tsx`, `src/ui/onboarding/onboarding.css`. (`main.tsx` is unchanged - it still mounts `<Onboarding/>`.)

- [ ] **Step 1: `src/ui/onboarding/TryItCard.tsx` (the one live card)**

  Phase machine: `idle` -> click "Add 3 sample pages" -> `seeding` (send one `capture-text` per sample, then wait for the SW's indexing-done broadcast) -> `seeded` (reveal the searchbox + the "Remove demo data" link). The searchbox reuses the `recall` round-trip (k:5) and the `<article class="card">` markup is byte-identical to `SearchTab` so the e2e `locator('article')` asserts resolve.

```tsx
import { useState, useEffect, useRef } from 'preact/hooks'
import type { OnboardingSection } from './sections'
import { DEMO_HOST } from './samples'
import type { MsgResult } from '../../messaging'
import type { RankedResult } from '../../core/model'
import { t } from '../sidepanel/strings'

type Phase = 'idle' | 'seeding' | 'seeded'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export function TryItCard({ section }: { section: Extract<OnboardingSection, { kind: 'try-it' }> }) {
  const [phase, setPhase] = useState<Phase>('idle')
  // True once all capture-text sends have resolved; we then wait for the drain-done event.
  const sentRef = useRef(false)

  // Search state (only used once seeded).
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  // Remove-demo state.
  const [removed, setRemoved] = useState(false)

  useEffect(() => {
    // The SW broadcasts {type:'indexing-progress', pending, embedded}; pending===0 means the
    // drain finished. Only flip to 'seeded' AFTER we have sent (sentRef), so an unrelated idle
    // broadcast cannot mark us seeded early.
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
    for (const s of section.samples) {
      const res: MsgResult = await chrome.runtime.sendMessage({
        type: 'capture-text', url: s.url, title: s.title, text: s.text,
      })
      if (res?.type === 'error') { setPhase('idle'); return }
    }
    sentRef.current = true
    // If embedding is already warm the drain can finish before the listener attaches; the
    // listener also catches the later pending===0 broadcast, so seeded is reached either way.
  }

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

  const removeDemo = async () => {
    await chrome.runtime.sendMessage({ type: 'forget-host', host: DEMO_HOST })
    setRemoved(true)
  }

  return (
    <section class="card section">
      <h2>Try it yourself</h2>
      <p>Add three short example pages to your private on-device index, then search them by meaning - just like your own pages.</p>

      <ul class="sample-list">
        {section.samples.map((s) => <li key={s.url}>{s.title}</li>)}
      </ul>

      {phase !== 'seeded' && (
        <button class="primary" disabled={phase === 'seeding'} onClick={() => void seed()}>
          {phase === 'seeding' ? t.obSeeding : t.obSeedButton}
        </button>
      )}

      {phase === 'seeded' && (
        <>
          <p class="demo-status">{t.obSeeded}</p>

          <div class="chips">
            {section.exampleQueries.map((eq) => (
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

          {!removed
            ? <button class="linkbtn" onClick={() => void removeDemo()}>{t.obRemoveDemo}</button>
            : <span class="demo-status">{t.obDemoRemoved}</span>}
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 2: refactor `src/ui/onboarding/Onboarding.tsx` into the SECTIONS-driven scroll**

  KEEP the file (do not delete). Keep `openRecall()` and `EXAMPLE_QUERIES` as they are. Replace the single hardcoded `return (...)` with: small per-kind static renderers holding the EXISTING JSX verbatim, a `SECTION_RENDERERS` map, and a driver that maps `SECTIONS`. The `<header class="hero">`, the how-it-works `<section>`, the search-by-meaning `<section>` (with the SAME `EXAMPLE_QUERIES` chips), and the open-recall `<section>` (with `<PinIllustration/>`, the keyboard shortcuts, and the Open Recall button) move into HeroSection / HowItWorksSection / SearchByMeaningSection / OpenRecallSection respectively, byte-for-byte. The old "What results look like" `<section>` is REPLACED by `<TryItCard/>` via the `try-it` kind.

```tsx
// Onboarding page shown in a full browser tab on first install.
//
// It is a SCROLL (not a wizard): SECTIONS is rendered top-to-bottom through a kind-keyed
// renderer map, so add/remove/reorder a section is a one-line edit in sections.ts. The static
// prose below is owner-approved and kept INLINE in each renderer on purpose - a one-off prose
// surface, distinct from the reusable UI strings in src/ui/sidepanel/strings.ts.

import { PinIllustration } from './PinIllustration'
import { SECTIONS } from './sections'
import type { OnboardingSection } from './sections'
import { TryItCard } from './TryItCard'

// Example "search by meaning" queries shown as illustrative pills (NOT clickable here - this
// is the explainer card; the live search lives in the try-it card below it).
const EXAMPLE_QUERIES = [
  'that article about sleep and cortisol',
  'the pricing page I saw',
  'react useEffect cleanup',
  'how photosynthesis works',
]

// Open the Recall side panel for the current window. A button click is a user gesture, so
// chrome.sidePanel.open is allowed here. We resolve the windowId via chrome.windows.getCurrent
// and swallow any failure so the click never throws - the printed instruction is the fallback.
async function openRecall(): Promise<void> {
  try {
    const win = await chrome.windows.getCurrent()
    if (win?.id != null) {
      await chrome.sidePanel.open({ windowId: win.id })
    }
  } catch {
    // sidePanel.open can be unreliable depending on Chrome/version/context.
  }
}

// --- per-kind static renderers (JSX migrated verbatim from the old single-function page) ---

function HeroSection() {
  return (
    <header class="hero">
      <div class="brand">Recall</div>
      <h1 class="tagline">Remember everything you read. Find it later in plain words.</h1>
      <p class="calm">Everything runs on your device. Nothing ever leaves it.</p>
    </header>
  )
}

function HowItWorksSection() {
  return (
    <section class="card section">
      <h2>How it works</h2>
      <ul class="features">
        <li><strong>Automatic.</strong> On-device AI saves the pages you actually read.</li>
        <li><strong>Manual.</strong> Save any page yourself in one click.</li>
        <li><strong>Private.</strong> Banking, email, and other sensitive sites are skipped - and you can pause anytime.</li>
      </ul>
    </section>
  )
}

function SearchByMeaningSection() {
  return (
    <section class="card section">
      <h2>Search by meaning</h2>
      <p>Forgot the exact words? Search by what it was about.</p>
      <div class="chips">
        {EXAMPLE_QUERIES.map((q) => (
          <span class="chip" key={q}>{q}</span>
        ))}
      </div>
    </section>
  )
}

function OpenRecallSection() {
  return (
    <section class="card section">
      <h2>Open Recall</h2>
      <p>Click the Recall icon in your toolbar to open the side panel.</p>
      <PinIllustration />
      <p class="tip">Tip: pin it for one-click access - click the puzzle-piece icon, then the pin next to Recall.</p>

      <div class="shortcuts">
        <h3 class="shortcuts-title">Keyboard shortcuts</h3>
        <div class="shortcut">
          <span class="keys"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd></span>
          <span>Open Recall</span>
        </div>
        <div class="shortcut">
          <span class="keys"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>U</kbd></span>
          <span>Save the current page</span>
        </div>
        <p class="tip">On Mac, use &#8984; Cmd instead of Ctrl.</p>
      </div>

      <button class="primary" onClick={() => void openRecall()}>Open Recall</button>
    </section>
  )
}

// One renderer per kind. Adding a brand-new kind = add ONE entry here (+ push to SECTIONS).
// The cast keeps each renderer typed to its own narrowed section.
const SECTION_RENDERERS: Record<OnboardingSection['kind'], (props: { section: any }) => preact.JSX.Element> = {
  'hero': HeroSection,
  'how-it-works': HowItWorksSection,
  'search-by-meaning': SearchByMeaningSection,
  'try-it': TryItCard,
  'open-recall': OpenRecallSection,
}

export function Onboarding() {
  return (
    <main class="page">
      {SECTIONS.map((section) => {
        const Renderer = SECTION_RENDERERS[section.kind]
        return <Renderer key={section.id} section={section} />
      })}
    </main>
  )
}
```

  > Note: the static renderers ignore their `section` prop (their content is inline); only `TryItCard` reads `section.samples` / `section.exampleQueries`. The `any` on the map value is the one deliberate cast (the union-across-a-map TS limitation); each renderer still narrows via `Extract` or simply ignores the prop. Keep the `any` local to the map.

- [ ] **Step 3: add the live-card CSS (`src/ui/onboarding/onboarding.css`)**

  Append (reuses the existing `.card`, `.section`, `.chips`/`.chip`, `.meta`, `.primary` rules; the old `.result-mock` rules can stay - they are simply unused now, or be removed):

```css
/* Try-it live card -------------------------------------------------------- */
/* Chips inside the try-it card are clickable buttons (the explainer chips above stay spans). */
.section .chips button.chip { cursor: pointer; font-family: inherit; }

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
.results .card > a:hover { text-decoration: underline; }
.results .card > p { margin: var(--space-2) 0 0; color: #374151; font-size: 14px; line-height: 1.5; }
.results .meta { margin-top: var(--space-2); font-size: 12px; color: var(--faint); }
.hint { margin-top: var(--space-3); color: var(--muted); font-size: 13px; }

.sample-list { margin: var(--space-3) 0 0; padding-left: var(--space-5); color: #374151; }
.demo-status { display: block; margin-top: var(--space-3); color: var(--accent); font-weight: 550; }
.linkbtn { display: inline-block; margin-top: var(--space-4); background: none; border: 0; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
```

- [ ] **Step 4: typecheck + build**

  Run: `npx tsc --noEmit && npm run build`
  Expected: typecheck clean; `dist-ext` builds without error.

- [ ] **Step 5: commit**

```bash
git add src/ui/onboarding/
git commit -m "feat(onboarding): declarative scroll driver + live Try-it card (keep static page)"
```

---

## Task 6: e2e - repoint the existing onboarding test + add the seed->search ride

The static "What results look like" mock is gone (now the live card), so the two asserts that read it (`How photosynthesis works` link, `wikipedia.org`) move into a new interactive spec that drives the real seed->search. The still-static asserts (brand, chip, side panel) stay byte-identical.

**Files:** Modify `tests/e2e/onboarding.spec.ts`; create `tests/e2e/onboarding-interactive.spec.ts`.

- [ ] **Step 1: repoint `tests/e2e/onboarding.spec.ts`**

  Keep the launch/extension-id boilerplate. In the assert block, KEEP the brand, the chip, and the side-panel asserts; DROP the `How photosynthesis works` link and `wikipedia.org` asserts; ADD that the live card's seed button is present. Update the header Scenario/Coverage comment to say the static content + the seed entry point render (the seed->search itself is the interactive spec).

```ts
  // Brand (exact - the PinIllustration splits "Recall" so this stays unambiguous).
  await expect(page.getByText('Recall', { exact: true })).toBeVisible({ timeout: 10_000 })
  // One example "search by meaning" chip (still a static explainer span).
  await expect(page.getByText('that article about sleep and cortisol')).toBeVisible()
  // The live try-it card's entry point.
  await expect(page.getByRole('button', { name: 'Add 3 sample pages' })).toBeVisible()
  // Side panel instruction.
  await expect(page.getByText('side panel', { exact: false })).toBeVisible()
```

  Run: `npx playwright test tests/e2e/onboarding.spec.ts`
  Expected: PASS.

- [ ] **Step 2: create `tests/e2e/onboarding-interactive.spec.ts` (the seed->search ride)**

```ts
// Scenario: a brand-new user rides the real flow once - the onboarding try-it card seeds
// bundled sample pages through the REAL capture pipeline, then searches them with the REAL
// on-device model and sees a real result card. This is the interactive card's whole promise.
// Coverage: integration (built extension in Chrome; real capture-text -> capture-service ->
// embed -> sqlite -> recall, rendered by the real try-it card). Full real path.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

test('onboarding try-it card seeds samples then searches them with the real engine', async () => {
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

  // The scroll page is shown; the try-it card's seed button is present. Seed the samples.
  await expect(page.getByRole('button', { name: 'Add 3 sample pages' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Add 3 sample pages' }).click()
  // "Sample pages added" appears only after the drain broadcasts pending===0 (model download
  // happens here on first run, so allow the long budget).
  await expect(page.getByText('Sample pages added')).toBeVisible({ timeout: 240_000 })

  // The searchbox is now revealed. Run a meaning query and expect the cortisol sample.
  await page.getByRole('searchbox').fill('the hormone that ruins sleep')
  await page.getByRole('searchbox').press('Enter')

  // A REAL result card must appear, and the cortisol sample must be the match (this is the
  // assertion that used to read the static mock).
  const cards = page.locator('article')
  await expect(cards.first()).toContainText('cortisol', { timeout: 30_000 })

  // Remove the demo data in one click and confirm it clears.
  await page.getByRole('button', { name: 'Remove demo data' }).click()
  await expect(page.getByText('Demo data removed')).toBeVisible({ timeout: 10_000 })

  await ctx.close()
})
```

  > Note on the search assertion text: the cortisol sample uses "cortisol" lower-case mid-sentence, so `toContainText('cortisol')` (case-sensitive substring) matches the chunk body. If chunking ever changes, assert on `'melatonin'` or the page title `'Sleep, cortisol, and the body clock'` instead.

  Run: `npx playwright test tests/e2e/onboarding-interactive.spec.ts`
  Expected: PASS (may be slow on first run - model download).

- [ ] **Step 3: commit**

```bash
git add tests/e2e/onboarding.spec.ts tests/e2e/onboarding-interactive.spec.ts
git commit -m "test(onboarding): repoint static spec + add seed->search interactive ride"
```

---

## Task 7: Full verification + final commit

- [ ] **Step 1: full unit suite**

  Run: `npm run test`
  Expected: all green (the prior 142 + the new samples/sections/strings/capture-service tests).

- [ ] **Step 2: full e2e suite**

  Run: `npx playwright test`
  Expected: green, including the repointed `onboarding.spec.ts` and the new `onboarding-interactive.spec.ts`. (The existing `recall-flow` / `forget-history` tests are unaffected - they do not touch onboarding.)

- [ ] **Step 3: typecheck + build sanity**

  Run: `npx tsc --noEmit && npm run build`
  Expected: clean.

- [ ] **Step 4: final commit (safety net if any cleanup remains)**

```bash
git add -A
git commit -m "chore(onboarding): finalize interactive onboarding card" || echo "nothing to finalize"
```

---

## Self-Review

**1. Spec coverage** (each requirement -> task):
- KEEP the scroll page, no wizard, no next/back/progress -> Decision 1 + Task 5 (`Onboarding` maps SECTIONS in one column; no nav module exists).
- Declarative `SECTIONS` array + `kind`-keyed renderer map; add/remove/reorder = one line -> Decision 2 + Task 2 (`sections.ts`) + Task 5 (`SECTION_RENDERERS`) + the "How the declarative section system delivers..." section.
- Migrate the five existing sections verbatim (hero, how-it-works, search-by-meaning, open-recall with pin + shortcuts) -> Task 5 static renderers (byte-identical JSX). PinIllustration reused -> OpenRecallSection.
- Upgrade ONLY "What results look like" -> live `try-it` card: seed via real `capture-text`, reveal inline search box, real `<article>` results, "Remove demo data" on the card -> Decision 3 + Task 5 (`TryItCard`).
- `capture-text` message + SW relay + offscreen op, core stays pure, gate skipped for seeds -> Task 3.
- Bundled samples (photosynthesis, sleep/cortisol, HTTP caching) on `recall-demo.example`, removable by host -> Task 1 + Decisions 4/5.
- Keep the install trigger; re-runnable -> Decision 6 (unchanged `onInstalled`, `main.tsx` untouched).
- Strings via `strings.ts` -> Task 4.
- e2e: kept strings stay byte-identical; static-mock asserts move to the interactive flow; new interactive spec for seed->search -> Task 6 (`onboarding.spec.ts` repointed, `onboarding-interactive.spec.ts` added).
- TDD where pure (samples validation, sections invariants, capture-service contract) -> Tasks 1, 2, 3. e2e full ride -> Task 6.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Sample prose is written out in Task 1; the migrated static JSX in Task 5 is the existing copy verbatim; all asserted strings are byte-identical to Task 4's `EN` or to the kept static copy.

**3. Type consistency:** `OnboardingSection` union (Task 2) is referenced by `Extract<..., {kind:'try-it'}>` in `TryItCard` (Task 5); kinds match (`hero`, `how-it-works`, `search-by-meaning`, `try-it`, `open-recall`). `SECTION_RENDERERS` keys === `OnboardingSection['kind']` === `SECTION_KINDS`. `capture-text` Msg shape (Task 3) matches the send in `TryItCard`. `MsgResult` `captured` reused, not redefined. New string keys (Task 4) match `TryItCard` usage and the `strings.test.ts` key list. The `recall` round-trip + `<article class="card">` markup match `SearchTab` (verified: `r.page.title` / `r.chunk.text` / `hostOf(r.page.url)`).

**4. The one deliberate `any`:** `SECTION_RENDERERS` value type uses `props: { section: any }` to sidestep the union-narrowing-across-a-map TS limitation. Static renderers ignore the prop; `TryItCard` narrows via `Extract`. Keep the `any` local to the map.

---

## Tradeoffs

- **Why scroll, not wizard.** The owner visually confirmed the existing scroll page is the desired product. A wizard would gate "seed before search" at the page level, but it would discard polished, approved UI for clicking. We keep the scroll and let the one live card gate itself internally (the search box only appears after seeding). Cost: the page does not force the user through the demo - they can scroll past it. Accepted: the demo is an offer, not a toll gate.
- **Declarative refactor vs leave-it-hardcoded.** Mapping `SECTIONS` through a renderer map adds ~20 lines of scaffolding over one hardcoded function. Upside: add/remove/reorder is a one-line data edit (the owner's flexibility requirement), and the live card is just another `kind`. The rendered output is unchanged, and the static prose stays inline + byte-identical so the kept e2e strings still match. Low risk for real flexibility.
- **Demo-data pollution + cleanup.** The card writes 3 real rows tagged `recall-demo.example`. Upside: the search is authentic (real engine, real results). Downside: if the user never clicks "Remove demo data", those rows linger and could appear in a later real search. Mitigations: (a) one-click removal right on the card after seeding, (b) the rows are clearly demo-hosted, (c) History/forget-site already let a user remove them later. Chosen over an ephemeral store because a second store/embedder path is heavy and would not exercise the real engine - the whole point of the ride.
- **`capture-text` reuses `capture-service` (core stays pure).** The slice is messaging glue + one offscreen op calling the unchanged `CaptureService.capture()`. It deliberately SKIPS the capture gate (a seeded demo is always stored). Risk: a future gate concern (e.g. global pause) won't apply to seeds - acceptable, because seeds are explicit user-initiated demo content, not auto-capture. The pure contract is pinned by the Task 3 capture-service test; the glue is covered by the Task 6 e2e.
- **Embedding latency shown honestly during seeding.** On first run the e5-small model (~23 MB) downloads when seeding starts, so "adding sample pages..." can sit for a while before "Sample pages added". We show that state plainly rather than faking instant success; the e2e budgets up to 240s for it. Honest > fast-but-fake, and it only happens once (the model caches).
- **Keeping the onboarding e2e meaningful.** Replacing the static mock changes what `onboarding.spec.ts` saw, so its two mock asserts (`How photosynthesis works`, `wikipedia.org`) are re-homed - stronger - in the interactive ride (seed -> real `<article>` result), while brand/chip/side-panel stay byte-identical static asserts. Net: same coverage intent, now against the real flow.
- **DRY tension on the result card.** `TryItCard` replicates `SearchTab`'s ~6-line `<article class="card">` markup rather than importing a shared component. Extracting a shared `ResultCard` would be DRY-er but means refactoring `SearchTab` (risk to a tested surface) for a tiny gain. The markup is kept byte-identical and noted; a shared component is a clean future refactor if a third caller appears.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-interactive-onboarding.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
</content>
</invoke>
