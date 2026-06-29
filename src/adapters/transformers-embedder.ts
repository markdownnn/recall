import type { EmbeddingPort } from '../core/ports'

export class TransformersEmbedder implements EmbeddingPort {
  private seq = 0
  private pending = new Map<number, (v: Float32Array[]) => void>()
  private rejecters = new Map<number, (e: unknown) => void>()

  constructor(private readonly worker: Worker) {
    this.worker.onmessage = (e: MessageEvent<{ id: number; vectors?: Float32Array[]; error?: string }>) => {
      const { id, vectors, error } = e.data
      if (error) { this.rejecters.get(id)?.(new Error(error)) }
      else { this.pending.get(id)?.(vectors!) }
      this.pending.delete(id); this.rejecters.delete(id)
    }
  }

  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const id = this.seq++
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve)
      this.rejecters.set(id, reject)
      this.worker.postMessage({ id, texts, kind })
    })
  }
}
