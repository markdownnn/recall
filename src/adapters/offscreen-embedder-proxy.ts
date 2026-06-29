import type { EmbeddingPort } from '../core/ports'

// SW-side proxy: implements EmbeddingPort but runs NO model. It forwards embed
// requests to the REAL embedder in the offscreen document over RPC, and converts
// the number[][] reply back into Float32Array[] (Float32Array does not survive
// chrome.runtime messaging — it would arrive as a useless plain object).
export class OffscreenEmbedderProxy implements EmbeddingPort {
  constructor(
    private readonly ensureOffscreen: () => Promise<void>,
    private readonly call: (payload: any) => Promise<any>,
  ) {}

  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.ensureOffscreen()
    const { vectors } = await this.call({ op: 'embed', texts, kind })
    return (vectors as number[][]).map((a) => new Float32Array(a))
  }

  // Pre-warm the model in the offscreen; returns the winning device ('webgpu'|'wasm').
  async ensureLoaded(): Promise<string> {
    await this.ensureOffscreen()
    const { device } = await this.call({ op: 'ensureLoaded' })
    return device
  }
}
