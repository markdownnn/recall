# 1-Pager: "어디서 봤더라" (Recall) — Local-first 리서치 회수

> Status: Draft v0.2 · grilling 반영판 · Owner: (미정) · **단독 제품**(라이너 기능 아님, ADR 0008)
> v0.2 변경: 회수 단위=청크 / 100% 로컬 확정 / 검색=브루트포스+하이브리드 / 게이트 비대칭 / 하이라이트=자기 청크 / 히스토리 prefill / Obsidian 내보내기 / durability / 유료화 / 포트 지도 갱신
> 결정 근거는 모두 `docs/adr/0001`~`0013`, 용어는 `CONTEXT.md` 참조.

## 한 줄 정의

사용자가 **읽은 것**을 자동으로 쌓고, *"그 호르몬이 수면 망친다던 거 어디서 봤지?"* 같은 자연어 질문에 **정확한 구절(청크) + 출처**로 답한다. 전 과정 **로컬**.

## 풀려는 문제

연구자/지식노동자의 데일리 고통 1순위는 "읽은 자료가 휘발돼서 다시 못 찾는다." 브라우저 히스토리는 *최근* URL은 찾지만, 단어를 까먹은 **오래된** 자료는 못 찾는다. 이 제품은 **오래될수록 가치가 오른다** — 최근 거는 어차피 히스토리로 찾으니까.

## 설계 원칙 (협상 불가)

1. **Local-first 절대.** 캡처·저장·임베딩·검색이 전부 기기 안. 기본값에서 아무것도 기기 밖으로 안 나간다. 이게 차별점이자 마케팅 메시지. (ADR 0001)
2. **Capture는 AI 0.** Readability 본문 + 하이라이트 + 메타. 결정적·싸고 빠름.
3. **검색은 "클라우드/LLM 없음"** (≠ "AI 없음"). 로컬 임베딩 + 렉시컬 하이브리드. (ADR 0002)
4. **보존 = 사용자 제어, TTL 아님.** 자동만료 대신 denylist·도메인 제외·수동 삭제.
5. **게이트 비대칭을 존중.** 못 담은 건 복구 불가, 잘못 담은 건 복구 가능 → 프라이버시는 빡세게, 참여는 관대하게. (ADR 0005)
6. **헥사고날 + TypeScript.** 모든 단계를 포트로 끊어 분리·조립·대체.

## 핵심 개념 (CONTEXT.md 요약)

- **Chunk:** 회수의 단위. 페이지를 문단 경계로 쪼갠 토막. 임베딩·검색·랭킹이 다 이 단위. "정확한 구절"이 곧 Chunk. (Q1)
- **CapturedPage:** 게이트를 통과해 저장된 페이지. Chunk들을 가지며 시간이 지나며 Chunk가 붙는 append-only.
- **Highlight:** 사용자가 손수 고른 본문. **항상 자기만의 Chunk**로 따로 임베딩·가점. (ADR 0006)

## 기술 스택

- **언어:** TypeScript (클라이언트 전체).
- **추출:** @mozilla/readability (라이브 DOM, content script)
- **임베딩:** transformers.js, **multilingual-e5-small**(한/영 + 검색 학습), 로컬 추론, Web Worker. 출발점이며 골든셋이 최종 선택. (ADR 0004)
- **저장/인덱스:** sqlite-wasm 단일 DB — 본문·메타·FTS5·벡터(**v1은 float32**). (ADR 0002)
- **권한:** `unlimitedStorage`(durability), `history`(prefill), `<all_urls>` host(캡처·prefill re-fetch).

## 캡처 파이프라인

1. **후보 감지:** 페이지 load **또는 SPA URL 변화**(pushState/replaceState/popstate). (Q5)
2. **Dwell 타이머(취소 가능):** 기본 **10초(사용자가 위로 조정 가능)**. 도중 URL 바뀌면 취소(튕김 거름). SPA 렌더 대기 겸용. (Q5)
3. **게이트:**
   - **Hard gate(프라이버시, 빡세게):** denylist(금융·헬스·웹메일·인증/결제·localhost·사내툴)·시크릿창.
   - **Soft gate(참여, 관대하게):** thin page·SERP. dwell은 하드컷이 아니라 OR(스크롤·체류 신호 있으면 빨리 통과).
4. **추출+청킹(빠름):** Readability → 문단 기반 청킹(상하한+겹침, 교체 가능). 즉시 저장(임베딩 대기 상태).
5. **임베딩 큐(워커, 인위적 지연 0):** `EmbeddingJobQueuePort`가 우선순위(LIVE > BACKFILL)로 처리. 줄이 비면 즉시. (ADR 0009)
- **오버라이드:** 하이라이트·Manual save는 soft gate 무시하고 캡처 강제. 단 hard gate는 못 뚫음(저장 안 하고 고지). (ADR 0006)

## 검색 (회수)

- **v1 = 전체 청크 브루트포스 + 하이브리드 합산.** FTS5 하드 prefilter 아님 — 단어 안 겹치는 의미 매칭(한글 질문→영어 구절)을 안 버리려고. 렉시컬은 거름망이 아니라 **점수원**(정확한 고유명사·용어 보강). (ADR 0002)
- **랭킹:** 1축 의미 유사도. **recency 순가점 없음**(오래될수록 가치라 역행). 하이라이트 청크 가점. (ADR 0003)
- **dedup:** 하이라이트 청크와 자동 청크가 겹치면 검색 시점에 합침(하이라이트 우선). (ADR 0006)
- **결과 = 구절 카드.** 링크가 아니라 **저장된 청크 텍스트 자체**를 보여줌(옛 페이지는 죽은 링크일 수 있으니). 원본 열기는 텍스트 프래그먼트(`#:~:text=`)로 그 구절까지 점프. (Q6)

## UI

- **커맨드팔레트(전역 단축키) = 검색.** 어느 페이지에서나 마찰 0. (Q6)
- **툴바 팝업 = 제어판.** denylist·일시정지·"이 사이트 기억 안 함"·삭제·백업.
- (post-v1) 전체 결과 페이지/사이드패널.

## Prefill (빈 방 해결, ADR 0007)

설치 시 브라우저 히스토리로 메모리를 채움. 단독 제품이라 외부 씨드가 없어 cold-start를 자체 해결.
- denylist 적용 + **쿠키 없이 re-fetch**(공개 버전만, 사적 페이지 차단) + thin-page 게이트.
- 기간 설정(기본 30일), 시작 전 대략 추정 + 진행 중 라이브 ETA.
- 큐 BACKFILL 우선순위(라이브가 없을 때), 동시성 3~5 제한, 재개·취소, URL 멱등.

## Obsidian 내보내기 (ADR 0010)

로컬 파일이라 ADR 0001과 충돌 없음(클라우드 Notion 내보내기는 OUT). File System Access로 볼트 폴더 1회 허용.
- v1 설정 5개: on/off · 대상(전부 / 하이라이트+Manual save) · prefill 포함(기본 off) · 폴더(기본 `Recall/`) · 구성(페이지당 노트 / 데일리 노트).
- 페이지당 .md 1개, URL 멱등 갱신. 템플릿·파일명 패턴 등은 post-v1.

## Durability (분실 방지, ADR 0012)

- `unlimitedStorage` + `persist()` → 용량 압박 자동삭제 막음.
- **전체 백업/복구 파일**(원문+메타+하이라이트, 벡터는 복구 시 재임베딩) → 익스텐션 삭제·재설치·기기 분실 대비. 익스텐션 바깥에 저장.
- (post-v1) 폴더 자동 백업 / (유료) 클라우드 sync.

## 유료화 (ADR 0011)

- **무료 = 완전한 로컬 경험**(불구로 안 만듦).
- **유료 = 클라우드층:** 기기 간 동기화/백업(주력) + 선택적 서버 임베딩(정밀도). 둘 다 서버 비용이 들어 구독이 정직하고 단속 가능.
- 경계는 지금 긋되 v1엔 안 만듦(공짜로 안 줄 뿐) → claw back 없이 활주로 확보. "오래될수록 가치"가 백업 지불의사를 키움.

## 아키텍처 (포트 지도, ADR 0009 갱신)

**Driven (아웃바운드)**

| 포트 | v1 어댑터 | 비고 |
|---|---|---|
| ContentExtractorPort | ReadabilityAdapter | |
| **ContentChunkerPort** | ParagraphChunkerAdapter | 신규(Q1), 골든셋으로 교체 |
| GatePort | HardGate + SoftGate 체인 | ADR 0005 |
| EmbeddingPort | LocalE5Adapter | ServerEmbedding은 유료(OUT) |
| LexicalIndexPort | Fts5Adapter | prefilter 아닌 점수원 |
| VectorSearchPort | float32 브루트포스 | int8/ANN OUT. candidateIds는 미래 ANN용 |
| StoragePort | SqliteWasmAdapter | append-only. sync 어댑터는 유료(OUT) |
| **HistoryReaderPort** | ChromeHistoryAdapter | 신규(prefill) |
| **PageFetcherPort** | 쿠키 없는 fetch | 신규(prefill 전용) |
| **EmbeddingJobQueuePort** | sqlite 영속 큐 | 신규, priority |
| **ExportTargetPort** | ObsidianFsAdapter | 신규 |
| KnowledgeSourcePort | — | post-v1(노트 가져오기) |
| TelemetryPort | — | post-v1, 옵트인(ADR 0013) |

**Driving (인바운드)**
- CaptureTrigger 소스: 페이지 load · SPA · 하이라이트 · Manual save · Prefill (각 게이트 오버라이드 다름)
- RecallQueryPort: 검색 UI/커맨드팔레트 → RecallService(코어가 하이브리드 합산·dedup·랭킹)

## 스코프 컷 (포트 뒤 빈자리로 명시)

**OUT (미래/유료)**
- int8 양자화 · binary coarse · ANN(IVF/HNSW) — `VectorSearchPort` 뒤 (10만+에서만)
- FTS5 하드 prefilter — 10만+ 최적화로만
- ServerEmbeddingAdapter — `EmbeddingPort` 뒤 (유료)
- sync 어댑터 — `StoragePort` 뒤 (유료)
- KnowledgeSourcePort(노트 가져오기), 폴더 자동 백업, TelemetryPort 구현
- 쿼리 시점 LLM 종합 / 페이지 요약

## 성공 지표 (ADR 0005로 교정)

- **Activation:** 설치 후 1주 내 성공적 회수 ≥1회 (prefill로 빈 방 문제 완화)
- **Core value:** 회수 쿼리 → 결과 클릭 비율
- **정밀도:** precision@1 / MRR — **골든셋(개발)** + 옵트인 텔레메트리(미래)
- **Retention:** 주간 회수 빈도
- ~~게이트 통과율(절반↑ 걸러짐)~~ → **폐기**. 잡음률이 아니라 회수 성공률을 본다.

## 스케일 절벽 지도 (v1은 2행까지)

| 규모 | 전략 | 이번 스코프 |
|---|---|---|
| ~1만 | 브루트포스 | ✅ |
| 1만~10만 | sqlite-wasm + float32 브루트포스 + 하이브리드 | ✅ (여기까지) |
| 10만~100만 | 렉시컬 prefilter + binary coarse → int8 rerank | ⬜ 포트 뒤 빈자리 |
| 100만+ | IVF / HNSW | ⬜ (현실적으로 안 옴) |

## 열린 결정 / 리스크

- **로컬 임베딩 품질 vs 정밀도.** 핵심 병목. 로컬 e5가 부족하면 `EmbeddingPort` 뒤 ServerEmbeddingAdapter(유료)로 보강 — 코어 무수정, 원문이 전송되므로 명시적 옵트인.
- **e5-small 첫 로드(수십~100MB)** → IndexedDB/OPFS 캐싱.
- **정밀도 관측 불가** — 비공개 데이터라 출시 후 측정이 옵트인 텔레메트리 전엔 골든셋뿐. (ADR 0013)
- **권한 경고**(history·all_urls) → 온보딩에서 정직히 설명해 설치 전환 방어.
