import type {
  AppConfig,
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngineInterface,
} from '@mlc-ai/web-llm'
import { NOT_FOUND_ANSWER, type AnswerDraft, type AnswerGeneratorPort, type AnswerRequest } from '../core/answer-generator'
import { parseAnswerCitation } from '../core/answer-citation'
import type { RankedResult } from '../core/model'
import { modelCdnUrl } from '../core/model-cdn'

export const LLAMA_ASK_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC'
export const LLAMA_ASK_MODEL_DIR = 'webllm/llama-3.2-1b-instruct/q4f16_1/resolve/main/'
export const LLAMA_ASK_MODEL_LIB = 'Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm'
export const GEMMA_ASK_MODEL = 'gemma3-1b-it-q4f16_1-MLC'
export const GEMMA_ASK_MODEL_DIR = 'webllm/gemma3-1b-it/q4f16_1/resolve/main/'
export const GEMMA_ASK_MODEL_LIB = 'gemma3-1b-it-q4f16_1_cs1k-webgpu.wasm'
export const ASK_MODEL_CANDIDATES = [LLAMA_ASK_MODEL, GEMMA_ASK_MODEL] as const
export const MAX_QUERY_EXPANSIONS = 4
export const MAX_EVIDENCE_PROMPT_CHUNKS = 4
export const MAX_ASK_PROMPT_CHUNKS = 3
export const MAX_CHARS_PER_PROMPT_CHUNK = 800
export const MAX_EVIDENCE_TOKENS = 220
// Kept short on purpose: Ask must return a concise SUMMARY, not a wall of text. A large budget
// let the 1B model ramble and paste excerpts until it got cut off mid-sentence; a tight cap forces
// a short answer that finishes cleanly.
export const MAX_ANSWER_TOKENS = 200
export type ModelProgressEvent = { status: string; progress?: number; error?: string }

function buildWebLlmAppConfig(
  modelId: string,
  modelBaseUrl: string,
  modelLibUrl: string,
  vramRequiredMB: number,
  lowResourceRequired: boolean,
  overrides: Record<string, number> = {},
): AppConfig {
  return {
    model_list: [
      {
        model: modelBaseUrl,
        model_id: modelId,
        model_lib: modelLibUrl,
        vram_required_MB: vramRequiredMB,
        low_resource_required: lowResourceRequired,
        overrides: { context_window_size: 4096, ...overrides },
      },
    ],
  }
}

export function buildLlamaAppConfig(modelBaseUrl: string, modelLibUrl: string): AppConfig {
  return buildWebLlmAppConfig(LLAMA_ASK_MODEL, modelBaseUrl, modelLibUrl, 879.04, true)
}

export function buildGemmaAppConfig(modelBaseUrl: string, modelLibUrl: string): AppConfig {
  // Gemma 3 is built around sliding-window attention (native window 512, interleaved with global
  // layers). WebLLM requires EXACTLY ONE of context_window_size / sliding_window_size to be
  // positive. So set context_window_size to -1 and let the model's native 512 sliding window
  // drive. The reverse (sliding_window_size: -1 + context 4096, i.e. forced full attention) loaded
  // but produced repeating gibberish -- the wasm lib expects the sliding-window path.
  // Sliding window also requires an attention_sink_size; 0 selects the default sliding-window
  // behaviour (WebLLM errors without it: AttentionSinkSizeError).
  return buildWebLlmAppConfig(GEMMA_ASK_MODEL, modelBaseUrl, modelLibUrl, 711.07, true, {
    context_window_size: -1,
    attention_sink_size: 0,
  })
}

export function webLlmProgressToModelProgress(report: InitProgressReport): ModelProgressEvent {
  const raw = report.progress <= 1 ? report.progress * 100 : report.progress
  return { status: 'progress', progress: Math.max(0, Math.min(100, Math.round(raw))) }
}

function promptSafeChunkText(text: string): string {
  if (text.length <= MAX_CHARS_PER_PROMPT_CHUNK) return text
  return `${text.slice(0, MAX_CHARS_PER_PROMPT_CHUNK).trimEnd()}...`
}

function formatSavedExcerpts(chunks: RankedResult[], maxChunks: number): string {
  return chunks
    .slice(0, maxChunks)
    .map((r, i) => `Excerpt ${i + 1})\nPage title: ${r.page.title}\nSaved text: ${promptSafeChunkText(r.chunk.text)}`)
    .join('\n\n')
}

export function buildEvidenceMessages(question: string, chunks: RankedResult[]): ChatCompletionMessageParam[] {
  return [
    {
      role: 'user',
      content:
        [
          'Read the saved excerpts and the user question.',
          '',
          'Return short working notes for the final answer.',
          '- Which excerpts directly answer the question?',
          '- What exact facts are supported?',
          '- What should be ignored as unrelated?',
          '- If the answer is not present, say that clearly.',
          '',
          'Do not answer the user yet.',
          'Keep it short. Use only the saved excerpts.',
          '',
          `Saved excerpts:\n${formatSavedExcerpts(chunks, MAX_EVIDENCE_PROMPT_CHUNKS)}`,
          '',
          `Question: ${question}`,
        ].join('\n'),
    },
  ]
}

export function buildAskMessages(question: string, chunks: RankedResult[]): ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content:
        [
          "You are Recall, a search assistant for the user's saved pages.",
          "Answer the user's question using only the saved page excerpts below.",
          'Rules:',
          '- Use ONLY information found in the saved excerpts. Never invent facts, numbers, names, or dates.',
          `- If the saved excerpts don't contain the answer, say exactly: "${NOT_FOUND_ANSWER}"`,
          '- Give a SHORT, direct answer in 1-3 sentences of plain prose, in your own words.',
          '- Do NOT quote, paste, or list the excerpts, and do not copy sentences verbatim.',
          '- Write ONLY the answer sentences, with no headings, labels, or section titles (no "Answer" or "Summary" labels, no sources or citation section), no markdown, no bullet points, and no lists.',
          "- Match the language of the user's question.",
          '- Stay neutral and factual. No opinions or filler.',
        ].join(' '),
    },
    {
      role: 'user',
      content: [`Saved excerpts:\n${formatSavedExcerpts(chunks, MAX_ASK_PROMPT_CHUNKS)}`, `Question: ${question}`].join('\n\n'),
    },
  ]
}

export function buildQueryExpansionMessages(question: string): ChatCompletionMessageParam[] {
  return [
    {
      role: 'user',
      content:
        [
          "You expand a user's search query into multiple search queries to improve retrieval coverage.",
          '',
          "Given the user's question, output 3-4 alternative search queries that each explore a DIFFERENT angle, entity, or sub-topic of the question.",
          '- Do NOT just reword the same idea with synonyms. Each query should be able to surface DIFFERENT saved content than the others.',
          '- Break a complex question into distinct sub-questions if it has multiple parts.',
          '- Include both broad and specific versions.',
          '',
          'Output ONLY a JSON array of strings. No explanation, no markdown.',
          '',
          `User question: ${question}`,
        ].join('\n'),
    },
  ]
}

export function parseExpandedQueries(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw.trim())
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_QUERY_EXPANSIONS)
  } catch {
    return []
  }
}

// A swappable description of an on-device Ask model: which MLC model, where its files live on
// our CDN, its compiled wasm lib, and how to build its WebLLM app config. Swapping the answer
// model = choosing a different spec at the composition root (offscreen) -- no parallel engine
// factories. All URLs resolve to our model CDN so WebLLM never falls back to HF/GitHub.
export interface AskModelSpec {
  modelId: string
  modelDir: string
  modelLib: string
  buildAppConfig: (modelBaseUrl: string, modelLibUrl: string) => AppConfig
}

export const LLAMA_ASK_SPEC: AskModelSpec = {
  modelId: LLAMA_ASK_MODEL,
  modelDir: LLAMA_ASK_MODEL_DIR,
  modelLib: LLAMA_ASK_MODEL_LIB,
  buildAppConfig: buildLlamaAppConfig,
}

export const GEMMA_ASK_SPEC: AskModelSpec = {
  modelId: GEMMA_ASK_MODEL,
  modelDir: GEMMA_ASK_MODEL_DIR,
  modelLib: GEMMA_ASK_MODEL_LIB,
  buildAppConfig: buildGemmaAppConfig,
}

// One factory for any Ask model. The concrete spec is chosen by the caller (offscreen), keeping
// the model choice at the composition root and this module model-agnostic.
export async function createAskEngine(
  spec: AskModelSpec,
  onProgress?: (e: ModelProgressEvent) => void,
): Promise<MLCEngineInterface> {
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm')
  const modelBaseUrl = modelCdnUrl(spec.modelDir)
  const modelLibUrl = modelCdnUrl(`${spec.modelDir}${spec.modelLib}`)
  onProgress?.({ status: 'initiate', progress: 0 })
  const engine = await CreateMLCEngine(spec.modelId, {
    appConfig: spec.buildAppConfig(modelBaseUrl, modelLibUrl),
    initProgressCallback: (report) => onProgress?.(webLlmProgressToModelProgress(report)),
  })
  onProgress?.({ status: 'ready' })
  return engine
}

export class WebLlmAnswerGenerator implements AnswerGeneratorPort {
  constructor(private readonly engine: MLCEngineInterface) {}

  async expandQueries(question: string): Promise<string[]> {
    const completion = await this.engine.chat.completions.create({
      messages: buildQueryExpansionMessages(question),
      temperature: 0.7,
      max_tokens: 120,
    })
    return parseExpandedQueries(completion.choices[0]?.message.content ?? '')
  }

  private async createAnswerText(request: AnswerRequest): Promise<string> {
    const completion = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks),
      temperature: 0,
      max_tokens: MAX_ANSWER_TOKENS,
    })
    return completion.choices[0]?.message.content?.trim() || NOT_FOUND_ANSWER
  }

  async answerStream(request: AnswerRequest, onDelta: (delta: string) => void): Promise<AnswerDraft> {
    const stream = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks),
      temperature: 0,
      max_tokens: MAX_ANSWER_TOKENS,
      stream: true,
    })
    let text = ''
    for await (const chunk of stream as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>) {
      const delta = chunk.choices?.[0]?.delta?.content ?? ''
      if (!delta) continue
      text += delta
      // Known limitation: the trailing [[cite: ...]] tag streams to onDelta character-by-
      // character like any other model output before we can strip it (we only know a
      // suffix is a citation tag once the FULL text is in hand). It briefly appears in the
      // live-typing UI and disappears once ask-answer-done replaces it with parseAnswerCitation's
      // stripped displayText. Not fixed here: buffering the tail to hide it would add real
      // complexity for a sub-second cosmetic flicker.
      onDelta(delta)
    }
    const raw = text.trim() || NOT_FOUND_ANSWER
    // Validate citations against exactly the excerpts the prompt showed (buildAskMessages
    // slices to MAX_ASK_PROMPT_CHUNKS via formatSavedExcerpts) -- NOT the full request.chunks,
    // which can be larger (AskService retrieves up to contextK chunks for context-building
    // even though only the first MAX_ASK_PROMPT_CHUNKS are ever numbered/shown to the model).
    const { displayText, citedChunkIds } = parseAnswerCitation(raw, request.chunks.slice(0, MAX_ASK_PROMPT_CHUNKS))
    return { text: displayText, citedChunkIds }
  }

  async answer(request: AnswerRequest): Promise<AnswerDraft> {
    const raw = await this.createAnswerText(request)
    // See the matching comment in answerStream: citations must be validated against the same
    // slice the prompt actually showed, not the full (possibly larger) request.chunks.
    const { displayText, citedChunkIds } = parseAnswerCitation(raw, request.chunks.slice(0, MAX_ASK_PROMPT_CHUNKS))
    return { text: displayText, citedChunkIds }
  }
}
