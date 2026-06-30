// The bundled embedding model's identity, persisted per-profile so a model swap can trigger a
// one-time corpus re-index. Bump the trailing -vN whenever the SHIPPED granite weights change
// in a way that makes old vectors incomparable (new dtype, new dims): the offscreen migration
// compares this id to the stored value and re-embeds the corpus on a mismatch.
//
// granite-only: there is exactly ONE shipped model, so exactly ONE version id. A device that
// last indexed with the old e5 model has no stored version (fresh) or a legacy value; either
// differs from this id, so the migration re-embeds with granite.
export const EMBED_MODEL_VERSION = 'granite-107m-r1-q8-v1'

// True when the stored version is missing or differs from the current one, i.e. a re-index is
// required. Pure: the offscreen wires the real settings + store around this decision.
export function needsReindex(stored: string | null, current: string): boolean {
  return stored !== current
}
