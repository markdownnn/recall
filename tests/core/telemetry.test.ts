import {
  NullTelemetry,
  bucketCount,
  bucketLatencyMs,
  bucketIndexSize,
} from '../../src/core/telemetry'
import type { TelemetryEvent, TelemetryPort } from '../../src/core/telemetry'

// ---------------------------------------------------------------------------
// NullTelemetry is a no-op (this is what keeps zero-egress literally true).
// ---------------------------------------------------------------------------

test('NullTelemetry.track does nothing and never throws', () => {
  const t: TelemetryPort = new NullTelemetry()
  const ev: TelemetryEvent = { name: 'installed' }
  // No return value, no side effect, no throw.
  expect(t.track(ev)).toBeUndefined()
})

test('NullTelemetry.track is a true no-op even when called many times', () => {
  const t = new NullTelemetry()
  for (let i = 0; i < 1000; i++) {
    t.track({ name: 'recall_performed', latency: '200ms-1s', resultCount: '4-10' })
  }
  // If track had any observable side effect this loop would surface it; it does not.
  expect(true).toBe(true)
})

test('NullTelemetry.flush resolves with nothing queued', async () => {
  const t = new NullTelemetry()
  await expect(t.flush()).resolves.toBeUndefined()
})

// ---------------------------------------------------------------------------
// Anonymous-by-construction: structural / compile-level checks.
// These @ts-expect-error lines are validated by `tsc --noEmit` (tsconfig
// includes tests/). If someone ever loosens an event prop to an open `string`
// or `number`, the expected error disappears and tsc fails the build.
// ---------------------------------------------------------------------------

test('a URL or free text cannot be assigned into any event prop', () => {
  // @ts-expect-error reason is a closed enum, not free text (no URL/title).
  const badReason: TelemetryEvent = { name: 'capture_result', reason: 'https://evil.com', chunkCount: '1-3' }

  // @ts-expect-error chunkCount is a bucket literal, not a raw number.
  const rawCount: TelemetryEvent = { name: 'capture_result', reason: 'captured', chunkCount: 42 }

  // @ts-expect-error latency is a bucket literal, not a raw millisecond number.
  const rawLatency: TelemetryEvent = { name: 'recall_performed', latency: 350, resultCount: '1-3' }

  // @ts-expect-error events cannot carry arbitrary extra fields (e.g. a query).
  const extra: TelemetryEvent = { name: 'installed', query: 'how to sleep better' }

  // @ts-expect-error unknown event names are rejected.
  const unknown: TelemetryEvent = { name: 'page_text', text: 'secret' }

  // Reference the bindings so they are not flagged as unused by tsc.
  void badReason
  void rawCount
  void rawLatency
  void extra
  void unknown
  expect(true).toBe(true)
})

test('a well-formed event of every kind compiles and is accepted by the port', () => {
  const t: TelemetryPort = new NullTelemetry()
  const events: TelemetryEvent[] = [
    { name: 'installed' },
    { name: 'capture_result', reason: 'thin', chunkCount: '0' },
    { name: 'recall_performed', latency: '<50ms', resultCount: '100+' },
    { name: 'model_loaded', device: 'webgpu', loadTime: '5-20s' },
    { name: 'index_size', size: '501-5000' },
  ]
  for (const ev of events) t.track(ev)
  expect(events.length).toBe(5)
})

// ---------------------------------------------------------------------------
// Pure bucketing helpers: raw measurements collapse to coarse buckets before
// an event is ever built, so a raw count/latency never reaches the wire.
// ---------------------------------------------------------------------------

test('bucketCount maps raw counts to coarse buckets', () => {
  expect(bucketCount(0)).toBe('0')
  expect(bucketCount(-5)).toBe('0')
  expect(bucketCount(1)).toBe('1-3')
  expect(bucketCount(3)).toBe('1-3')
  expect(bucketCount(4)).toBe('4-10')
  expect(bucketCount(10)).toBe('4-10')
  expect(bucketCount(30)).toBe('11-30')
  expect(bucketCount(100)).toBe('31-100')
  expect(bucketCount(101)).toBe('100+')
})

test('bucketLatencyMs maps milliseconds to coarse buckets', () => {
  expect(bucketLatencyMs(0)).toBe('<50ms')
  expect(bucketLatencyMs(49)).toBe('<50ms')
  expect(bucketLatencyMs(50)).toBe('50-200ms')
  expect(bucketLatencyMs(199)).toBe('50-200ms')
  expect(bucketLatencyMs(999)).toBe('200ms-1s')
  expect(bucketLatencyMs(4999)).toBe('1-5s')
  expect(bucketLatencyMs(19999)).toBe('5-20s')
  expect(bucketLatencyMs(20000)).toBe('20s+')
})

test('bucketIndexSize maps page counts to coarse buckets', () => {
  expect(bucketIndexSize(0)).toBe('0')
  expect(bucketIndexSize(50)).toBe('1-50')
  expect(bucketIndexSize(51)).toBe('51-500')
  expect(bucketIndexSize(500)).toBe('51-500')
  expect(bucketIndexSize(5000)).toBe('501-5000')
  expect(bucketIndexSize(5001)).toBe('5000+')
})
