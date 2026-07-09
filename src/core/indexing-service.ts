import type { EmbeddingPort, VectorSearchPort } from './ports'

// GPU-gentle gap between indexing batches: lets the foreground page render AND lets an
// interactive query (which the embedder runs ahead of queued passages) start during the
// gap. Smaller batches reduce the longest single GPU hold while the user keeps browsing.
export const INDEXING_BATCH_SIZE = 4
export const INDEXING_YIELD_MS = 120

export class IndexingService {
  private running = false
  // While a model-swap migration runs, capture/ping drains are SUPPRESSED so they cannot
  // steal the embed slot mid-migration (which would let the migration null page after page
  // without re-embedding, blanking the whole corpus, and stamp the new version while a
  // background drain still crawls). The migration drives its own drainForMigration() instead.
  private migrating = false
  // The currently-running drain (capture/ping OR migration). Lets drainForMigration wait out
  // a drain that was already in flight when the migration began, so it never returns early.
  private inflight: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: VectorSearchPort,
    private readonly embedder: EmbeddingPort,
    // Small batches bound the worst-case wait an interactive query pays: the embedder runs
    // a 'query' ahead of queued passages but cannot interrupt the batch already in flight,
    // so a smaller batch = a shorter query stall.
    private readonly batch = INDEXING_BATCH_SIZE,
    private readonly maxRetries = 3,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  // Enter/leave migration mode. While migrating, drain() (capture/ping keep-alive) is a no-op
  // so only the migration's own drainForMigration() touches the embed queue.
  beginMigration(): void {
    this.migrating = true
  }
  endMigration(): void {
    this.migrating = false
  }

  // Drain pending chunks until none remain OR a batch fails persistently.
  // Single-flight: a concurrent call returns immediately. Suppressed during a migration.
  // onTiming (optional) reports total chunks drained + total wall-ms once the drain
  // finishes, ONLY when real work happened. It carries raw numbers so the offscreen can
  // format/log the [Recall:perf] line - core stays platform-free (no console, no browser APIs here).
  async drain(
    onBatch?: (embeddedCount: number) => void,
    onTiming?: (info: { chunks: number; ms: number }) => void,
  ): Promise<void> {
    if (this.migrating) return
    if (this.running) return
    this.inflight = this.drainLoop(onBatch, onTiming)
    return this.inflight
  }

  // The migration's own drain. Bypasses the `migrating` suppression (which exists to stop
  // capture/ping, not the migration) but is still single-flight on `running`: it waits out any
  // drain that was already in flight when the migration started, then drains THIS page's freshly
  // nulled chunks to completion. Never returns early, so migrateEmbeddingModel's per-page
  // re-embed guarantee holds even under a concurrent keep-alive drain.
  async drainForMigration(onBatch?: (embeddedCount: number) => void): Promise<void> {
    while (this.running) await this.inflight.catch(() => {})
    this.inflight = this.drainLoop(onBatch)
    return this.inflight
  }

  private async drainLoop(
    onBatch?: (embeddedCount: number) => void,
    onTiming?: (info: { chunks: number; ms: number }) => void,
  ): Promise<void> {
    this.running = true
    const startedAt = Date.now()
    let chunks = 0
    try {
      for (;;) {
        const pending = await this.store.pendingChunks(this.batch)
        if (pending.length === 0) break
        const ok = await this.embedBatchWithRetry(pending)
        if (!ok) break // persistent failure: leave the rest pending for a later re-drain
        chunks += pending.length
        onBatch?.(pending.length)
        await this.sleep(INDEXING_YIELD_MS)
      }
    } finally {
      this.running = false
      // Emit only when work happened so idle ping/keep-alive re-drains stay silent.
      if (chunks > 0) onTiming?.({ chunks, ms: Date.now() - startedAt })
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
