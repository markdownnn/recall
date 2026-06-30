import { relativeTime } from '../../src/ui/sidepanel/relative-time'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// Scenario: a page captured seconds ago should read "just now", not "0m".
// Coverage: integration (pure function, injected now).
test('under a minute reads just now', () => {
  expect(relativeTime(1_000_000, 1_000_000 + 5 * SEC)).toBe('just now')
})

// Scenario: minutes/hours/days each get a compact ASCII label.
// Coverage: integration (pure function, injected now).
test('minutes, hours, and days bucket compactly', () => {
  const t = 1_000_000_000
  expect(relativeTime(t, t + 5 * MIN)).toBe('5m')
  expect(relativeTime(t, t + 3 * HOUR)).toBe('3h')
  expect(relativeTime(t, t + 2 * DAY)).toBe('2d')
})

// Scenario: bucket boundaries must not overlap or gap (59s is still "just now"; 60s is "1m";
// 60m is "1h"; 24h is "1d").
// Coverage: integration (pure function, injected now).
test('boundaries are exact', () => {
  const t = 2_000_000_000
  expect(relativeTime(t, t + 59 * SEC)).toBe('just now')
  expect(relativeTime(t, t + 60 * SEC)).toBe('1m')
  expect(relativeTime(t, t + 60 * MIN)).toBe('1h')
  expect(relativeTime(t, t + 24 * HOUR)).toBe('1d')
})

// Scenario: anything older than ~30 days falls back to a short calendar date (no "400d").
// Coverage: integration (pure function, injected now; assert ASCII month + day, fixed UTC input).
test('old captures show a short calendar date', () => {
  // 2021-03-04T00:00:00Z, read from far in the future so it is in the calendar bucket.
  const then = Date.UTC(2021, 2, 4)
  const out = relativeTime(then, then + 90 * DAY)
  expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/) // e.g. "Mar 4"
})
