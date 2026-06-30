# Internal / private-network capture skip (hostname-only, CHEAP)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Every code change is TDD: failing test FIRST, watched fail, then implementation. Steps use checkbox (`- [ ]`).

**Goal:** Skip capturing pages that live on an INTERNAL / private network (a company intranet, a home network, a dev box), detected CHEAPLY from the URL hostname ALONE. No `webRequest`, no IP resolution, no DNS lookup, no new permissions. Pure string analysis of `location.hostname`. A new pure predicate `isInternalHost(hostname)` answers "is this host on a private network?", and `CaptureGate.decide` consults it as a new gate with reason `'internal'`, mirroring exactly how `isSerp` is wired.

**HARD constraint (owner):** CHEAP only. The expensive version - resolving the host to an IP via `webRequest` and checking the IP against RFC1918 ranges - is explicitly OUT of scope. We accept the known blind spot (an internal site on a public-looking domain that resolves to a private IP via split-horizon DNS) in exchange for zero new permissions and zero network cost. See Tradeoffs.

**Tech Stack:** TypeScript, Vite+CRXJS, Preact, Vitest, Playwright. Hexagonal: `src/core/*` stays pure (no `chrome`, no DOM); browser glue lives in `src/content/*` and `src/offscreen/*`.

**Current baseline (verify before starting):** `npx vitest run` green. `rg "chrome|document\.|window\." src/core` = empty (core is pure). Confirm both before touching anything.

---

## Design decisions (baked in)

- **New pure module `src/core/internal-host.ts`.** Exports `isInternalHost(hostname: string): boolean`. Pure string analysis - no `URL` parse needed (the gate already parses the URL and has the hostname via `hostOf`). It mirrors `isSerp`: a single pure predicate, kept SEPARATE from the privacy denylist (different intent: "private network" vs "never store") and from `isSerp` ("low value").

- **Detection set (precise, to avoid false positives on real public domains):**
  - **Private IPv4 literals:** `10.x` (10.0.0.0/8), `172.16-31.x` (172.16.0.0/12 - ONLY 16..31; `172.15.x` and `172.32.x`+ are PUBLIC), `192.168.x` (192.168.0.0/16), `127.x` (loopback), `169.254.x` (link-local).
  - **Private/loopback IPv6:** `::1` (loopback), `fc00::/7` ULA (first hextet 0xfc00..0xfdff, i.e. `fc..`/`fd..`), `fe80::/10` link-local (first hextet 0xfe80..0xfebf). Handle the bracketed `[::1]` form that `new URL(...).hostname` returns for IPv6.
  - **Conventional internal suffixes:** `localhost` (exact), and hostnames ENDING in `.local` (mDNS), `.internal`, `.corp`, `.lan`, `.intranet`, `.home`, `.localdomain`. SUFFIX-only - `mylocal.com` is PUBLIC; only the `.local` suffix is internal.
  - **Reserved / non-routable TLDs (RFC 2606 / 6761):** `.test`, `.localhost`, `.invalid`, `.example`.
  - **Single-label hostnames** (no dot AND no colon, e.g. `wiki`, `jira`, `confluence`): public DNS names always have a dot, so a bare single label is an intranet host. IPv4 literals have dots and IPv6 literals have colons, so both are already handled by the IP branches before this rule fires - the single-label rule only catches plain words.

- **Gate wiring: new reason `'internal'`, mirror `isSerp`.** Add `'internal'` to `GateDecision.reason`. The PLACEMENT depends on the manual-vs-hard decision below.

- **DECISION (state recommendation, owner confirms at review): auto-only with manual override, OR hard skip even for manual?**
  - **Option A - auto-only + manual override (RECOMMENDED).** Place the check INSIDE the existing `if (!input.manual) { ... }` soft-gate block, next to `isSerp`. Auto-capture skips internal pages silently; a user who EXPLICITLY clicks "Capture this page" on an internal doc still saves it.
  - **Option B - hard skip (even manual).** Place the check ALONGSIDE the denylist hard gate, BEFORE the `!input.manual` block. Even a manual save of an internal page is refused - matches the owner's stricter "수집 불가능" (cannot collect) wording.
  - **Recommendation: Option A.** Three reasons. (1) **Consistency:** the module we are mirroring (`isSerp`) is auto-only; the gate already has a clean "hard = privacy denylist, soft = auto-only quality" split, and "internal network" is a quality/relevance signal, not a privacy secret. (2) **Recoverable false-positives:** an internal-but-wanted doc (the user's own localhost docs server, a company wiki they genuinely want recalled) is still one click away; under Option B it is permanently unsavable. (3) **Low blast radius:** an auto-skip is silent and reversible; a hard refusal needs a UI string and surprises the user. The owner's wording leans Option B, so this is the ONE decision to confirm at review - the detection is precise either way, so false-positive risk is low. **The plan below implements Option A; Task 1 Step 4 shows the exact 2-line diff to switch to Option B.**

- **Status string: only needed for Option B.** Under Option A, auto-skips are SILENT (the same way SERP/thin auto-skips are silent - the content script's auto path shows nothing), and a manual save SUCCEEDS, so no new string is required. Under Option B, a MANUAL attempt on an internal page returns reason `'internal'`, which `SidePanel.tsx` must map to a friendly line - an additive `notSavedInternal` string. Task 3 covers the Option-B string and is SKIPPED if Option A is chosen.

- **Overlap with `denylist.ts` (DECISION): leave the denylist as-is (harmless redundancy).** `DEFAULT_DENYLIST` line 11 already hard-blocks `localhost | 127.0.0.1 | [::1] | *.local`. The new `isInternalHost` re-covers those AND adds the broader set (private IPv4 ranges, IPv6 ULA/link-local, single-label, `.internal`/`.corp`/`.lan`/`.intranet`/`.home`/`.localdomain`/`.test`/`.invalid`/`.example`). **Recommendation: do NOT touch `denylist.ts`.** Reasons: (1) **No behavior regression** - the denylist hard-blocks localhost/loopback/.local even for manual; removing those entries while the new gate is auto-only (Option A) would silently DOWNGRADE them from hard-block to manual-savable, a behavior change the owner did not ask for. (2) **Minimal diff** - one new module + one gate line beats editing two modules. The four-host overlap is harmless: a localhost URL is caught by the denylist first (hard) and the new gate never sees it. If Option B is chosen at review, consolidation becomes attractive (both hard-block, so the denylist regex is pure dead weight) - in that case remove the `(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.local)` alternation from line 11 in a FOLLOW-UP, with the denylist test updated. Out of scope for the recommended path.

---

## File Map

| File | Action | Responsibility after change |
|------|--------|-----------------------------|
| `src/core/internal-host.ts` | Create | Pure `isInternalHost(hostname): boolean` - private IPv4/IPv6 literals, localhost, internal suffixes, reserved TLDs, single-label hosts. No DOM, no chrome, no URL parse. |
| `src/core/capture-gate.ts` | Modify | Add `'internal'` to `GateDecision.reason`; consult `isInternalHost(hostOf(input.url))` inside the `!input.manual` soft-gate block (Option A) before the thin check. |
| `tests/core/internal-host.test.ts` | Create | The full positive/negative case table (each private range, localhost, single-label, suffixes, reserved TLDs; PUBLIC negatives that look close). |
| `tests/core/capture-gate.test.ts` | Modify | Add: internal host blocked for auto (reason `'internal'`), allowed for manual (Option A); a public host still captured. |
| `src/ui/sidepanel/strings.ts` | Modify (Option B ONLY) | Additive `notSavedInternal` string. SKIPPED under Option A. |
| `src/ui/sidepanel/SidePanel.tsx` | Modify (Option B ONLY) | Map `reason === 'internal'` to `t.notSavedInternal`. SKIPPED under Option A. |
| `tests/e2e/internal-skip.spec.ts` | Create | Route `http://10.0.0.5/article` to the article fixture; assert AUTO-capture is skipped; (Option A) assert MANUAL capture still works. |

**NOT touched:** `src/core/denylist.ts` (see overlap decision - leave the redundant localhost/.local entry; consolidation is a follow-up if Option B is picked), `src/core/serp.ts`, `src/offscreen/offscreen.ts` (it already returns `{ captured: false, reason: decision.reason }` at line 118 - the new `'internal'` reason flows through unchanged), the search/index pipeline, the content script.

---

## Task 1: Pure `isInternalHost` + gate integration (reason `'internal'`)

A private-network host detected from the hostname string alone. Pure - no DNS, no IP resolution, no `webRequest`. Wires into the gate next to `isSerp`, inside the `!input.manual` block (Option A), so a deliberate manual save of an internal doc still works.

**Files:** Create `tests/core/internal-host.test.ts` (test first), `src/core/internal-host.ts`; Modify `tests/core/capture-gate.test.ts`, `src/core/capture-gate.ts`.

- [ ] **Step 1 (RED): `tests/core/internal-host.test.ts`**

To get a clean assertion-RED (not a missing-module error), first stub `src/core/internal-host.ts` as `export function isInternalHost(_hostname: string): boolean { return false }`, then write the test and watch the positive cases fail.

```typescript
import { isInternalHost } from '../../src/core/internal-host'

// Scenario: a page served from a private/intranet host is not public web content; every
// private-network form must be recognized so auto-capture skips it.
// Coverage: integration (pure hostname check over real private-host forms).
test('recognizes internal / private-network hosts', () => {
  const internal = [
    // Private IPv4 ranges.
    '10.0.0.5', '10.255.255.255',
    '172.16.0.1', '172.31.255.1',
    '192.168.1.1',
    '127.0.0.1',           // loopback
    '169.254.1.1',         // link-local
    // IPv6 loopback / ULA / link-local (and the bracketed URL form).
    '::1', '[::1]',
    'fc00::1', 'fd12:3456:789a::1',
    'fe80::1',
    // localhost + conventional intranet suffixes.
    'localhost',
    'wiki.local', 'printer.internal', 'jira.corp',
    'nas.lan', 'docs.intranet', 'router.home', 'box.localdomain',
    // Reserved / non-routable TLDs.
    'app.test', 'site.localhost', 'thing.invalid', 'demo.example',
    // Single-label hosts (no dot at all) - intranet shortcuts.
    'wiki', 'jira', 'confluence',
  ]
  for (const h of internal) expect(isInternalHost(h)).toBe(true)
})

// Scenario: a real PUBLIC domain that merely LOOKS close to a private form must NOT be
// flagged, or we would wrongly skip real articles.
// Coverage: integration (pure hostname check, false-positive guard).
test('does not flag public hosts that look close', () => {
  const publicHosts = [
    'en.wikipedia.org', 'github.com', 'example.org',
    '8.8.8.8', '1.1.1.1',          // public DNS resolvers
    '11.0.0.1',                    // 11.x is public (only 10.x is private)
    '172.15.0.1', '172.32.0.1', '172.200.0.1', // only 172.16-31 is private
    '192.169.1.1',                 // 192.168 only
    'mylocal.com',                 // only the .local SUFFIX is internal
    'corp.example.com',            // .corp must be a SUFFIX, not a label
    '2001:db8::1',                 // public IPv6 doc range, not ULA/link-local
  ]
  for (const h of publicHosts) expect(isInternalHost(h)).toBe(false)
})

// Scenario: an empty hostname (e.g. file:// pages have host='') must not throw and must
// not be treated as internal - the gate runs on every page.
// Coverage: integration (pure hostname check, empty path).
test('empty hostname is not internal', () => {
  expect(isInternalHost('')).toBe(false)
})
```

Run `npx vitest run tests/core/internal-host.test.ts` -> the two positive/negative blocks MUST fail against the stub.

- [ ] **Step 2 (GREEN): `src/core/internal-host.ts`**

Pure string analysis. The test table is the spec; the structure below is the intended shape, not a frozen string - tune predicates so every positive matches and every negative does not.

```typescript
// Detects whether a hostname belongs to an INTERNAL / private network, from the hostname
// STRING ALONE - no DNS, no IP resolution, no webRequest, no new permissions. This is the
// CHEAP locality check. Internal hosts are intranet / home / dev-network pages, not public
// web content, so auto-capture should skip them.
//
// Detection is deliberately PRECISE to avoid false positives on real public domains:
//   - 172.200.x is PUBLIC; only 172.16-31 is private (172.16.0.0/12).
//   - mylocal.com is PUBLIC; only the `.local` SUFFIX is internal.
//   - example.com has a dot, so it is NOT a single-label intranet host.
//
// Kept SEPARATE from the privacy denylist ("never store") and isSerp ("low value");
// mirrors isSerp's shape: one pure predicate.

// Conventional intranet suffixes (mDNS / split-horizon naming) + reserved non-routable
// TLDs (RFC 2606 / 6761). SUFFIX match only.
const INTERNAL_SUFFIXES = [
  '.local', '.internal', '.corp', '.lan', '.intranet', '.home', '.localdomain',
  '.test', '.localhost', '.invalid', '.example',
]

export function isInternalHost(hostname: string): boolean {
  if (!hostname) return false
  let host = hostname.toLowerCase()
  // URL hostnames keep IPv6 in brackets ([::1]); strip them to inspect the address.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  if (host === 'localhost') return true
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return true
  if (isPrivateIpv4(host)) return true
  if (isPrivateIpv6(host)) return true
  // Single-label hostnames (no dot, no colon) are intranet shortcuts - public DNS needs a
  // dot. IPv4 literals have dots and IPv6 literals have colons, handled above.
  if (!host.includes('.') && !host.includes(':')) return true
  return false
}

// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 (loopback), 169.254.0.0/16
// (link-local). A public IP (8.8.8.8, 172.200.x) simply matches no branch.
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1]); const b = Number(m[2])
  if (a === 10) return true
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

// ::1 (loopback), fc00::/7 ULA (first hextet 0xfc00..0xfdff), fe80::/10 link-local
// (0xfe80..0xfebf). Public IPv6 (2001:db8::1) matches no branch.
function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  if (host === '::1') return true
  const first = host.split(':')[0]
  if (first === '') return false // "::<other>" - not a private prefix
  const n = parseInt(first, 16)
  if (Number.isNaN(n)) return false
  if (n >= 0xfc00 && n <= 0xfdff) return true // ULA
  if (n >= 0xfe80 && n <= 0xfebf) return true // link-local
  return false
}
```

- [ ] **Step 3 (RED): gate tests for the internal gate (`tests/core/capture-gate.test.ts`)**

Add to the existing file (it already builds `gate` with `minWords: 5` and an `open` settings object; every `decide` call passes `settings` - keep that). These three tests assume Option A (auto-only + manual override). If Option B is chosen at review, change the "manual" assertion to expect `capture === false` and `reason === 'internal'`.

```typescript
// Scenario: a page on a private network (here a 10.x intranet host) is not public web
// content; auto-capture must skip it with reason 'internal'.
// Coverage: integration (real CaptureGate + isInternalHost, soft-gate path).
test('auto: internal host rejected with reason internal', () => {
  const d = gate.decide({ url: 'http://10.0.0.5/wiki/onboarding', text: long, manual: false }, open)
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('internal')
})

// Scenario: if the user EXPLICITLY clicks save on an internal doc, honor the intent - the
// internal gate is auto-only, skipped for manual, like the SERP and thin gates (Option A).
// Coverage: integration (real CaptureGate, manual path).
test('manual: internal host IS captured (soft gate skipped)', () => {
  const d = gate.decide({ url: 'http://10.0.0.5/wiki/onboarding', text: long, manual: true }, open)
  expect(d.capture).toBe(true)
})

// Scenario: a normal public page must still pass - the internal gate must not over-block.
// Coverage: integration (real CaptureGate).
test('auto: public host still captured', () => {
  const d = gate.decide({ url: 'https://en.wikipedia.org/wiki/Cortisol', text: long, manual: false }, open)
  expect(d.capture).toBe(true)
})
```

Run `npx vitest run tests/core/capture-gate.test.ts` -> the two internal-block assertions MUST fail (today the 10.x url passes as a normal page).

- [ ] **Step 4 (GREEN): wire into `CaptureGate.decide` (`src/core/capture-gate.ts`)**

Add the reason to the type and the check to the soft-gate block. Import at top: `import { isInternalHost } from './internal-host'`.

```typescript
export interface GateDecision { capture: boolean; reason?: 'paused' | 'denylisted' | 'thin' | 'serp' | 'internal' }
```

**Option A (RECOMMENDED) - inside the existing `if (!input.manual) { ... }` block, next to the SERP check:**
```typescript
    if (!input.manual) {
      if (isSerp(input.url)) return { capture: false, reason: 'serp' }
      // Internal / private-network hosts are not public content worth recalling.
      if (isInternalHost(hostOf(input.url))) return { capture: false, reason: 'internal' }
      const words = input.text.trim().split(/\s+/).filter(Boolean).length
      if (words < this.minWords) return { capture: false, reason: 'thin' }
    }
```

**Option B (hard skip, if owner picks it at review) - BEFORE the `!input.manual` block, next to the denylist hard gate:**
```typescript
    if (isDenylisted(input.url, this.denylist)) return { capture: false, reason: 'denylisted' }
    if (hostDenied(hostOf(input.url), settings.userDenyHosts)) return { capture: false, reason: 'denylisted' }
    // Internal / private-network hosts: cannot be collected, even for a manual save.
    if (isInternalHost(hostOf(input.url))) return { capture: false, reason: 'internal' }
```
(`hostOf` already exists in `capture-gate.ts`. The `offscreen.ts` relay at line 118 passes `decision.reason` through unchanged - no edit needed there for either option.)

- [ ] **Step 5: verify Task 1**

`npx vitest run tests/core/internal-host.test.ts tests/core/capture-gate.test.ts` -> all green. `rg "chrome|document\.|window\." src/core/internal-host.ts` -> empty (pure).

---

## Task 2: Light e2e - internal host auto-skip (and manual-still-works under Option A)

An end-to-end that proves the gate in the REAL built extension: a private-IP host page is NOT auto-captured. Routing works because Playwright intercepts the request at the CDP level BEFORE DNS, so `10.0.0.5` does not need to resolve - exactly like the existing `deny-test.example` routed-host test in `user-controls.spec.ts`. The content script matches `<all_urls>`, so it injects on the routed host and `location.hostname` reads as `10.0.0.5`, which `isInternalHost` flags.

**Files:** Create `tests/e2e/internal-skip.spec.ts`. Reuse `fixtures/article.html`.

- [ ] **Step 1: write the spec (mirror `user-controls.spec.ts` routed-host setup)**

```typescript
// Scenario: a page served from a private-IP host (10.0.0.5) must NOT be auto-captured -
// it is an internal/intranet page, not public content. Under Option A an EXPLICIT manual
// save of it still works.
// Coverage: integration (built extension, real content-script -> offscreen -> gate path).
test('internal host is skipped by auto-capture but savable manually', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const internalUrl = 'http://10.0.0.5/article'

  const articlePage = await ctx.newPage()
  await articlePage.route(internalUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: articleHtml }),
  )
  await articlePage.goto(internalUrl)

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)

  // AUTO leg (negative): wait PAST the 10s dwell window, then recall -> nothing, because
  // the gate rejected the internal host with reason 'internal'.
  await articlePage.bringToFront()
  await popup.waitForTimeout(13_000)
  await popup.getByRole('searchbox').fill('hormone that ruins sleep')
  await popup.getByRole('searchbox').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // MANUAL leg (Option A): an explicit save of the same internal page DOES work.
  // (If Option B is chosen at review, replace this leg with an assertion that the
  // "not saved" internal line appears and recall still finds nothing.)
  await articlePage.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText(/captured|indexing/i)).toBeVisible({ timeout: 30_000 })
  await articlePage.goto('about:blank')
  await expect(async () => {
    await popup.getByRole('searchbox').fill('hormone that ruins sleep')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })

  await ctx.close()
})
```
Imports at top of the file mirror `user-controls.spec.ts`: `test, expect, chromium` from `@playwright/test`; `fs`, `path`, `fileURLToPath`; `dir`/`distPath` derived the same way.

- [ ] **Step 2: verify Task 2**

`npx playwright test tests/e2e/internal-skip.spec.ts` -> green. The auto leg proves absence (a NEGATIVE assertion, kept robust by the deterministic routed fixture); the manual leg proves Option A's override.

---

## Task 3 (Option B ONLY - SKIP under Option A): surface a status string for a manual internal attempt

Only needed if the owner picks Option B (hard skip) at review. A manual save of an internal page returns reason `'internal'`; the panel must show a friendly line instead of the generic "nothing substantial".

**Files:** Modify `src/ui/sidepanel/strings.ts`, `src/ui/sidepanel/SidePanel.tsx`. (No new automated test - this is a 1-line additive string + 1-line reason mapping, the same shape as the existing `notSavedDenylisted` mapping at `SidePanel.tsx:85`; it is covered behaviorally by the Option-B variant of the Task 2 e2e manual leg.)

- [ ] **Step 1 (Option B): add the additive string**

In `strings.ts`, add to the `UIStrings` interface (near `notSavedDenylisted`) and the `EN` object:
```typescript
  notSavedInternal: string
```
```typescript
  notSavedInternal: 'not saved: this page is on a private/internal network',
```
ASCII only.

- [ ] **Step 2 (Option B): map the reason in `SidePanel.tsx`**

Next to the existing `denylisted` branch (line 85):
```typescript
        else if (!res.captured && res.reason === 'internal') setStatus(t.notSavedInternal)
```

- [ ] **Step 3 (Option B): verify**

`npx tsc --noEmit` -> clean. The Task 2 e2e (Option-B manual leg) asserts the line appears.

---

## Self-Review Checklist

- [ ] `isInternalHost` is pure (no chrome/DOM/URL-parse), matches every form in the spec (10.x / 172.16-31.x / 192.168.x / 127.x / 169.254.x; `::1` / `[::1]` / `fc..` / `fd..` / `fe80..`; localhost; `.local`/`.internal`/`.corp`/`.lan`/`.intranet`/`.home`/`.localdomain`; `.test`/`.localhost`/`.invalid`/`.example`; single-label), and rejects the close-but-PUBLIC negatives (`172.200.x`, `172.15.x`, `172.32.x`, `11.x`, `192.169.x`, `8.8.8.8`, `mylocal.com`, `2001:db8::1`, `en.wikipedia.org`).
- [ ] Internal gate wired with reason `'internal'`; under Option A it sits INSIDE the `!input.manual` block (blocked for `manual:false`, allowed for `manual:true`); under Option B it sits with the denylist hard gate (blocked for both). `offscreen.ts` relays `'internal'` unchanged (no edit there).
- [ ] The manual-vs-hard DECISION is called out (recommend Option A) and the 2-line Option-B switch is shown - owner confirms at review.
- [ ] `denylist.ts` is NOT edited (overlap left as harmless redundancy; consolidation is a noted follow-up only if Option B is picked).
- [ ] Each test step carries the Scenario:/Coverage: 2 lines; the e2e auto leg's negative assertion is justified by the deterministic routed fixture (no flaky real DNS - routing intercepts before resolution).
- [ ] All test code is ASCII-only - hostnames/URLs only, no Hangul, no em-dash/smart quotes.
- [ ] Watched the RED: `internal-host.test.ts` positives fail on the stub; the two gate internal asserts fail before the gate edit.
- [ ] `rg "chrome" src/core` stays empty; existing `capture-gate` tests still pass (every `decide` call passes the `settings` arg).
- [ ] Option-A path adds ZERO new strings and ZERO `SidePanel.tsx` edits (auto-skip is silent, manual succeeds); the string/Task 3 is gated on Option B.

---

## Tradeoffs / Known Constraints (honest)

- **CDN / reverse-proxy / split-horizon DNS false-NEGATIVES (the accepted blind spot).** This cheap version reads the hostname STRING only. An internal site reached via a public-looking name - `wiki.mycompany.com` that split-horizon DNS resolves to a `10.x` private IP, or an intranet app behind a corporate proxy on a normal domain - looks public to us, so we will NOT skip it. ONLY the expensive `webRequest`-IP version (resolve the host, check the resolved IP against RFC1918) catches those, and that needs the `webRequest` permission and per-request IP inspection. The owner explicitly chose cheap-only; we accept this gap. The user's "Don't remember this site" per-host control remains the manual escape hatch for such a domain.
- **Single-label false-POSITIVE risk is near zero but nonzero.** A bare single-label host (`wiki`) is treated as internal. On the public web a single-label URL is essentially never browsed (no dot = no public DNS name); the only realistic source is an intranet shortcut, which is exactly what we want to skip. If a captive portal or an odd appliance ever served a single-label public page, Option A's manual override still saves it.
- **The manual-vs-hard decision is a values call, deferred to the owner.** Option A (recommended) trades strictness for recoverability and consistency with `isSerp`; Option B matches the literal "cannot collect" wording but makes a mis-flagged internal-but-wanted doc permanently unsavable. Detection precision is the same for both, so the risk delta is small - but the decision changes the gate placement, whether a UI string is needed, and whether denylist consolidation becomes worthwhile.
- **IPv4 octet validation is loose.** `isPrivateIpv4` does not reject octets >255 (e.g. `999.0.0.1`); such a string is malformed and simply matches no private branch (returns false / public), and real `location.hostname` never produces it. Tightening is unnecessary cost.
- **No IPv6 zone-ID handling.** `fe80::1%eth0` (a zone-ID suffix) is an edge case that does not appear in browser `location.hostname`; not handled, acceptable.

---

**Commit (doc only):**
```
docs(plan): cheap intranet/private-network capture skip (hostname-only, no new permissions)
```
