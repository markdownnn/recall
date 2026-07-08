import type { ChatCompletionMessageParam, MLCEngineInterface } from '@mlc-ai/web-llm'
import type { AnswerDraft, AnswerGeneratorPort, AnswerRequest } from '../core/answer-generator'
import type { RankedResult } from '../core/model'

export const LLAMA_ASK_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC'
export const NOT_FOUND_ANSWER = 'I could not find that in your saved pages.'

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

export async function createLlamaAskEngine(): Promise<MLCEngineInterface> {
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm')
  return await CreateMLCEngine(LLAMA_ASK_MODEL)
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
