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

// The transformers pipeline() factory, narrowed to what this class uses.
// Injectable via the constructor so unit tests can supply a FAKE factory and
// exercise the load/retry/batching logic without downloading a real model.
export type PipelineFactory = (
  task: string,
  model: string,
  options?: unknown,
) => Promise<FeatureExtractionPipeline>

const MODEL_ID = 'Xenova/multilingual-e5-small'
const BATCH = 32

// Configure the ONNX runtime ONCE to load its WASM from the bundled extension
// dir (public/onnx-hf/), not a CDN.  Both WASM and WebGPU backends need asyncify.wasm.
// The model itself is also bundled under public/models/ (fetched at build time by
// scripts/fetch-model.mjs) so connect-src no longer needs huggingface.co at runtime.
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
    // Load the model from the bundled extension path, never from a remote host.
    env.allowLocalModels = true
    env.localModelPath = chrome.runtime.getURL('models/')
    env.allowRemoteModels = false
  }
}

export class WebGpuEmbedder {
  // Created once per instance; concurrent ensureLoaded/embed share this promise.
  private pipeP: Promise<FeatureExtractionPipeline> | null = null
  private _device: 'webgpu' | 'wasm' | null = null
  // Single-flight queue so ONNX never receives two overlapping inputs.
  private queue: Promise<unknown> = Promise.resolve()
  // Default progress sink. Used by the LAZY load path (a capture/recall that
  // triggers getPipe() without an explicit onProgress) so the popup still sees
  // model-load progress instead of a silent wait.
  private progressSink?: ProgressCb

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

  // Create the pipeline (triggers the model download), wiring v4 progress events
  // to onProgress so download progress can be reported to the popup.
  async ensureLoaded(onProgress?: ProgressCb): Promise<void> {
    await this.getPipe(onProgress)
  }

  private getPipe(onProgress?: ProgressCb): Promise<FeatureExtractionPipeline> {
    if (!this.pipeP) {
      // POISONED-PIPE FIX: if createPipe rejects, null out pipeP so the NEXT
      // call retries (e.g. after the network recovers). Without this, the
      // rejected promise stays cached forever and every later call replays the
      // same rejection.
      this.pipeP = this.createPipe(onProgress ?? this.progressSink).catch((e) => {
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
        // dtype:'q8' requests model_quantized.onnx — the file we bundle in public/models/.
        dtype: 'q8',
        progress_callback: onProgress,
      })) as FeatureExtractionPipeline
      await pipe(['query: warmup'], { pooling: 'mean', normalize: true })
      this._device = 'webgpu'
      console.log('[recall] embedder ready on WebGPU')
      return pipe
    } catch (e) {
      console.warn('[recall] WebGPU unavailable, falling back to WASM:', String(e))
    }

    // --- WASM single-thread fallback. numThreads=1 avoids the proxy worker. ---
    ;(env.backends.onnx as any).wasm.numThreads = 1
    const pipe = (await this.pipelineFactory('feature-extraction', MODEL_ID, {
      device: 'wasm',
      // dtype:'q8' requests model_quantized.onnx — the same bundled file used by WebGPU path.
      dtype: 'q8',
      progress_callback: onProgress,
    })) as FeatureExtractionPipeline
    await pipe(['query: warmup'], { pooling: 'mean', normalize: true })
    this._device = 'wasm'
    console.log('[recall] embedder ready on WASM (single-thread)')
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
      const prefixed = slice.map((t) => `${kind}: ${t}`)
      const output = await pipe(prefixed, { pooling: 'mean', normalize: true })
      for (const arr of output.tolist() as number[][]) out.push(arr)
    }
    return out
  }
}
