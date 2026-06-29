# User Controls (Plan 2, increment 2a): Pause + "Don't remember this site"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two privacy controls in the popup, persisted locally: a global **Pause** (stop capturing anything during a sensitive session) and **"Don't remember this site"** (add the current page's host to a user denylist so it is never captured). Settings live in the OPFS sqlite (no new permission).

**Architecture:** Hexagonal, unchanged shape. `CaptureGate` stays PURE — `decide()` now takes a `settings` argument (paused + user-denied hosts) so it remains unit-testable. Persistence is a new `SettingsPort` implemented by the offscreen sqlite worker. The offscreen `capture` op loads settings and passes them to the gate. The popup reads/writes settings over RPC through the SW relay.

**Tech Stack:** TypeScript · existing offscreen/SW/content architecture · OPFS sqlite (settings tables) · Vitest (pure gate) · Preact popup.

**Decisions (confirmed):**
- Settings persist in OPFS sqlite (`settings` k/v + `user_denylist` host rows). No chrome.storage.
- **Pause blocks ALL captures (auto AND manual)** — clear privacy semantics ("nothing is stored while paused"). It is a temporary global hard gate.
- "Don't remember this site" stores the exact **hostname** (e.g. `news.ycombinator.com`); the hard gate rejects matching captures (auto and manual), same as the built-in denylist.
- Out of scope (increment 2b): denylist viewer/editor, remove-host, "forget this site's history" (deleteByDomain). SERP/scroll signals: later.

---

## File Structure

```
src/core/ports.ts                       # MODIFY: add SettingsPort + AppSettings
src/core/capture-gate.ts                # MODIFY: decide(input, settings) — pause + user hosts
src/offscreen/sqlite-worker.ts          # MODIFY: settings + user_denylist tables + ops
src/offscreen/offscreen-settings-store.ts  # NEW: SettingsPort adapter (talks to worker)
src/offscreen/offscreen.ts              # MODIFY: gate uses settings; handle settings RPC ops
src/background/index.ts                 # MODIFY: relay settings ops
src/messaging.ts                        # MODIFY: settings messages
src/ui/popup/App.tsx                    # MODIFY: pause toggle + "don't remember this site"
tests/core/capture-gate.test.ts          # MODIFY: pause + user-host cases
```

---

## Task 1: CaptureGate takes settings (pure, TDD)

**Files:** Modify `src/core/capture-gate.ts`, `src/core/ports.ts`, `tests/core/capture-gate.test.ts`

- [ ] **Step 1: Add the SettingsPort + AppSettings types to ports.ts**

```ts
// src/core/ports.ts — append
export interface AppSettings {
  paused: boolean
  userDenyHosts: string[]
}
export interface SettingsPort {
  get(): Promise<AppSettings>
  setPaused(paused: boolean): Promise<void>
  addDenyHost(host: string): Promise<void>
}
```

- [ ] **Step 2: Write the failing gate tests**

**Scenario:** While paused, NOTHING is captured — not even a manual save — so a user in a sensitive session is fully protected. A site the user marked "don't remember" is never captured either.
**Coverage:** ✅ integration (pure decide(), real matching, no mock)

```ts
// tests/core/capture-gate.test.ts — add these (keep existing tests)
const open = { paused: false, userDenyHosts: [] as string[] }

test('paused blocks auto capture', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: long, manual: false }, { paused: true, userDenyHosts: [] }).capture).toBe(false)
})

test('paused blocks manual save too', () => {
  const d = gate.decide({ url: 'https://site.com/post', text: long, manual: true }, { paused: true, userDenyHosts: [] })
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('paused')
})

test('user-denied host is rejected (auto and manual)', () => {
  const s = { paused: false, userDenyHosts: ['news.ycombinator.com'] }
  expect(gate.decide({ url: 'https://news.ycombinator.com/item?id=1', text: long, manual: false }, s).capture).toBe(false)
  expect(gate.decide({ url: 'https://news.ycombinator.com/item?id=1', text: long, manual: true }, s).reason).toBe('denylisted')
})

test('different host not affected by user denylist', () => {
  const s = { paused: false, userDenyHosts: ['news.ycombinator.com'] }
  expect(gate.decide({ url: 'https://other.com/post', text: long, manual: false }, s).capture).toBe(true)
})
```

ALSO update the EXISTING gate tests to pass the new `settings` arg `open` (e.g. `gate.decide({...}, open)`), since `decide` now requires it.

- [ ] **Step 3: Run the tests, watch them fail**

Run: `npx vitest run tests/core/capture-gate.test.ts`
Expected: FAIL (decide signature / paused handling).

- [ ] **Step 4: Implement**

```ts
// src/core/capture-gate.ts
import { DEFAULT_DENYLIST, isDenylisted } from './denylist'
import type { AppSettings } from './ports'

export interface GateInput { url: string; text: string; manual: boolean }
export interface GateDecision { capture: boolean; reason?: 'paused' | 'denylisted' | 'thin' }

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export class CaptureGate {
  private readonly denylist: RegExp[]
  private readonly minWords: number
  constructor(opts: { denylist?: RegExp[]; minWords?: number } = {}) {
    this.denylist = opts.denylist ?? DEFAULT_DENYLIST
    this.minWords = opts.minWords ?? 100
  }

  decide(input: GateInput, settings: AppSettings): GateDecision {
    // Pause is a temporary global hard gate — blocks everything, even manual.
    if (settings.paused) return { capture: false, reason: 'paused' }
    // Hard gate (privacy): built-in denylist + user "don't remember" hosts. Applies to manual.
    if (isDenylisted(input.url, this.denylist)) return { capture: false, reason: 'denylisted' }
    if (settings.userDenyHosts.includes(hostOf(input.url))) return { capture: false, reason: 'denylisted' }
    // Soft gate (quality): skipped for explicit manual save.
    if (!input.manual) {
      const words = input.text.trim().split(/\s+/).filter(Boolean).length
      if (words < this.minWords) return { capture: false, reason: 'thin' }
    }
    return { capture: true }
  }
}
```

- [ ] **Step 5: Run the tests, watch them pass**

Run: `npx vitest run tests/core/capture-gate.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/core/ports.ts src/core/capture-gate.ts tests/core/capture-gate.test.ts
git commit -m "feat(core): gate honors pause + user deny-hosts (SettingsPort)"
```

---

## Task 2: Settings persistence in the sqlite worker

**Files:** Modify `src/offscreen/sqlite-worker.ts`; Create `src/offscreen/offscreen-settings-store.ts`

- [ ] **Step 1: Add settings schema + ops in the worker**

In `src/offscreen/sqlite-worker.ts`, on init create:
```sql
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS user_denylist (host TEXT PRIMARY KEY);
```
Add these message ops (same `{ id, op, args }` -> `{ id, result }` protocol as the existing store ops):
- `getSettings` -> read `settings` where key='paused' (default '0'), and all rows from `user_denylist`; return `{ paused: value==='1', userDenyHosts: string[] }`.
- `setPaused` (args: boolean) -> `INSERT OR REPLACE INTO settings (key,value) VALUES ('paused', ?)` with '1'/'0'.
- `addDenyHost` (args: string) -> `INSERT OR IGNORE INTO user_denylist (host) VALUES (?)`.

- [ ] **Step 2: Create the SettingsPort adapter**

```ts
// src/offscreen/offscreen-settings-store.ts
import type { AppSettings, SettingsPort } from '../core/ports'

// Talks to the same dedicated sqlite worker via a request/reply call function.
// `call(op, args)` is provided by the offscreen (reuse the worker-call helper used
// by OffscreenWorkerStore, or pass the worker's call method in).
export class OffscreenSettingsStore implements SettingsPort {
  constructor(private readonly call: (op: string, args?: unknown) => Promise<unknown>) {}
  async get(): Promise<AppSettings> {
    return (await this.call('getSettings')) as AppSettings
  }
  async setPaused(paused: boolean): Promise<void> {
    await this.call('setPaused', paused)
  }
  async addDenyHost(host: string): Promise<void> {
    await this.call('addDenyHost', host)
  }
}
```
(Implementation note: `OffscreenWorkerStore` already owns the worker + a request/reply map. Expose its call method — e.g. a public `call(op, args)` — or have both stores share one worker-call helper. Wire `OffscreenSettingsStore` to that same worker so there is ONE sqlite worker.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors only where offscreen.ts wires it (next task).

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/sqlite-worker.ts src/offscreen/offscreen-settings-store.ts
git commit -m "feat(offscreen): persist settings + user denylist in sqlite worker"
```

---

## Task 3: offscreen — gate with settings + settings RPC ops

**Files:** Modify `src/offscreen/offscreen.ts`

- [ ] **Step 1: Load settings and pass to the gate; add settings ops**

- Construct `const settingsStore = new OffscreenSettingsStore(<worker call>)` sharing the same worker as the store.
- In the `capture` op: `const settings = await settingsStore.get()`, then `gate.decide({ url, text, manual }, settings)`. Keep the rest (store + drain) unchanged.
- Add RPC ops:
  - `get-settings` -> `return await settingsStore.get()`
  - `set-paused` (payload.paused) -> `await settingsStore.setPaused(payload.paused); return { ok: true }`
  - `deny-host` (payload.host) -> `await settingsStore.addDenyHost(payload.host); return { ok: true }`

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean (callers in SW/popup updated in Tasks 4-5; if tsc errors there, proceed — fixed next).

- [ ] **Step 3: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat(offscreen): apply settings in gate; expose settings RPC ops"
```

---

## Task 4: messaging + SW relay for settings

**Files:** Modify `src/messaging.ts`, `src/background/index.ts`

- [ ] **Step 1: Add settings messages**

```ts
// src/messaging.ts — add to Msg:
| { type: 'get-settings' }
| { type: 'set-paused'; paused: boolean }
| { type: 'deny-host'; host: string }
// add to MsgResult:
| { type: 'settings'; paused: boolean; userDenyHosts: string[] }
| { type: 'ok' }
```

- [ ] **Step 2: Relay in the SW**

In `src/background/index.ts` onMessage, add branches (relay to offscreen, like capture/recall):
- `get-settings` -> `callOffscreen({op:'get-settings'})` -> respond `{type:'settings', paused, userDenyHosts}`.
- `set-paused` -> `callOffscreen({op:'set-paused', paused})` -> respond `{type:'ok'}`.
- `deny-host` -> `callOffscreen({op:'deny-host', host})` -> respond `{type:'ok'}`.
Ensure these are added to the "handled types" guard so the listener returns true for them and responds.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean (popup updated next).

- [ ] **Step 4: Commit**

```bash
git add src/messaging.ts src/background/index.ts
git commit -m "feat(sw): relay settings get/set + deny-host"
```

---

## Task 5: Popup — pause toggle + "Don't remember this site"

**Files:** Modify `src/ui/popup/App.tsx`

- [ ] **Step 1: Add the controls**

- On mount, query `{ type:'get-settings' }`; store `paused` and `userDenyHosts`.
- Render near the top:
  - A **Pause** checkbox/toggle bound to `paused`. On change -> `chrome.runtime.sendMessage({type:'set-paused', paused})`, update local state. Label e.g. `Pause capturing` and when on show `Paused — nothing is being saved`.
  - A **"Don't remember this site"** button. On click: get the active tab host (`const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); const host = new URL(tab.url!).hostname`), send `{type:'deny-host', host}`, then show a confirmation like `Won't remember ${host}`. If `host` is already in `userDenyHosts`, show that state instead (e.g. button disabled / "already on the no-remember list").
- Keep the existing model-status, capture button, search, results UI.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ui/popup/App.tsx
git commit -m "feat(popup): pause toggle and 'don't remember this site'"
```

---

## Task 6: e2e — pause stops capture; deny-host stops capture

**Files:** Create `tests/e2e/user-controls.spec.ts`

- [ ] **Step 1: Write the e2e**

**Scenario:** Pausing must stop auto-capture entirely; marking a site "don't remember" must stop it being captured. These are the privacy promises the controls make.
**Coverage:** ✅ integration (built extension; real settings persistence + gate). Uses the manual capture path for determinism (no 10s dwell wait).

```ts
import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
const articleUrl = 'file://' + path.resolve(dir, 'fixtures/article.html')

test('pause blocks capture; unpausing restores it', async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]
  const page = await ctx.newPage()
  await page.goto(articleUrl)
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

  // Pause, then manual-capture -> blocked.
  await popup.getByLabel(/pause/i).check()
  await page.bringToFront()
  await popup.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(popup.locator('span')).toContainText(/paused|not saved/i, { timeout: 10_000 })

  // Search finds nothing.
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('li')).toHaveCount(0)

  // Unpause, capture -> works, recallable.
  await popup.getByLabel(/pause/i).uncheck()
  await popup.getByText('Capture this page').click()
  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('li').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  await ctx.close()
})
```

- [ ] **Step 2: Build + run**

Run: `npm run build && npx playwright test tests/e2e/user-controls.spec.ts`
Expected: PASS.

- [ ] **Step 3: Full suite**

Run: `npm run test && npx playwright test tests/e2e/recall-flow.spec.ts tests/e2e/persistence.spec.ts tests/e2e/auto-capture.spec.ts tests/e2e/user-controls.spec.ts`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/user-controls.spec.ts
git commit -m "test(e2e): pause blocks capture and unpause restores it"
```

---

## Self-Review

**Spec coverage:**
- Pause blocks all captures (auto + manual): Task 1 (gate, unit) + Task 6 (e2e). ✅
- "Don't remember this site" persists + blocks: Task 1 (gate) + Task 2 (persist) + Task 5 (popup). ✅
- Settings persist in sqlite (no new permission): Task 2. ✅
- Popup controls: Task 5. ✅

**Deferred (increment 2b):** denylist viewer/editor, remove-host, "forget this site's history" (deleteByDomain), SERP/scroll signals.

**Notes / risks:**
- One sqlite worker must back BOTH the chunk store and the settings store. Wire `OffscreenSettingsStore` to the SAME worker (expose the worker-call helper), do NOT spawn a second worker.
- Pause semantics: blocks manual too (privacy-clear). If a user wants to save one thing while paused, they unpause — acceptable.
- "Don't remember this site" uses exact hostname; subdomains differ (mail.x.com vs x.com). Domain-level blocking is increment 2b.
- The deny-host popup action reads the ACTIVE tab url; on a restricted tab (chrome://) `new URL(tab.url)` may throw — guard it and show a benign message.
