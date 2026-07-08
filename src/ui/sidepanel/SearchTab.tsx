import { useState } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import type { AskAnswer, RankedResult } from '../../core/model'
import { t } from './strings'
import { SUGGESTIONS, randomIndex } from './suggestions'
import { demoLinkFor } from '../onboarding/samples'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

// Search/Ask surface: one input, a small mode switch, and either result cards or an answer.
// The search card markup keeps <article> reserved for normal recall results.
export function SearchTab() {
  const [mode, setMode] = useState<'search' | 'ask'>('search')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [answer, setAnswer] = useState<AskAnswer | null>(null)
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
      if (mode === 'ask') {
        setResults([])
        setAnswer(null)
        const res: MsgResult = await chrome.runtime.sendMessage({
          type: 'ask',
          text: q,
          retrieveK: 12,
          contextK: 8,
        })
        if (res.type === 'asked') setAnswer(res.answer)
        else if (res.type === 'error') setSearchErr(res.error)
      } else {
        setAnswer(null)
        const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
        if (res.type === 'recalled') setResults(res.results)
        else if (res.type === 'error') setSearchErr(res.error)
      }
    } catch (e) {
      // Local hint only; the capture/index status line is owned by SidePanel.
      setSearchErr(mode === 'ask' ? t.askFailed(String(e)) : t.searchFailed(String(e)))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div class="searchtab">
      <div class="modebar" role="group" aria-label="Search mode">
        <button
          class={`mode ${mode === 'search' ? 'active' : ''}`}
          type="button"
          onClick={() => setMode('search')}
        >
          {t.searchTabLabel}
        </button>
        <button
          class={`mode ${mode === 'ask' ? 'active' : ''}`}
          type="button"
          onClick={() => setMode('ask')}
        >
          {t.askModeLabel}
        </button>
      </div>
      <div class="searchbar">
        <input
          type="search"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder={mode === 'ask' ? t.askPlaceholder : placeholder}
        />
        <button
          class="searchbtn"
          aria-label={mode === 'ask' ? t.askButtonAria : t.searchButtonAria}
          onClick={search}
          disabled={searching}
        >
          {mode === 'ask' ? t.askButtonLabel : t.searchButtonLabel}
        </button>
      </div>
      {searching && <div class="hint">{mode === 'ask' ? t.answering : t.searching}</div>}
      {searchErr && <div class="hint">{searchErr}</div>}
      {!searching && mode === 'search' && hasSearched && !searchErr && results.length === 0 && <div class="hint">{t.noResults}</div>}

      {mode === 'ask' && answer && (
        <div class="answerbox">
          <p>{answer.text}</p>
          {answer.sources.length > 0 && (
            <div class="answersources">
              {answer.sources.map((r) => (
                <a href={demoLinkFor(r.page.url)} target="_blank" rel="noopener noreferrer" key={r.chunk.id}>
                  {r.page.title}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === 'search' && results.length > 0 && (
        <div class="results">
          {results.map((r) => (
            <article class="card" key={r.chunk.id}>
              <a href={demoLinkFor(r.page.url)} target="_blank" rel="noopener noreferrer">{r.page.title}</a>
              <p>{r.chunk.text}</p>
              <div class="meta">{hostOf(demoLinkFor(r.page.url))}</div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
