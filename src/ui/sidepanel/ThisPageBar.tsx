import { useState, useEffect, useRef } from 'preact/hooks'
import type { MsgResult, IndexingProgressMsg } from '../../messaging'
import { siteHost } from '../../core/site-host'
import { isCapturableUrl } from '../../core/is-capturable-url'
import { t } from './strings'

// The active tab the bar is reflecting. Title is shown as the primary line; host is the
// secondary label and the target of the SITE-scoped controls.
interface ActiveTab { url: string; host: string; title: string }

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return '' }
}

// Active-tab-reactive "this page" bar. Shows TITLE + host + a PAGE-scoped SAVED badge and
// Capture, plus the SITE-scoped privacy controls (Pause / Don't remember / Forget / the
// no-remember list). The combined capture/index status is NOT owned here - the Capture
// button fires the `onCapture` prop and SidePanel renders the one status line. Uses no
// <article> element (that tag is reserved for SearchTab result cards).
export function ThisPageBar({ onCapture, refreshSignal }: { onCapture: () => void; refreshSignal: number }) {
  const [tab, setTab] = useState<ActiveTab>({ url: '', host: '', title: '' })
  // False until the FIRST active-tab query resolves. The seed url is '' (isCapturableUrl('')
  // is false), so without this gate the button would flash the disabled "Can't save this page"
  // error state for a beat before the real tab loads. While unresolved we show a NEUTRAL
  // disabled "Capture this page" instead of the wrong error.
  const [resolved, setResolved] = useState(false)
  const [saved, setSaved] = useState(false)
  // True while THIS exact page still has un-embedded chunks (page-pending). Drives the
  // "Saving..." button/badge state. Per-page: a background drain of OTHER pages re-queries
  // THIS tab, finds it not pending, and leaves the bar unchanged.
  const [pending, setPending] = useState(false)
  const [userDenyHosts, setUserDenyHosts] = useState<string[]>([])
  const [denyStatus, setDenyStatus] = useState('')
  // Tracks the url of the MOST RECENT refresh. On a rapid tab switch an older has-page
  // round-trip can resolve after a newer one started; we ignore any response whose url is
  // no longer the active one, so the badge never shows a stale page's saved-state.
  const latestUrlRef = useRef('')

  const refreshActiveTab = async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
    const url = active?.url ?? ''
    const urlChanged = url !== latestUrlRef.current
    latestUrlRef.current = url
    const next: ActiveTab = { url, host: hostOf(url), title: active?.title ?? '' }
    setTab(next)
    setResolved(true) // the real tab is known now; the button can leave its neutral loading state
    // On a real tab SWITCH, drop the previous tab's save-state IMMEDIATELY so the bar never
    // flashes another page's "saved"/"Saving..." while this tab's has-page/page-pending queries
    // are still in flight. Each tab thus shows only its OWN state, with zero carryover.
    if (urlChanged) { setSaved(false); setPending(false) }

    // Save-state READ: send the RAW tab url; the offscreen applies sanitizeUrl+pageIdFromUrl so
    // the id can never drift from what capture stored. Skip non-http(s) tabs.
    if (!isCapturableUrl(url)) { setSaved(false); setPending(false); return }
    try {
      const [hp, pp]: MsgResult[] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'has-page', url }),
        chrome.runtime.sendMessage({ type: 'page-pending', url }),
      ])
      // Out-of-order guard: the active url changed while we were waiting; drop this answer so a
      // slow response for a PREVIOUS tab can never overwrite the CURRENT tab's state.
      if (latestUrlRef.current !== url) return
      setSaved(hp?.type === 'page-status' ? hp.exists : false)
      setPending(pp?.type === 'page-pending-status' ? pp.pending : false)
    } catch {
      if (latestUrlRef.current !== url) return
      setSaved(false)
      setPending(false)
    }
  }

  useEffect(() => {
    // Seed the no-remember list so the "Don't remember this site" button can show whether the
    // CURRENT host is already blocked. The global Pause toggle and the full editable list now
    // live in the Settings tab; this bar keeps only the per-page/per-site actions.
    chrome.runtime.sendMessage({ type: 'get-settings' }).then((res: MsgResult) => {
      if (res?.type === 'settings') setUserDenyHosts(res.userDenyHosts)
    }).catch(() => {})

    // Active-tab reactivity: refresh on mount and whenever the user switches or reloads
    // tabs (the panel persists, unlike the popup).
    void refreshActiveTab()
    const onActivated = () => void refreshActiveTab()
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo, tabArg: chrome.tabs.Tab) => {
      if (tabArg.active && (info.status === 'complete' || info.url)) void refreshActiveTab()
    }
    // As the background drain makes progress, re-check THIS tab's pending state so the button
    // settles "Saving..." -> "saved"/"Update this page" the moment its last chunk embeds. A
    // drain of OTHER pages re-queries this tab, finds it not pending, and leaves the bar as-is.
    const onMessage = (msg: IndexingProgressMsg | { type?: string }) => {
      if (msg?.type === 'indexing-progress') void refreshActiveTab()
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.runtime.onMessage.addListener(onMessage)
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.runtime.onMessage.removeListener(onMessage)
    }
  }, [])

  // After a capture, SidePanel bumps refreshSignal; re-query the badge for the current tab
  // so it flips to "saved" without the user switching tabs. Skip the initial 0 (mount
  // already queried above).
  useEffect(() => {
    if (refreshSignal > 0) void refreshActiveTab()
  }, [refreshSignal])

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

  // Can this exact tab host a content script? Non-http(s)/file schemes (chrome://, extension
  // pages, new-tab) can't, so the Capture button is DISABLED + grayed and never fires - this
  // proactively prevents the "Receiving end does not exist" error. Internal/intranet http
  // hosts ARE capturable-by-manual, so they stay active "Capture this page".
  const capturable = isCapturableUrl(tab.url)

  // Is THIS host already on the no-remember list? Compare the registrable form (the same
  // siteHost(...) the deny/forget logic derives) against state - never sniff English
  // status strings, so the label stays correct under i18n.
  const hostDenied = tab.host !== '' && userDenyHosts.includes(siteHost(tab.host))

  // PAGE-scoped save state for THIS exact tab. `pending` (un-embedded chunks) WINS so the bar
  // reads "Saving..." while a just-captured page indexes, then settles to saved/not-saved.
  const badgeClass = pending ? 'badge saving' : saved ? 'badge saved' : 'badge'
  const badgeLabel = pending ? t.saving : saved ? t.savedBadge : t.notSavedBadge
  const buttonClass = !resolved ? 'capture'
    : !capturable ? 'capture disabled'
    : pending ? 'capture saving'
    : saved ? 'capture saved'
    : 'capture'
  const buttonLabel = !resolved ? t.captureButton
    : !capturable ? t.cannotCaptureButton
    : pending ? t.saving
    : saved ? t.updateButton
    : t.captureButton

  return (
    <div class="thispage">
      <div class="page-head">
        <div class="page-id">
          <div class="page-title">{primary}</div>
          {tab.host && <div class="page-host">{tab.host}</div>}
        </div>
        <span class={badgeClass}>{badgeLabel}</span>
      </div>

      {/* PAGE-scoped: acts on THIS exact URL. Non-capturable scheme -> DISABLED + gray; while it
          indexes -> "Saving..." (disabled); already-saved -> "Update" + faded; else "Capture". */}
      <div class="page-actions">
        <button
          class={buttonClass}
          disabled={!resolved || !capturable || pending}
          onClick={onCapture}
        >
          {buttonLabel}
        </button>
      </div>
      {pending && <div class="note">{t.savingHint}</div>}

      {/* SITE-scoped: acts on the HOST. Per-page/per-site only - the global Pause toggle and
          the editable no-remember list live in the Settings tab. */}
      <div class="site-actions">
        <div class="toolbar">
          <button class="linkbtn" onClick={denyHost}>
            {hostDenied ? t.alreadyOnListShort : t.dontRememberSite}
          </button>
          <button class="linkbtn danger" onClick={forgetHost}>{t.forgetSiteHistory}</button>
        </div>
        {denyStatus && <div class="note">{denyStatus}</div>}
      </div>
    </div>
  )
}
