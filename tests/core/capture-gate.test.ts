import { CaptureGate } from '../../src/core/capture-gate'

const gate = new CaptureGate({ minWords: 5 })
// A gate with no built-in denylist  -  isolates user-denylist suffix-matching behaviour.
const gateNoBuiltin = new CaptureGate({ minWords: 5, denylist: [] })
const long = 'one two three four five six seven eight'
const short = 'too short here'
const open = { paused: false, userDenyHosts: [] as string[] }

test('auto: denylisted url rejected', () => {
  expect(gate.decide({ url: 'https://site.com/login', text: long, manual: false }, open).capture).toBe(false)
})

test('auto: thin page rejected', () => {
  const d = gate.decide({ url: 'https://site.com/post', text: short, manual: false }, open)
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('thin')
})

test('auto: normal page captured', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: long, manual: false }, open).capture).toBe(true)
})

// Scenario: a long Chinese/Japanese article has NO inter-word spaces, so a whitespace-split
// "word" count collapses the whole page to 1 word and the thin gate silently rejects it -
// auto-capture never fires even though the model is multilingual. The gate must measure
// content size script-agnostically (Unicode letters), so a long spaceless CJK page passes.
// Coverage: integration (real CaptureGate soft-gate path). CJK data via \u escapes so the
// test source stays ASCII-only.
test('auto: long spaceless CJK page is NOT thin (captured)', () => {
  // 40 repetitions of U+6587 (a CJK ideograph) = 40 letters, one whitespace "word".
  const cjk = '\u6587'.repeat(40)
  const d = gate.decide({ url: 'https://site.com/post', text: cjk, manual: false }, open)
  expect(d.capture).toBe(true)
})

// Scenario: a genuinely thin CJK page (a handful of characters) must still be rejected -
// the script-agnostic measure must not over-accept tiny CJK snippets.
// Coverage: integration (real CaptureGate soft-gate path).
test('auto: very short CJK page is still thin', () => {
  const cjk = '\u6587'.repeat(3) // 3 letters, well under the threshold
  const d = gate.decide({ url: 'https://site.com/post', text: cjk, manual: false }, open)
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('thin')
})

// Scenario: a number/code-heavy English page (a stats table or code listing) has many digits
// and symbols but few alphabetic letters. A letter-only thin gate (\p{L}) drops these digits,
// so the page can fall under the letter threshold and get wrongly rejected as 'thin' - even
// though the old word-count gate captured it. Counting letters AND numbers (\p{L} + \p{N})
// keeps numeric/code tokens contributing, so the page is captured.
// Coverage: integration (real CaptureGate soft-gate path).
test('auto: number/code-heavy page is NOT thin (letters+numbers counted)', () => {
  // 30 digits, 0 alphabetic letters. minWords 5 * AVG_WORD_LEN 5 = 25 threshold. A letter-only
  // count is 0 (rejected); counting digits gives 30 >= 25 (captured).
  const numeric = '1234567890'.repeat(3)
  const d = gate.decide({ url: 'https://site.com/stats', text: numeric, manual: false }, open)
  expect(d.capture).toBe(true)
})

test('manual: thin page IS captured (soft gate skipped)', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: short, manual: true }, open).capture).toBe(true)
})

test('manual: denylisted url STILL rejected (hard gate wins)', () => {
  const d = gate.decide({ url: 'https://site.com/login', text: long, manual: true }, open)
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('denylisted')
})

test('paused blocks auto capture', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: long, manual: false }, { paused: true, userDenyHosts: [] }).capture).toBe(false)
})

test('paused blocks manual save too', () => {
  const d = gate.decide({ url: 'https://site.com/post', text: long, manual: true }, { paused: true, userDenyHosts: [] })
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('paused')
})

test('user-denied host is rejected (auto and manual)', () => {
  const s = { paused: false, userDenyHosts: ['news.ycombinator.com'] }
  expect(gate.decide({ url: 'https://news.ycombinator.com/item?id=1', text: long, manual: false }, s).capture).toBe(false)
  expect(gate.decide({ url: 'https://news.ycombinator.com/item?id=1', text: long, manual: true }, s).reason).toBe('denylisted')
})

test('different host not affected by user denylist', () => {
  const s = { paused: false, userDenyHosts: ['news.ycombinator.com'] }
  expect(gate.decide({ url: 'https://other.com/post', text: long, manual: false }, s).capture).toBe(true)
})

test('user deny blocks subdomains of the denied host', () => {
  const s = { paused: false, userDenyHosts: ['bank.com'] }
  expect(gateNoBuiltin.decide({ url: 'https://www.bank.com/x', text: long, manual: false }, s).capture).toBe(false)
  expect(gateNoBuiltin.decide({ url: 'https://secure.bank.com/page', text: long, manual: true }, s).reason).toBe('denylisted')
})

test('user deny does NOT block lookalike hosts', () => {
  const s = { paused: false, userDenyHosts: ['bank.com'] }
  expect(gateNoBuiltin.decide({ url: 'https://evilbank.com/x', text: long, manual: false }, s).capture).toBe(true)
  expect(gateNoBuiltin.decide({ url: 'https://bank.com.evil.com/x', text: long, manual: false }, s).capture).toBe(true)
})

// Scenario: a user who searched then bounced through results should NOT have the SERP
// auto-captured - it is a link list, not an article.
// Coverage: integration (real CaptureGate + isSerp, soft-gate path).
test('auto: SERP rejected with reason serp', () => {
  const d = gate.decide({ url: 'https://www.google.com/search?q=cortisol', text: long, manual: false }, open)
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('serp')
})

// Scenario: if the user EXPLICITLY clicks save on a results page, honor the intent -
// the SERP soft gate is skipped for manual, just like the thin gate.
// Coverage: integration (real CaptureGate, manual path).
test('manual: SERP IS captured (soft gate skipped)', () => {
  const d = gate.decide({ url: 'https://www.google.com/search?q=cortisol', text: long, manual: true }, open)
  expect(d.capture).toBe(true)
})

// Scenario: a normal article must still pass - the SERP gate must not over-block.
// Coverage: integration (real CaptureGate).
test('auto: non-SERP article still captured', () => {
  const d = gate.decide({ url: 'https://example.com/article/cortisol', text: long, manual: false }, open)
  expect(d.capture).toBe(true)
})

// Scenario: a page on a private network (here a 10.x intranet host) is not public web
// content; auto-capture must skip it with reason 'internal'.
// Coverage: integration (real CaptureGate + isInternalHost, soft-gate path).
test('auto: internal host rejected with reason internal', () => {
  const d = gate.decide({ url: 'http://10.0.0.5/wiki/onboarding', text: long, manual: false }, open)
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('internal')
})

// Scenario: if the user EXPLICITLY clicks save on an internal doc, honor the intent - the
// internal gate is auto-only, skipped for manual, like the SERP and thin gates (Option A).
// Coverage: integration (real CaptureGate, manual path).
test('manual: internal host IS captured (soft gate skipped)', () => {
  const d = gate.decide({ url: 'http://10.0.0.5/wiki/onboarding', text: long, manual: true }, open)
  expect(d.capture).toBe(true)
})

// Scenario: a normal public page must still pass - the internal gate must not over-block.
// Coverage: integration (real CaptureGate).
test('auto: public host still captured', () => {
  const d = gate.decide({ url: 'https://en.wikipedia.org/wiki/Cortisol', text: long, manual: false }, open)
  expect(d.capture).toBe(true)
})
