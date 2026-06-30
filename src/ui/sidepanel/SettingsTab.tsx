import { useState, useEffect, useRef } from 'preact/hooks'
import type { MsgResult } from '../../messaging'
import { t } from './strings'

// Settings tab: the home for GLOBAL controls that are not tied to the current page. Today that
// is (1) Pause capturing - a single global switch, moved here OUT of the per-page bar so the
// app has exactly one place to turn saving on/off; and (2) the no-remember list - every site
// the user blocked via "Don't remember this site", each removable to start saving it again.
// Both read/write the SAME settings ops the rest of the app uses (get-settings / set-paused /
// remove-deny-host), so this tab is a view onto shared state, not a second source of truth.
export function SettingsTab() {
  const [paused, setPaused] = useState(false)
  const [denyHosts, setDenyHosts] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)  // first get-settings resolved (drives empty state)
  const [status, setStatus] = useState('')
  // True once the user has toggled Pause themselves. The mount get-settings is async; if the user
  // clicks BEFORE it resolves, setPaused(res.paused) would clobber their click with the stale DB
  // value. This guard makes a user toggle win the race - the mount setter then leaves it alone.
  const pauseTouched = useRef(false)

  // Fetch on mount: the tab remounts each time the user selects it (SidePanel renders it
  // conditionally), so this always shows the CURRENT settings - including a site just blocked
  // from the per-page bar - without any cross-component subscription.
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'get-settings' }).then((res: MsgResult) => {
      if (res?.type === 'settings') {
        if (!pauseTouched.current) setPaused(res.paused)
        setDenyHosts(res.userDenyHosts)
      }
    }).catch(() => {}).finally(() => setLoaded(true))
  }, [])

  const togglePause = async (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked
    pauseTouched.current = true
    setPaused(checked)
    await chrome.runtime.sendMessage({ type: 'set-paused', paused: checked }).catch(() => {})
  }

  // Un-block a site: await the real round-trip (SW -> offscreen -> SQLite DELETE) before
  // dropping the row from the list, so the list only loses a host once the delete committed.
  const removeDeny = async (h: string) => {
    let res: MsgResult
    try {
      res = await chrome.runtime.sendMessage({ type: 'remove-deny-host', host: h })
    } catch {
      setStatus(t.couldNotRemove)
      return
    }
    if (res?.type !== 'ok') {
      setStatus(t.couldNotRemove)
      return
    }
    setStatus('')
    setDenyHosts((prev) => prev.filter((x) => x !== h))
  }

  return (
    <div class="settingstab">
      <section class="setting-section">
        <h2 class="setting-heading">{t.settingsCaptureHeading}</h2>
        <label class="toggle">
          <span class="switch">
            <input type="checkbox" checked={paused} onChange={togglePause} />
            <span class="track" />
          </span>
          {t.pauseLabel}
        </label>
        <p class="setting-help">{t.pauseHelp}</p>
      </section>

      <section class="setting-section">
        <h2 class="setting-heading">{t.noRememberSitesHeader}</h2>
        <p class="setting-help">{t.denylistHelp}</p>
        {loaded && denyHosts.length === 0 && <p class="hint">{t.denylistEmpty}</p>}
        {denyHosts.length > 0 && (
          <div class="denylist">
            {denyHosts.map((h) => (
              <div class="denyrow" key={h}>
                <span>{h}</span>
                <button class="linkbtn" onClick={() => removeDeny(h)}>{t.removeLabel}</button>
              </div>
            ))}
          </div>
        )}
        {status && <div class="note">{status}</div>}
      </section>
    </div>
  )
}
