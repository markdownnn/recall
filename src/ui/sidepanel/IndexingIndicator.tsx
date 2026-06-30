import { t } from './strings'

// Indeterminate progress indicator shown WHILE the background drain is embedding chunks.
// Indexing has NO known total (the pending count can still grow as more pages are captured),
// so a percentage would lie. Instead we show an indeterminate sliding indigo bar, a small
// pulsing sparkle for liveliness, and the live `done` count. The label reuses the existing
// `t.indexingProgress(n)` string so the rendered text still contains "indexing" + the count
// (the e2e waits match `/captured|indexing/i`). Driven purely by the `done` prop.
export function IndexingIndicator({ done }: { done: number }) {
  return (
    <div class="indexing" role="status" aria-live="polite" aria-label={t.indexingAria}>
      <div class="indexing-bar" aria-hidden="true">
        <div class="indexing-fill" />
      </div>
      <div class="indexing-meta">
        <span class="indexing-spark" aria-hidden="true">{'✦'}</span>
        <span class="indexing-label">{t.indexingProgress(done)}</span>
      </div>
    </div>
  )
}
