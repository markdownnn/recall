import { useEffect, useRef, useState } from 'preact/hooks'
import type { AskAnswerDeltaMsg, AskAnswerDoneMsg, AskAnswerErrorMsg, AskAnswerQueriesMsg, MsgResult } from '../../messaging'
import type { AskAnswer, RankedResult } from '../../core/model'
import type { AskModelStatus } from '../../core/ask-model-status'
import { t } from './strings'
import { SUGGESTIONS, randomIndex } from './suggestions'
import { demoLinkFor } from '../onboarding/samples'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

// Search/Ask surface: one input, with the mode chosen by the top-level side-panel tab.
// The search card markup keeps <article> reserved for normal recall results.
export function SearchTab({
  initialMode = 'search',
  askModelStatus = { state: 'not-loaded', percent: 0 },
  onPrepareAskModel,
}: {
  initialMode?: 'search' | 'ask'
  askModelStatus?: AskModelStatus
  onPrepareAskModel?: () => void
}) {
  const mode = initialMode
  const askReady = askModelStatus.state === 'ready'
  const askModelDownloadable = askModelStatus.state === 'not-loaded' || askModelStatus.state === 'error'
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [answer, setAnswer] = useState<AskAnswer | null>(null)
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [expandedQueries, setExpandedQueries] = useState<string[]>([])
  const activeAskRequestId = useRef('')
  // Placeholder: pick ONE random suggestion on mount and keep it (no rotation). The index
  // math is pure (suggestions.ts).
  const [placeholder] = useState(() => SUGGESTIONS[randomIndex(SUGGESTIONS.length)])

  useEffect(() => {
    const onMessage = (msg: AskAnswerDeltaMsg | AskAnswerDoneMsg | AskAnswerErrorMsg | AskAnswerQueriesMsg) => {
      if (!msg || msg.requestId !== activeAskRequestId.current) return
      if (msg.type === 'ask-answer-delta') {
        setAnswer((prev) => ({ text: `${prev?.text ?? ''}${msg.text}`, sources: prev?.sources ?? [] }))
      } else if (msg.type === 'ask-answer-queries') {
        setExpandedQueries(msg.queries)
      } else if (msg.type === 'ask-answer-done') {
        setAnswer(msg.answer)
        setSearching(false)
      } else if (msg.type === 'ask-answer-error') {
        setSearchErr(msg.error)
        setSearching(false)
      }
    }
    chrome.runtime.onMessage.addListener(onMessage as any)
    return () => chrome.runtime.onMessage.removeListener(onMessage as any)
  }, [])

  const search = async () => {
    if (!q.trim() || searching) return
    if (mode === 'ask' && !askReady) return
    setSearching(true)
    setHasSearched(true)
    setSearchErr('')
    setExpandedQueries([])
    try {
      if (mode === 'ask') {
        setResults([])
        setAnswer(null)
        const requestId = crypto.randomUUID()
        activeAskRequestId.current = requestId
        const res: MsgResult = await chrome.runtime.sendMessage({
          type: 'ask-stream',
          requestId,
          text: q,
          retrieveK: 12,
          contextK: 8,
        })
        if (res.type === 'error') {
          setSearchErr(res.error)
          setSearching(false)
        }
        return
      } else {
        setAnswer(null)
        const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
        if (res.type === 'recalled') setResults(res.results)
        else if (res.type === 'error') setSearchErr(res.error)
      }
    } catch (e) {
      // Local hint only; the capture/index status line is owned by SidePanel.
      setSearchErr(mode === 'ask' ? t.askFailed(String(e)) : t.searchFailed(String(e)))
      setSearching(false)
    }
    setSearching(false)
  }

  return (
    <div class="searchtab">
      {mode === 'ask' && (
        <div class="askmodel">
          {askModelDownloadable && (
            <button
              class="linkbtn"
              type="button"
              onClick={onPrepareAskModel}
            >
              {t.downloadWebLlm}
            </button>
          )}
          <span class="hint">
            {askModelStatus.state === 'loading'
              ? t.webLlmLoading(askModelStatus.percent)
              : askModelStatus.state === 'error'
                ? askModelStatus.message
              : askReady
                ? t.webLlmReady
                : t.webLlmRequired}
          </span>
        </div>
      )}
      <div class="searchbar">
        <input
          type="search"
          value={q}
          disabled={mode === 'ask' && !askReady}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder={mode === 'ask' ? t.askPlaceholder : placeholder}
        />
        <button
          class="searchbtn"
          aria-label={mode === 'ask' ? t.askButtonAria : t.searchButtonAria}
          onClick={search}
          disabled={searching || (mode === 'ask' && !askReady)}
        >
          {mode === 'ask' ? t.askButtonLabel : t.searchButtonLabel}
        </button>
      </div>
      {searching && mode === 'ask' && !answer?.text && (
        <div class="answerloader" role="status" aria-label={t.answering}>
          <span class="answerloader-dot" />
          <span class="answerloader-dot" />
          <span class="answerloader-dot" />
        </div>
      )}
      {searching && mode === 'search' && <div class="hint">{t.searching}</div>}
      {searchErr && <div class="hint">{searchErr}</div>}
      {!searching && mode === 'search' && hasSearched && !searchErr && results.length === 0 && <div class="hint">{t.noResults}</div>}

      {mode === 'ask' && expandedQueries.length > 1 && (
        <div class="querychips" aria-label={t.triedSearches}>
          <span>{t.triedSearches}</span>
          {expandedQueries.map((query) => (
            <span class="querychip" key={query}>{query}</span>
          ))}
        </div>
      )}

      {mode === 'ask' && answer && (
        <div class="answerbox">
          <p>{answer.text}</p>
          {answer.sources.length > 0 && (
            <div class="answersources">
              {answer.sources.map((r) => (
                <div class="answersource" key={r.chunk.id}>
                  <a href={demoLinkFor(r.page.url)} target="_blank" rel="noopener noreferrer">
                    {r.page.title}
                  </a>
                  <p>{r.chunk.text}</p>
                </div>
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
