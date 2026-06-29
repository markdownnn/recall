# User Controls (Plan 2, increment 2a): Pause + "Don't remember this site"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two privacy controls in the popup, persisted locally: a global **Pause** (stop capturing anything during a sensitive session) and **"Don't remember this site"** (add the current page's host to a user denylist so it is never captured). Settings live in the OPFS sqlite (no new permission).

**Architecture:** Hexagonal. The CORE depends only on domain ports — `VectorSearchPort` (exists) and a new `SettingsPort`. `CaptureGate` stays PURE: `decide()` takes a `settings` argument (paused + user-denied hosts) so it remains unit-testable.

DB access is abstracted into ONE primitive — `SqliteWorkerClient` — that owns the single dedicated sqlite worker (request/reply correlation, timeout, onerror-reject, all in one place). The two store ADAPTERS (`WorkerVectorStore`, `WorkerSettingsStore`) are thin DECLARATIVE mappings: each port method is a one-line `client.request('op', args)`. No worker plumbing is duplicated; both stores share one worker.

The WORKER itself is declarative too: a `SCHEMA` array of DDL statements and an op -> handler MAP (`{ upsertPage, putChunks, getSettings, setPaused, ... }`), not a hand-rolled if/else chain. Adding an op = adding a row to the map.

The offscreen `capture` op loads settings via `SettingsPort` and passes them to the gate. The popup reads/writes settings over RPC through the SW relay.

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
src/offscreen/sqlite-worker-client.ts   # NEW: SqliteWorkerClient (owns the worker; request/reply/timeout/onerror)
src/offscreen/sqlite-worker.ts          # MODIFY: declarative SCHEMA[] + op->handler MAP; add settings ops
src/offscreen/worker-vector-store.ts    # NEW: VectorSearchPort over the client (declarative one-liners)
src/offscreen/worker-settings-store.ts  # NEW: SettingsPort over the client (declarative one-liners)
src/offscreen/offscreen-worker-store.ts # DELETE: replaced by sqlite-worker-client + worker-vector-store
src/offscreen/offscreen.ts              # MODIFY: build client + both stores; gate uses settings; settings RPC ops
src/background/index.ts                 # MODIFY: relay settings ops
src/messaging.ts                        # MODIFY: settings messages
src/ui/popup/App.tsx                    # MODIFY: pause toggle + "don't remember this site"
tests/core/capture-gate.test.ts          # MODIFY: pause + user-host cases
tests/core/sqlite-worker-client.test.ts  # NEW: client correlation/timeout/onerror (fake worker)
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

## Task 2: Abstract DB access — one worker client + declarative worker + port adapters

This replaces the ad-hoc `OffscreenWorkerStore` (which owns the worker AND implements the port AND duplicates plumbing) with a clean split: ONE `SqliteWorkerClient` owns the worker; thin declarative adapters implement each port; the worker is a declarative schema + handler map.

**Files:** Create `src/offscreen/sqlite-worker-client.ts`, `src/offscreen/worker-vector-store.ts`, `src/offscreen/worker-settings-store.ts`, `tests/core/sqlite-worker-client.test.ts`; Modify `src/offscreen/sqlite-worker.ts`; Delete `src/offscreen/offscreen-worker-store.ts`.

- [ ] **Step 1: Write the failing client test**

**Scenario:** Every DB call must resolve with the matching reply and never hang: a worker error must reject the right call, and a worker crash must reject ALL in-flight calls (not leak). This is the single primitive all persistence relies on.
**Coverage:** ✅ integration (fake Worker; real correlation/timeout/onerror logic)

```ts
// tests/core/sqlite-worker-client.test.ts
import { SqliteWorkerClient } from '../../src/offscreen/sqlite-worker-client'

function fakeWorker() {
  const w: any = { posted: [], onmessage: null, onerror: null,
    postMessage(m: any) { this.posted.push(m) } }
  return w
}

test('request resolves with the matching reply', async () => {
  const w = fakeWorker()
  const c = new SqliteWorkerClient(w)
  const p = c.request('getSettings')
  const id = w.posted[0].id
  w.onmessage({ data: { id, result: { paused: true } } })
  await expect(p).resolves.toEqual({ paused: true })
})

test('worker error rejects only the matching call', async () => {
  const w = fakeWorker()
  const c = new SqliteWorkerClient(w)
  const a = c.request('a'); const b = c.request('b')
  w.onmessage({ data: { id: w.posted[0].id, error: 'boom' } })
  await expect(a).rejects.toThrow('boom')
  w.onmessage({ data: { id: w.posted[1].id, result: 1 } })
  await expect(b).resolves.toBe(1)
})

test('worker onerror rejects all in-flight calls', async () => {
  const w = fakeWorker()
  const c = new SqliteWorkerClient(w)
  const a = c.request('a'); const b = c.request('b')
  w.onerror(new Error('crash'))
  await expect(a).rejects.toBeTruthy()
  await expect(b).rejects.toBeTruthy()
})
```

- [ ] **Step 2: Implement the client**

```ts
// src/offscreen/sqlite-worker-client.ts
// Owns the single dedicated sqlite worker. Correlates {id,op,args} requests to
// {id,result|error} replies; times out; rejects all pending on worker fault.
export class SqliteWorkerClient {
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly worker: { postMessage: (m: unknown) => void; onmessage: ((e: { data: any }) => void) | null; onerror: ((e: unknown) => void) | null }, private readonly timeoutMs = 30_000) {
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data
      const entry = this.pending.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(id)
      if (error) entry.reject(new Error(String(error)))
      else entry.resolve(result)
    }
    this.worker.onerror = (e) => this.rejectAll(e)
  }

  request<T>(op: string, args?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`[sqlite] timeout: ${op}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, op, args })
    })
  }

  private rejectAll(cause: unknown): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(`[sqlite] worker fault: ${String(cause)}`))
    }
    this.pending.clear()
  }
}
```
Run: `npx vitest run tests/core/sqlite-worker-client.test.ts` -> PASS (3 tests).

- [ ] **Step 3: Make the worker declarative + add settings (`src/offscreen/sqlite-worker.ts`)**

Restructure the worker to a declarative `SCHEMA` array and an op -> handler MAP. Move the existing chunk SQL into handler functions unchanged; add the new settings tables + handlers. Sketch:

```ts
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, url TEXT, title TEXT, capturedAt INTEGER)`,
  `CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS user_denylist (host TEXT PRIMARY KEY)`,
]

const handlers: Record<string, (db: any, args: any) => unknown> = {
  upsertPage: (db, page) => { /* existing SQL */ },
  putChunks: (db, { pageId, chunks }) => { /* existing */ },
  pendingChunks: (db, { limit }) => { /* existing */ },
  setVector: (db, { id, vector }) => { /* existing */ },
  search: (db, { query, k }) => { /* existing */ },
  getSettings: (db) => {
    let paused = false
    db.exec({ sql: `SELECT value FROM settings WHERE key='paused'`, rowMode: 'array', callback: (r: any) => { paused = r[0] === '1' } })
    const userDenyHosts: string[] = []
    db.exec({ sql: `SELECT host FROM user_denylist`, rowMode: 'array', callback: (r: any) => userDenyHosts.push(r[0]) })
    return { paused, userDenyHosts }
  },
  setPaused: (db, paused: boolean) => db.exec({ sql: `INSERT OR REPLACE INTO settings (key,value) VALUES ('paused',?)`, bind: [paused ? '1' : '0'] }),
  addDenyHost: (db, host: string) => db.exec({ sql: `INSERT OR IGNORE INTO user_denylist (host) VALUES (?)`, bind: [host] }),
}

// init: SCHEMA.forEach(sql => db.exec(sql))
// onmessage: const { id, op, args } = e.data
//   try { postMessage({ id, result: handlers[op](db, args) }) }
//   catch (err) { postMessage({ id, error: String(err) }) }
```
(Keep the OPFS SAH pool init exactly as it is. The vector args carry Float32Array via structured clone — unchanged.)

- [ ] **Step 4: Port adapters over the client (declarative)**

```ts
// src/offscreen/worker-vector-store.ts
import type { VectorSearchPort } from '../core/ports'
import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import type { SqliteWorkerClient } from './sqlite-worker-client'

export class WorkerVectorStore implements VectorSearchPort {
  constructor(private readonly c: SqliteWorkerClient) {}
  upsertPage = (p: CapturedPage) => this.c.request<void>('upsertPage', p)
  putChunks = (pageId: string, chunks: Chunk[]) => this.c.request<void>('putChunks', { pageId, chunks })
  pendingChunks = (limit: number) => this.c.request<Chunk[]>('pendingChunks', { limit })
  setVector = (id: string, vector: Float32Array) => this.c.request<void>('setVector', { id, vector })
  search = (query: Float32Array, k: number) => this.c.request<RankedResult[]>('search', { query, k })
}
```
```ts
// src/offscreen/worker-settings-store.ts
import type { AppSettings, SettingsPort } from '../core/ports'
import type { SqliteWorkerClient } from './sqlite-worker-client'

export class WorkerSettingsStore implements SettingsPort {
  constructor(private readonly c: SqliteWorkerClient) {}
  get = () => this.c.request<AppSettings>('getSettings')
  setPaused = (paused: boolean) => this.c.request<void>('setPaused', paused)
  addDenyHost = (host: string) => this.c.request<void>('addDenyHost', host)
}
```
Delete `src/offscreen/offscreen-worker-store.ts` (its plumbing now lives in the client; its port impl is `WorkerVectorStore`).

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run` (client tests pass; core unaffected). `npx tsc --noEmit` (errors only in offscreen.ts wiring, fixed in Task 3).
```bash
git add src/offscreen/sqlite-worker-client.ts src/offscreen/sqlite-worker.ts src/offscreen/worker-vector-store.ts src/offscreen/worker-settings-store.ts tests/core/sqlite-worker-client.test.ts
git rm src/offscreen/offscreen-worker-store.ts
git commit -m "refactor(offscreen): SqliteWorkerClient + declarative worker + port adapters"
```

---

## Task 3: offscreen — gate with settings + settings RPC ops

**Files:** Modify `src/offscreen/offscreen.ts`

- [ ] **Step 1: Build the client + both stores; gate with settings; add settings ops**

- Construct ONE worker + client + both adapters:
  ```ts
  const worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })
  const client = new SqliteWorkerClient(worker)
  const store = new WorkerVectorStore(client)        // VectorSearchPort
  const settings = new WorkerSettingsStore(client)   // SettingsPort
  ```
  (Replaces the old `new OffscreenWorkerStore()`. Core services are still constructed with `store` exactly as before.)
- In the `capture` op: `const s = await settings.get()`, then `gate.decide({ url, text, manual }, s)`. Keep the rest (store + drain) unchanged.
- Add RPC ops (declarative, mirroring the SettingsPort):
  - `get-settings` -> `return await settings.get()`
  - `set-paused` (payload.paused) -> `await settings.setPaused(payload.paused); return { ok: true }`
  - `deny-host` (payload.host) -> `await settings.addDenyHost(payload.host); return { ok: true }`

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
- ONE worker, ONE client: `WorkerVectorStore` and `WorkerSettingsStore` share a single `SqliteWorkerClient` (Task 2/3). Do NOT spawn a second worker. The client is the only place with worker plumbing.
- The Task 2 refactor (extract client, declarative worker, delete `offscreen-worker-store.ts`) must keep `recall-flow` + `persistence` e2e green — it is a structure change, not a behavior change. Run them after Task 3.
- Pause semantics: blocks manual too (privacy-clear). If a user wants to save one thing while paused, they unpause — acceptable.
- "Don't remember this site" uses exact hostname; subdomains differ (mail.x.com vs x.com). Domain-level blocking is increment 2b.
- The deny-host popup action reads the ACTIVE tab url; on a restricted tab (chrome://) `new URL(tab.url)` may throw — guard it and show a benign message.
