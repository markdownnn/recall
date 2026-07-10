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
export const MAX_ASK_PROMPT_CHUNKS = 5
export const MAX_CHARS_PER_PROMPT_CHUNK = 800
export const MAX_EVIDENCE_TOKENS = 220
export const MAX_ANSWER_TOKENS = 640
// Decoding for the final answer, tuned to avoid the greedy-loop failure a 1B model falls into:
// at temperature 0 with no penalty it repeated a single sentence dozens of times. A little
// temperature plus frequency/presence penalties break exact-repetition loops while staying
// grounded enough for a short factual answer. (Only the ANSWER step -- evidence notes and query
// expansion keep their own params.)
export const ANSWER_DECODING = {
  temperature: 0.3,
  top_p: 0.9,
  frequency_penalty: 0.5,
  presence_penalty: 0.3,
} as const
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
  return buildWebLlmAppConfig(GEMMA_ASK_MODEL, modelBaseUrl, modelLibUrl, 711.07, true, {
    context_window_size: -1,
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

// One-shot worked example shown BEFORE the real question. A 1B model given only the "synthesize,
// don't list" rule still copies the numbered excerpts back verbatim; a single demonstration of the
// desired shape (a user turn with excerpts + question, then an assistant turn that answers in
// synthesized prose and ends with the hidden [[cite: ...]] line) reliably breaks that habit. The
// topic (caffeine) is deliberately unrelated to typical queries so the model never bleeds this
// example's content into a real answer, and its excerpt numbering is local to the example.
const ONE_SHOT_EXAMPLE: ChatCompletionMessageParam[] = [
  {
    role: 'user',
    content: [
      'Saved excerpts:',
      'Excerpt 1)\nPage title: Caffeine\nSaved text: Caffeine blocks adenosine receptors in the brain, which reduces the feeling of tiredness and increases alertness.',
      '',
      'Excerpt 2)\nPage title: Sleep hygiene\nSaved text: Caffeine has a half-life of about five hours, so drinking it late in the day can make it harder to fall asleep at night.',
      '',
      'Question: how does caffeine keep you awake?',
    ].join('\n'),
  },
  {
    role: 'assistant',
    content:
      'Caffeine keeps you awake by blocking adenosine, the brain chemical that builds up through the day ' +
      'and makes you feel sleepy, so you stay more alert instead. Because it lingers in the body for about ' +
      'five hours, having it late in the day can also delay how easily you fall asleep at night.\n[[cite: 1, 2]]',
  },
]

export function buildAskMessages(
  question: string,
  chunks: RankedResult[],
  workingNotes = '',
): ChatCompletionMessageParam[] {
  const notes = workingNotes.trim()
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
          "- Synthesize across excerpts into one coherent answer. Don't list excerpts one by one or copy snippets verbatim.",
          '- Lead with the direct answer first, then add supporting detail only if useful.',
          '- Write in natural, conversational prose. Keep it to 2-3 short paragraphs. No bullet points unless the question explicitly asks for a list.',
          "- Match the language of the user's question.",
          '- Stay neutral and factual. Don\'t add opinions or filler like "Great question!"',
          'Do not write audit sections like "what is provided", "what is missing", or "this saved chunk supports".',
          'Do not include a sources section; Recall shows sources below the answer.',
          'After your answer, on a new line, add the excerpt numbers you actually used like this: [[cite: 1, 3]] using the numbers shown below. This line is hidden from the user and does not count as a visible sources section. If you cannot answer from the excerpts, do not add this line.',
          notes ? 'Use the working notes as a relevance guide, but the saved excerpts are the source of truth. Do not mention the working notes.' : '',
        ].join(' '),
    },
    // Show the desired shape once (synthesized prose + hidden cite line) before the real question.
    ...ONE_SHOT_EXAMPLE,
    {
      role: 'user',
      content:
        [
          `Saved excerpts:\n${formatSavedExcerpts(chunks, MAX_ASK_PROMPT_CHUNKS)}`,
          notes ? `Working notes:\n${notes}` : '',
          `Question: ${question}`,
        ].filter(Boolean).join('\n\n'),
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

  private async createEvidenceNotes(request: AnswerRequest): Promise<string> {
    const completion = await this.engine.chat.completions.create({
      messages: buildEvidenceMessages(request.question, request.chunks),
      temperature: 0,
      max_tokens: MAX_EVIDENCE_TOKENS,
    })
    return completion.choices?.[0]?.message.content?.trim() ?? ''
  }

  private async createAnswerText(request: AnswerRequest, workingNotes: string): Promise<string> {
    const completion = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks, workingNotes),
      ...ANSWER_DECODING,
      max_tokens: MAX_ANSWER_TOKENS,
    })
    return completion.choices[0]?.message.content?.trim() || NOT_FOUND_ANSWER
  }

  async answerStream(request: AnswerRequest, onDelta: (delta: string) => void): Promise<AnswerDraft> {
    const workingNotes = await this.createEvidenceNotes(request)
    const stream = await this.engine.chat.completions.create({
      messages: buildAskMessages(request.question, request.chunks, workingNotes),
      ...ANSWER_DECODING,
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
    const workingNotes = await this.createEvidenceNotes(request)
    const raw = await this.createAnswerText(request, workingNotes)
    // See the matching comment in answerStream: citations must be validated against the same
    // slice the prompt actually showed, not the full (possibly larger) request.chunks.
    const { displayText, citedChunkIds } = parseAnswerCitation(raw, request.chunks.slice(0, MAX_ASK_PROMPT_CHUNKS))
    return { text: displayText, citedChunkIds }
  }
}
