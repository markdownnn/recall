# R2 model artifacts with local-only content

Recall may download model artifacts from Cloudflare R2, but captured page text, highlights, queries, vectors, and generated answers stay on the user's device. This supersedes the old "zero network egress" wording from ADR 0001: the new privacy boundary is "user content never leaves the device", not "the extension never contacts the network".

## Considered Options

Keeping every model bundled preserves the strictest privacy story, but it makes BGE and WebLLM model swaps hard because extension packages become too large. Sending user text to a server would improve quality and reduce device cost, but it breaks the core product promise. R2 model artifacts keep user content local while allowing bigger model files to be cached and updated outside the extension package.

## Consequences

- JavaScript, WASM, and app code still ship with the extension. Remote artifacts are model data only.
- Every downloaded model file must be pinned by expected identity and verified by hash before use.
- Product copy must say "your reading data and questions do not leave your device"; it must not keep saying "zero network egress".
- Model download, verification, load progress, slow hardware, and offline states are first-class UX states.
