import type { ContentChunkerPort, VectorSearchPort } from './ports'
import type { CapturedPage } from './model'
import { stripTrackingParams } from './strip-tracking-params'

export function pageIdFromUrl(url: string): string {
  const u = new URL(stripTrackingParams(url))
  u.hash = ''
  u.username = ''
  u.password = ''
  return u.toString()
}

export class CaptureService {
  constructor(
    private readonly chunker: ContentChunkerPort,
    private readonly store: VectorSearchPort,
  ) {}

  async capture(input: { url: string; title: string; text: string }): Promise<{ chunkCount: number }> {
    const pageId = pageIdFromUrl(input.url)
    const chunks = this.chunker.chunk({ pageId, text: input.text })
    if (chunks.length === 0) return { chunkCount: 0 }
    const page: CapturedPage = { id: pageId, url: input.url, title: input.title, capturedAt: Date.now() }
    await this.store.upsertPage(page)
    await this.store.putChunks(pageId, chunks)
    return { chunkCount: chunks.length }
  }
}
