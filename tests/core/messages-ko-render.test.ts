// Deterministic proof of the LIVE Korean render chain: component -> `t` facade ->
// chrome.i18n.getMessage -> ko/messages.json. The only other test exercising this end to end is
// tests/e2e/ko-locale.spec.ts, which test.skips on macOS (and can vacuously skip on CI), so a
// facade regression that breaks the KO path without touching messages.json would ship GREEN.
// Here we STUB chrome.i18n.getMessage to resolve keys against the SHIPPED ko/messages.json (with
// the same placeholder substitution chrome does), then drive the REAL `t` facade and assert it
// renders the Korean strings - so the wiring is exercised on every runner, browser-free.
//
// ASCII-only by construction: we never hardcode a Korean literal. We read both shipped locale
// files and compare `t` against the ko VALUES (proving KO resolved) and against the en values
// (proving it is NOT the English fallback) - no charset-fragile literal in this source.

import { beforeAll, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

type Entry = { message: string; placeholders?: Record<string, { content: string }> }
type Messages = Record<string, Entry>

const root = path.resolve(__dirname, '../..')
const en = JSON.parse(readFileSync(path.join(root, 'public/_locales/en/messages.json'), 'utf8')) as Messages
const ko = JSON.parse(readFileSync(path.join(root, 'public/_locales/ko/messages.json'), 'utf8')) as Messages

// Mirror chrome.i18n.getMessage: replace each $name$ with the substitution its content ("$1")
// points at, inserted LITERALLY via a function replacer (so $ sequences are not reinterpreted).
function render(entry: Entry, subs: string[]): string {
  let out = entry.message
  for (const [name, def] of Object.entries(entry.placeholders ?? {})) {
    const idx = Number(def.content.replace('$', '')) - 1
    const value = subs[idx] ?? ''
    out = out.replace(new RegExp('\\$' + name + '\\$', 'gi'), () => value)
  }
  return out
}

// Install the stub BEFORE the facade is imported (its static entries resolve at module load).
;(globalThis as { chrome?: unknown }).chrome = {
  i18n: {
    getMessage: (key: string, subs?: string | string[]): string => {
      const entry = ko[key]
      if (!entry) return ''
      const arr = Array.isArray(subs) ? subs : subs == null ? [] : [subs]
      return render(entry, arr)
    },
  },
}

// Dynamic import so the facade evaluates AFTER the chrome stub exists; importing statically would
// snapshot the EN fallback before the stub is in place.
let t: typeof import('../../src/ui/sidepanel/strings').t
beforeAll(async () => {
  ;({ t } = await import('../../src/ui/sidepanel/strings'))
})

// Scenario: a facade change (e.g. msg() stops calling chrome.i18n, or a key is misspelled) breaks
// the KO path while messages.json is untouched; without this it only shows on a Korean browser.
// A STATIC key must render the Korean string, not the English fallback.
// Coverage: integration (real `t` facade over a chrome.i18n stub backed by shipped ko messages).
test('static key renders the Korean message through the live facade', () => {
  expect(t.captureButton).toBe(ko.captureButton.message)
  expect(t.captureButton).not.toBe(en.captureButton.message)
})

// Scenario: a placeholder regression (dropped/renamed $host$, or the facade passing args wrong)
// makes a dynamic Korean string render a blank or a literal "$host$". Drive the real dynamic
// accessor and assert the Korean message renders with the argument substituted.
// Coverage: integration (real `t` facade dynamic accessor over the ko-backed stub).
test('dynamic placeholder key renders Korean with the argument substituted', () => {
  const HOST = 'example.com'
  const got = t.wonRemember(HOST)
  expect(got).toBe(render(ko.wonRemember, [HOST]))      // exact ko render
  expect(got).toContain(HOST)                            // argument landed
  expect(got).not.toMatch(/\$[a-z]+\$/i)                 // no leftover $name$ token
  expect(got).not.toBe(render(en.wonRemember, [HOST]))   // not the English fallback
})
