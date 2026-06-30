import { EngagementTracker, MIN_SELECTION_CHARS } from '../../src/content/engagement-tracker'

// Scenario: a short page (fits ~1.5 screens) needs no scrolling to be "read"; reaching
// dwell on it should count as engaged immediately, with zero scroll events.
// Coverage: integration (pure tracker, real ratio math, no mock).
test('short page is engaged immediately without scrolling', () => {
  const t = new EngagementTracker()
  // viewport 800, content 1000 -> 1000 <= 800 * 1.5 (1200) -> short.
  expect(t.engaged(800, 1000)).toBe(true)
})

// Scenario: a long page left open but never scrolled is probably NOT read; it must not
// count as engaged until the user actually scrolls through it.
// Coverage: integration (pure tracker).
test('long page is not engaged until scrolled past halfway', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000 // 4000 > 800 * 1.5 (1200) -> long page
  expect(t.engaged(vp, sh)).toBe(false) // no scroll yet
  t.onScroll(200, vp, sh) // (200 + 800) / 4000 = 0.25 -> under half
  expect(t.engaged(vp, sh)).toBe(false)
  t.onScroll(1400, vp, sh) // (1400 + 800) / 4000 = 0.55 -> past half
  expect(t.engaged(vp, sh)).toBe(true)
})

// Scenario: a user who selects a few words on a long page (to copy/highlight) clearly
// engaged with the content even without scrolling halfway.
// Coverage: integration (pure tracker).
test('long page is engaged via a selection without scrolling', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000
  expect(t.engaged(vp, sh)).toBe(false)
  t.onSelection(MIN_SELECTION_CHARS) // exactly the threshold (a few words)
  expect(t.engaged(vp, sh)).toBe(true)
})

// Scenario: a stray double-click selecting a single short word must NOT count as
// engagement, or near-every page would falsely qualify.
// Coverage: integration (pure tracker).
test('selection shorter than the minimum is ignored', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000
  t.onSelection(MIN_SELECTION_CHARS - 1)
  expect(t.engaged(vp, sh)).toBe(false)
})

// Scenario: max-reached is sticky - scrolling back up must not undo "engaged" (the user
// already read down the page).
// Coverage: integration (pure tracker).
test('engagement sticks after scrolling back up', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000
  t.onScroll(1400, vp, sh) // 0.55 -> engaged
  t.onScroll(0, vp, sh) // back to top
  expect(t.engaged(vp, sh)).toBe(true)
})

// Scenario: SPA navigation to a new page must restart engagement from zero, or a deep
// scroll or selection on page A would wrongly mark page B as read.
// Coverage: integration (pure tracker).
test('reset clears both scroll depth and selection', () => {
  const t = new EngagementTracker()
  const vp = 800
  const sh = 4000
  t.onScroll(1400, vp, sh) // engaged via scroll
  t.onSelection(MIN_SELECTION_CHARS) // engaged via selection
  t.reset()
  expect(t.engaged(vp, sh)).toBe(false)
})
