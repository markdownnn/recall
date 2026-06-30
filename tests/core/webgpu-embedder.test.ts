// Unit tests for WebGpuEmbedder using a FAKE pipeline factory (no real model
// download). The fake factory returns a fake extractor whose call resolves to an
// object with .tolist() -> number[][] (dim 4), and records concurrency + inputs
// so we can assert serialization, prefixing and batching.

import { WebGpuEmbedder, type PipelineFactory } from '../../src/offscreen/webgpu-embedder'

interface FakeHandle {
  factory: PipelineFactory
  factoryCalls: number
  calls: string[][] // inputs the extractor was called with
  maxActive: number // peak concurrent extractor calls (single-flight => 1)
}

// failTimes: number of leading factory() invocations that throw. Note createPipe
// tries WebGPU then WASM, so one full createPipe round consumes TWO factory
// calls; failTimes:2 makes an entire first load fail and the next one succeed.
// failInference: number of leading NON-warmup inference calls that throw (the
// warmup embed inside createPipe is excluded so the model still LOADS fine and
// only a real embed fails). Models a WebGPU "device lost" mid-run.
function makeFake(opts: { failTimes?: number; failInference?: number } = {}): FakeHandle {
  const h: FakeHandle = { factory: null as unknown as PipelineFactory, factoryCalls: 0, calls: [], maxActive: 0 }
  let active = 0
  let realInferenceCalls = 0

  const extractor = async (inputs: string[]) => {
    active++
    h.maxActive = Math.max(h.maxActive, active)
    await new Promise((r) => setTimeout(r, 5)) // hold the slot so any overlap is visible
    const isWarmup = inputs.some((t) => t.includes('warmup'))
    if (!isWarmup) {
      realInferenceCalls++
      if (realInferenceCalls <= (opts.failInference ?? 0)) {
        active--
        throw new Error(`fake inference failure #${realInferenceCalls}`)
      }
    }
    h.calls.push(inputs)
    active--
    return { tolist: () => inputs.map(() => [0.1, 0.2, 0.3, 0.4]) }
  }

  h.factory = (async (_task: string, _model: string) => {
    h.factoryCalls++
    if (h.factoryCalls <= (opts.failTimes ?? 0)) {
      throw new Error(`fake load failure #${h.factoryCalls}`)
    }
    return extractor
  }) as unknown as PipelineFactory

  return h
}

// Scenario: the model load fails once (e.g. network blip), then the user tries
// again after recovery; the second attempt must succeed, not replay the cached
// rejection forever.
// Coverage: integration (real WebGpuEmbedder load/retry path, fake factory).
test('poisoned pipe: a failed load does not poison later calls (pipeP cleared)', async () => {
  const fake = makeFake({ failTimes: 2 }) // fail the whole first createPipe (webgpu + wasm)
  const embedder = new WebGpuEmbedder(fake.factory)

  await expect(embedder.ensureLoaded()).rejects.toThrow()
  // Without the fix, pipeP stays cached as a rejected promise and this rejects too.
  await expect(embedder.ensureLoaded()).resolves.toBeUndefined()
  expect(embedder.device).toBe('webgpu')
})

// Scenario: a WebGPU "device lost" makes a real embed throw AFTER the pipe was
// already loaded. The dead pipe must NOT stay cached: the next embed has to
// reload the model (factory invoked again) and self-heal, otherwise the drain's
// retry loop replays the same failure until the offscreen document restarts.
// Coverage: integration (real WebGpuEmbedder run/cache path, fake factory whose
// first real inference throws and which counts factory invocations).
test('inference failure resets the cached pipe so the next embed reloads', async () => {
  const fake = makeFake({ failInference: 1 }) // first real embed throws, then OK
  const embedder = new WebGpuEmbedder(fake.factory)

  // First embed loads the pipe, then the inference throws -> embed rejects.
  await expect(embedder.embed(['x'], 'passage')).rejects.toThrow()
  const callsAfterFirst = fake.factoryCalls
  expect(callsAfterFirst).toBeGreaterThan(0) // it did load once

  // Without the fix the dead pipe is reused and this rejects too / no reload.
  await expect(embedder.embed(['y'], 'passage')).resolves.toBeDefined()
  expect(fake.factoryCalls).toBeGreaterThan(callsAfterFirst) // pipe was reloaded
})

// Scenario: two captures/recalls run embeds at the same time; ONNX must never
// receive two overlapping inputs.
// Coverage: integration (fake records peak concurrency through the real queue).
test('single-flight: concurrent embed calls never overlap in the model', async () => {
  const fake = makeFake()
  const embedder = new WebGpuEmbedder(fake.factory)

  await Promise.all([embedder.embed(['a'], 'query'), embedder.embed(['b'], 'query')])

  expect(fake.maxActive).toBe(1)
})

// Scenario: e5 requires "query: " / "passage: " prefixes; dropping them silently
// wrecks retrieval quality.
// Coverage: integration (fake records the exact strings the model receives).
test('kind prefix: query/passage prefixes reach the model', async () => {
  const fake = makeFake()
  const embedder = new WebGpuEmbedder(fake.factory)

  await embedder.embed(['foo'], 'query')
  await embedder.embed(['bar'], 'passage')

  const flat = fake.calls.flat()
  expect(flat).toContain('query: foo')
  expect(flat).toContain('passage: bar')
})

// Scenario: a background indexing batch is mid-flight when the user hits Enter on a
// search. The interactive query must NOT wait behind queued passage batches (the ~10s
// "search hangs" bug); it jumps ahead of any passage work not yet started.
// Coverage: integration (fake records execution order through the real queue).
test('priority: a query embed jumps ahead of queued passage embeds', async () => {
  const fake = makeFake()
  const embedder = new WebGpuEmbedder(fake.factory)
  await embedder.ensureLoaded()
  fake.calls.length = 0 // drop the warmup call

  const p1 = embedder.embed(['p1'], 'passage') // commits first, holds the single slot
  const p2 = embedder.embed(['p2'], 'passage') // queues behind p1
  const q = embedder.embed(['q1'], 'query') // arrives while p1 in flight -> overtakes p2
  await Promise.all([p1, p2, q])

  expect(fake.calls.flat()).toEqual(['passage: p1', 'query: q1', 'passage: p2'])
})

// Scenario: a large capture (20 chunks) must be embedded in small GPU-gentle batches
// of 8 and return one vector per input, not drop or merge any.
// Coverage: integration (fake records each batch size; asserts 8 + 8 + 4).
test('batching: 20 texts embed in batches of 8 and return 20 vectors', async () => {
  const fake = makeFake()
  const embedder = new WebGpuEmbedder(fake.factory)
  const texts = Array.from({ length: 20 }, (_, i) => `t${i}`)

  const vecs = await embedder.embed(texts, 'passage')

  expect(vecs.length).toBe(20)
  expect(vecs[0].length).toBe(4)
  const batchSizes = fake.calls.filter((c) => c[0].startsWith('passage: ')).map((c) => c.length)
  expect(batchSizes).toEqual([8, 8, 4])
})
