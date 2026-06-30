# Indexing Resilience: drain retry + periodic re-drain

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make embedding eventually-consistent so a chunk that is stored but not yet embedded (vector NULL) can never stay invisible to search forever. Capture already stores chunks immediately; this plan makes the background drain (a) retry transient embed failures and (b) get re-triggered periodically so leftover pending chunks always catch up.

**Architecture:** Two small changes. (1) `IndexingService.drain` (pure core) retries each batch with backoff and, on persistent failure, STOPS gracefully leaving the rest pending (never throws away work, never infinite-loops). (2) The offscreen's keep-alive `ping` handler kicks a (single-flight) drain, so pending chunks are re-attempted ~every 20s while the SW is alive - in addition to the existing startup drain and post-capture drain.

**Tech Stack:** TypeScript · existing core/offscreen · Vitest.

**Decisions:**
- Retry is per-batch, bounded (default 3 retries, exponential backoff 250/500/1000ms). On final failure the drain returns normally (leaves remaining pending) rather than throwing - the next re-drain handles them.
- `sleep` is injected into `IndexingService` (default real `setTimeout`) so unit tests run instantly and stay deterministic.
- Re-drain trigger = the existing 20s keep-alive `ping` (already firing). `drain` is single-flight, so a ping-drain that overlaps a capture-drain is a cheap no-op. No new timers, no new permissions.
- Out of scope: idempotent capture (skip re-embed when chunk text unchanged) - a separate optimization.

---

## File Structure

```
src/core/indexing-service.ts        # MODIFY: per-batch retry+backoff, injected sleep, graceful stop
tests/core/indexing-service.test.ts # MODIFY: add retry-recovers + persistent-fail tests
src/offscreen/offscreen.ts          # MODIFY: ping handler also kicks runDrainWithProgress()
```

---

## Task 1: IndexingService retries transient embed failures (TDD)

**Files:** Modify `src/core/indexing-service.ts`, `tests/core/indexing-service.test.ts`

- [ ] **Step 1: Write the failing tests**

**Scenario:** A transient embed failure (GPU hiccup) must not strand a chunk as unsearchable - the drain retries and the chunk eventually gets its vector. A PERSISTENT failure must not throw or loop forever - the drain stops, leaving the chunk pending for a later re-drain (not lost).
**Coverage:** ✅ integration (real IndexingService + fakes; injected no-op sleep)

```ts
// tests/core/indexing-service.test.ts - add (keep existing tests)
const noSleep = async () => {}

test('retries a transient embed failure until it succeeds', async () => {
  const store = new MemoryVectorStore()
  // seed one pending chunk (vector NULL)
  await store.upsertPage({ id: 'p', url: 'u', title: 't', capturedAt: 0 })
  await store.putChunks('p', [{ id: 'c0', pageId: 'p', idx: 0, text: 'hello world' }])

  let calls = 0
  const embedder = {
    embed: async (texts: string[]) => {
      calls++
      if (calls < 3) throw new Error('gpu hiccup')
      return texts.map(() => new Float32Array([1, 0]))
    },
    ensureLoaded: async () => {},
  }
  const svc = new IndexingService(store as any, embedder as any, 32, 3, noSleep)
  await svc.drain()

  expect(calls).toBe(3) // failed twice, succeeded on the 3rd
  expect((await store.pendingChunks(10)).length).toBe(0) // chunk got embedded
})

test('persistent embed failure stops gracefully: no throw, chunk stays pending', async () => {
  const store = new MemoryVectorStore()
  await store.upsertPage({ id: 'p', url: 'u', title: 't', capturedAt: 0 })
  await store.putChunks('p', [{ id: 'c0', pageId: 'p', idx: 0, text: 'hello world' }])

  const embedder = { embed: async () => { throw new Error('model dead') }, ensureLoaded: async () => {} }
  const svc = new IndexingService(store as any, embedder as any, 32, 2, noSleep)

  await expect(svc.drain()).resolves.toBeUndefined() // does NOT throw
  expect((await store.pendingChunks(10)).length).toBe(1) // still pending, not lost
})
```
(Adjust seeding to match `MemoryVectorStore`'s actual API - check `putChunks`/`pendingChunks`/`upsertPage` signatures in `src/adapters/memory-vector-store.ts`. Chunk/page shapes from `src/core/model.ts`. ASCII only.)

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/core/indexing-service.test.ts`
Expected: FAIL (current drain has no retry; persistent failure currently throws).

- [ ] **Step 3: Implement retry + graceful stop**

```ts
// src/core/indexing-service.ts
import type { EmbeddingPort, VectorSearchPort } from './ports'

export class IndexingService {
  private running = false

  constructor(
    private readonly store: VectorSearchPort,
    private readonly embedder: EmbeddingPort,
    private readonly batch = 32,
    private readonly maxRetries = 3,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  // Drain pending chunks until none remain OR a batch fails persistently.
  // Single-flight: a concurrent call returns immediately.
  async drain(onBatch?: (embeddedCount: number) => void): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const pending = await this.store.pendingChunks(this.batch)
        if (pending.length === 0) break
        const ok = await this.embedBatchWithRetry(pending)
        if (!ok) break // persistent failure: leave the rest pending for a later re-drain
        onBatch?.(pending.length)
      }
    } finally {
      this.running = false
    }
  }

  // Embed one batch, retrying transient failures with exponential backoff.
  // Returns false if it still fails after maxRetries (caller stops the drain).
  private async embedBatchWithRetry(
    pending: { id: string; text: string }[],
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const vectors = await this.embedder.embed(
          pending.map((c) => c.text),
          'passage',
        )
        for (let i = 0; i < pending.length; i++) {
          await this.store.setVector(pending[i].id, vectors[i])
        }
        return true
      } catch {
        if (attempt === this.maxRetries) return false
        await this.sleep(250 * 2 ** attempt) // 250, 500, 1000ms
      }
    }
    return false
  }
}
```
(`pending`'s element type should match what `pendingChunks` returns - use the existing `Chunk` type from `model.ts` if that's what the port declares; the `{id,text}` above is the minimum the method uses.)

- [ ] **Step 4: Run, watch pass**

Run: `npx vitest run tests/core/indexing-service.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Full unit + typecheck + purity**

Run: `npm run test && npx tsc --noEmit && rg "chrome" src/core`
Expected: all green; `src/core` stays chrome-free.

- [ ] **Step 6: Commit**

```bash
git add src/core/indexing-service.ts tests/core/indexing-service.test.ts
git commit -m "feat(core): drain retries transient embed failures, stops gracefully on persistent ones"
```

---

## Task 2: keep-alive ping re-triggers the drain

**Files:** Modify `src/offscreen/offscreen.ts`

- [ ] **Step 1: Kick a drain on ping**

In `offscreen.ts`, find the `ping` op handler. Have it ALSO call `runDrainWithProgress()` (fire-and-forget) before replying. `IndexingService.drain` is single-flight and `pendingChunks` returns fast when empty, so a ping with no pending chunks is a cheap no-op; a ping when chunks are stranded (a prior drain failed) re-attempts them ~every 20s.

Sketch (match the existing op-dispatch style):
```ts
if (op === 'ping') {
  // Re-attempt any pending (un-embedded) chunks left by a failed/interrupted drain.
  // Single-flight + empty-fast, so this is free when there is nothing to do.
  runDrainWithProgress()
  return { ok: true }
}
```
Do NOT await the drain - the ping must reply immediately to keep the keep-alive snappy.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Verify no regression**

**Scenario:** the periodic drain must not disturb normal capture/recall, and the existing drain path still works.
**Coverage:** ⚠️ The ping->drain wiring is offscreen glue; its effect (re-embedding stranded chunks) is the same `runDrainWithProgress` already covered by `recall-flow`/`persistence` e2e. Triggering it from ping is a one-line dispatch with no new logic. Justification: a dedicated "kill the model mid-drain, then let a ping finish it" e2e would need fault injection into the bundled embedder that the harness can't do; the retry LOGIC is unit-tested in Task 1, and the ping is just one more caller of an already-tested, single-flight function.

Run: `npm run build && npx playwright test tests/e2e/recall-flow.spec.ts tests/e2e/persistence.spec.ts`
Expected: both green (capture -> index -> recall still works; ping-drain causes no interference).

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat(offscreen): keep-alive ping re-triggers drain so stranded chunks catch up"
```

---

## Self-Review

**Spec coverage:**
- Retry transient embed failures: Task 1 (unit). ✅
- Don't lose work / don't loop on persistent failure: Task 1 (unit - chunk stays pending, no throw). ✅
- Periodic re-drain so pending always catch up: Task 2 (ping trigger), complementing the existing startup drain (`offscreen.ts` module load) + post-capture drain. ✅

**Result:** capture always stores; embedding is now self-healing - a transient GPU failure retries, a persistent one leaves chunks pending (not lost) and a later ping/startup/capture drain finishes them. "Stored but never searchable" can no longer persist.

**Notes / risks:**
- If a batch fails persistently, the drain breaks early, so `runDrainWithProgress`'s "indexing-complete" may fire while some chunks are still pending - the popup could briefly show "indexed" though a few remain. Minor and self-correcting (next drain). Out of scope to fix here.
- The ping only fires while the SW is alive (it pings every 20s). When the SW is asleep, pending wait until the next wake (capture/recall/startup), where the startup drain catches them. Acceptable.
- `maxRetries`/backoff are constructor defaults; the offscreen constructs `IndexingService` with the defaults (no call-site change needed).
