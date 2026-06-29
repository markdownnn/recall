# Local-first as an absolute privacy boundary for v1

v1에서는 캡처·저장·임베딩·검색이 전부 기기 안에서 일어나며, 어떤 본문 텍스트도 서버로 나가지 않는다. 임베딩은 로컬 MiniLM(transformers.js)으로 생성한다. 이 절대 약속("아무것도 기기 밖으로 나가지 않는다")이 곧 마케팅 메시지이자 NotebookLM·Atlas 같은 클라우드 업로드 모델과의 핵심 차별점이기 때문이다.

## Considered Options

라이너 서버 임베딩(Vertex/BigQuery 인프라 보유)을 기본으로 쓰면 정밀도는 더 높을 수 있다. 그러나 서버에서 임베딩을 생성하려면 본문·질문 텍스트를 서버로 전송해야 하므로, 절대 프라이버시 약속이 깨진다. 정밀도보다 신뢰 가능한 약속을 우선했다.

## Consequences

- `EmbeddingPort` 뒤에 `ServerEmbeddingAdapter`를 둘 수 있는 escape hatch는 남기되, v1 스코프에서는 OUT이며 기본값에서 절대 켜지지 않는다.
- 만약 미래에 서버 임베딩을 켜는 옵션을 제공한다면, 반드시 명시적 옵트인이어야 하고 "벡터를 만들기 위해 글/질문 텍스트가 전송된다(저장 안 함)"고 정직하게 고지해야 한다. "원문은 안 나가고 벡터만"이라는 표현은 서버 임베딩에서 성립하지 않으므로 쓰지 않는다.
- 로컬 MiniLM 품질이 정밀도(precision@1)에서 부족한 것으로 드러나면, 이 ADR을 재검토(superseded)하는 형태로만 방향을 바꾼다 — 조용히 기본값을 바꾸지 않는다.

## 모델 자산 fetch (정직한 단서)

- 사용자 콘텐츠(본문 텍스트, 검색 질문)는 기기 밖으로 나가지 않는다 — 핵심 약속은 유효.
- 단, 첫 실행 시 임베딩 모델 가중치(tokenizer, 모델 파일)를 huggingface.co에서 1회 받아 CacheStorage에 저장한다. 이때 사용자 IP·익스텐션 사용 사실·모델명이 huggingface.co / *.aws.cdn.hf.co에 노출된다. ONNX WASM 런타임은 더 이상 외부에서 받지 않는다(아래 적용 항목 참고).
- 현재 적용한 공급망 완화:
  - **ONNX WASM 런타임 번들 (적용됨):** `ort-wasm*.wasm` 4종을 익스텐션 패키지(`public/onnx/`)에 포함하고, 서비스 워커에서 `chrome.runtime.getURL('onnx/')`로 참조한다. CDN에서 실행 코드를 가져오는 경로가 완전히 제거됐다. `connect-src`에서 `cdn.jsdelivr.net`을 삭제해 CSP 수준에서도 해당 경로가 차단된다.
  - **모델 revision 고정 (적용됨):** 모델 revision을 불변 커밋 SHA(`761b726dd34fb83930e26aab4e9ac3899aa1fa78`)로 고정해, 공급망 교체 공격을 차단한다.
  - **CSP egress 제한 (적용됨):** `connect-src`를 `huggingface.co` / `*.aws.cdn.hf.co`만 허용(임의 호스트 egress 차단). 주의: HuggingFace는 tokenizer.json 같은 작은 파일도 포함해 모든 파일을 `*.aws.cdn.hf.co` 계열 CDN으로 302 리다이렉트한다 — `huggingface.co`만 허용하면 실제 다운로드가 차단된다.
- 현재 남은 외부 egress: 모델 가중치·토크나이저를 huggingface.co / *.aws.cdn.hf.co에서 1회 수신하는 것뿐이며, 해당 파일들은 불변 SHA로 콘텐츠-주소화되어 있다.
- 후속(선택적 심화): 다운로드한 모델 파일을 SHA-256으로 검증한다. 이미 SHA로 고정된 revision을 사용하므로 우선순위는 낮다(방어 심화 목적).
