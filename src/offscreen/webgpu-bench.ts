// Spike: measure WebGPU vs WASM embedding speed using @huggingface/transformers v3.
// This file is ADDITIVE and isolated — it does not touch the capture/recall/embedding flow.
// Remove or graduate to production once the architecture decision is made.
//
// SPIKE CSP NOTE: If @huggingface/transformers v3 fails to find the WASM binary from
// the extension's public/onnx-hf/, it will fall back to cdn.jsdelivr.net (onnxruntime-web
// default). The current manifest CSP does NOT allow cdn.jsdelivr.net. If you see
// "net::ERR_BLOCKED_BY_CLIENT" in the bench, add cdn.jsdelivr.net to connect-src as a
// SPIKE-ONLY override and re-build. For production the WASM must be bundled.

import { pipeline, env } from '@huggingface/transformers'

// 32 fixed ASCII passages, 50-120 words each.
// Same texts used for all backends to ensure apples-to-apples comparison.
const PASSAGES: string[] = [
  'The theory of relativity, developed by Albert Einstein, fundamentally changed our understanding of space and time. It showed that both are relative, depending on the speed of the observer, and that energy and mass are interchangeable through the famous equation.',
  'Machine learning is a branch of artificial intelligence that allows computer systems to learn from data and improve their performance over time without being explicitly programmed for each specific task they perform.',
  'The human brain contains roughly 86 billion neurons, each connected to thousands of others via synapses. This vast network processes information in parallel, enabling perception, memory, language, and consciousness.',
  'Climate change refers to long-term shifts in global temperatures and weather patterns. While some changes are natural, scientific evidence shows that human activities, especially burning fossil fuels, are the primary driver since the mid-20th century.',
  'Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen. This biochemical reaction is the foundation of almost all life on Earth, producing the oxygen we breathe.',
  'The internet is a global network of billions of computers and other electronic devices. With the internet, it is possible to access almost any information, communicate with anyone else in the world, and do many more tasks.',
  'Quantum mechanics is the branch of physics that describes the behavior of matter and energy at the atomic and subatomic scale. It introduces concepts like superposition, entanglement, and the uncertainty principle.',
  'DNA, or deoxyribonucleic acid, carries the genetic instructions for the development, functioning, growth, and reproduction of all known organisms and many viruses. Its double-helix structure was discovered in 1953.',
  'The stock market is a marketplace where buyers and sellers trade shares of publicly listed companies. Prices fluctuate based on supply and demand, driven by factors like earnings reports, economic indicators, and investor sentiment.',
  'Ocean currents are large, continuous movements of ocean water driven by forces like wind, temperature, salinity, and Earth rotation. They play a critical role in regulating global climate and weather patterns.',
  'The Renaissance was a period of cultural and intellectual rebirth in Europe between the 14th and 17th centuries, reviving classical Greek and Roman thought and producing remarkable advances in art, science, and literature.',
  'Vaccines work by training the immune system to recognize and fight specific pathogens. They contain weakened or inactivated forms of a microbe, or its surface proteins, that stimulate an immune response without causing disease.',
  'Blockchain is a decentralized, distributed ledger technology that records transactions across many computers in a way that ensures the records cannot be altered retroactively. It underpins cryptocurrencies like Bitcoin and Ethereum.',
  'The speed of light in a vacuum is approximately 299,792 kilometers per second. This constant, denoted as c, plays a fundamental role in physics and sets the ultimate speed limit for the transfer of information.',
  'Neurons transmit information using electrochemical signals called action potentials. When a neuron fires, a wave of electrical activity travels along its axon and triggers the release of neurotransmitters at the synaptic terminal.',
  'Natural language processing is a subfield of artificial intelligence focused on enabling computers to understand, interpret, and generate human language. Applications include machine translation, sentiment analysis, and conversational agents.',
  'The periodic table organizes chemical elements by their atomic number, electron configuration, and recurring chemical properties. Rows are called periods and columns are called groups, which share similar characteristics.',
  'Compilers translate source code written in a high-level programming language into machine code that a computer processor can execute directly. This process involves lexical analysis, parsing, semantic analysis, and code generation.',
  'Supply and demand is a fundamental economic model that determines the price of goods and services in a market. When supply exceeds demand prices fall; when demand exceeds supply prices rise until the market reaches equilibrium.',
  'Stars are massive, luminous spheres of plasma held together by gravity. They generate energy through nuclear fusion in their cores, converting hydrogen into helium and releasing enormous amounts of light and heat in the process.',
  'The human digestive system breaks down food into nutrients that the body can absorb and use for energy, growth, and cell repair. It includes the mouth, esophagus, stomach, small intestine, large intestine, and accessory organs.',
  'Version control systems like Git allow developers to track changes in their code over time, collaborate with others, and revert to earlier versions when needed. Branches enable parallel development of features and bug fixes.',
  'Aerodynamics is the study of how air interacts with solid objects, such as airplane wings or car bodies. Understanding drag and lift is essential for designing efficient vehicles and structures that withstand wind forces.',
  'The law of conservation of energy states that energy cannot be created or destroyed, only converted from one form to another. The total energy in an isolated system remains constant regardless of internal changes.',
  'Microprocessors contain millions to billions of transistors etched onto a silicon chip. These tiny switches process binary data by performing arithmetic and logical operations billions of times per second.',
  'Sleep is essential for cognitive function, emotional regulation, and physical health. During sleep the brain consolidates memories, removes waste products, and the body repairs tissues and regulates hormones.',
  'Tectonic plates are massive segments of the Earth crust that float on the semi-fluid mantle below. Their slow movement drives earthquakes, volcanoes, and mountain formation over geological timescales.',
  'Algorithms are step-by-step procedures or formulas for solving problems. In computer science, algorithm efficiency is measured by time complexity and space complexity, often expressed using Big-O notation.',
  'The greenhouse effect occurs when certain gases in the atmosphere trap heat from the sun, warming the planet surface. Water vapor, carbon dioxide, and methane are the primary greenhouse gases affecting Earth temperature.',
  'Antibiotics are medicines that kill or inhibit the growth of bacteria. They have saved countless lives since penicillin was discovered in 1928, but overuse and misuse have led to the rise of antibiotic-resistant bacteria.',
  'Databases store and organize structured data so it can be efficiently retrieved, updated, and managed. Relational databases use tables linked by keys, while non-relational databases use documents, graphs, or key-value stores.',
  'The theory of evolution by natural selection, proposed by Charles Darwin, explains how species change over generations. Individuals with traits better suited to their environment survive and reproduce more successfully.',
]

export interface BenchResult {
  webgpuMsPerChunk: number | null
  wasm1MsPerChunk: number | null
  wasmMultiMsPerChunk: number | null
  crossOriginIsolated: boolean
  accuracyCosine: number | null
  webgpuDtype: string | null
  notes: string[]
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function embedBatch(pipe: any, texts: string[]): Promise<Float32Array[]> {
  const prefixed = texts.map(t => `passage: ${t}`)
  const output = await pipe(prefixed, { pooling: 'mean', normalize: true })
  return (output.tolist() as number[][]).map(arr => new Float32Array(arr))
}

async function singleVec(pipe: any, text: string): Promise<Float32Array> {
  const output = await pipe([`passage: ${text}`], { pooling: 'mean', normalize: true })
  return new Float32Array((output.tolist() as number[][])[0])
}

export async function runBench(): Promise<BenchResult> {
  const notes: string[] = []
  const crossOriginIsolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false

  // --- Configure WASM paths from the extension (no CDN required) ---
  // public/onnx-hf/ contains the onnxruntime-web asyncify WASM from @huggingface/transformers.
  // We override the wasmPaths that transformers.web.js sets to cdn.jsdelivr.net at module init.
  // Both the WASM backend and the WebGPU backend (ort-webgpu bundle) use asyncify.wasm.
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    const onnxHfBase = chrome.runtime.getURL('onnx-hf/')
    ;(env.backends.onnx as any).wasm.wasmPaths = {
      wasm: `${onnxHfBase}ort-wasm-simd-threaded.asyncify.wasm`,
      mjs: `${onnxHfBase}ort-wasm-simd-threaded.asyncify.mjs`,
    }
    notes.push(`onnx-hf wasmPaths set to ${onnxHfBase}`)
  }
  env.allowLocalModels = false

  // --- WebGPU backend ---
  let webgpuMsPerChunk: number | null = null
  let webgpuDtype: string | null = null
  let webgpuVec: Float32Array | null = null

  const dtypesToTry: Array<string | undefined> = [undefined, 'fp32', 'q8', 'fp16']
  for (const dtype of dtypesToTry) {
    try {
      const opts: Record<string, unknown> = { device: 'webgpu' }
      if (dtype !== undefined) opts.dtype = dtype
      console.log(`[webgpu-bench] trying WebGPU dtype=${dtype ?? 'default'}...`)
      const pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', opts)
      // Warmup: not timed
      await embedBatch(pipe, [PASSAGES[0]])
      console.log('[webgpu-bench] WebGPU warmup done, starting timed run...')
      const t0 = Date.now()
      await embedBatch(pipe, PASSAGES)
      const ms = Date.now() - t0
      webgpuMsPerChunk = ms / PASSAGES.length
      webgpuDtype = dtype ?? 'default'
      webgpuVec = await singleVec(pipe, PASSAGES[0])
      notes.push(`WebGPU: worked with dtype=${webgpuDtype}, totalMs=${ms}`)
      console.log(`[webgpu-bench] WebGPU done: ${ms}ms total, ${webgpuMsPerChunk.toFixed(1)}ms/chunk`)
      break
    } catch (e) {
      const msg = `WebGPU dtype=${dtype ?? 'default'} failed: ${String(e)}`
      notes.push(msg)
      console.warn(`[webgpu-bench] ${msg}`)
    }
  }

  // --- WASM single-thread backend ---
  let wasm1MsPerChunk: number | null = null
  let wasm1Vec: Float32Array | null = null

  try {
    // Force single thread for apples-to-apples comparison
    ;(env.backends.onnx as any).wasm.numThreads = 1
    console.log('[webgpu-bench] creating WASM single-thread pipeline...')
    const pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { device: 'wasm' })
    // Warmup
    await embedBatch(pipe, [PASSAGES[0]])
    console.log('[webgpu-bench] WASM-1 warmup done, starting timed run...')
    const t0 = Date.now()
    await embedBatch(pipe, PASSAGES)
    const ms = Date.now() - t0
    wasm1MsPerChunk = ms / PASSAGES.length
    wasm1Vec = await singleVec(pipe, PASSAGES[0])
    notes.push(`WASM-1: totalMs=${ms}`)
    console.log(`[webgpu-bench] WASM-1 done: ${ms}ms total, ${wasm1MsPerChunk.toFixed(1)}ms/chunk`)
  } catch (e) {
    const msg = `WASM single-thread failed: ${String(e)}`
    notes.push(msg)
    console.error(`[webgpu-bench] ${msg}`)
  }

  // --- WASM multi-thread backend ---
  let wasmMultiMsPerChunk: number | null = null

  if (!crossOriginIsolated) {
    const msg = 'WASM multi-thread: unavailable (crossOriginIsolated=false; SharedArrayBuffer requires COOP/COEP headers — not set in Chrome extension offscreen docs by default)'
    notes.push(msg)
    console.log(`[webgpu-bench] ${msg}`)
  } else {
    try {
      const threads = navigator.hardwareConcurrency
      ;(env.backends.onnx as any).wasm.numThreads = threads
      console.log(`[webgpu-bench] creating WASM multi-thread pipeline (threads=${threads})...`)
      const pipe = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { device: 'wasm' })
      await embedBatch(pipe, [PASSAGES[0]])  // warmup
      const t0 = Date.now()
      await embedBatch(pipe, PASSAGES)
      const ms = Date.now() - t0
      wasmMultiMsPerChunk = ms / PASSAGES.length
      notes.push(`WASM-multi (threads=${threads}): totalMs=${ms}`)
      console.log(`[webgpu-bench] WASM-multi done: ${ms}ms total, ${wasmMultiMsPerChunk.toFixed(1)}ms/chunk`)
    } catch (e) {
      const msg = `WASM multi-thread failed: ${String(e)}`
      notes.push(msg)
      console.warn(`[webgpu-bench] ${msg}`)
    }
  }

  // --- Accuracy: cosine similarity between WebGPU and WASM-1 vectors ---
  let accuracyCosine: number | null = null
  if (webgpuVec && wasm1Vec) {
    accuracyCosine = cosine(webgpuVec, wasm1Vec)
    notes.push(`accuracy cosine(webgpu, wasm1) = ${accuracyCosine.toFixed(6)}`)
    console.log(`[webgpu-bench] accuracy: cosine = ${accuracyCosine.toFixed(6)}`)
  } else {
    notes.push('accuracy: could not compute (one or both backends failed)')
  }

  return {
    webgpuMsPerChunk,
    wasm1MsPerChunk,
    wasmMultiMsPerChunk,
    crossOriginIsolated,
    accuracyCosine,
    webgpuDtype,
    notes,
  }
}
