# English Ask Rollout Summary

## What changed

This branch changes Recall from a Korean-and-English mix into an English-only Ask flow with remote model delivery.

The extension now serves both the embedding model and the Ask WebLLM model from the Team Nyongs CDN / R2 path. Fallback download origins such as Hugging Face and GitHub were removed so model delivery is consistent.

The Ask experience was rebuilt around explicit model readiness. The Ask tab is now a top-level tab. Users download WebLLM on purpose before asking, Ask stays disabled until the model is ready, and answers stream into the panel instead of appearing all at once.

Search quality for Ask changed in three important ways:

1. Ask retrieves answer context differently from Search, so it can keep multiple chunks from the same saved page.
2. Query expansion generates a few extra English search queries, runs retrieval for each one, merges the results, and shows the successful query set back in the UI.
3. Answer generation now uses an internal two-step flow:
   - an evidence pass that writes short working notes
   - a final answer pass that streams the user-facing answer

## Why it changed

The main goal was to make English Ask materially better on small local models.

English-only let us move to stronger English embedding candidates and simplify the product surface. Remote model hosting made downloads predictable and removed extension-local and third-party fallback paths.

Ask quality was weak when one user query had to do everything. Query expansion improves retrieval recall. The evidence pass helps the small answer model separate useful saved facts from noise before it writes the final answer.

## UX changes

Ask no longer renders an empty answer box before the first streamed text arrives. It shows a small visual loader first, then creates the answer card on the first token.

When query expansion succeeds, the UI shows the searches that were actually tried. When expansion fails, Recall silently falls back to the original query and logs a warning for debugging.

Long strings in answer text and sources now wrap inside the card instead of breaking the layout.

## Safety guard added after rollout

The evidence pass increased prompt size enough to hit the 4096 context window on some pages. To prevent that, Ask now trims the prompt before calling WebLLM:

- evidence pass: up to 4 chunks
- final answer pass: up to 5 chunks
- each prompt chunk text: up to 800 characters

This cap applies only to the prompt sent to WebLLM. Stored chunks and search retrieval stay unchanged.

## Verification

The following checks were run during this rollout:

- `npx vitest run tests/core/ask-ui.test.ts tests/core/ask-routing.test.ts tests/core/ask-service.test.ts tests/core/webllm-answer-generator.test.ts tests/core/strings.test.ts`
- `npx vitest run tests/core/ask-ui.test.ts tests/core/ask-routing.test.ts tests/core/ask-service.test.ts tests/core/webllm-answer-generator.test.ts tests/core/webgpu-embedder.test.ts tests/core/indexing-service.test.ts tests/core/strings.test.ts`
- `npm run package`

## Remaining watchouts

The new Ask flow makes more WebLLM calls than before:

- query expansion
- evidence pass
- final answer pass

That improves answer quality, but it can increase time to first token. If Ask still feels slow on real pages, the next levers to tune are the prompt chunk caps and the number of chunks passed into the final answer step.
