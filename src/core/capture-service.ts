import type { ContentChunkerPort, EmbeddingPort, VectorSearchPort } from './ports'
import type { CapturedPage } from './model'

function pageIdFromUrl(url: string): string {
  const u = new URL(url)
  u.hash = ''
  return u.toString()
}

export class CaptureService {
  constructor(
    private readonly chunker: ContentChunkerPort,
    private readonly embedder: EmbeddingPort,
    private readonly store: VectorSearchPort,
  ) {}

  async capture(input: { url: string; title: string; text: string }): Promise<void> {
    const pageId = pageIdFromUrl(input.url)
    const page: CapturedPage = {
      id: pageId,
      url: input.url,
      title: input.title,
      capturedAt: Date.now(),
    }
    await this.store.upsertPage(page)
    await this.store.clearChunks(pageId)

    const chunks = this.chunker.chunk({ pageId, text: input.text })
    if (chunks.length === 0) return

    const vectors = await this.embedder.embed(chunks.map((c) => c.text), 'passage')
    for (let i = 0; i < chunks.length; i++) {
      await this.store.upsertChunk(chunks[i], vectors[i])
    }
  }
}
