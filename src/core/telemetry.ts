// Telemetry port: a cross-cutting seam for ANONYMOUS, OPT-IN, off-by-default
// product analytics. This file is PURE: no browser APIs, no network, no I/O.
//
// Design rule: ANONYMOUS BY CONSTRUCTION.
//   Every event is a closed string-literal name plus props whose value types
//   are closed string-literal unions ("buckets") or enums. There is NO field
//   anywhere of an open `string` or raw `number` type, so a URL, a page title,
//   a query, or chunk text literally cannot be assigned into an event. The
//   compiler rejects it. This is the structural guarantee behind ADR 0013.
//
// What flows on the wire (only when a real adapter is later opted in):
//   - the event name (a fixed identifier)
//   - small bucketed/enum props (e.g. "11-30", "warm", "webgpu")
//   - a random anonymous client id (added by the future adapter, not here)
// Never: URLs, hosts, titles, queries, chunk text, raw counts, timestamps of
// individual actions, or any identifier tied to a person.

// ---------------------------------------------------------------------------
// Bucket vocabularies (closed unions — cannot hold free text)
// ---------------------------------------------------------------------------

// Coarse count buckets. Used for chunk counts and result counts.
export type CountBucket = '0' | '1-3' | '4-10' | '11-30' | '31-100' | '100+'

// Coarse latency buckets in milliseconds. Used for recall and model load.
export type LatencyBucket = '<50ms' | '50-200ms' | '200ms-1s' | '1-5s' | '5-20s' | '20s+'

// Coarse index-size buckets (number of stored pages).
export type IndexSizeBucket = '0' | '1-50' | '51-500' | '501-5000' | '5000+'

// Why a capture attempt ended the way it did. Mirrors the gate's outcomes but
// is intentionally redefined here so core/telemetry stays decoupled from the
// gate's internal reason strings.
export type CaptureReason = 'captured' | 'thin' | 'denylisted' | 'paused' | 'duplicate'

// Where embedding ran. Mirrors WebGpuEmbedder.device semantics.
export type EmbedDevice = 'webgpu' | 'wasm'

// ---------------------------------------------------------------------------
// Event taxonomy (discriminated union on `name`)
// ---------------------------------------------------------------------------

// Extension installed / updated. No props — presence is the whole signal.
export interface InstalledEvent {
  name: 'installed'
}

// One capture attempt finished. `reason` says what happened; for a successful
// capture, `chunkCount` is bucketed (never the exact number).
export interface CaptureResultEvent {
  name: 'capture_result'
  reason: CaptureReason
  chunkCount: CountBucket
}

// One recall (search) ran. Both latency and result count are bucketed.
export interface RecallPerformedEvent {
  name: 'recall_performed'
  latency: LatencyBucket
  resultCount: CountBucket
}

// The embedding model finished loading. Which backend, and how long (bucketed).
export interface ModelLoadedEvent {
  name: 'model_loaded'
  device: EmbedDevice
  loadTime: LatencyBucket
}

// A periodic/coarse snapshot of how big the local index is (bucketed pages).
export interface IndexSizeEvent {
  name: 'index_size'
  size: IndexSizeBucket
}

// The full set of events. Add new members here; each must stay anonymous by
// construction (name + bucket/enum props only).
export type TelemetryEvent =
  | InstalledEvent
  | CaptureResultEvent
  | RecallPerformedEvent
  | ModelLoadedEvent
  | IndexSizeEvent

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface TelemetryPort {
  // Record one anonymous event. Fire-and-forget by contract: never throws,
  // never blocks the caller, returns nothing. A real adapter queues/batches.
  track(event: TelemetryEvent): void
  // Best-effort drain of any queued events. The no-op adapter resolves at once.
  flush(): Promise<void>
}

// ---------------------------------------------------------------------------
// Default adapter: does nothing. This is what is wired by default, so the
// zero-egress guarantee (connect-src 'self') holds literally. Swapping in a
// real network adapter is an explicit, opt-in, separately-reviewed change.
// ---------------------------------------------------------------------------

export class NullTelemetry implements TelemetryPort {
  track(_event: TelemetryEvent): void {
    // intentionally empty — no recording, no network, no side effects
  }
  async flush(): Promise<void> {
    // nothing queued, nothing to send
  }
}

// ---------------------------------------------------------------------------
// Pure bucketing helpers. Callers pass raw measurements; these collapse them
// to coarse buckets BEFORE an event is built, so a raw count/latency never
// reaches the port. Pure functions: no I/O, fully unit-testable.
// ---------------------------------------------------------------------------

export function bucketCount(n: number): CountBucket {
  if (n <= 0) return '0'
  if (n <= 3) return '1-3'
  if (n <= 10) return '4-10'
  if (n <= 30) return '11-30'
  if (n <= 100) return '31-100'
  return '100+'
}

export function bucketLatencyMs(ms: number): LatencyBucket {
  if (ms < 50) return '<50ms'
  if (ms < 200) return '50-200ms'
  if (ms < 1000) return '200ms-1s'
  if (ms < 5000) return '1-5s'
  if (ms < 20000) return '5-20s'
  return '20s+'
}

export function bucketIndexSize(pages: number): IndexSizeBucket {
  if (pages <= 0) return '0'
  if (pages <= 50) return '1-50'
  if (pages <= 500) return '51-500'
  if (pages <= 5000) return '501-5000'
  return '5000+'
}
