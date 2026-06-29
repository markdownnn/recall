import { DEFAULT_DENYLIST, isDenylisted } from './denylist'

export interface GateInput {
  url: string
  text: string
  manual: boolean
}
export interface GateDecision {
  capture: boolean
  reason?: 'denylisted' | 'thin'
}

export class CaptureGate {
  private readonly denylist: RegExp[]
  private readonly minWords: number
  constructor(opts: { denylist?: RegExp[]; minWords?: number } = {}) {
    this.denylist = opts.denylist ?? DEFAULT_DENYLIST
    this.minWords = opts.minWords ?? 100
  }

  decide(input: GateInput): GateDecision {
    if (isDenylisted(input.url, this.denylist)) {
      return { capture: false, reason: 'denylisted' }
    }
    if (!input.manual) {
      const words = input.text.trim().split(/\s+/).filter(Boolean).length
      if (words < this.minWords) return { capture: false, reason: 'thin' }
    }
    return { capture: true }
  }
}
