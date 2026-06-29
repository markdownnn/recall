# Local-first as an absolute privacy boundary for v1

v1에서는 캡처·저장·임베딩·검색이 전부 기기 안에서 일어나며, 어떤 본문 텍스트도 서버로 나가지 않는다. 임베딩은 로컬 MiniLM(transformers.js)으로 생성한다. 이 절대 약속("아무것도 기기 밖으로 나가지 않는다")이 곧 마케팅 메시지이자 NotebookLM·Atlas 같은 클라우드 업로드 모델과의 핵심 차별점이기 때문이다.

## Considered Options

라이너 서버 임베딩(Vertex/BigQuery 인프라 보유)을 기본으로 쓰면 정밀도는 더 높을 수 있다. 그러나 서버에서 임베딩을 생성하려면 본문·질문 텍스트를 서버로 전송해야 하므로, 절대 프라이버시 약속이 깨진다. 정밀도보다 신뢰 가능한 약속을 우선했다.

## Consequences

- `EmbeddingPort` 뒤에 `ServerEmbeddingAdapter`를 둘 수 있는 escape hatch는 남기되, v1 스코프에서는 OUT이며 기본값에서 절대 켜지지 않는다.
- 만약 미래에 서버 임베딩을 켜는 옵션을 제공한다면, 반드시 명시적 옵트인이어야 하고 "벡터를 만들기 위해 글/질문 텍스트가 전송된다(저장 안 함)"고 정직하게 고지해야 한다. "원문은 안 나가고 벡터만"이라는 표현은 서버 임베딩에서 성립하지 않으므로 쓰지 않는다.
- 로컬 MiniLM 품질이 정밀도(precision@1)에서 부족한 것으로 드러나면, 이 ADR을 재검토(superseded)하는 형태로만 방향을 바꾼다 — 조용히 기본값을 바꾸지 않는다.
