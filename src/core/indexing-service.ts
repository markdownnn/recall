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
