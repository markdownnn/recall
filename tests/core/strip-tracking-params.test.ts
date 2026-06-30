import { stripTrackingParams } from '../../src/core/strip-tracking-params'

// Scenario: a user lands via a campaign link; the tracking params must not become part
// of the page's identity, or the same article saves twice and the badge misreads.
// Coverage: integration (real pure helper).
test('strips known tracking params', () => {
  const r = stripTrackingParams('https://x.com/article?utm_source=a&utm_medium=b&gclid=c&fbclid=d')
  expect(r).toBe('https://x.com/article')
})

// Scenario: real query params (the ones that change WHICH page you see) must survive.
// Coverage: integration (pure).
test('keeps real query params, drops only tracking', () => {
  const r = stripTrackingParams('https://shop.com/items?id=5&utm_campaign=sale&page=2')
  expect(r).toBe('https://shop.com/items?id=5&page=2')
})

// Scenario: tracking keys arrive in mixed case from some sites.
// Coverage: integration (pure).
test('matches tracking keys case-insensitively', () => {
  expect(stripTrackingParams('https://x.com/a?UTM_SOURCE=a&GcLiD=b&id=1')).toBe('https://x.com/a?id=1')
})

// Scenario: a plain url with no query must be returned untouched (no trailing '?').
// Coverage: integration (pure).
test('leaves a no-query url unchanged', () => {
  expect(stripTrackingParams('https://en.wikipedia.org/wiki/Cortisol')).toBe('https://en.wikipedia.org/wiki/Cortisol')
})

// Scenario: a non-url string must not throw; return it as-is (matches sanitizeUrl).
// Coverage: integration (pure).
test('returns a bad url as-is', () => {
  expect(stripTrackingParams('not a url')).toBe('not a url')
})
