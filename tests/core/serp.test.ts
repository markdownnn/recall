import { isSerp } from '../../src/core/serp'

// Scenario: the major engines' results pages are link lists, not readable content; each
// must be recognized so auto-capture skips them.
// Coverage: integration (pure URL check over real result-page URLs).
test('recognizes major search-engine result pages', () => {
  const serps = [
    'https://www.google.com/search?q=cortisol+sleep',
    'https://www.bing.com/search?q=double+entry+bookkeeping',
    'https://duckduckgo.com/?q=photosynthesis&ia=web',
    'https://duckduckgo.com/html/?q=photosynthesis',
    'https://search.yahoo.com/search?p=tax+basics',
    'https://search.brave.com/search?q=hexagonal+architecture',
    'https://www.ecosia.org/search?q=opfs',
    'https://www.startpage.com/sp/search?query=vitest',
    'https://kagi.com/search?q=playwright',
    'https://www.baidu.com/s?wd=typescript',
    'https://yandex.com/search/?text=preact',
  ]
  for (const url of serps) expect(isSerp(url)).toBe(true)
})

// Scenario: a normal article (even on a search-engine host) must NOT be mistaken for a
// SERP, or we would wrongly skip real content.
// Coverage: integration (pure URL check).
test('does not flag non-result pages', () => {
  const notSerps = [
    'https://example.com/article/cortisol',
    'https://www.google.com/maps/place/Paris',
    'https://news.ycombinator.com/item?id=1',
    'https://duckduckgo.com/about',
    'https://www.bing.com/news',
    'https://en.wikipedia.org/wiki/Search_engine',
  ]
  for (const url of notSerps) expect(isSerp(url)).toBe(false)
})

// Scenario: a malformed URL must not throw - the gate runs on every page.
// Coverage: integration (pure URL check, error path).
test('returns false for a malformed url', () => {
  expect(isSerp('not a url')).toBe(false)
})
