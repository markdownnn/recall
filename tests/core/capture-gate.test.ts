import { CaptureGate } from '../../src/core/capture-gate'

const gate = new CaptureGate({ minWords: 5 })
// A gate with no built-in denylist — isolates user-denylist suffix-matching behaviour.
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
