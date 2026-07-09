// Ask-quality harness: runs the REAL retrieval/dedup/merge/gate pipeline (everything up to
// but not including the LLM's final answer — WebLLM only runs in-browser, so generation
// itself is out of scope here; see the spec's "잴 수 없는 것" section).
// Usage: vite-node eval/run-ask.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { buildStore, loadManifest } from './lib/build-and-search.mjs'
import { embed } from './lib/embed-node.mjs'
import { dedupeSimilarQueries } from '../src/core/query-dedup.ts'
import {
  mergeAnswerResults,
  passesConfidenceGate,
  ASK_MIN_CONFIDENCE,
  QUERY_DEDUP_THRESHOLD,
} from '../src/core/ask-service.ts'
import { DEFAULT_ANSWER_RETRIEVAL_OPTIONS } from '../src/core/answer-retrieval.ts'
import { evidenceRecallAtContext, confidenceGateCorrect } from '../src/core/eval-metrics.ts'

const manifest = loadManifest()
const golden = JSON.parse(readFileSync('eval/ask-golden.json', 'utf8'))
const expansionsPath = 'eval/fixtures/expansions.json'
const expansions = existsSync(expansionsPath) ? JSON.parse(readFileSync(expansionsPath, 'utf8')) : {}

console.log(`[eval:ask] corpus=${manifest.length} pages  queries=${golden.length}`)
const t0 = Date.now()
const store = await buildStore(manifest, { strip: true, minProse: 0.35 })
console.log(`[eval:ask] indexed + embedded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)

// Batch-embed every candidate query text across the whole golden set up front (one round of
// model calls) instead of one call per golden row -- embed-node.mjs already batches BATCH=8
// texts per forward pass, so calling it once per row (1-2 texts each) wastes that batching on
// a cold-cache run.
const allCandidateTexts = golden.map((g) => [g.query, ...(expansions[g.query] ?? [])])
const flatVectors = await embed(allCandidateTexts.flat(), 'query')

const rows = []
let cursor = 0
for (const [i, g] of golden.entries()) {
  const candidateTexts = allCandidateTexts[i]
  const vectors = flatVectors.slice(cursor, cursor + candidateTexts.length)
  cursor += candidateTexts.length
  const candidates = candidateTexts.map((text, j) => ({ text, vector: vectors[j] }))
  const survivors = dedupeSimilarQueries(candidates, QUERY_DEDUP_THRESHOLD)

  const resultSets = await Promise.all(
    survivors.map((s) => store.searchForAnswer(s.vector, s.text, DEFAULT_ANSWER_RETRIEVAL_OPTIONS)),
  )
  const merged = mergeAnswerResults(resultSets)
  // Same fix as AskService.askWithGenerator (src/core/ask-service.ts): merged[0] is whichever
  // chunk the most expanded queries corroborated, not necessarily the highest-scoring one. Use
  // the true max so this measurement matches what production actually gates on. -Infinity on
  // an empty merge makes passesConfidenceGate fail naturally, so no separate empty-check needed.
  const topScore = merged.reduce((max, r) => Math.max(max, r.score), -Infinity)
  const passesGate = passesConfidenceGate(topScore, ASK_MIN_CONFIDENCE)

  const context = merged.slice(0, DEFAULT_ANSWER_RETRIEVAL_OPTIONS.maxContextChunks)
  const contextPageIds = context.map((r) => r.page.id)

  rows.push({
    query: g.query,
    expectAnswerable: g.expectAnswerable,
    survivingQueries: survivors.length,
    topScore: Number(topScore.toFixed(3)),
    passesGate,
    gateCorrect: confidenceGateCorrect(passesGate, g.expectAnswerable),
    evidenceRecall: g.expectAnswerable
      ? evidenceRecallAtContext(contextPageIds, g.expectTopPageIds ?? [])
      : null,
  })
}

console.log('QUERY                                          answerable  gate    OK   evidRecall  survQ  topScore')
for (const r of rows) {
  console.log(
    `${r.query.slice(0, 46).padEnd(46)}  ${String(r.expectAnswerable).padEnd(10)}  ` +
      `${(r.passesGate ? 'pass' : 'block').padEnd(6)}  ${r.gateCorrect ? 'yes' : 'NO '}  ` +
      `${r.evidenceRecall === null ? '   n/a' : `     ${r.evidenceRecall}`}       ${r.survivingQueries}      ${r.topScore}`,
  )
}

const gateAccuracy = rows.reduce((a, r) => a + r.gateCorrect, 0) / rows.length
const answerable = rows.filter((r) => r.expectAnswerable)
const evidenceRecallAvg = answerable.length
  ? answerable.reduce((a, r) => a + r.evidenceRecall, 0) / answerable.length
  : 0
console.log('---')
console.log(`gate-accuracy=${gateAccuracy.toFixed(2)}  evidence-recall@context=${evidenceRecallAvg.toFixed(2)}`)

writeFileSync(
  'eval/last-ask-scorecard.json',
  JSON.stringify({ gateAccuracy, evidenceRecallAvg, rows }, null, 2) + '\n',
)
