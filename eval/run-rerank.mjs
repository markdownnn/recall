// Reranker A/B: does a cross-encoder reorder retrieved candidates into a better top-5 than the
// hybrid search order alone? (Backlog A1, "evidence first" step.)
//
// For each golden query it retrieves the top-N page candidates ONCE, then compares two top-5s
// drawn from that same set -- so the only variable is the ordering:
//   BASELINE  = the hybrid search order, truncated to 5 (what production shows today)
//   RERANKED  = the same candidates reordered by the cross-encoder, truncated to 5
// Retrieving more than 5 before reranking is the point: a target sitting at rank 6-N (search
// recall) can be rescued into the top-5 by the reranker.
//
// Usage: vite-node eval/run-rerank.mjs [--golden=<path>] [--strip] [--min-prose=0.35]
//   env: RERANK_RETRIEVE (candidate pool, default 25), RERANK_MODEL, RERANK_DTYPE
import { readFileSync } from 'node:fs'
import { buildStore, runQuery, loadManifest } from './lib/build-and-search.mjs'
import { rerank } from './lib/rerank-node.mjs'
import { precisionAt1, recallAtK, mrr, aggregate } from '../src/core/eval-metrics.ts'

const args = process.argv.slice(2)
const strip = args.includes('--strip')
const minProse = Number(args.find((a) => a.startsWith('--min-prose='))?.split('=')[1] ?? 0)
const goldenPath = args.find((a) => a.startsWith('--golden='))?.split('=')[1] ?? 'eval/english-golden.json'
const K = 5
const RETRIEVE_N = Number(process.env.RERANK_RETRIEVE || 25) || 25

const manifest = loadManifest()
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
console.log(`[rerank-eval] corpus=${manifest.length} pages  queries=${golden.length}  retrieveN=${RETRIEVE_N}  strip=${strip}  minProse=${minProse}`)
const store = await buildStore(manifest, { strip, minProse })

const baseRows = []
const rerRows = []
const perQuery = []
for (const g of golden) {
  const candidates = await runQuery(store, g.query, RETRIEVE_N) // page-diverse RankedResult[], search order
  const baseIds = candidates.slice(0, K).map((r) => r.page.id)
  const reranked = await rerank(g.query, candidates)
  const rerIds = reranked.slice(0, K).map((r) => r.page.id)

  const base = { p1: precisionAt1(baseIds, g.expectTopPageIds), r5: recallAtK(baseIds, g.expectTopPageIds, K), rr: mrr(baseIds, g.expectTopPageIds) }
  const rer = { p1: precisionAt1(rerIds, g.expectTopPageIds), r5: recallAtK(rerIds, g.expectTopPageIds, K), rr: mrr(rerIds, g.expectTopPageIds) }
  baseRows.push(base)
  rerRows.push(rer)
  perQuery.push({ scenario: g.scenario, query: g.query, base, rer, baseTop: baseIds[0] ?? '(none)', rerTop: rerIds[0] ?? '(none)' })
}

const b = aggregate(baseRows)
const r = aggregate(rerRows)

console.log('\nSCEN  P@1(base->rer)  RR(base->rer)  query')
for (const q of perQuery) {
  const mark = q.rer.p1 > q.base.p1 ? ' +' : q.rer.p1 < q.base.p1 ? ' -' : '  '
  console.log(
    `${q.scenario.padEnd(5)} ${q.base.p1}->${q.rer.p1}${mark}         ` +
      `${q.base.rr.toFixed(2)}->${q.rer.rr.toFixed(2)}    ${q.query}`,
  )
}
console.log('---')
console.log(`BASELINE  P@1=${b.precisionAt1.toFixed(2)}  recall@5=${b.recallAt5.toFixed(2)}  MRR=${b.mrr.toFixed(2)}`)
console.log(`RERANKED  P@1=${r.precisionAt1.toFixed(2)}  recall@5=${r.recallAt5.toFixed(2)}  MRR=${r.mrr.toFixed(2)}`)
console.log(
  `DELTA     P@1=${(r.precisionAt1 - b.precisionAt1 >= 0 ? '+' : '')}${(r.precisionAt1 - b.precisionAt1).toFixed(2)}  ` +
    `recall@5=${(r.recallAt5 - b.recallAt5 >= 0 ? '+' : '')}${(r.recallAt5 - b.recallAt5).toFixed(2)}  ` +
    `MRR=${(r.mrr - b.mrr >= 0 ? '+' : '')}${(r.mrr - b.mrr).toFixed(2)}`,
)
