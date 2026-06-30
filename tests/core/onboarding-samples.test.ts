import { SAMPLES, DEMO_HOST, isValidSample } from '../../src/ui/onboarding/samples'

// Scenario: the try-it card seeds bundled docs; if one were empty or mis-hosted, the seed
// would store garbage or the cleanup (forget-host on DEMO_HOST) would miss it.
// Coverage: integration (real samples.ts).
test('every bundled sample is valid and hosted on the demo host', () => {
  expect(SAMPLES.length).toBeGreaterThanOrEqual(3)
  for (const s of SAMPLES) {
    expect(isValidSample(s)).toBe(true)
    expect(new URL(s.url).hostname).toBe(DEMO_HOST)
  }
})

// Scenario: embedding needs real signal; a one-line sample would make the search return
// nothing. Pin a minimum word count per sample.
// Coverage: integration (real samples.ts).
test('every sample has enough words for a meaningful embedding', () => {
  for (const s of SAMPLES) {
    expect(s.text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(80)
  }
})

// Scenario: two samples sharing a url would dedup to one page (capture upserts by pageId),
// silently dropping a demo doc. Urls must be unique.
// Coverage: integration (real samples.ts).
test('sample urls are unique', () => {
  const urls = SAMPLES.map((s) => s.url)
  expect(new Set(urls).size).toBe(urls.length)
})

// Scenario: isValidSample must REJECT a blank or mis-hosted doc, or the guard is useless.
// Coverage: integration (real samples.ts).
test('isValidSample rejects blank and off-host docs', () => {
  const src = 'https://en.wikipedia.org/wiki/X'
  expect(isValidSample({ url: 'https://recall-demo.example/x', sourceUrl: src, title: '', text: 'hi there' })).toBe(false)
  expect(isValidSample({ url: 'https://evil.example/x', sourceUrl: src, title: 'T', text: 'some words here' })).toBe(false)
  expect(isValidSample({ url: 'not a url', sourceUrl: src, title: 'T', text: 'some words here' })).toBe(false)
})
