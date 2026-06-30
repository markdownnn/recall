import { useState } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import type { RankedResult } from '../../core/model'
import { t } from './strings'
import { SUGGESTIONS, randomIndex } from './suggestions'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

// Search hero: searchbox + accent Search button + a suggested-query placeholder +
// <article> result cards. The recall round-trip (k:5) and the card markup match the spike
// exactly so the e2e <article> + getByText asserts keep resolving.
export function SearchTab() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  // Placeholder: pick ONE random suggestion on mount and keep it (no rotation). The index
  // math is pure (suggestions.ts).
  const [placeholder] = useState(() => SUGGESTIONS[randomIndex(SUGGESTIONS.length)])

  const search = async () => {
    if (!q.trim() || searching) return
    setSearching(true)
    setHasSearched(true)
    setSearchErr('')
    try {
      const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
      if (res.type === 'recalled') setResults(res.results)
      else if (res.type === 'error') setSearchErr(res.error)
    } catch (e) {
      // Local hint only; the capture/index status line is owned by SidePanel.
      setSearchErr(t.searchFailed(String(e)))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div class="searchtab">
      <div class="searchbar">
        <input
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder={placeholder}
        />
        <button class="searchbtn" aria-label={t.searchButtonAria} onClick={search}>
          {t.searchButtonLabel}
        </button>
      </div>
      {searching && <div class="hint">{t.searching}</div>}
      {searchErr && <div class="hint">{searchErr}</div>}
      {!searching && hasSearched && !searchErr && results.length === 0 && <div class="hint">{t.noResults}</div>}

      {results.length > 0 && (
        <div class="results">
          {results.map((r) => (
            <article class="card" key={r.chunk.id}>
              <a href={r.page.url} target="_blank" rel="noopener noreferrer">{r.page.title}</a>
              <p>{r.chunk.text}</p>
              <div class="meta">{hostOf(r.page.url)} &middot; {r.score.toFixed(2)}</div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
