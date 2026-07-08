import type {
  AppConfig,
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngineInterface,
} from '@mlc-ai/web-llm'
import type { AnswerDraft, AnswerGeneratorPort, AnswerRequest } from '../core/answer-generator'
import type { RankedResult } from '../core/model'

export const LLAMA_ASK_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC'
export const LLAMA_ASK_MODEL_DIR = 'models/webllm/llama-3.2-1b-instruct/q4f16_1/resolve/main/'
export const LLAMA_ASK_MODEL_LIB = 'Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm'
export const NOT_FOUND_ANSWER = 'I could not find that in your saved pages.'
export type ModelProgressEvent = { status: string; progress?: number }

function extensionUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path)
  }
  return path
}

export function buildLlamaAppConfig(modelBaseUrl: string, modelLibUrl: string): AppConfig {
  return {
    model_list: [
      {
        model: modelBaseUrl,
        model_id: LLAMA_ASK_MODEL,
        model_lib: modelLibUrl,
        vram_required_MB: 879.04,
        low_resource_required: true,
        overrides: { context_window_size: 4096 },
      },
    ],
  }
}

export function webLlmProgressToModelProgress(report: InitProgressReport): ModelProgressEvent {
  const raw = report.progress <= 1 ? report.progress * 100 : report.progress
  return { status: 'progress', progress: Math.max(0, Math.min(100, Math.round(raw))) }
}

export function buildAskMessages(question: string, chunks: RankedResult[]): ChatCompletionMessageParam[] {
  const context = chunks
    .map((r) => `[${r.chunk.id}] ${r.page.title}\n${r.chunk.text}`)
    .join('\n\n')
  return [
    {
      role: 'system',
      content:
        `Use only the saved chunks to answer. If the chunks do not answer the question, say exactly: ${NOT_FOUND_ANSWER} Cite chunk ids in square brackets.`,
    },
    {
      role: 'user',
      content: `Question: ${question}\n\nSaved chunks:\n${context}`,
    },
  ]
}

export async function createLlamaAskEngine(
  onProgress?: (e: ModelProgressEvent) => void,
): Promise<MLCEngineInterface> {
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm')
  const modelBaseUrl = extensionUrl(LLAMA_ASK_MODEL_DIR)
  const modelLibUrl = extensionUrl(`${LLAMA_ASK_MODEL_DIR}${LLAMA_ASK_MODEL_LIB}`)
  onProgress?.({ status: 'initiate', progress: 0 })
  const engine = await CreateMLCEngine(LLAMA_ASK_MODEL, {
    appConfig: buildLlamaAppConfig(modelBaseUrl, modelLibUrl),
    initProgressCallback: (report) => onProgress?.(webLlmProgressToModelProgress(report)),
  })
  onProgress?.({ status: 'ready' })
  return engine
}

export class WebLlmAnswerGenerator implements AnswerGeneratorPort {
  constructor(private readonly engine: MLCEngineInterface) {}

  async answer(request: AnswerRequest): Promise<AnswerDraft> {
    const completion = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks),
      temperature: 0,
      max_tokens: 220,
    })
    const text = completion.choices[0]?.message.content?.trim() || NOT_FOUND_ANSWER
    const ids = new Set(request.chunks.map((r) => r.chunk.id))
    const citedChunkIds = [...text.matchAll(/\[([^\]]+)\]/g)]
      .map((m) => m[1])
      .filter((id) => ids.has(id))
    return { text, citedChunkIds }
  }
}
