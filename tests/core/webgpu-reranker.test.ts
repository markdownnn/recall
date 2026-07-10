// Unit tests for WebGpuReranker using a FAKE scorer factory (no real ~22MB model download).
// The fake records which devices the factory was asked to load and the peak concurrent score()
// calls, so we can assert reordering, WebGPU->WASM fallback, poisoned-load retry, and that ONNX
// never gets two overlapping inferences.
import { WebGpuReranker, type RerankerFactory, type RerankScorer } from '../../src/offscreen/webgpu-reranker'
import { rankedResult } from './fixtures'

interface FakeHandle {
  factory: RerankerFactory
  devices: string[] // devices the factory was asked to load, in order
  maxActive: number // peak concurrent score() calls (serialized => 1)
}

// failLoads: the first N factory() calls throw. createScorer tries webgpu then wasm, so one full
// load consumes TWO factory calls; failLoads:2 fails an entire first load and the next succeeds.
// scoreOf: maps a passage text to its relevance score (default = text length).
function makeFake(opts: { failLoads?: number; scoreOf?: (text: string) => number } = {}): FakeHandle {
  const scoreOf = opts.scoreOf ?? ((t) => t.length)
  const h: FakeHandle = { factory: null as unknown as RerankerFactory, devices: [], maxActive: 0 }
  let active = 0
  const scorer: RerankScorer = {
    async score(_query, passages) {
      active++
      h.maxActive = Math.max(h.maxActive, active)
      await new Promise((r) => setTimeout(r, 5)) // hold the slot so any overlap is visible
      active--
      return passages.map(scoreOf)
    },
  }
  h.factory = async (device) => {
    h.devices.push(device)
    if (h.devices.length <= (opts.failLoads ?? 0)) throw new Error(`fake load failure on ${device}`)
    return scorer
  }
  return h
}

function candsOf(texts: string[]) {
  return texts.map((t) => rankedResult(`p_${t}#0`, t, { id: `p_${t}`, url: `http://${t}`, title: t, capturedAt: 1 }))
}

// Scenario: 벡터+FTS가 뽑은 후보 순서를 크로스인코더가 관련도로 다시 세워, 진짜 정답을 위로 올려야 한다.
// Coverage: ⚠️ mock - 실제 모델은 무겁기 때문에 같은 계약의 fake scorer로 재정렬 로직만 확인한다.
test('reranks candidates by cross-encoder score and returns the top k', async () => {
  const scoreMap: Record<string, number> = { a: 1, b: 5, c: 3, d: 4, e: 2 }
  const r = new WebGpuReranker(makeFake({ scoreOf: (t) => scoreMap[t] ?? 0 }).factory)
  const out = await r.rerank('q', candsOf(['a', 'b', 'c', 'd', 'e']), 3)
  // scores b5 d4 c3 e2 a1 -> top3 = b, d, c
  expect(out.map((x) => x.chunk.text)).toEqual(['b', 'd', 'c'])
})

// Scenario: 후보가 0~1개면 재정렬할 게 없다. 무거운 모델을 아예 안 띄워 한 건짜리 검색이 안 느려야 한다.
// Coverage: ⚠️ mock - 같은 계약의 fake factory가 호출됐는지 여부로 모델 스킵을 확인한다.
test('skips the model for 0 or 1 candidates', async () => {
  const fake = makeFake()
  const r = new WebGpuReranker(fake.factory)
  const one = candsOf(['only'])
  expect(await r.rerank('q', one, 5)).toEqual(one)
  expect(await r.rerank('q', [], 5)).toEqual([])
  expect(fake.devices).toEqual([]) // factory never invoked
})

// Scenario: 이 기기에서 WebGPU가 안 되면 조용히 WASM으로 떨어져 그래도 리랭크는 돼야 한다.
// Coverage: ⚠️ mock - 같은 계약의 fake factory가 webgpu 로드에서 throw하게 만들어 폴백을 확인한다.
test('falls back to WASM when WebGPU load fails, still reranks', async () => {
  const fake = makeFake({ failLoads: 1 }) // first factory call (webgpu) throws
  const r = new WebGpuReranker(fake.factory)
  const out = await r.rerank('q', candsOf(['aa', 'bbb']), 2)
  expect(fake.devices).toEqual(['webgpu', 'wasm'])
  expect(r.device).toBe('wasm')
  expect(out.map((x) => x.chunk.text)).toEqual(['bbb', 'aa']) // len 3 > len 2
})

// Scenario: 첫 로드가 실패해도(네트워크 blip) 다음 리랭크는 캐시된 실패를 재생하지 말고 다시 시도해야 한다.
// Coverage: ⚠️ mock - 같은 계약의 fake factory가 첫 로드(webgpu+wasm)를 실패시키고 다음엔 성공시킨다.
test('a failed load does not poison later reranks (retries)', async () => {
  const fake = makeFake({ failLoads: 2 }) // fail the whole first load (webgpu + wasm)
  const r = new WebGpuReranker(fake.factory)
  await expect(r.rerank('q', candsOf(['aa', 'bbb']), 2)).rejects.toThrow()
  const out = await r.rerank('q', candsOf(['aa', 'bbb']), 2) // retry: webgpu now succeeds
  expect(out.length).toBe(2)
  expect(r.device).toBe('webgpu')
})

// Scenario: 두 검색이 동시에 리랭크를 걸어도 ONNX 세션에 추론이 겹쳐 들어가면 안 된다.
// Coverage: ⚠️ mock - 같은 계약의 fake scorer가 동시 실행 피크(maxActive)를 기록해 직렬화를 확인한다.
test('serializes scoring so inferences never overlap', async () => {
  const fake = makeFake()
  const r = new WebGpuReranker(fake.factory)
  await Promise.all([r.rerank('q1', candsOf(['aa', 'bb']), 2), r.rerank('q2', candsOf(['cc', 'dd']), 2)])
  expect(fake.maxActive).toBe(1)
})
