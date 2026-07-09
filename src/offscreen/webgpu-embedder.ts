// Real embedder that runs the selected BGE English model inside the offscreen document.
// Query text gets BGE's search instruction; passage text stays raw. Tries WebGPU first
// (fast) and falls back to single-thread WASM if WebGPU is unsupported; if BOTH
// fail, the load REJECTS so the offscreen can surface an "unavailable" state
// (this device can't run the on-device model).  Returns embeddings as number[][]
// (NOT Float32Array[]) because Float32Array does not survive chrome.runtime
// messaging — the SW-side proxy reconstructs Float32Array from these plain arrays.
//
// This is the REAL embedder of the hexagonal architecture; the SW holds only a
// proxy (OffscreenEmbedderProxy) that forwards here over RPC.
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { MODEL_CDN_BASE_URL } from '../core/model-cdn'

type ProgressCb = (e: { status: string; progress?: number }) => void

interface EmbedTask {
  texts: string[]
  kind: 'query' | 'passage'
  resolve: (vecs: number[][]) => void
  reject: (err: unknown) => void
}

// The transformers pipeline() factory, narrowed to what this class uses.
// Injectable via the constructor so unit tests can supply a FAKE factory and
// exercise the load/retry/batching logic without downloading a real model.
export type PipelineFactory = (
  task: string,
  model: string,
  options?: unknown,
) => Promise<FeatureExtractionPipeline>

const MODEL_ID = 'bge-base-en-v1.5'
// Small batches + a yield between them keep indexing GPU-gentle: a big single
// submission monopolizes the GPU and makes the page the user is currently reading
// stutter. Smaller submissions with gaps let the foreground keep rendering. A single
// query (1 text => 1 batch) never hits the inter-batch yield, so search stays fast.
const BATCH = 4
const YIELD_MS = 120
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Configure the ONNX runtime ONCE to load its WASM from the bundled extension
// dir (public/onnx-hf/), not a CDN.  Both WASM and WebGPU backends need asyncify.wasm.
// The BGE model itself is downloaded from our model CDN and cached by the browser.
let _envConfigured = false
function configureEnv(): void {
  if (_envConfigured) return
  _envConfigured = true
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    const onnxHfBase = chrome.runtime.getURL('onnx-hf/')
    ;(env.backends.onnx as any).wasm.wasmPaths = {
      wasm: `${onnxHfBase}ort-wasm-simd-threaded.asyncify.wasm`,
      mjs: `${onnxHfBase}ort-wasm-simd-threaded.asyncify.mjs`,
    }
    env.allowLocalModels = false
    env.allowRemoteModels = true
    env.remoteHost = MODEL_CDN_BASE_URL
    env.remotePathTemplate = '{model}/resolve/{revision}/'
    env.useBrowserCache = true
  }
}

export class WebGpuEmbedder {
  // Created once per instance; concurrent ensureLoaded/embed share this promise.
  private pipeP: Promise<FeatureExtractionPipeline> | null = null
  private _device: 'webgpu' | 'wasm' | null = null
  // [Recall:perf] instrumentation. _everLoaded distinguishes a FRESH first load from a
  // RELOAD after a device-lost/inference reset; _resetCount tracks how often the pipe was
  // nulled (each reset forces a costly model reload). Remove with the perf logs.
  private _everLoaded = false
  private _resetCount = 0
  // Single-flight, two-lane scheduler: ONNX never gets two overlapping inputs, AND an
  // interactive query never waits behind background passage work. queries -> highQ,
  // passages -> lowQ; the pump always drains highQ first. The in-flight runEmbed is never
  // interrupted (ONNX can't be), so passage batches are kept small (IndexingService).
  private highQ: EmbedTask[] = []
  private lowQ: EmbedTask[] = []
  private pumping = false
  // Default progress sink. Used by the LAZY load path (a capture/recall that
  // triggers getPipe() without an explicit onProgress) so the popup still sees
  // model-load progress instead of a silent wait.
  private progressSink?: ProgressCb
  private degradedSink?: (info: { device: 'wasm' }) => void
  // createPipe re-runs on every pipe reset (device-lost/inference reset), and each WASM reload
  // would re-fire the 'wasm' degraded notice. Emit it AT MOST ONCE per session so the side panel
  // doesn't flap the "running slow" banner on every reset.
  private degradedEmitted = false

  // pipelineFactory defaults to the real transformers pipeline(); tests inject a fake.
  constructor(private readonly pipelineFactory: PipelineFactory = pipeline as unknown as PipelineFactory) {}

  // Which backend actually won. Null until the pipeline has been created.
  get device(): 'webgpu' | 'wasm' | null {
    return this._device
  }

  // Register a default progress callback used whenever getPipe() runs without an
  // explicit one (the lazy-load path). The offscreen wires this to model-progress
  // rpc-events so lazy loads show progress too.
  setProgressSink(cb: ProgressCb): void {
    this.progressSink = cb
  }

  // The offscreen wires this to an 'embedder-degraded' rpc-event with state:'wasm'. Called once
  // BGE loaded on WASM (slower than the WebGPU ideal). The side panel turns it into a
  // "running slow" notice instead of a buried console.warn. (The harder "unavailable" state -
  // BGE failed on BOTH providers - is surfaced by the offscreen from ensureLoaded's
  // rejection, not from here.)
  setDegradedSink(cb: (info: { device: 'wasm' }) => void): void {
    this.degradedSink = cb
  }

  // Create the pipeline (triggers the model download), wiring v4 progress events
  // to onProgress so download progress can be reported to the popup.
  async ensureLoaded(onProgress?: ProgressCb): Promise<void> {
    await this.getPipe(onProgress)
  }

  private getPipe(onProgress?: ProgressCb): Promise<FeatureExtractionPipeline> {
    if (!this.pipeP) {
      // [Recall:perf] time the model load and tag it fresh vs reload (a reload follows a
      // device-lost/inference reset and re-pays the full load cost - a prime suspect for
      // a 30s indexing stall). Remove this block with the other perf logs.
      const fresh = !this._everLoaded
      const t0 = performance.now()
      // POISONED-PIPE FIX: if createPipe rejects, null out pipeP so the NEXT
      // call retries (e.g. after the network recovers). Without this, the
      // rejected promise stays cached forever and every later call replays the
      // same rejection.
      this.pipeP = this.createPipe(onProgress ?? this.progressSink)
        .then((pipe) => {
          this._everLoaded = true
          console.log(
            `[Recall:perf] bge-load device=${this._device ?? 'unknown'} ms=${Math.round(performance.now() - t0)} ` +
            `kind=${fresh ? 'fresh' : 'reload'}`,
          )
          return pipe
        })
        .catch((e) => {
          this.pipeP = null
          throw e
        })
    }
    return this.pipeP
  }

  private async createPipe(onProgress?: ProgressCb): Promise<FeatureExtractionPipeline> {
    configureEnv()

    // --- WebGPU first. A failure in creation OR the warmup embed means WebGPU
    //     is unusable here, so we fall through to WASM. ---
    try {
      const pipe = (await this.pipelineFactory('feature-extraction', MODEL_ID, {
        device: 'webgpu',
        // dtype:'q8' requests model_quantized.onnx from the CDN model folder.
        dtype: 'q8',
        progress_callback: onProgress,
      })) as FeatureExtractionPipeline
      await pipe(['warmup'], { pooling: 'mean', normalize: true }) // raw text, no prefix
      this._device = 'webgpu'
      console.log('[recall] embedder ready on WebGPU')
      return pipe
    } catch (e) {
      console.warn('[recall] WebGPU unavailable, falling back to WASM:', String(e))
    }

    // --- WASM single-thread fallback. numThreads=1 avoids the proxy worker. If THIS also
    //     throws there is no further fallback: the rejection propagates, getPipe
    //     nulls pipeP, and ensureLoaded rejects so the offscreen can surface "unavailable". ---
    ;(env.backends.onnx as any).wasm.numThreads = 1
    const pipe = (await this.pipelineFactory('feature-extraction', MODEL_ID, {
      device: 'wasm',
      dtype: 'q8', // model_quantized.onnx - the same CDN file used by the WebGPU path.
      progress_callback: onProgress,
    })) as FeatureExtractionPipeline
    await pipe(['warmup'], { pooling: 'mean', normalize: true }) // raw text, no prefix
    this._device = 'wasm'
    console.warn('[recall] DEGRADED embedder: BGE on WASM single-thread (slow)')
    if (!this.degradedEmitted) {
      this.degradedEmitted = true
      this.degradedSink?.({ device: 'wasm' })
    }
    console.log('[recall] embedder ready on WASM (single-thread)')
    return pipe
  }

  // Enqueue an embed onto its lane (query -> highQ, passage -> lowQ) and kick the pump.
  // Serialized + reordered so concurrent embeds never overlap and a query never waits
  // behind queued passage work.
  embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
    return new Promise<number[][]>((resolve, reject) => {
      ;(kind === 'query' ? this.highQ : this.lowQ).push({ texts, kind, resolve, reject })
      this.pump()
    })
  }

  // Single-flight: one runEmbed at a time. Always prefer a waiting query over passages.
  // Checks `pumping` BEFORE shifting (never drops a task) and always re-pumps in .finally
  // (a failed batch never stalls the lane).
  private pump(): void {
    if (this.pumping) return
    const next = this.highQ.shift() ?? this.lowQ.shift()
    if (!next) return
    this.pumping = true
    this.runEmbed(next.texts, next.kind).then(next.resolve, next.reject).finally(() => {
      this.pumping = false
      this.pump()
    })
  }

  private async runEmbed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
    const pipe = await this.getPipe()
    const out: number[][] = []
    try {
      for (let i = 0; i < texts.length; i += BATCH) {
        const slice = texts.slice(i, i + BATCH)
        const inputs =
          kind === 'query'
            ? slice.map((text) => `Represent this sentence for searching relevant passages: ${text}`)
            : slice
        // [Recall:perf] per-batch embed cost. Summed over a drain this shows whether the
        // ~30s is the model inference itself vs the load/yields around it. Removable.
        const b0 = performance.now()
        const output = await pipe(inputs, { pooling: 'mean', normalize: true })
        console.log(`[Recall:perf] embed batch=${slice.length} ${Math.round(performance.now() - b0)}ms`)
        for (const arr of output.tolist() as number[][]) out.push(arr)
        // Yield the GPU between batches (not after the last) so the foreground page
        // the user is reading keeps rendering smoothly during background indexing.
        if (i + BATCH < texts.length) await sleep(YIELD_MS)
      }
    } catch (e) {
      // DEAD-PIPE FIX: an inference can throw AFTER the pipe resolved (e.g. a
      // WebGPU "device lost" mid-run). The cached pipe is now dead, so null it
      // out — the NEXT embed (or the drain's next retry) reloads the model and
      // self-heals instead of replaying this failure forever. Single-flight
      // guarantees one runEmbed at a time, so no concurrent caller is mid-use of
      // this promise; nulling it here is safe.
      this.pipeP = null
      // [Recall:perf] each reset forces a full model reload on the next embed; a high
      // count points at WebGPU instability as the regression cause. Removable.
      console.log(`[Recall:perf] pipe reset (count=${++this._resetCount}) after inference failure`)
      throw e
    }
    return out
  }
}
