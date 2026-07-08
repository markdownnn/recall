import type { VectorSearchPort } from './ports'
import { needsReindex } from './embed-version'

// The persisted embedding-model version, read/written around the corpus re-index.
export interface EmbedVersionStore {
  getEmbedVersion(): Promise<string | null>
  setEmbedVersion(version: string): Promise<void>
}

// If the stored embedding-model version differs from `current`, re-embed the corpus with
// the current BGE model - but ONE PAGE AT A TIME so search stays mostly alive. For each page we null its
// vectors (only that page leaves search) and immediately re-embed the now-pending chunks via
// `reembedPending` (the offscreen passes the real drain), so the page is searchable again
// before we touch the next one. `onProgress` reports {done,total} pages for the UI bar.
//
// CRUCIAL: we snapshot ONLY pages that already hold OLD-model vectors (pagesWithVectors), NOT
// every page. A page captured DURING this init (its chunks are all still NULL, pending) has no
// old vectors to convert - clearing it would be a no-op and re-embedding it here would route it
// through the migration's reindex-progress path, so the side panel never sees the
// indexing-complete terminal and the user's fresh capture never reaches "indexed". By
// excluding NULL-only pages, the normal post-migration drain handles them (and DOES fire
// indexing-complete).
//
// Order matters for interrupt-safety: the new version is recorded only AFTER every page is
// done. A crash mid-run leaves some pages pending and the version unchanged, so the next
// launch simply re-runs the loop (re-nulling an already-migrated page and re-embedding it is
// wasted work but never wrong). Returns true when a re-index was triggered.
export async function migrateEmbeddingModel(
  store: Pick<VectorSearchPort, 'clearVectorsForPage' | 'pagesWithVectors'>,
  versions: EmbedVersionStore,
  current: string,
  reembedPending: () => Promise<void>,
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<boolean> {
  const stored = await versions.getEmbedVersion()
  if (!needsReindex(stored, current)) return false

  // Snapshot only the pages that have old-model vectors to CONVERT. NULL-only (freshly
  // captured) pages are left for the normal drain.
  const pageIds = await store.pagesWithVectors()
  const total = pageIds.length
  for (let i = 0; i < pageIds.length; i++) {
    await store.clearVectorsForPage(pageIds[i]) // only this page leaves search
    await reembedPending() // drain re-embeds it (+ any newly captured chunks) -> searchable
    onProgress?.({ done: i + 1, total })
  }

  await versions.setEmbedVersion(current)
  return true
}
