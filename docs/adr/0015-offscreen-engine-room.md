# 오프스크린 문서가 엔진룸, 서비스워커는 얇은 중계기

저장·임베딩·코어 서비스(Capture/Indexing/Recall)를 모두 **오프스크린 문서**에서 돌리고, 백그라운드 서비스워커(SW)는 팝업/콘텐츠 메시지를 오프스크린으로 전달하는 **얇은 중계기**로 둔다. MV3 SW는 OPFS 동기 핸들·Worker·안정적 WebGPU를 못 써서 로컬 ML+영속의 호스트가 될 수 없기 때문이다(ADR 0014 확장). 이 결정은 세 스파이크로 검증한 뒤 내렸다.

## 왜 (SW의 한계, 실측으로 확인)

- **OPFS 영속 불가:** `createSyncAccessHandle`은 전용 워커에서만 되고 SW에서 안 된다 → sqlite 영속이 SW에선 원천 불가.
- **Worker 불가:** SW에서 `new Worker()`가 undefined → 멀티스레드/프록시워커 기반 기능 불가.
- 반면 오프스크린 문서는 전용 워커를 띄울 수 있고(→ OPFS 영속), WebGPU 어댑터가 잡히며, 자체 수명으로 상주한다(→ 모델/DB가 메모리에 남음).

## 구조

- **오프스크린(엔진룸):** WebGpuEmbedder(EmbeddingPort) + OPFS 워커 스토어(VectorSearchPort) + CaptureService/IndexingService/RecallService. drain(비동기 색인)도 여기서 돈다(SW와 달리 안 꺼지므로 keepalive 해킹 불필요).
- **SW(중계기):** 오프스크린 생성·유지, 메시지 라우팅(capture/recall/model-status), 진행률 이벤트를 팝업에 재방송. 코어·스토어·임베더를 전혀 갖지 않는다.
- **팝업/콘텐츠:** 계약 불변(SW와 대화).

## Consequences

- **헥사고날 덕에 코어 무수정:** 포트(EmbeddingPort/VectorSearchPort)는 그대로고 어댑터의 *실행 위치*만 옮겼다. `src/core/*`는 chrome 참조 0을 유지한다.
- **Float32Array가 chrome.runtime 경계를 안 넘는다:** 벡터는 오프스크린↔워커(structured clone)에서만 흐르고, SW↔오프스크린은 capture{text}→{chunkCount}, recall→RankedResult[] 같은 평범한 객체만 오간다.
- **모델/DB 상주:** 오프스크린을 닫지 않으므로(+25s keepalive ping) 일회성 모델 로드(~20s, ADR 0016) 이후 반복 캡처는 즉시.
- ADR 0014의 "임베딩은 SW에서 InlineEmbedder"는 이 ADR로 대체된다(임베딩은 오프스크린).
