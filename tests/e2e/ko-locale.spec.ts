// Scenario: a Korean-language Chrome must show the Recall UI in Korean. Standard MV3
// chrome.i18n resolves the message locale from the browser's application locale, so we launch
// Chromium with `--lang=ko`. On platforms that honor it (e.g. Linux CI) the onboarding page and
// the side panel then render the ko/messages.json strings instead of the EN defaults, proving
// the whole chain: component -> `t` facade -> chrome.i18n.getMessage -> ko/messages.json.
//
// macOS Chromium ignores `--lang` for the EXTENSION message locale (it follows the OS app
// locale, settable only via global `defaults`/`-AppleLanguages`, which Playwright cannot pass).
// So we DETECT the resolved message locale at runtime: if Chrome did not switch to ko, the
// platform cannot force it and we skip with a precise reason rather than assert a locale the
// environment refused to set. (The ko file's completeness + correctness is covered
// machine-independently by tests/core/messages-ko.test.ts.)
//
// Coverage: integration where the locale is forceable (real ko-UI Chrome + real chrome.i18n +
// the real Preact surfaces); skipped-with-reason where the platform cannot force it. Expected
// Korean strings are READ FROM the shipped ko/messages.json at runtime so this test source
// stays ASCII-only (no charset/collation-fragile literals) while asserting the exact text.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

type Messages = Record<string, { message: string }>
const ko = JSON.parse(
  readFileSync(path.resolve(dir, '../../public/_locales/ko/messages.json'), 'utf8'),
) as Messages
const en = JSON.parse(
  readFileSync(path.resolve(dir, '../../public/_locales/en/messages.json'), 'utf8'),
) as Messages

test('Korean Chrome renders the UI in Korean (chrome.i18n ko path)', async () => {
  test.setTimeout(60_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    locale: 'ko-KR',
    args: [
      '--lang=ko',
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })

  const swPromise = ctx.waitForEvent('serviceworker')
  const existingSw = ctx.serviceWorkers()[0]
  const sw = existingSw ?? (await swPromise)
  const extId = sw.url().split('/')[2]

  const onboarding = await ctx.newPage()
  await onboarding.goto(`chrome-extension://${extId}/src/ui/onboarding/index.html`)

  // The locale chrome.i18n actually resolved for MESSAGES (distinct from getUILanguage()).
  const msgLocale = await onboarding.evaluate(() => chrome.i18n.getMessage('@@ui_locale'))
  if (!msgLocale.toLowerCase().startsWith('ko')) {
    await ctx.close()
    test.skip(true, `platform cannot force the extension message locale to ko (resolved: ${msgLocale})`)
    return
  }

  // --- Onboarding page: inline prose comes through chrome.i18n ---
  await expect(onboarding.getByText(ko.obHeroTagline.message)).toBeVisible({ timeout: 10_000 })
  await expect(onboarding.getByRole('button', { name: ko.obSeedButton.message })).toBeVisible()
  // Prove the switch actually happened: the EN seed-button label must NOT be present.
  await expect(onboarding.getByText(en.obSeedButton.message)).toHaveCount(0)

  // --- Side panel: tab labels + capture button come through the same facade ---
  const panel = await ctx.newPage()
  await panel.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  await expect(panel.getByRole('tab', { name: ko.searchTabLabel.message })).toBeVisible({ timeout: 10_000 })
  await expect(panel.getByRole('tab', { name: ko.settingsTabLabel.message })).toBeVisible()
  await expect(panel.getByRole('button', { name: ko.captureButton.message })).toBeVisible()

  await ctx.close()
})
