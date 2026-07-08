// The selected embedding model's identity, persisted per-profile so a model swap can trigger a
// one-time corpus re-index. Bump the trailing -vN whenever the shipped BGE weights change in a
// way that makes old vectors incomparable.
export const EMBED_MODEL_VERSION = 'bge-base-en-v1.5-q8-v1'

// True when the stored version is missing or differs from the current one, i.e. a re-index is
// required. Pure: the offscreen wires the real settings + store around this decision.
export function needsReindex(stored: string | null, current: string): boolean {
  return stored !== current
}
