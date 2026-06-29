import { CaptureGate } from '../../src/core/capture-gate'

const gate = new CaptureGate({ minWords: 5 })
const long = 'one two three four five six seven eight'
const short = 'too short here'

test('auto: denylisted url rejected', () => {
  expect(gate.decide({ url: 'https://site.com/login', text: long, manual: false }).capture).toBe(false)
})

test('auto: thin page rejected', () => {
  const d = gate.decide({ url: 'https://site.com/post', text: short, manual: false })
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('thin')
})

test('auto: normal page captured', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: long, manual: false }).capture).toBe(true)
})

test('manual: thin page IS captured (soft gate skipped)', () => {
  expect(gate.decide({ url: 'https://site.com/post', text: short, manual: true }).capture).toBe(true)
})

test('manual: denylisted url STILL rejected (hard gate wins)', () => {
  const d = gate.decide({ url: 'https://site.com/login', text: long, manual: true })
  expect(d.capture).toBe(false)
  expect(d.reason).toBe('denylisted')
})
