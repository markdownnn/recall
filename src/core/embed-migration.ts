import type { VectorSearchPort } from './ports'
import { needsReindex } from './embed-version'

// The persisted embedding-model version, read/written around the corpus re-index.
export interface EmbedVersionStore {
  getEmbedVersion(): Promise<string | null>
  setEmbedVersion(version: string): Promise<void>
}

// If the stored embedding-model version differs from `current`, re-embed the whole corpus
// with granite - but ONE PAGE AT A TIME so search stays mostly alive. For each page we null
// its vectors (only that page leaves search) and immediately re-embed the now-pending chunks
// via `reembedPending` (the offscreen passes the real drain), so the page is searchable again
// before we touch the next one. `onProgress` reports {done,total} pages for the UI bar.
//
// Order matters for interrupt-safety: the new version is recorded only AFTER every page is
// done. A crash mid-run leaves some pages pending and the version unchanged, so the next
// launch simply re-runs the loop (re-nulling an already-migrated page and re-embedding it is
// wasted work but never wrong). Returns true when a re-index was triggered.
export async function migrateEmbeddingModel(
  store: Pick<VectorSearchPort, 'clearVectorsForPage' | 'recentPages'>,
  versions: EmbedVersionStore,
  current: string,
  reembedPending: () => Promise<void>,
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<boolean> {
  const stored = await versions.getEmbedVersion()
  if (!needsReindex(stored, current)) return false

  // Snapshot every page id. recentPages with a huge limit returns the whole corpus; order is
  // irrelevant here (every page gets re-embedded).
  const pages = await store.recentPages(Number.MAX_SAFE_INTEGER)
  const total = pages.length
  for (let i = 0; i < pages.length; i++) {
    await store.clearVectorsForPage(pages[i].id) // only this page leaves search
    await reembedPending() // drain re-embeds it (+ any newly captured chunks) -> searchable
    onProgress?.({ done: i + 1, total })
  }

  await versions.setEmbedVersion(current)
  return true
}
