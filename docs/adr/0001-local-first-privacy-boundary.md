# Local-first as an absolute privacy boundary for v1

Status: superseded in part by ADR 0022. The original v1 shipped with no runtime network egress. The next model-delivery direction allows remote model artifacts from R2, while keeping captured content, questions, vectors, and answers on device.

v1에서는 캡처·저장·임베딩·검색이 전부 기기 안에서 일어나며, 어떤 본문 텍스트도 서버로 나가지 않는다. 임베딩은 로컬 MiniLM(transformers.js)으로 생성한다. 이 절대 약속("아무것도 기기 밖으로 나가지 않는다")이 곧 마케팅 메시지이자 NotebookLM·Atlas 같은 클라우드 업로드 모델과의 핵심 차별점이기 때문이다.

## Considered Options

라이너 서버 임베딩(Vertex/BigQuery 인프라 보유)을 기본으로 쓰면 정밀도는 더 높을 수 있다. 그러나 서버에서 임베딩을 생성하려면 본문·질문 텍스트를 서버로 전송해야 하므로, 절대 프라이버시 약속이 깨진다. 정밀도보다 신뢰 가능한 약속을 우선했다.

## Consequences

- `EmbeddingPort` 뒤에 `ServerEmbeddingAdapter`를 둘 수 있는 escape hatch는 남기되, v1 스코프에서는 OUT이며 기본값에서 절대 켜지지 않는다.
- 만약 미래에 서버 임베딩을 켜는 옵션을 제공한다면, 반드시 명시적 옵트인이어야 하고 "벡터를 만들기 위해 글/질문 텍스트가 전송된다(저장 안 함)"고 정직하게 고지해야 한다. "원문은 안 나가고 벡터만"이라는 표현은 서버 임베딩에서 성립하지 않으므로 쓰지 않는다.
- 로컬 MiniLM 품질이 정밀도(precision@1)에서 부족한 것으로 드러나면, 이 ADR을 재검토(superseded)하는 형태로만 방향을 바꾼다 — 조용히 기본값을 바꾸지 않는다.

## 모델 자산 fetch — 해소됨 (2026-06-29)

- **외부 egress 제로 달성.** 임베딩 모델(Xenova/multilingual-e5-small, int8 양자화)과 ONNX WASM 런타임이 모두 익스텐션 패키지에 번들된다. 런타임에 어떤 파일도 외부에서 받지 않는다. "아무것도 기기 밖으로 나가지 않는다"는 약속이 이제 문자 그대로 성립한다.
- 적용된 완화 조치 (전체):
  - **ONNX WASM 런타임 번들 (적용됨):** `ort-wasm-simd-threaded.asyncify.wasm/.mjs`를 `public/onnx-hf/`에 포함. `chrome.runtime.getURL('onnx-hf/')`로 참조.
  - **임베딩 모델 번들 (적용됨):** `scripts/fetch-model.mjs`가 빌드 전(`prebuild`)에 commit SHA `761b726dd34fb83930e26aab4e9ac3899aa1fa78`로 고정된 URL에서 4개 파일을 `public/models/Xenova/multilingual-e5-small/`에 내려받는다. 이미 파일이 있으면 건너뛴다(멱등). 모델 파일은 git에 커밋하지 않는다(135MB).
  - **CSP egress 완전 차단 (적용됨):** `connect-src 'self'`만 허용. `huggingface.co` / `*.aws.cdn.hf.co`가 CSP 수준에서 차단되므로, 코드가 실수로 외부를 호출해도 브라우저가 막는다.
  - **allowRemoteModels = false (적용됨):** transformers.js v4의 `env.allowRemoteModels = false`로 라이브러리 수준에서도 원격 모델 fetch를 차단한다.
- 현재 남은 외부 egress: **없음.** 빌드 시에만 huggingface.co에서 모델 파일을 받으며, 이는 개발자 머신에서 일어나고 최종 사용자 기기에는 영향 없다.
