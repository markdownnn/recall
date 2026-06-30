import { useState, useEffect } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import { siteHost } from '../../core/site-host'
import { t } from './strings'

// The active tab the bar is reflecting. Title is shown as the primary line; host is the
// secondary label and the target of the SITE-scoped controls.
interface ActiveTab { url: string; host: string; title: string }

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return '' }
}

// The SAVED badge only round-trips for pages capture can actually store: http(s) and
// local file:// pages (the content script matches <all_urls>, so a file:// article is
// captured and SHOULD read SAVED). chrome://, extension, and blank/restricted tabs are
// never captured, so skip the round-trip for them.
function isCapturable(url: string | undefined): boolean {
  if (!url) return false
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:' || p === 'file:'
  } catch { return false }
}

// Active-tab-reactive "this page" bar. Shows TITLE + host + a PAGE-scoped SAVED badge and
// Capture, plus the SITE-scoped privacy controls (Pause / Don't remember / Forget / the
// no-remember list). The combined capture/index status is NOT owned here - the Capture
// button fires the `onCapture` prop and SidePanel renders the one status line. Uses no
// <article> element (that tag is reserved for SearchTab result cards).
export function ThisPageBar({ onCapture, refreshSignal }: { onCapture: () => void; refreshSignal: number }) {
  const [tab, setTab] = useState<ActiveTab>({ url: '', host: '', title: '' })
  const [saved, setSaved] = useState(false)
  const [paused, setPaused] = useState(false)
  const [userDenyHosts, setUserDenyHosts] = useState<string[]>([])
  const [denyStatus, setDenyStatus] = useState('')

  const refreshActiveTab = async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
    const url = active?.url ?? ''
    const next: ActiveTab = { url, host: hostOf(url), title: active?.title ?? '' }
    setTab(next)

    // Badge READ: send the RAW tab url; the offscreen applies sanitizeUrl+pageIdFromUrl so
    // the id can never drift from what capture stored. Skip non-http(s) tabs.
    if (!isCapturable(url)) { setSaved(false); return }
    try {
      const res: MsgResult = await chrome.runtime.sendMessage({ type: 'has-page', url })
      setSaved(res?.type === 'page-status' ? res.exists : false)
    } catch {
      setSaved(false)
    }
  }

  useEffect(() => {
    // Seed pause + the no-remember list (moved here from the popup root, unchanged).
    chrome.runtime.sendMessage({ type: 'get-settings' }).then((res: MsgResult) => {
      if (res?.type === 'settings') {
        setPaused(res.paused)
        setUserDenyHosts(res.userDenyHosts)
      }
    }).catch(() => {})

    // Active-tab reactivity: refresh on mount and whenever the user switches or reloads
    // tabs (the panel persists, unlike the popup).
    void refreshActiveTab()
    const onActivated = () => void refreshActiveTab()
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo, tabArg: chrome.tabs.Tab) => {
      if (tabArg.active && (info.status === 'complete' || info.url)) void refreshActiveTab()
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [])

  // After a capture, SidePanel bumps refreshSignal; re-query the badge for the current tab
  // so it flips to "saved" without the user switching tabs. Skip the initial 0 (mount
  // already queried above).
  useEffect(() => {
    if (refreshSignal > 0) void refreshActiveTab()
  }, [refreshSignal])

  const togglePause = async (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked
    setPaused(checked)
    await chrome.runtime.sendMessage({ type: 'set-paused', paused: checked }).catch(() => {})
  }

  const denyHost = async () => {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      const host = siteHost(new URL(active.url!).hostname)
      if (userDenyHosts.includes(host)) {
        setDenyStatus(t.alreadyOnListHost(host))
        return
      }
      let res: MsgResult
      try {
        res = await chrome.runtime.sendMessage({ type: 'deny-host', host })
      } catch {
        setDenyStatus(t.couldNotAdd)
        return
      }
      if (res?.type !== 'ok') {
        setDenyStatus(t.couldNotAdd)
        return
      }
      setUserDenyHosts((prev) => [...prev, host])
      setDenyStatus(t.wonRemember(host))
    } catch {
      setDenyStatus(t.restrictedTabAdd)
    }
  }

  const removeDeny = async (h: string) => {
    let res: MsgResult
    try {
      res = await chrome.runtime.sendMessage({ type: 'remove-deny-host', host: h })
    } catch {
      setDenyStatus(t.couldNotRemove)
      return
    }
    if (res?.type !== 'ok') {
      setDenyStatus(t.couldNotRemove)
      return
    }
    setUserDenyHosts((prev) => prev.filter((x) => x !== h))
  }

  const forgetHost = async () => {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      const host = siteHost(new URL(active.url!).hostname)
      if (!window.confirm(t.forgetConfirm(host))) return
      let res: MsgResult
      try {
        res = await chrome.runtime.sendMessage({ type: 'forget-host', host })
      } catch {
        setDenyStatus(t.couldNotForget)
        return
      }
      if (res?.type !== 'ok') {
        setDenyStatus(t.couldNotForget)
        return
      }
      setDenyStatus(t.forgotEverythingFrom(host))
    } catch {
      setDenyStatus(t.restrictedTabForget)
    }
  }

  // PRIMARY line falls back to host, then url, so the bar is never blank.
  const primary = tab.title || tab.host || tab.url

  return (
    <div class="thispage">
      <div class="page-head">
        <div class="page-id">
          <div class="page-title">{primary}</div>
          {tab.host && <div class="page-host">{tab.host}</div>}
        </div>
        <span class={saved ? 'badge saved' : 'badge'}>{saved ? t.savedBadge : t.notSavedBadge}</span>
      </div>

      {/* PAGE-scoped: acts on THIS exact URL. */}
      <div class="page-actions">
        <button class="capture" onClick={onCapture}>{t.captureButton}</button>
      </div>

      {/* SITE-scoped: acts on the HOST. */}
      <div class="site-actions">
        <label class="toggle">
          <span class="switch">
            <input type="checkbox" checked={paused} onChange={togglePause} />
            <span class="track" />
          </span>
          {t.pauseLabel}
        </label>
        {paused && <div class="note paused">{t.pausedNote}</div>}

        <div class="toolbar">
          <button class="linkbtn" onClick={denyHost}>
            {userDenyHosts.length > 0 && denyStatus.startsWith('Already') ? t.alreadyOnListShort : t.dontRememberSite}
          </button>
          <button class="linkbtn danger" onClick={forgetHost}>{t.forgetSiteHistory}</button>
        </div>
        {denyStatus && <div class="note">{denyStatus}</div>}

        {userDenyHosts.length > 0 && (
          <div class="denylist">
            <div class="denylist-head">{t.noRememberSitesHeader}</div>
            {userDenyHosts.map((h) => (
              <div class="denyrow" key={h}>
                <span>{h}</span>
                <button class="linkbtn" onClick={() => removeDeny(h)}>{t.removeLabel}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
