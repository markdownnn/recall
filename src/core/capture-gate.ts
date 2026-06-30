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
      const words = input.text.trim().split(/\s+/).filter(Boolean).length
      if (words < this.minWords) return { capture: false, reason: 'thin' }
    }
    return { capture: true }
  }
}
