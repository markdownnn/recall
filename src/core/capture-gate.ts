import { DEFAULT_DENYLIST, isDenylisted } from './denylist'
import { isSerp } from './serp'
import { isInternalHost } from './internal-host'
import type { AppSettings } from './ports'

export interface GateInput { url: string; text: string; manual: boolean }
export interface GateDecision { capture: boolean; reason?: 'paused' | 'denylisted' | 'thin' | 'serp' | 'internal' }

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

function hostDenied(host: string, denyHosts: string[]): boolean {
  if (!host) return false
  return denyHosts.some((d) => host === d || host.endsWith('.' + d))
}

// Average English word length (letters per word). The thin gate is configured in WORDS
// (minWords) but measured in LETTERS, so we convert with this constant. ~5 is the standard
// mean English word length, keeping the letter threshold equivalent to the old word count.
const AVG_WORD_LEN = 5

export class CaptureGate {
  private readonly denylist: RegExp[]
  private readonly minWords: number
  constructor(opts: { denylist?: RegExp[]; minWords?: number } = {}) {
    this.denylist = opts.denylist ?? DEFAULT_DENYLIST
    this.minWords = opts.minWords ?? 100
  }

  decide(input: GateInput, settings: AppSettings): GateDecision {
    // Pause is a temporary global hard gate — blocks everything, even manual.
    if (settings.paused) return { capture: false, reason: 'paused' }
    // Hard gate (privacy): built-in denylist + user "don't remember" hosts. Applies to manual.
    if (isDenylisted(input.url, this.denylist)) return { capture: false, reason: 'denylisted' }
    if (hostDenied(hostOf(input.url), settings.userDenyHosts)) return { capture: false, reason: 'denylisted' }
    // Soft gate (quality): skipped for explicit manual save.
    if (!input.manual) {
      // SERPs are navigational link lists, not content worth recalling.
      if (isSerp(input.url)) return { capture: false, reason: 'serp' }
      // Internal / private-network hosts are not public content worth recalling.
      if (isInternalHost(hostOf(input.url))) return { capture: false, reason: 'internal' }
      // Measure content size script-agnostically by counting Unicode LETTERS + NUMBERS
      // (\p{L} + \p{N}), not whitespace-split "words". A long Chinese/Japanese page has no
      // inter-word spaces, so a word count collapses the whole page to 1 "word" and the gate
      // wrongly rejects it as thin (auto-capture never fires). We count \p{N} too so
      // number/code-heavy English pages (stats tables, code listings) - lots of digits, few
      // letters - aren't wrongly dropped as thin the way a letter-only count would. CJK stays
      // \p{L} (matching prose-score.ts). The threshold is the word budget scaled by average
      // word length, so English behavior stays equivalent.
      const letters = (input.text.match(/[\p{L}\p{N}]/gu) ?? []).length
      if (letters < this.minWords * AVG_WORD_LEN) return { capture: false, reason: 'thin' }
    }
    return { capture: true }
  }
}
