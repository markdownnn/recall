// Korean locale completeness + correctness, validated against the EXACT files the extension
// ships (public/_locales/{en,ko}/messages.json). This is the machine-independent proof of the
// KO path: chrome.i18n resolves a key against ko/messages.json, so every EN key must exist in
// ko with the same placeholder shape, or a Korean Chrome would silently fall back to English
// (or render a broken placeholder). The browser-locale switch itself is exercised by the
// ko-locale e2e where the platform can force the message locale.
//
// ASCII-only by construction: we never hardcode a Korean literal. We read both shipped files
// and assert STRUCTURE (key/placeholder parity, substitution, non-emptiness) plus the fact
// that translatable labels actually differ from English - so no charset-fragile comparison.

import { readFileSync } from 'node:fs'
import path from 'node:path'

type Entry = { message: string; placeholders?: Record<string, { content: string }> }
type Messages = Record<string, Entry>

const root = path.resolve(__dirname, '../..')
const en = JSON.parse(readFileSync(path.join(root, 'public/_locales/en/messages.json'), 'utf8')) as Messages
const ko = JSON.parse(readFileSync(path.join(root, 'public/_locales/ko/messages.json'), 'utf8')) as Messages

// Scenario: a contributor adds an EN string but forgets the Korean one; a Korean Chrome then
// silently shows English for that key. This pins ko to cover EXACTLY the same keys as en.
// Coverage: integration (real shipped messages.json files).
test('ko covers exactly the same message keys as en', () => {
  expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort())
})

// Scenario: a Korean message drops or renames a $placeholder$ that the facade substitutes,
// so chrome.i18n renders a literal "$host$" or an empty slot. This pins ko placeholders to
// match en's name->content map for every key.
// Coverage: integration (real shipped messages.json files).
test('ko placeholders match en for every key', () => {
  for (const key of Object.keys(en)) {
    expect(ko[key].placeholders ?? null, key).toEqual(en[key].placeholders ?? null)
  }
})

// Scenario: a Korean message is present but empty, rendering a blank label. Pin every ko
// message as a non-empty string.
// Coverage: integration (real shipped messages.json files).
test('every ko message is a non-empty string', () => {
  for (const key of Object.keys(ko)) {
    expect(typeof ko[key].message, key).toBe('string')
    expect(ko[key].message.length, key).toBeGreaterThan(0)
  }
})

// Scenario: ko was copy-pasted from en (machine left untranslated). Sanity-check that the
// user-facing tab labels actually differ from English, while the product NAME stays "Recall".
// (Compares against en values read from the file - no hardcoded Korean.)
// Coverage: integration (real shipped messages.json files).
test('translatable labels are translated, brand stays Recall', () => {
  expect(ko.brand.message).toBe(en.brand.message) // product name, intentionally identical
  for (const key of ['searchTabLabel', 'historyTabLabel', 'settingsTabLabel', 'captureButton', 'savedBadge']) {
    expect(ko[key].message, key).not.toBe(en[key].message)
  }
})

// Scenario: a placeholder's content ("$1") points past the args the facade passes, so the
// substituted value never lands. Replicate chrome.i18n substitution on the ko entries that
// take args and assert the arg appears and no "$name$" token is left behind.
// Coverage: integration (real shipped ko messages + the same substitution rule the facade uses).
test('ko placeholder substitution lands the argument', () => {
  const render = (entry: Entry, subs: string[]): string => {
    let out = entry.message
    for (const [name, def] of Object.entries(entry.placeholders ?? {})) {
      const idx = Number(def.content.replace('$', '')) - 1
      out = out.replace(new RegExp('\\$' + name + '\\$', 'gi'), subs[idx] ?? '')
    }
    return out
  }
  const ARG = 'ZZ_TEST_ARG_42'
  for (const key of Object.keys(ko)) {
    const entry = ko[key]
    if (!entry.placeholders) continue
    const rendered = render(entry, [ARG, ARG])
    expect(rendered, key).toContain(ARG)
    expect(rendered, key).not.toMatch(/\$[a-z]+\$/i)
  }
})
