import { useState, useEffect, useRef } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import type { RankedResult } from '../../core/model'
import { t } from './strings'
import { SUGGESTIONS, randomIndex, nextIndex } from './suggestions'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

// Search hero: searchbox + accent Search button + rotating suggested-query placeholder +
// <article> result cards. The recall round-trip (k:5) and the card markup match the spike
// exactly so the e2e <article> + getByText asserts keep resolving.
export function SearchTab() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  // Rotating placeholder: random on mount, then a gentle 1-step rotation every ~5s while
  // the box is empty AND unfocused. The index math is pure (suggestions.ts); the timer +
  // focus/empty gating is glue.
  const [placeIdx, setPlaceIdx] = useState(() => randomIndex(SUGGESTIONS.length))
  const emptyRef = useRef(true)
  const focusedRef = useRef(false)

  useEffect(() => {
    const id = setInterval(() => {
      if (emptyRef.current && !focusedRef.current) {
        setPlaceIdx((cur) => nextIndex(cur, SUGGESTIONS.length))
      }
    }, 5000)
    return () => clearInterval(id)
  }, [])

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
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value
            emptyRef.current = v.trim() === ''
            setQ(v)
          }}
          onFocus={() => { focusedRef.current = true }}
          onBlur={() => { focusedRef.current = false }}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder={SUGGESTIONS[placeIdx]}
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
