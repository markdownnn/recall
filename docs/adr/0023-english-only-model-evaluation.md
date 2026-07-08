# English-only model evaluation

Recall is moving from bilingual recall to English-only recall, so the Golden set now measures English search quality rather than Korean/English cross-lingual behavior. This keeps ADR 0004's measurement-first rule, but removes its old requirement that every model choice preserve Korean-query to English-document recall.

## Consequences

- BGE English models are valid candidates, including models that do not support Korean well.
- Korean fixtures and KO/EN combo scorecards are no longer product gates.
- If Korean support returns later, it must be a new product decision and a new Golden set slice, not an accidental leftover from the old bilingual design.
