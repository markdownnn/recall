// Owns the single dedicated sqlite worker. Correlates {id,op,args} requests to
// {id,result|error} replies; times out; rejects all pending on worker fault.
export class SqliteWorkerClient {
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly worker: {
      postMessage: (m: unknown) => void
      onmessage: ((e: { data: any }) => void) | null
      onerror: ((e: unknown) => void) | null
    },
    private readonly timeoutMs = 30_000,
  ) {
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data
      const entry = this.pending.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(id)
      if (error) entry.reject(new Error(String(error)))
      else entry.resolve(result)
    }
    this.worker.onerror = (e) => this.rejectAll(e)
  }

  request<T>(op: string, args?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`[sqlite] timeout: ${op}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, op, args })
    })
  }

  private rejectAll(cause: unknown): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(`[sqlite] worker fault: ${String(cause)}`))
    }
    this.pending.clear()
  }
}
