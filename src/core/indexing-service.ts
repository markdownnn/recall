import type { EmbeddingPort, VectorSearchPort } from './ports'

// GPU-gentle gap between indexing batches: lets the foreground page render AND lets an
// interactive query (which the embedder runs ahead of queued passages) start during the
// gap. Mirrors the embedder's own 120ms inter-batch yield, which goes dormant at batch=8.
const YIELD_MS = 120

export class IndexingService {
  private running = false

  constructor(
    private readonly store: VectorSearchPort,
    private readonly embedder: EmbeddingPort,
    // Small batches bound the worst-case wait an interactive query pays: the embedder runs
    // a 'query' ahead of queued passages but cannot interrupt the batch already in flight,
    // so a smaller batch = a shorter query stall.
    private readonly batch = 8,
    private readonly maxRetries = 3,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  // Drain pending chunks until none remain OR a batch fails persistently.
  // Single-flight: a concurrent call returns immediately.
  // onTiming (optional) reports total chunks drained + total wall-ms once the drain
  // finishes, ONLY when real work happened. It carries raw numbers so the offscreen can
  // format/log the [Recall:perf] line - core stays chrome-free (no console, no chrome here).
  async drain(
    onBatch?: (embeddedCount: number) => void,
    onTiming?: (info: { chunks: number; ms: number }) => void,
  ): Promise<void> {
    if (this.running) return
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
        await this.sleep(YIELD_MS)
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
