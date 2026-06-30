# 하이브리드 검색: FTS5 trigram 렉시컬 + 벡터를 RRF로 융합

검색을 벡터 코사인 한 축에서 **벡터 + 렉시컬 두 축**으로 넓혔다. 렉시컬은 sqlite FTS5 trigram 인덱스(`chunks_fts`)로 만들고, 두 랭킹을 Reciprocal Rank Fusion(RRF, k=60)으로 합친다. 벡터만 쓰면 의미는 잘 잡지만 **희귀한 정확 단어**(사람 이름, 식별자, 에러 코드)를 놓쳤다 — 임베딩은 "비슷한 뜻"을 보지 "철자가 똑같다"를 안 보기 때문이다. ADR 0002가 약속한 "렉시컬은 prefilter가 아니라 점수원"을 실제 구현으로 채운 결정이다.

## 왜 trigram, 왜 RRF

- **trigram(3글자 단위) 토크나이저:** 한국어처럼 띄어쓰기 없이 붙는 언어에서도 부분 문자열 매칭이 된다. 일반 `unicode61` 토크나이저는 공백으로 단어를 가르므로 한국어 안쪽 매칭을 놓친다. trigram은 글자 3개 창을 굴려 "코르티솔" 안의 "르티솔"도 잡는다.
- **RRF(역순위 융합):** 두 랭킹의 **순위**만 더한다(`score = sum 1/(k+rank)`, `src/core/rrf.ts`). 코사인 점수(0~1)와 BM25 점수(스케일 제각각)를 **정규화해서 더할 필요가 없다** — 정규화는 가중치 튜닝이라는 함정을 부르는데, 순위 융합은 그걸 통째로 피한다. k=60은 널리 쓰는 표준 상수다.

## 구조

- `src/core/fts-query.ts` `toFtsQuery`: 자유 입력을 안전한 FTS5 MATCH 식으로 바꾼다. 공백으로 쪼개고, **3글자 이상** 단어만 남기고(trigram은 3글자가 최소), 각 단어를 큰따옴표 구절로 감싸 내부 따옴표를 이중화한다 → 사용자 텍스트가 FTS5 연산자를 주입하거나 구문 오류를 내는 걸 원천 차단. 단어들은 OR로 잇는다(렉시컬은 후보만 대고, 정밀도는 RRF+벡터가 맡는다). 자격 단어가 없으면 `null` → 호출자는 벡터 단독 검색.
- `src/offscreen/sqlite-worker.ts` `opSearch`: ① 벡터 코사인 상위 N개 id, ② FTS5 trigram BM25 상위 N개 id를 각각 뽑아 `rrfFuse([vectorIds, lexicalIds])`로 융합한다. `chunks_fts`는 `content='chunks'` 외부 콘텐츠 테이블이라 본문을 중복 저장하지 않고, insert/delete 트리거로 `chunks`와 동기화된다(본문은 insert 후 불변이라 update 트리거 불필요).
- 업그레이드된 기존 프로필을 위한 1회 backfill: FTS가 비어 있고(`ftsCount===0`) 청크가 있으면 `rebuild`로 전체 색인을 깐다. 캡처를 막지 않도록 지연 실행이며, 새 캡처는 backfill과 무관하게 트리거로 색인된다.

## Considered Options / 트레이드오프

- **trigram이라 한국어 2음절은 렉시컬 가점이 없다.** "수면" 같은 2글자(=2 trigram 미만)는 `toFtsQuery`에서 걸러진다. 이런 짧은 질의는 벡터 축이 받친다. 정확 매칭의 이득이 큰 3글자 이상에 렉시컬을 거는 의도된 선택이다.
- **벡터 스캔은 여전히 풀스캔이다.** FTS는 지금 **벡터 후보를 줄이는 prefilter가 아니다** — 두 축이 각자 독립으로 상위 N(=50)을 뽑고 융합할 뿐이다. ADR 0002대로 v1 규모(청크 1만~10만)에선 풀 코사인이 수십 ms라 충분하고, 의미 매칭을 하나도 잘라내지 않는다. FTS를 진짜 prefilter로 켜는 건 10만+에서의 후속 최적화(building block은 깔아둔 상태).
- **`ftsAvailable` 플래그로 우아한 강등.** FTS5 초기화가 실패해도 capture/recall이 죽지 않는다. 인덱스 생성 try/catch가 `initPromise`를 reject하지 않게 격리되어 있고(reject하면 캡처까지 멈춘다), 실패 시 `ftsAvailable=false`로 두면 `opSearch`가 **벡터 단독으로 자동 강등**된다. 깨진 렉시컬이 제품을 못 쓰게 만드는 것보다, 조용히 한 축을 끄는 쪽이 낫다.
- 후보 캡 N=50(축당)이 recall 상한을 만든다. 두 축 합쳐 최대 100 후보를 융합한다.

## Consequences

- 희귀 정확 단어 회수가 살아난다(이름/ID/코드). 의미 매칭은 벡터 축이 그대로 유지하므로 ADR 0002의 "의미를 하나도 버리지 않는다"가 지켜진다.
- 코어 메모리 스토어(`src/adapters/memory-vector-store.ts`)도 같은 RRF 계약(`search(queryVector, queryText, k)`)을 따른다 — 단 거기 렉시컬은 trigram이 아니라 단순 부분 문자열 매칭이라 테스트/참조용 근사다. 실 경로는 워커의 FTS5.
- 미래에 "왜 벡터만 안 쓰고 FTS까지?"라고 단순화하려 하면 이 ADR을 본다 — 벡터 단독은 희귀 정확 단어를 놓친다.
