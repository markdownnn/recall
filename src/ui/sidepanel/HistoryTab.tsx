import { useState, useEffect } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import type { CapturedPage } from '../../core/model'
import { t } from './strings'
import { relativeTime } from './relative-time'

const PAGE_SIZE = 20

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

// Browse view: reverse-chronological list of captured pages, paged by the capturedAt
// keyset cursor. Distinct from Search - this is "show me everything I saved, newest first".
export function HistoryTab() {
  const [pages, setPages] = useState<CapturedPage[]>([])
  const [loaded, setLoaded] = useState(false)   // first fetch resolved (drives empty state)
  const [done, setDone] = useState(false)       // last fetch returned < PAGE_SIZE -> no more
  const [loading, setLoading] = useState(false)

  const fetchPage = async (beforeTs?: number) => {
    if (loading) return
    setLoading(true)
    try {
      const res: MsgResult = await chrome.runtime.sendMessage({ type: 'recent-pages', limit: PAGE_SIZE, beforeTs })
      if (res.type === 'pages') {
        setPages((cur) => beforeTs === undefined ? res.pages : [...cur, ...res.pages])
        if (res.pages.length < PAGE_SIZE) setDone(true)
      }
    } catch {
      // Local-only: the capture/index status line is owned by SidePanel; a failed browse
      // just leaves the list as-is.
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }

  useEffect(() => { fetchPage() }, [])

  const loadMore = () => {
    if (pages.length === 0) return
    fetchPage(pages[pages.length - 1].capturedAt)
  }

  const now = Date.now()
  return (
    <div class="historytab">
      {loaded && pages.length === 0 && <div class="hint">{t.historyEmpty}</div>}
      {pages.length > 0 && (
        <div class="results">
          {pages.map((p) => (
            <article class="card" key={p.id}>
              <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title || p.url}</a>
              <div class="meta">{hostOf(p.url)} &middot; {relativeTime(p.capturedAt, now)}</div>
            </article>
          ))}
        </div>
      )}
      {pages.length > 0 && !done && (
        <button class="linkbtn loadmore" onClick={loadMore} disabled={loading}>{t.loadMore}</button>
      )}
    </div>
  )
}
