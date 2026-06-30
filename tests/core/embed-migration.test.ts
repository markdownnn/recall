import { migrateEmbeddingModel, type EmbedVersionStore } from '../../src/core/embed-migration'
import { MemoryVectorStore } from '../../src/adapters/memory-vector-store'
import { IndexingService } from '../../src/core/indexing-service'
import type { EmbeddingPort } from '../../src/core/ports'
import type { CapturedPage, Chunk } from '../../src/core/model'

function fakeVersions(initial: string | null): EmbedVersionStore & { value: string | null } {
  const state = { value: initial }
  return {
    get value() {
      return state.value
    },
    async getEmbedVersion() {
      return state.value
    },
    async setEmbedVersion(v: string) {
      state.value = v
    },
  } as EmbedVersionStore & { value: string | null }
}

// A fake embedder that stamps a recognizable vector so we can tell a re-embed happened, and
// that records the peak number of pending chunks it ever saw in a single drain. The peak is
// the gradual guarantee: with two single-chunk pages a page-by-page migration must never see
// more than ONE pending chunk at a time (all-at-once would see two).
function spyEmbedder(): { port: EmbeddingPort; peakPending: () => number; setPeek: (n: number) => void } {
  let peek = 0
  let peak = 0
  const port: EmbeddingPort = {
    async embed(texts) {
      peak = Math.max(peak, peek)
      return texts.map(() => new Float32Array([9, 9]))
    },
  }
  return { port, peakPending: () => peak, setPeek: (n) => { peek = n } }
}

async function seededTwoPageStore(): Promise<MemoryVectorStore> {
  const store = new MemoryVectorStore()
  const pages: CapturedPage[] = [
    { id: 'p1', url: 'http://x', title: 'X', capturedAt: 1 },
    { id: 'p2', url: 'http://y', title: 'Y', capturedAt: 2 },
  ]
  for (const p of pages) await store.upsertPage(p)
  const c1: Chunk = { id: 'p1#0', pageId: 'p1', index: 0, text: 'alpha' }
  const c2: Chunk = { id: 'p2#0', pageId: 'p2', index: 0, text: 'beta' }
  await store.putChunks('p1', [c1])
  await store.putChunks('p2', [c2])
  await store.setVector('p1#0', new Float32Array([1, 0]))
  await store.setVector('p2#0', new Float32Array([0, 1]))
  return store
}

// Scenario: the model changed since this profile was last indexed (e5-era -> granite). Every
// page must be re-embedded with granite and the new version recorded - but page by page,
// never blanking the whole corpus at once.
// Coverage: integration (real MemoryVectorStore + real IndexingService + fake embedder).
test('stale version re-embeds every page gradually and records the new version', async () => {
  const store = await seededTwoPageStore()
  const versions = fakeVersions('e5-small-q8-v1')
  const spy = spyEmbedder()
  const indexing = new IndexingService(store, spy.port)
  const progress: { done: number; total: number }[] = []

  const reindexed = await migrateEmbeddingModel(
    store,
    versions,
    'granite-107m-r1-q8-v1',
    async () => {
      // Before draining, record how many chunks are pending so the test can assert that the
      // migration never nulls more than one page's worth at a time.
      spy.setPeek((await store.pendingChunks(100)).length)
      await indexing.drain()
    },
    (p) => progress.push(p),
  )

  expect(reindexed).toBe(true)
  expect((await store.pendingChunks(100)).length).toBe(0) // all re-embedded
  expect(await versions.getEmbedVersion()).toBe('granite-107m-r1-q8-v1')
  expect(progress).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }])
  expect(spy.peakPending()).toBe(1) // never more than one page pending => gradual, not dark
})

// Scenario: a profile already on granite reopens the extension. The migration must be a no-op:
// it must NOT clear durable vectors and force a needless re-embed every launch.
// Coverage: integration (real MemoryVectorStore + fake version store).
test('matching version is a no-op (vectors preserved, no re-embed)', async () => {
  const store = await seededTwoPageStore()
  const versions = fakeVersions('granite-107m-r1-q8-v1')
  let drained = 0

  const reindexed = await migrateEmbeddingModel(
    store,
    versions,
    'granite-107m-r1-q8-v1',
    async () => {
      drained++
    },
  )

  expect(reindexed).toBe(false)
  expect(drained).toBe(0)
  expect((await store.pendingChunks(100)).length).toBe(0) // still embedded
})
