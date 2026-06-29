# 임베딩 작업은 우선순위 필드를 가진 단일 영속 큐 포트로

임베딩 작업(청크 임베딩)은 단일 `EmbeddingJobQueuePort`로 모델링한다. 코어가 작업을 넣을 때 priority(LIVE | BACKFILL)를 붙이고, 어댑터는 우선순위 높은 것부터 꺼내준다. 큐는 sqlite 기반 영속이라 브라우저가 꺼져도 prefill 백필을 재개할 수 있다. 워커(Web Worker)는 이 큐를 비우는 별도 어댑터다.

## Considered Options

- 큐 2개(라이브용/백필용)로 나누고 워커가 라이브부터 비우는 안: 개념은 단순하나 어댑터가 둘로 늘고 영속·재개 로직이 중복된다.
- 포트 없이 워커가 "라이브 먼저"를 하드코딩하는 안: 우선순위라는 비즈니스 규칙이 인프라로 새어 헥사고날 원칙을 깬다.

단일 포트 + priority 필드는 "우선순위는 코어(비즈니스), 큐 기계장치는 어댑터(인프라)"를 깔끔히 가른다.

## Consequences

- 라이브 캡처(방금 읽음)는 LIVE 우선순위로 즉시 처리되고, prefill은 BACKFILL로 라이브가 없을 때 빈다(Q9, ADR 0007).
- 큐가 영속이므로 prefill 재개·취소가 자연스럽게 풀린다.
- 인위적 지연은 두지 않는다. 큐가 비어 있으면 작업은 즉시 처리된다(한 페이지의 청크들이 자연스러운 배치).
- 이 결정과 함께 포트 지도가 갱신된다: 신규 ContentChunkerPort(Q1)·HistoryReaderPort·PageFetcherPort(ADR 0007), EmbeddingPort 어댑터 교체(multilingual-e5-small), VectorSearchPort 어댑터 교체(float32 브루트포스, ADR 0002), GatePort의 Hard/Soft 분리(ADR 0005). LexicalIndexPort는 prefilter가 아니라 하이브리드 점수원으로 역할 변경(ADR 0002).
