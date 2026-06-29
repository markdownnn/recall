import type { EmbeddingPort, VectorSearchPort } from './ports'

export class IndexingService {
  private running = false

  constructor(
    private readonly store: VectorSearchPort,
    private readonly embedder: EmbeddingPort,
    private readonly batch = 32,
  ) {}

  // Drain pending chunks until none remain.
  // Single-flight: if a drain is already running, the new call returns immediately.
  async drain(onBatch?: (embeddedCount: number) => void): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const pending = await this.store.pendingChunks(this.batch)
        if (pending.length === 0) break
        const vectors = await this.embedder.embed(pending.map((c) => c.text), 'passage')
        for (let i = 0; i < pending.length; i++) {
          await this.store.setVector(pending[i].id, vectors[i])
        }
        onBatch?.(pending.length)
      }
    } finally {
      this.running = false
    }
  }
}
