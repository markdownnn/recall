import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const candidates = JSON.parse(readFileSync('eval/model-candidates.json', 'utf8'))
mkdirSync('eval/scorecards', { recursive: true })

const results = []
for (const c of candidates) {
  const safe = c.id.replaceAll('/', '__')
  const env = {
    ...process.env,
    EVAL_MODEL: c.id,
    EVAL_DTYPE: c.dtype,
    EVAL_PREFIX: c.prefix,
    EVAL_MODEL_FILE: c.modelFile ?? '',
  }
  const run = spawnSync(
    'npx',
    ['vite-node', 'eval/run.mjs', '--strip', '--min-prose=0.35', '--golden=eval/english-golden.json'],
    { stdio: 'inherit', env },
  )
  if (run.status !== 0) process.exit(run.status ?? 1)
  const score = JSON.parse(readFileSync('eval/last-scorecard.json', 'utf8'))
  const out = `eval/scorecards/${safe}.json`
  writeFileSync(out, JSON.stringify(score, null, 2) + '\n')
  results.push({ id: c.id, scorecard: out, agg: score.agg })
}

writeFileSync('eval/scorecards/summary.json', JSON.stringify(results, null, 2) + '\n')
console.log('\n[eval] wrote eval/scorecards/summary.json')
