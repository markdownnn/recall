import type { ContentChunkerPort, VectorSearchPort } from './ports'
import type { CapturedPage, Chunk } from './model'
import { stripTrackingParams } from './strip-tracking-params'
import { proseScore } from './prose-score'

export function pageIdFromUrl(url: string): string {
  // A malformed url (no protocol, garbage, etc.) makes new URL(...) throw. Rather than
  // crash capture, fall back to the raw url string as the id.
  try {
    const u = new URL(stripTrackingParams(url))
    u.hash = ''
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return url
  }
}

export class CaptureService {
  constructor(
    private readonly chunker: ContentChunkerPort,
    private readonly store: VectorSearchPort,
    // Fix 2: drop chunks whose proseScore is below this before indexing (citation/boilerplate
    // safety net for whatever Fix 1's heading strip misses). 0 = keep everything (the
    // backward-compatible default).
    private readonly minProseScore = 0,
  ) {}

  async capture(input: { url: string; title: string; text: string; force?: boolean }): Promise<{ chunkCount: number; skipped?: 'already-saved' }> {
    const pageId = pageIdFromUrl(input.url)
    // Auto-capture dedup: an already-saved page is NOT re-captured by the automatic
    // (engagement/dwell) path; only an explicit user action (force=true, the manual
    // Capture/Update button) re-captures. Besides saving redundant re-embedding on every
    // revisit, this removes the re-capture-wipes-vectors race: a forced putChunks() during
    // an in-flight embed of the prior chunks would drop those vectors - the same race the
    // e2e worked around with about:blank navigation. Skipping the auto re-capture closes it.
    if (!input.force && (await this.store.hasPage(pageId))) {
      return { chunkCount: 0, skipped: 'already-saved' }
    }
    const all = this.chunker.chunk({ pageId, text: input.text })
    if (all.length === 0) return { chunkCount: 0 }
    // Drop low-prose (citation/boilerplate) chunks - but never wipe a page out entirely: if
    // filtering would remove ALL chunks (a genuinely table/formula-heavy page), keep the
    // originals so the page stays findable.
    let chunks = all
    if (this.minProseScore > 0) {
      const kept = all.filter((c) => proseScore(c.text) >= this.minProseScore)
      chunks = kept.length > 0 ? reindex(kept, pageId) : all
    }
    const page: CapturedPage = { id: pageId, url: input.url, title: input.title, capturedAt: Date.now() }
    await this.store.upsertPage(page)
    await this.store.putChunks(pageId, chunks)
    return { chunkCount: chunks.length }
  }
}

// Chunk ids are `${pageId}#${index}` and must stay contiguous after filtering, or hydrate
// could see gaps. Re-number the survivors so the ids are dense again.
function reindex(chunks: Chunk[], pageId: string): Chunk[] {
  return chunks.map((c, i) => ({ id: `${pageId}#${i}`, pageId, index: i, text: c.text }))
}
