# Ask·Search 품질/성능 백로그 — 실행 로드맵

> **성격:** 이건 여러 서브시스템에 걸친 백로그의 **실행 순서표**다. 각 항목의 상세 TDD 계획은 그 차례가 왔을 때 별도로 쓴다(한 번에 다 쓰지 않는다 — writing-plans의 Scope Check에 따라 서브시스템별로 분리).
> **원본 백로그:** 이 세션 첫 메시지(후속 작업 문서). 여기에는 순서·의존성·확정된 결정만 담는다.

**작성일:** 2026-07-10

---

## 확정된 결정 (시작 전 잠금)

- **B1 범위 = "인용한 청크 전부".** 페이지당 대표 1개로 접지 않는다. → [ask-service.ts](../../../src/core/ask-service.ts)의 `sourcesByPage` 접기 로직과 `AskAnswer.sources` 모양([model.ts](../../../src/core/model.ts))을 손봐야 함. UI만 고치는 작은 작업이 **아님**.
- **F1 다국어 모델 = 보류.** ADR 0023(영어 전용) + 메모리(더 큰 모델 측정 전엔 재론 금지)에 따라 이번 스코프에서 제외. 재개하려면 별도 제품 결정 + 다국어 골든셋이 선행.

---

## 실행 순서

각 항목은 차례가 오면 **TDD로 계획→구현→검증→커밋**. 앞 항목에서 배운 걸 다음에 반영한다.

### 0. 몸풀기 (결정 불필요, 하네스 검증)

- [x] **E1 죽은 스트리밍 델타 배선 제거 — 닫음(잘못된 전제) 2026-07-10**
  - 조사 결과: 델타 경로가 전 구간 **살아 있음**. offscreen:356의 onDelta가 `ask-answer-delta`를 실제로 보내고 → background:171 중계 → SearchTab:42가 라이브 타이핑으로 렌더. generator [answerStream:244](../../../src/offscreen/webllm-answer-generator.ts)는 토큰마다 `onDelta(delta)`를 발신 중.
  - 즉 백로그의 "answerStream이 델타를 안 쏜다"는 현재 코드와 어긋남. 지우면 실시간 타이핑이 깨지는 회귀. **제거할 죽은 코드 없음 → 항목 닫음.**

### 1. 품질 즉효

- [x] **B1 인용 청크 전부 하단 표시** (코어 변경 — 위 결정 참조) — **완료 2026-07-10**
  - ask-service: `sourcesByPage` 접기 → `chunks.filter(cited)` (전부·순서). SearchTab: 제목 링크 + 3줄 클램프 스니펫.
  - 잴: ask-service.test.ts(코어) + ask-ui.test.ts(소스 계약)로 고정. 픽셀 눈 확인은 남은 선택 항목.
- [ ] **A1 크로스인코더 리랭커** (최대 레버, 새 온디바이스 모델)
  - 후보 50개 → 크로스인코더 재채점. Search 결과 + Ask 청크 둘 다.
  - 잴: `eval:english` 골든셋으로 precision@1·MRR 전후 비교.
- [ ] **A2 청킹 겹침 + 문장 경계** (재색인 필요)
  - [ParagraphChunker](../../../src/core/paragraph-chunker.ts) 220단어 하드컷 → 1~2문장 겹침 + 문장 끝 자르기. 저장된 페이지 전체 재색인([embed-migration](../../../src/core/embed-migration.ts) 계열).
  - 잴: 골든셋이 페이지 단위 정답이라 청킹이 바뀌어도 안 깨짐 → `eval:english` recall 전후 비교.

### 2. 속도

- [ ] **C1 코사인 → 내적** (전제 필요 — 백로그의 "안전" 주장은 틀림)
  - 발견(2026-07-10): [cosine.test.ts](../../../tests/core/cosine.test.ts)이 **비정규 벡터**로 코사인을 못박음(`[1,0,0]` vs `[2,0,0]` → 1, 내적이면 2 → 테스트 깨짐). [sqlite-worker.ts:150](../../../src/offscreen/sqlite-worker.ts)에 "dot product 쓰지 마라, normalize:true 가정해 발산"이라는 결정 주석 있음.
  - 그래서 공짜 스왑 아님. 하려면: (1) "저장 벡터는 항상 길이 1" 불변식을 테스트로 세우고(필요시 읽기 시 정규화), (2) 핫패스(sqlite-worker·memory-store 스캔 루프)에만 별도 `dotProduct` 도입, `cosineSimilarity`는 일반 계약 유지.
  - 잴: `eval:english`로 랭킹 값 동일 확인.
- [ ] **C2 워커 메모리 벡터 캐시** — SQLite BLOB 재읽기 제거, 새 청크 임베딩 시에만 갱신.
- [ ] **C3 Ask 다중 쿼리 한 번 스캔** — 청크 1회 순회로 쿼리 N개 점수 동시 계산.
  - 주의: ADR 0002(v1 브루트포스로 충분) 범위 안의 소규모 최적화. ANN/양자화는 여전히 스코프 밖.

### 3. 측정·다듬기

- [ ] **D1 실제 확장 쿼리 픽스처 기록** — [eval/fixtures/expansions.json](../../../eval/fixtures/expansions.json)이 비어 `eval:ask`가 dedup을 안 굴림. 브라우저 WebLLM 실제 출력 1회 기록(수동 세션 필요).
- [ ] **D2 Ask 지표 CI 게이트 + 골든셋 확장** — 새 지표(`evidence-recall@context`, `confidence-gate-accuracy`) CI 게이트화. 9문항은 얇음(두 그룹 점수 겹쳐 7/9 천장) → 부정 예시 확충 후 게이트.
- [ ] **B2 답변 글맛 (문장 vs 글머리)** — WebLLM 브라우저 전용이라 자동 측정 불가. 후보: (a) 근거 메모 단계 제거 재검토, (b) 프롬프트 강화, (c) 더 큰 모델. 브라우저 눈 비교.

### 보류

- **F1 다국어 임베딩 모델** — 별도 제품 결정. 위 "확정된 결정" 참조.
