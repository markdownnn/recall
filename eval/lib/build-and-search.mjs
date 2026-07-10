// Reuses the REAL chunker and the REAL MemoryVectorStore.search (same rrfFuse +
// topPagesBySnippet as the production opSearch, per ADR 0020). Fixes 3/4 land in those
// files, so this glue exercises them end to end without re-implementing ranking.
//
// NOTE: this harness applies the extraction-time fixes (Fix 1 stripBoilerplate, Fix 2
// low-prose filter) to the fixture text ITSELF, rather than through CaptureService. That
// is deliberate: the production capture path (src/content/capture.ts and
// src/core/capture-service.ts) is owned by a parallel task, so the harness proves the
// PURE functions' effect on the same chunks the extension would index. The 1-2 line
// production wiring is a documented follow-up.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ParagraphChunker } from '../../src/core/paragraph-chunker.ts'
import { pageIdFromUrl } from '../../src/core/capture-service.ts'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store.ts'
import { stripBoilerplate } from '../../src/core/boilerplate-strip.ts'
import { proseScore } from '../../src/core/prose-score.ts'
import { embed } from './embed-node.mjs'

// Shared by every eval/run*.mjs entrypoint so the corpus manifest path lives in one place.
export function loadManifest() {
  return JSON.parse(readFileSync('eval/manifest.json', 'utf8'))
}

// Chunk ids are `${pageId}#${index}`; keep them contiguous after a prose filter so two
// pages' chunk ids never collide and hydrate sees no gaps. Re-number the survivors.
function reindex(chunks, pageId) {
  return chunks.map((c, i) => ({ id: `${pageId}#${i}`, pageId, index: i, text: c.text }))
}

// Build a store from the whole corpus once. `opts.strip` and `opts.minProse` toggle the
// extraction-time fixes so one process can produce before/after numbers.
export async function buildStore(manifest, opts = {}) {
  const store = new MemoryVectorStore()
  const chunker = new ParagraphChunker(220)
  for (const row of manifest) {
    let text = readFileSync(resolve('eval/fixtures', row.file), 'utf8')
    if (opts.strip) text = stripBoilerplate(text)
    const pageId = pageIdFromUrl(row.url)
    const all = chunker.chunk({ pageId, text })
    if (all.length === 0) continue
    // Fix 2 (safety net): drop low-prose chunks - but never wipe a page out entirely.
    let chunks = all
    if (opts.minProse && opts.minProse > 0) {
      const kept = all.filter((c) => proseScore(c.text) >= opts.minProse)
      chunks = kept.length > 0 ? reindex(kept, pageId) : all
    }
    await store.upsertPage({ id: pageId, url: row.url, title: row.id, capturedAt: Date.now() })
    await store.putChunks(pageId, chunks)
  }
  // Embed every pending chunk (passage:) and store the vector.
  const pending = await store.pendingChunks(1e9)
  const vectors = await embed(
    pending.map((c) => c.text),
    'passage',
  )
  for (let i = 0; i < pending.length; i++) await store.setVector(pending[i].id, vectors[i])
  return store
}

export async function runQuery(store, query, k) {
  const [qvec] = await embed([query], 'query')
  return store.search(qvec, query, k) // RankedResult[]
}
