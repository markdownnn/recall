import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Thin (<100-word) docs so AUTO-capture is blocked by the thin gate and only the
// deterministic MANUAL captures exist (same technique as forget-history).
const page1 = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><p>${body}</p></article></body></html>`

// term vs decoy are NEAR-IDENTICAL (same topic, almost the same words); only `term`
// contains the rare token "Zylophin". So for the query "Zylophin" the two are equally
// close by VECTOR - the ONLY thing that can rank `term` above `decoy` is the lexical
// (trigram exact-term) side. That isolates the lexical contribution.
const TERM = page1(
  'Garden A',
  'Our community plot grows tomatoes, basil, peppers, and a rare heirloom variety called Zylophin every warm season without fail.',
)
const DECOY = page1(
  'Garden B',
  'Our community plot grows tomatoes, basil, peppers, and several rare heirloom plant varieties every warm season without fail.',
)
// Distinct topic, shares NO words with the query "trouble sleeping at night" -> a pure
// VECTOR win.
const SLEEP = page1(
  'Sleep Notes',
  'Cortisol is a stress hormone from the adrenal glands. When it stays high late in the evening it blocks melatonin and keeps the brain alert, so a person lies awake for hours unable to drift into rest.',
)
// Korean corpus lives in a fixture (HTML data, Hangul allowed there). Its <title> is
// ASCII so the result can be asserted without Hangul in this test source.
const KO = fs.readFileSync(path.resolve(dir, 'fixtures/ko-photosynthesis.html'), 'utf8')
// The Korean term "gwang-hap-seong" (3 syllables, = photosynthesis) built from char
// codes to keep this source ASCII-only (repo rule). The fixture body contains it as a
// sub-word (term + a particle), so the trigram lexical path must surface the KO page.
const KO_QUERY = String.fromCharCode(0xad11, 0xd569, 0xc131)

async function capture(popup: any, page: any) {
  await page.bringToFront()
  // Re-click capture until it lands. Under full-suite load the offscreen can be busy
  // (model load / embedding) and a single capture RPC may not resolve quickly; retrying
  // the user action (re-click) is robust and honest - same pageId, so it just dedupes.
  await expect(async () => {
    await popup.getByText('Capture this page').click()
    await expect(popup.getByText(/captured|indexing/i)).toBeVisible({ timeout: 15_000 })
  }).toPass({ timeout: 90_000 })
}

async function search(popup: any, q: string) {
  await popup.getByRole('searchbox').fill(q)
  await popup.getByRole('searchbox').press('Enter')
}

// Scenario: hybrid must add the LEXICAL signal, not just re-prove vector.
//  (1) lexical win, ISOLATED by a near-identical decoy that lacks the rare term;
//  (2) vector win on a semantic query with no shared words;
//  (3) Korean 3-char term matches a doc that contains it as a sub-word (trigram).
// Coverage: integration (real extension, real FTS5 trigram + real embeddings + RRF).
test('hybrid search: lexical win (isolated), vector win, Korean sub-word lexical', async () => {
  test.setTimeout(180_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const docs: [string, string][] = [
    ['http://hybrid-test.example/term', TERM],
    ['http://hybrid-test.example/decoy', DECOY],
    ['http://hybrid-test.example/sleep', SLEEP],
    ['http://hybrid-test.example/ko', KO],
  ]
  const pages = []
  for (const [url, body] of docs) {
    const p = await ctx.newPage()
    // charset=utf-8 is REQUIRED: the KO fixture is UTF-8 Korean. Without an explicit charset
    // Chrome decodes the response as Latin-1, so the captured/stored text is mojibake
    // ("ê´..." instead of the Hangul) - the trigram lexical lane and the
    // embedding then both miss the proper Korean query and the KO page never ranks. (ASCII docs
    // are unaffected; UTF-8 is a superset.)
    await p.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body }))
    await p.goto(url)
    pages.push(p)
  }

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)

  for (const p of pages) await capture(popup, p)

  // (1) Lexical win: "Zylophin" only appears in the term doc; the decoy is otherwise
  //     near-identical, so vector alone cannot prefer term over decoy. Lexical must.
  await expect(async () => {
    await search(popup, 'Zylophin')
    await expect(popup.locator('article').first()).toContainText('Zylophin', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  // (2) Vector win: query shares no words with the sleep doc, yet semantic match wins.
  await expect(async () => {
    await search(popup, 'trouble sleeping at night')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  // (3) Korean sub-word lexical: trigram matches the 3-syllable term inside the longer
  //     word (term + particle) in the KO fixture -> KO page. Asserted on the ASCII page
  //     title shown in the result link (no Hangul in this test source).
  await expect(async () => {
    await search(popup, KO_QUERY)
    await expect(popup.locator('article').first()).toContainText('Photosynthesis', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  await ctx.close()
})
