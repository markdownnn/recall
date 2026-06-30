import { migrateEmbeddingModel, type EmbedVersionStore } from '../../src/core/embed-migration'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import { IndexingService } from '../../src/core/indexing-service'
import type { EmbeddingPort } from '../../src/core/ports'
import type { CapturedPage, Chunk } from '../../src/core/model'

function fakeVersions(initial: string | null): EmbedVersionStore {
  let value = initial
  return {
    async getEmbedVersion() { return value },
    async setEmbedVersion(v: string) { value = v },
  }
}

// Reproduces the offscreen init wiring: a fire-and-forget CAPTURE drain is started, then the
// migration runs (begin/drainForMigration/end), then a post-migration drain. A slow embedder
// makes the capture drain still be in flight when the migration begins (the real e2e race). The
// whole thing must COMPLETE, not hang (a hang would leave migrating=true forever and suppress
// every drain - the e2e symptom: panel stuck on "indexing...").
test('capture drain in flight when migration begins does not hang the init chain', async () => {
  const store = new MemoryVectorStore()
  const page: CapturedPage = { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 }
  await store.upsertPage(page)
  const chunks: Chunk[] = [
    { id: 'p1#0', pageId: 'p1', index: 0, text: 'cortisol' },
    { id: 'p1#1', pageId: 'p1', index: 1, text: 'tax' },
  ]
  await store.putChunks('p1', chunks)

  const embedder: EmbeddingPort = {
    async embed(texts) {
      await new Promise((r) => setTimeout(r, 20)) // slow embed -> capture drain stays in flight
      return texts.map(() => new Float32Array([1, 0]))
    },
  }
  const indexing = new IndexingService(store, embedder)
  const versions = fakeVersions(null)

  // Fire-and-forget capture drain (exactly like runDrainWithProgress in the offscreen).
  const captureDrain = indexing.drain()

  // Init migration chain.
  indexing.beginMigration()
  await migrateEmbeddingModel(
    store,
    versions,
    'granite-107m-r1-q8-v1',
    () => indexing.drainForMigration(),
  )
  indexing.endMigration()
  await indexing.drain() // post-migration
  await captureDrain

  expect((await store.pendingChunks(10)).length).toBe(0)
  expect(await versions.getEmbedVersion()).toBe('granite-107m-r1-q8-v1')
}, 10_000)
