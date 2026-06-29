# User Controls (Plan 2, increment 2b): Subdomain matching + denylist editor + Forget this site

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the user-control surface: (a) "Don't remember this site" blocks the whole site including subdomains (not just the exact host), (b) a denylist editor in the popup to view + remove user-denied hosts, and (c) "Forget this site's history" that deletes everything already captured for the current site.

**Architecture:** Hexagonal + declarative, matching 2a. The gate stays PURE (host-suffix matching is a pure function). New persistence ops go through the SAME `SqliteWorkerClient` + declarative worker handler map. New port methods: `SettingsPort.removeDenyHost`, `VectorSearchPort.deletePagesByHost`. Adapters are one-line `client.request(...)`. The popup talks to the SW relay over RPC.

**Decisions:**
- **Suffix matching:** a denied host `d` blocks page host `h` iff `h === d` OR `h.endsWith('.' + d)`. So `bank.com` blocks `www.bank.com` and `app.bank.com` but NOT `evilbank.com` or `bank.com.evil.com`. Pure + safe.
- **"Don't remember this site" stores host with a leading `www.` stripped**, so denying on `www.bank.com` covers the apex + subdomains. (Deeper subdomains like `app.notion.so` store as-is and block that host + its subdomains — "this site" = where you are. A full public-suffix-list registrable-domain is a future refinement.)
- **Forget by host** deletes captured pages + chunks whose stored host equals or is a subdomain of the given host. A `host` column is added to `pages` (derived from the url at capture; existing rows backfilled on init).
- Out of scope: SERP/scroll gate signals; per-page (vs per-site) forget; export/backup.

---

## File Structure

```
src/core/capture-gate.ts        # MODIFY: host-suffix matching (pure)
src/core/ports.ts               # MODIFY: SettingsPort.removeDenyHost, VectorSearchPort.deletePagesByHost
src/offscreen/sqlite-worker.ts  # MODIFY: pages.host column + backfill; removeDenyHost, deletePagesByHost handlers; upsertPage stores host
src/offscreen/worker-vector-store.ts    # MODIFY: deletePagesByHost one-liner
src/offscreen/worker-settings-store.ts  # MODIFY: removeDenyHost one-liner
src/offscreen/offscreen.ts      # MODIFY: remove-deny-host + forget-host RPC ops
src/background/index.ts         # MODIFY: relay remove-deny-host + forget-host
src/messaging.ts                # MODIFY: remove-deny-host, forget-host messages
src/ui/popup/App.tsx            # MODIFY: denylist list+remove; "Forget this site's history" + store stripped host
tests/core/capture-gate.test.ts          # MODIFY: suffix-match cases
tests/e2e/user-controls.spec.ts          # MODIFY: subdomain block + forget-history
```

---

## Task 1: Gate host-suffix matching (pure, TDD)

**Files:** Modify `src/core/capture-gate.ts`, `tests/core/capture-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

**Scenario:** Marking a bank "don't remember" must also stop its login subdomain (`secure.bank.com`) — exact-host-only was a real privacy gap. But it must NOT over-block lookalikes (`evilbank.com`).
**Coverage:** ✅ integration (pure decide(), real matching)

```ts
// tests/core/capture-gate.test.ts — add (open settings already defined)
test('user deny blocks subdomains of the denied host', () => {
  const s = { paused: false, userDenyHosts: ['bank.com'] }
  expect(gate.decide({ url: 'https://www.bank.com/x', text: long, manual: false }, s).capture).toBe(false)
  expect(gate.decide({ url: 'https://secure.bank.com/login', text: long, manual: true }, s).reason).toBe('denylisted')
})

test('user deny does NOT block lookalike hosts', () => {
  const s = { paused: false, userDenyHosts: ['bank.com'] }
  expect(gate.decide({ url: 'https://evilbank.com/x', text: long, manual: false }, s).capture).toBe(true)
  expect(gate.decide({ url: 'https://bank.com.evil.com/x', text: long, manual: false }, s).capture).toBe(true)
})
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/capture-gate.test.ts`
Expected: FAIL (current exact-match `includes` doesn't block subdomains).

- [ ] **Step 3: Implement the suffix matcher**

In `src/core/capture-gate.ts`, replace the exact `userDenyHosts.includes(hostOf(input.url))` check with:

```ts
function hostDenied(host: string, denyHosts: string[]): boolean {
  if (!host) return false
  return denyHosts.some((d) => host === d || host.endsWith('.' + d))
}
// in decide(): if (hostDenied(hostOf(input.url), settings.userDenyHosts)) return { capture: false, reason: 'denylisted' }
```

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/capture-gate.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/core/capture-gate.ts tests/core/capture-gate.test.ts
git commit -m "feat(core): deny-host matches subdomains (suffix match)"
```

---

## Task 2: Ports — removeDenyHost + deletePagesByHost

**Files:** Modify `src/core/ports.ts`

- [ ] **Step 1: Extend the port interfaces**

```ts
// SettingsPort — add:
  removeDenyHost(host: string): Promise<void>
// VectorSearchPort — add:
  deletePagesByHost(host: string): Promise<void>
```

- [ ] **Step 2: Typecheck (adapters/worker updated next)**

Run: `npx tsc --noEmit`
Expected: errors only in the adapters/offscreen (next tasks).

- [ ] **Step 3: Commit**

```bash
git add src/core/ports.ts
git commit -m "feat(core): ports for removeDenyHost + deletePagesByHost"
```

---

## Task 3: Worker — host column + backfill + delete/remove handlers

**Files:** Modify `src/offscreen/sqlite-worker.ts`, `src/offscreen/worker-vector-store.ts`, `src/offscreen/worker-settings-store.ts`

- [ ] **Step 1: Schema migration + host on insert**

In `sqlite-worker.ts`, after running `SCHEMA`, ensure the `pages.host` column exists and is backfilled (idempotent):
```ts
// after SCHEMA.forEach(...):
try { db.exec(`ALTER TABLE pages ADD COLUMN host TEXT`) } catch { /* already exists */ }
// backfill host for rows missing it (one-time)
const toFix: { id: string; url: string }[] = []
db.exec({ sql: `SELECT id, url FROM pages WHERE host IS NULL`, rowMode: 'object', callback: (r: any) => toFix.push({ id: r.id, url: r.url }) })
for (const r of toFix) {
  let host = ''
  try { host = new URL(r.url).hostname.toLowerCase() } catch { /* leave '' */ }
  db.exec({ sql: `UPDATE pages SET host = ? WHERE id = ?`, bind: [host, r.id] })
}
```
Update the `upsertPage` handler to compute + store host:
```ts
upsertPage: (db, page) => {
  let host = ''
  try { host = new URL(page.url).hostname.toLowerCase() } catch {}
  db.exec({ sql: `INSERT OR REPLACE INTO pages (id, url, title, capturedAt, host) VALUES (?,?,?,?,?)`,
    bind: [page.id, page.url, page.title, page.capturedAt, host] })
},
```
(Adjust the existing upsertPage SQL — it currently has 4 columns; add `host`.)

- [ ] **Step 2: Add the two handlers (declarative map entries)**

```ts
removeDenyHost: (db, host: string) => db.exec({ sql: `DELETE FROM user_denylist WHERE host = ?`, bind: [host] }),

deletePagesByHost: (db, host: string) => {
  // delete this host and any subdomain of it (h == host OR h ends with '.'||host)
  const where = `(host = ? OR host LIKE '%.' || ?)`
  db.exec({ sql: `DELETE FROM chunks WHERE pageId IN (SELECT id FROM pages WHERE ${where})`, bind: [host, host] })
  db.exec({ sql: `DELETE FROM pages WHERE ${where}`, bind: [host, host] })
},
```

- [ ] **Step 3: Adapter one-liners**

```ts
// worker-vector-store.ts — add:
deletePagesByHost = (host: string) => this.c.request<void>('deletePagesByHost', host)
// worker-settings-store.ts — add:
removeDenyHost = (host: string) => this.c.request<void>('removeDenyHost', host)
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean (offscreen op handlers added next; if tsc errors there, proceed).

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/sqlite-worker.ts src/offscreen/worker-vector-store.ts src/offscreen/worker-settings-store.ts
git commit -m "feat(offscreen): pages.host column + delete-by-host + remove-deny-host handlers"
```

---

## Task 4: offscreen + messaging + SW relay

**Files:** Modify `src/offscreen/offscreen.ts`, `src/messaging.ts`, `src/background/index.ts`

- [ ] **Step 1: offscreen RPC ops**

In `offscreen.ts`, add ops:
- `remove-deny-host` (payload.host) -> `await settings.removeDenyHost(payload.host); return { ok: true }`
- `forget-host` (payload.host) -> `await store.deletePagesByHost(payload.host); return { ok: true }`

- [ ] **Step 2: messaging types**

```ts
// Msg — add:
| { type: 'remove-deny-host'; host: string }
| { type: 'forget-host'; host: string }
```
(MsgResult `{ type:'ok' }` already exists from 2a.)

- [ ] **Step 3: SW relay**

In `background/index.ts`, add `remove-deny-host` and `forget-host` to the handled-types guard and relay each to the offscreen op, responding `{ type:'ok' }`.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean (popup next).

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/offscreen.ts src/messaging.ts src/background/index.ts
git commit -m "feat(sw): relay remove-deny-host + forget-host"
```

---

## Task 5: Popup — denylist editor + Forget this site + store stripped host

**Files:** Modify `src/ui/popup/App.tsx`

- [ ] **Step 1: Store the stripped host on deny**

In `denyHost()`, strip a leading `www.` before sending/adding so "this site" covers the apex + subdomains:
```ts
const host = new URL(tab.url!).hostname.replace(/^www\./, '')
```

- [ ] **Step 2: Denylist editor**

Render the user's denied hosts (from `userDenyHosts`) as a small list, each with a "remove" (x) button that sends `{ type:'remove-deny-host', host }` and removes it from local state. Keep it compact (only show when the list is non-empty), e.g. under the controls:
```tsx
{userDenyHosts.length > 0 && (
  <div style="font-size:11px; margin-bottom:8px;">
    <div style="color:#888;">No-remember sites:</div>
    {userDenyHosts.map((h) => (
      <div key={h} style="display:flex; justify-content:space-between; align-items:center;">
        <span>{h}</span>
        <button onClick={() => removeDeny(h)} style="font-size:10px;">remove</button>
      </div>
    ))}
  </div>
)}
```
where `removeDeny(h)` sends the message and `setUserDenyHosts(prev => prev.filter(x => x !== h))`.

- [ ] **Step 3: "Forget this site's history" button**

A button that gets the active tab host (stripped of `www.`, guarded for restricted tabs), sends `{ type:'forget-host', host }`, and shows confirmation `Forgot everything from <host>`. Place it near "Don't remember this site".

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/popup/App.tsx
git commit -m "feat(popup): denylist editor + forget this site's history"
```

---

## Task 6: e2e — subdomain block + forget-history

**Files:** Modify `tests/e2e/user-controls.spec.ts`

- [ ] **Step 1: Add the forget-history e2e**

**Scenario:** "Forget this site's history" must actually delete captured pages for the site (the user's right-to-be-forgotten), proven through the real delete SQL — not just a popup message.
**Coverage:** ✅ integration (real extension; capture -> index -> forget -> search returns nothing).

Sketch (reuse the http-route trick from the deny-host test to get a real host):
```ts
test('forget this site deletes its captured history', async () => {
  test.setTimeout(120_000)
  // load extension; route http://forget-test.example/article to the article html; goto it
  // open popup; manual Capture this page; wait for indexing; search -> assert Cortisol IS found
  // click "Forget this site's history"; wait for confirmation
  // search again -> assert 0 results (the page + chunks were deleted)
})
```
(Use `expect.poll`/`toPass` for the indexing wait, mirroring existing tests.)

- [ ] **Step 2: (optional) subdomain-deny e2e**

The gate suffix match is unit-tested (Task 1). An e2e for subdomain blocking is optional — if cheap, route a subdomain of a denied host and assert it is blocked; otherwise rely on the unit test.

- [ ] **Step 3: Run**

Run: `npm run build && npx playwright test tests/e2e/user-controls.spec.ts`
Expected: all green (pause, deny-host, forget-history).

- [ ] **Step 4: Full suite**

Run: `npm run test && npx playwright test tests/e2e/recall-flow.spec.ts tests/e2e/persistence.spec.ts tests/e2e/auto-capture.spec.ts tests/e2e/user-controls.spec.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/user-controls.spec.ts
git commit -m "test(e2e): forget this site deletes its captured history"
```

---

## Self-Review

**Spec coverage:**
- Subdomain blocking: Task 1 (gate, unit). ✅
- Denylist editor (view + remove): Task 2/3/4/5. ✅
- Forget this site's history (delete by host incl. subdomains): Task 3 (SQL) + Task 6 (e2e proof). ✅
- Stored host stripped of www so "this site" covers apex+subdomains: Task 5. ✅

**Notes / risks:**
- `pages.host` migration must be idempotent (ALTER in try/catch) and not break the existing persistence e2e — run it after Task 3.
- Suffix match is host-based, not a public-suffix-list registrable domain. Honest behavior: blocks the stored host + its subdomains. Documented in the popup label is nice-to-have.
- `deletePagesByHost` deletes pages + chunks; pending (un-embedded) chunks for that host are also removed (they reference the deleted pages). Fine.
- Backfill runs once on the first load after upgrade (rows where host IS NULL); on big corpora it iterates all pages once — acceptable, but note it.
- The forget-history button is destructive — clear confirmation text; a confirm dialog is optional (popups + window.confirm can be awkward; a clear status message is acceptable for v1).
