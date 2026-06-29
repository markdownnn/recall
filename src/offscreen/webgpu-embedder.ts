// Real embedder that runs the multilingual-e5-small model inside the offscreen
// document.  Tries WebGPU first (fast) and falls back to single-thread WASM if
// WebGPU is unsupported.  Returns embeddings as number[][] (NOT Float32Array[])
// because Float32Array does not survive chrome.runtime messaging — the SW-side
// proxy reconstructs Float32Array from these plain arrays.
//
// This is the REAL embedder of the hexagonal architecture; the SW holds only a
// proxy (OffscreenEmbedderProxy) that forwards here over RPC.
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'

type ProgressCb = (e: { status: string; progress?: number }) => void

const MODEL_ID = 'Xenova/multilingual-e5-small'
const BATCH = 32

// Configure the ONNX runtime ONCE to load its WASM from the bundled extension
// dir (public/onnx-hf/), not a CDN.  Proven by the WebGPU bench (webgpu-bench.ts):
// both the WASM backend and the WebGPU backend (ort-webgpu) need asyncify.wasm.
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
  }
  // We never bundle the model itself; go straight to the pinned remote fetch.
  env.allowLocalModels = false
}

export class WebGpuEmbedder {
  // Created once per instance; concurrent ensureLoaded/embed share this promise.
  private pipeP: Promise<FeatureExtractionPipeline> | null = null
  private _device: 'webgpu' | 'wasm' | null = null
  // Single-flight queue so ONNX never receives two overlapping inputs.
  private queue: Promise<unknown> = Promise.resolve()

  // Timing captured during createPipe(); zero until loaded.
  private _pipelineMs: number = 0
  private _warmupMs: number = 0

  // Which backend actually won. Null until the pipeline has been created.
  get device(): 'webgpu' | 'wasm' | null {
    return this._device
  }

  // Time (ms) for pipeline() to resolve (model download + onnx/webgpu init).
  get pipelineMs(): number {
    return this._pipelineMs
  }

  // Time (ms) for the warmup embed after the pipeline resolves (shader compilation / first-inference).
  get warmupMs(): number {
    return this._warmupMs
  }

  // Create the pipeline (triggers the model download), wiring v4 progress events
  // to onProgress so download progress can be reported to the popup.
  async ensureLoaded(onProgress?: ProgressCb): Promise<void> {
    await this.getPipe(onProgress)
  }

  private getPipe(onProgress?: ProgressCb): Promise<FeatureExtractionPipeline> {
    if (!this.pipeP) this.pipeP = this.createPipe(onProgress)
    return this.pipeP
  }

  private async createPipe(onProgress?: ProgressCb): Promise<FeatureExtractionPipeline> {
    configureEnv()

    // --- WebGPU first. A failure in creation OR the warmup embed means WebGPU
    //     is unusable here, so we fall through to WASM. ---
    try {
      const t0Pipeline = Date.now()
      const pipe = (await pipeline('feature-extraction', MODEL_ID, {
        device: 'webgpu',
        progress_callback: onProgress,
      } as any)) as FeatureExtractionPipeline
      this._pipelineMs = Date.now() - t0Pipeline
      console.log(`[timing] offscreen pipeline (webgpu attempt) = ${this._pipelineMs} ms`)

      const t0Warmup = Date.now()
      await pipe(['query: warmup'], { pooling: 'mean', normalize: true })
      this._warmupMs = Date.now() - t0Warmup
      console.log(`[timing] offscreen warmup (webgpu) = ${this._warmupMs} ms`)

      this._device = 'webgpu'
      console.log('[recall/offscreen] embedder ready on WebGPU')
      return pipe
    } catch (e) {
      console.warn('[recall/offscreen] WebGPU embedder unavailable, falling back to WASM:', String(e))
      // Reset timing counters before WASM attempt.
      this._pipelineMs = 0
      this._warmupMs = 0
    }

    // --- WASM single-thread fallback. numThreads=1 avoids the proxy worker. ---
    ;(env.backends.onnx as any).wasm.numThreads = 1
    const t0Pipeline = Date.now()
    const pipe = (await pipeline('feature-extraction', MODEL_ID, {
      device: 'wasm',
      progress_callback: onProgress,
    } as any)) as FeatureExtractionPipeline
    this._pipelineMs = Date.now() - t0Pipeline
    console.log(`[timing] offscreen pipeline (wasm) = ${this._pipelineMs} ms`)

    const t0Warmup = Date.now()
    await pipe(['query: warmup'], { pooling: 'mean', normalize: true })
    this._warmupMs = Date.now() - t0Warmup
    console.log(`[timing] offscreen warmup (wasm) = ${this._warmupMs} ms`)

    this._device = 'wasm'
    console.log('[recall/offscreen] embedder ready on WASM (single-thread)')
    return pipe
  }

  // Prefix each text with `${kind}: `, run in batches of 32, return number[][].
  // Serialized through the queue so concurrent embeds never overlap.
  embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
    const run = () => this.runEmbed(texts, kind)
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async runEmbed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
    const pipe = await this.getPipe()
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH)
      const t0 = Date.now()
      const prefixed = slice.map((t) => `${kind}: ${t}`)
      const output = await pipe(prefixed, { pooling: 'mean', normalize: true })
      for (const arr of output.tolist() as number[][]) out.push(arr)
      console.log(
        `[recall/offscreen] embed batch ${Math.floor(i / BATCH) + 1}: ${slice.length} texts (${kind}) in ${Date.now() - t0}ms on ${this._device}`,
      )
    }
    return out
  }
}
