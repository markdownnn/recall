import { useState, useEffect, useRef } from 'preact/hooks'
import type { OnboardingSection } from './sections'
import { DEMO_HOST, demoLinkFor } from './samples'
import type { MsgResult } from '../../messaging'
import type { RankedResult } from '../../core/model'
import { t } from '../sidepanel/strings'

type Phase = 'idle' | 'seeding' | 'seeded'

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export function TryItCard({ section }: { section: Extract<OnboardingSection, { kind: 'try-it' }> }) {
  const [phase, setPhase] = useState<Phase>('idle')
  // True once all capture-text sends have resolved; we then wait for the drain-done event.
  const sentRef = useRef(false)

  // Search state (only used once seeded).
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RankedResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  // Remove-demo state.
  const [removed, setRemoved] = useState(false)

  useEffect(() => {
    // The SW broadcasts {type:'indexing-progress', pending, embedded}; pending===0 means the
    // drain finished. Only flip to 'seeded' AFTER we have sent (sentRef), so an unrelated idle
    // broadcast cannot mark us seeded early.
    const listener = (msg: { type?: string; pending?: number }) => {
      if (msg?.type === 'indexing-progress' && msg.pending === 0 && sentRef.current) {
        setPhase('seeded')
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const seed = async () => {
    if (phase === 'seeding') return
    setPhase('seeding')
    for (const s of section.samples) {
      const res: MsgResult = await chrome.runtime.sendMessage({
        type: 'capture-text', url: s.url, title: s.title, text: s.text,
      })
      if (res?.type === 'error') { setPhase('idle'); return }
    }
    sentRef.current = true
    // If embedding is already warm the drain can finish before the listener attaches; the
    // listener also catches the later pending===0 broadcast, so seeded is reached either way.
  }

  const runSearch = async (text: string) => {
    if (!text.trim() || searching) return
    setSearching(true)
    setHasSearched(true)
    try {
      const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recall', text, k: 5 })
      if (res.type === 'recalled') setResults(res.results)
    } finally {
      setSearching(false)
    }
  }

  const removeDemo = async () => {
    await chrome.runtime.sendMessage({ type: 'forget-host', host: DEMO_HOST })
    setRemoved(true)
  }

  // A result's page.url is the recall-demo storage url (a fake host that 404s on click).
  // demoLinkFor maps it back to the sample's REAL sourceUrl so the link opens a live page
  // (shared with the real search/history). Storage + "Remove demo data" still key on the demo url.

  return (
    <section class="card section">
      <h2>{t.obTryTitle}</h2>
      <p>{t.obTryText}</p>

      <ul class="sample-list">
        {section.samples.map((s) => <li key={s.url}>{s.title}</li>)}
      </ul>

      {phase !== 'seeded' && (
        <button class="primary" disabled={phase === 'seeding'} onClick={() => void seed()}>
          {phase === 'seeding' ? t.obSeeding : t.obSeedButton}
        </button>
      )}

      {phase === 'seeded' && (
        <>
          <p class="demo-status">{t.obSeeded}</p>

          <div class="chips">
            {section.exampleQueries.map((eq) => (
              <button class="chip" key={eq} onClick={() => { setQ(eq); void runSearch(eq) }}>{eq}</button>
            ))}
          </div>

          <div class="searchbar">
            <input
              type="search"
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch(q)}
              placeholder={t.obSearchPlaceholder}
            />
            <button class="searchbtn" aria-label={t.searchButtonAria} onClick={() => runSearch(q)}>
              {t.searchButtonLabel}
            </button>
          </div>

          {searching && <div class="hint">{t.searching}</div>}
          {!searching && hasSearched && results.length === 0 && <div class="hint">{t.noResults}</div>}

          {results.length > 0 && (
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

          {!removed
            ? <button class="linkbtn" onClick={() => void removeDemo()}>{t.obRemoveDemo}</button>
            : <span class="demo-status">{t.obDemoRemoved}</span>}
        </>
      )}
    </section>
  )
}
