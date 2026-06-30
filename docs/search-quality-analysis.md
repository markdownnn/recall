# 검색 품질 분석: 참고문헌 스니펫 버그 + 골든셋 평가 하네스 설계

> 상태: 분석 + 설계 (구현 전). 수정 코드는 아직 넣지 않는다.
> 작성 근거: 아래 "재현"의 숫자는 실제 위키백과 HTML + 레포의 진짜 추출/청킹 + 진짜 e5-small 모델 추론으로 측정했다.

## 0. 한 줄 결론

페이지에서 글(서론·설명 문단)을 빼낼 때 **참고문헌(References)·각주·"See also"·외부 링크 같은 보일러플레이트를 안 걷어낸다.** 그래서 DOI·PMID·저널 이름으로 가득 찬 인용 목록이 그대로 청크가 되고, 이런 청크는 키워드가 빽빽해서 "박테리아" 같은 주제 질의에 대해 **서론 문단보다 코사인 점수가 더 높게 나온다.** 스니펫은 "그 페이지에서 점수 가장 높은 청크 하나"로 고르기 때문에(ADR 0020), 사용자에게 보이는 스니펫이 인용 목록이 된다.

---

## 1. 파이프라인 한눈에 (코드 위치)

캡처부터 검색까지 글이 흐르는 길이다.

1. **추출** — `src/content/capture.ts`의 `extract()`.
   - `new Readability(docClone).parse()` 후 `article.textContent`를 그대로 쓴다.
   - Readability는 위키백과의 **참고문헌·각주·See also·External links를 본문으로 같이 남긴다.** 이걸 따로 떼는 코드는 어디에도 없다 (`rg -i 'references|see also|boilerplate|citation'` 결과: 해당 없음).
2. **청킹** — `src/core/paragraph-chunker.ts`의 `ParagraphChunker`.
   - 글 전체를 한 줄의 단어 스트림으로 보고 `\s+`로 쪼갠 뒤, 220단어씩 모아 청크를 만든다. 빈 줄(문단 경계)은 그냥 공백 취급이라 flush를 안 한다.
   - **보일러플레이트를 거르는 단계가 전혀 없다.** 인용 목록도 일반 문단과 똑같이 220단어 청크가 된다.
3. **임베딩** — `src/offscreen/webgpu-embedder.ts`. 모델 `Xenova/multilingual-e5-small`, `dtype:'q8'`, mean pooling, normalize. 질의는 `query:`, 본문은 `passage:` 접두사.
4. **검색/랭킹** — `src/offscreen/sqlite-worker.ts`의 `opSearch`.
   - 벡터 레인: 청크별 코사인 → **페이지별 최고 코사인 청크 1개** → 상위 50 페이지.
   - 렉시컬 레인: FTS5 트라이그램 BM25 (`src/core/fts-query.ts`의 `toFtsQuery`). **3글자 이상 토큰만** MATCH로 만든다.
   - RRF 융합(`src/core/rrf.ts`) → 전체 hydrate → `topPagesBySnippet`(`src/core/ranking.ts`).
5. **페이지 접기 + 스니펫 선택** — `topPagesBySnippet(results, k)`.
   - 페이지별로 **점수 가장 높은 청크 하나만** 남겨 그 청크를 대표 스니펫으로 쓰고, 그 점수로 페이지를 정렬한다 (ADR 0020). **글의 품질은 전혀 안 본다.**

핵심 두 가지가 합쳐져 버그가 된다.
- (2) 인용 목록이 청크로 살아남는다.
- (5) 스니펫 = 최고 코사인 청크. 글이 좋은지 나쁜지 안 따진다.

---

## 2. 재현 (실측)

scratchpad에서 실제 영어 위키백과 HTML 2개(`/wiki/Bacteria`, `/wiki/Protein`)를 받아, 레포의 진짜 추출(Readability) + 진짜 청커(`ParagraphChunker` 로직 그대로) + 진짜 e5-small 모델로 돌렸다. (모델은 `tests/core/embedding-model.node.test.ts`가 이미 노드에서 같은 모델을 받아 쓰는 길을 그대로 따랐다.)

### 2a. 청크 덤프 — 인용 청크가 절반이다

| 페이지 | 추출 글자수 | 청크 수 | "참고문헌스러운" 청크 | 비율 |
|---|---|---|---|---|
| Bacteria | 117,562 | 72 | 34 | **47%** |
| Protein | 77,073 | 49 | 18 | 37% |

"참고문헌스러운"의 판정: 청크 안에 `doi/PMID/PMC/ISSN/ISBN/Bibcode/arXiv/S2CID` 마커가 2개 이상이거나, 숫자 밀도 > 6%, 또는 알파벳-단어 비율 < 55%.

- 서론 청크(#0) 예: `citeMarkers=0, digitDensity=0.038, alphaWordRatio=0.723` → 글다움.
- 참고문헌 청크 예(#66): `citeMarkers=20, digitDensity=0.231, alphaWordRatio=0.55`, 앞머리 `rhizosphere". Journal of Experimental Botany. 56 (417): 1761-78. doi:10.1093/jxb/eri197...` → 글이 아니라 인용 목록.

### 2b. 모델 점수 — 인용 청크가 서론을 이긴다 (버그의 기계적 증명)

질의 `"박테리아"`(한글) vs 세 청크의 코사인(진짜 e5-small, fp32):

```
0.7875  Bacteria REFERENCE chunk   <- 이긴다
0.7816  Bacteria LEAD (prose)
0.7510  Protein LEAD (prose)
```

참고문헌 청크가 서론 문단을 **0.006 차이로 이긴다.** `topPagesBySnippet`은 최고 코사인 청크를 스니펫으로 고르므로, Bacteria의 표시 스니펫은 곧 이 인용 목록 청크다. 증상과 정확히 일치한다.

### 2c. 페이지 전체로 본 결과 — 두 페이지 다 스니펫이 보일러플레이트

각 페이지의 **모든 청크**를 임베딩해 페이지별 최고 코사인 청크(=실제로 화면에 뜨는 스니펫)를 뽑았다:

```
Bacteria: pageScore=0.8074  winningChunk=#61  isReference=true
   snippet: "Douady CJ, Papke RT, Walsh DA, Boudreau ME, Nesbo CL, et al. (2003). Lateral gene transfer..."
Protein:  pageScore=0.7878  winningChunk=#31  isReference=true
   snippet: "large molecule Protein evolution - Study of changes in DNA and RNA over time Protein seq..."
```

- Bacteria의 대표 스니펫은 **72개 중 #61번** 청크 — 참고문헌 목록 깊숙한 곳이다.
- 두 페이지 **모두** 대표 스니펫이 글이 아니라 인용/See-also 보일러플레이트다. = **이 질의의 참고문헌-스니펫 비율 100%.**

정직하게 짚을 점:
- 이 측정에서는 Bacteria(0.8074) > Protein(0.7878)이라 **랭킹 1등은 맞았다.** 오너가 본 "Protein이 Bacteria 위" 순서까지 똑같이 재현하지는 못했다. 그건 캡처 시점의 위키백과 리비전, 잡힌 청크 구성, 그리고 익스텐션의 `q8` 양자화(여기선 fp32) 차이에 달렸다. 다만 **스니펫 회귀(스니펫이 인용 목록이 됨)는 직접 재현했고**, 페이지 점수를 인용 청크가 좌우한다는 사실이 곧 페이지 간 순위를 불안정하게 만든다(0.006~0.02 수준의 박빙이라 양자화·리비전 차이로 쉽게 뒤집힘). 즉 "Protein > Bacteria"는 같은 원인의 다른 발현이다.
- 위 점수는 fp32다. 익스텐션은 `q8`을 쓴다. 마진이 작아 q8에서 순위가 더 흔들릴 수 있다 — 이게 바로 고쳐야 할 불안정성이다. (하네스는 prod와 맞추려 q8을 쓰는 걸 권장, 6절.)

---

## 3. 근본 원인 (정리)

> **추출 단계에서 참고문헌·각주·See also·외부 링크 같은 보일러플레이트를 안 걷어낸다. 그래서 키워드가 빽빽한 인용 청크가 그대로 임베딩되고, 주제 질의에 대해 서론 문단보다 코사인이 높게 나와 페이지의 max-청크(=스니펫이자 페이지 점수)를 차지한다. 게다가 스니펫 선택기(`topPagesBySnippet`)에 글다움(prose-ness) 선호가 전혀 없어, 박빙이어도 인용 청크가 무조건 이긴다.**

부차 요인:
- **크로스링구얼은 주범이 아니다.** 한글 질의 → 영어 본문은 e5에서 본래 코사인이 중간대(0.75~0.81)다. 절대값이 낮아서가 아니라, 같은 페이지 안에서 **인용 청크 vs 서론 청크의 상대 순위**가 뒤집히는 게 문제다. 다만 마진이 좁은 중간대라 보일러플레이트가 순위를 뒤집기 더 쉽다는 점은 거든다.
- **렉시컬 레인은 한글 질의에 무력하다.** `"박테리아"`는 영어 본문 트라이그램에 안 맞아 FTS 후보가 0이다. 그래서 이 질의는 사실상 벡터 단독 검색이고, 벡터 레인의 약점(인용 청크)이 그대로 노출된다. RRF가 보정해줄 렉시컬 신호가 없다.

---

## 4. 수정 제안 (순위·트레이드오프)

### 수정 A — 추출 시 보일러플레이트 섹션 제거 (1순위, 근본 해결)

청킹 **전에** References/Notes/See also/External links/Bibliography/Further reading 섹션을 떼어낸다. 인용 청크 자체가 안 생기니 임베딩·검색·스니펫 모두 깨끗해진다.

- 어디서: `src/content/capture.ts`의 `extract()` 안, Readability `parse()` 결과의 DOM에서 해당 섹션을 잘라낸 뒤 `textContent`를 얻는다. (Readability는 `content` HTML도 주므로 그 위에서 헤딩 기준으로 자른다.)
- 어떻게(휴리스틱):
  - 위키백과: `<h2>/<h3>` 제목이 `References, Notes, Citations, See also, External links, Further reading, Bibliography, Sources`(+ 흔한 다국어/변형)인 섹션과 그 이하 형제 노드를 제거.
  - 일반 페이지: 위 영어/다국어 제목 사전 + `class/id`에 `reference|references|footnote|citation`이 든 리스트 컨테이너 제거.
- 트레이드오프:
  - 장점: 가장 깨끗하다. 청크 수도 Bacteria 기준 72→약 40으로 줄어 임베딩 비용·노이즈 둘 다 감소.
  - 단점: 제목 사전에 의존 → 블로그·문서 사이트엔 안 맞는 섹션이 있다(그래서 수정 B와 함께 간다). 콘텐츠 스크립트(브라우저 DOM)에서 도는 코드라 노드 단위 테스트가 까다롭다 → DOM 손질 로직을 순수 함수로 분리해 테스트(6절 파일 맵).
  - 주의: 너무 공격적으로 자르면 본문 일부를 날릴 수 있다. "제목이 정확히 일치 + 문서 후반부"처럼 보수적으로.

### 수정 B — 저(低)글다움 청크 거르기/감점 (2순위, 안전망)

A가 못 잡은 보일러플레이트(블로그 푸터, 코드 사이트의 API 목록 등)를 잡는 값싼 휴리스틱. **순수 함수 `proseScore(text)`** 로 만든다(TDD 쉬움).

제안 점수(0~1, 높을수록 글다움):

```
prose(text):
  digitDensity   = (숫자 글자 수) / (전체 글자 수)
  alphaWordRatio = (알파벳/한글로 시작하는 단어 수) / (전체 단어 수)
  citeMarkers    = doi|PMID|PMC|ISSN|ISBN|Bibcode|arXiv|S2CID 매치 수
  punctDensity   = ([.,;:()\[\]] 등) / (전체 글자 수)
  점수 = clamp(1
               - 2.0*max(0, digitDensity-0.04)
               - 0.8*max(0, 0.7-alphaWordRatio)
               - 0.05*citeMarkers
               , 0, 1)
```

쓰는 곳(둘 중 택1, B1 권장):
- **B1 인덱싱에서 드롭**: `proseScore < 0.35`면 청크를 아예 저장 안 한다(`CaptureService.capture`). 부작용: 진짜 표·수식 위주 페이지는 글다움이 낮아 통째로 빠질 위험 → 페이지에 살아남는 청크가 0이면 드롭을 끄는 가드 필요.
- **B2 랭킹에서 감점**: 검색 시 `score *= (0.5 + 0.5*proseScore)`로 곱 감점. 인덱스는 그대로 두니 안전하지만, 검색 때마다 점수 보정이 필요하고 ADR 0003/0020(순수 의미 점수)과의 정합을 ADR로 명시해야 한다.

트레이드오프: B는 A보다 정밀하지 않지만(임계값 튜닝 필요) 사이트 종류를 안 가린다. A의 보완재.

### 수정 C — 스니펫 선택에 글다움 선호 (3순위, 표시 품질 즉효)

페이지 점수(랭킹)는 그대로 두되, **스니펫만** 글다운 청크를 선호한다. "최고 코사인 청크가 인용이면, 코사인이 ε 이내인 글다운 청크로 대체."

- 어디서: `topPagesBySnippet`(또는 그 직후 스니펫 픽 단계). 페이지 점수는 max-cosine 유지(ADR 0020 불변), 표시 스니펫만 `cos >= maxCos - ε && proseScore >= τ`인 청크 중 최고 코사인으로.
- 트레이드오프: 가장 국소적이라 위험이 적고 "보이는 문제"를 바로 없앤다. 하지만 **페이지 순위 자체는 여전히 인용 청크가 좌우**한다(Protein>Bacteria류 불안정은 안 고쳐짐). 그래서 C 단독은 반쪽 — A(또는 B)와 함께.

**권장 조합: A를 주축, B를 안전망, C는 표시 보강.** A만으로 2c의 두 스니펫이 다 사라진다(인용 섹션이 청크화 전에 제거되므로).

---

## 5. 골든셋 평가 하네스 설계 (핵심 산출물)

ADR 0004가 "골든셋 하네스(precision@1/MRR)는 v1 스코프 IN"이라 못박았는데 아직 구현체가 없다. 이 절이 그 구체 설계다. 목표: **진짜 파이프라인을 오프라인으로 돌려, 위 수정의 효과를 숫자로 증명**한다.

### 5.1 고정 픽스처 (fixtures)

진짜로 캡처되는 페이지의 HTML 스냅샷을 레포에 저장한다(네트워크 없이 재현 가능해야 함).

- `eval/fixtures/pages/*.html` — 대표 페이지 스냅샷:
  - 위키백과 여러 편: `bacteria.html`, `protein.html`, `photosynthesis.html`, `mitochondrion.html` (참고문헌 많은 대표 케이스).
  - 블로그 글 1개, 기술 문서(docs) 1개 — 보일러플레이트 모양이 위키와 다른 케이스(수정 B 검증용).
  - 한국어 페이지 1개 — 한글 본문 케이스. (이미 `tests/e2e/fixtures/ko-photosynthesis.html`, `article.html`이 있으니 재활용 가능.)
- `eval/golden.json` — 질의 + 기대값:

```jsonc
[
  {
    "query": "박테리아",
    "expectTopPageIds": ["…/wiki/Bacteria"],   // 1등으로 와야 할 페이지(들)
    "expectProseSnippet": true                 // 스니펫이 인용/보일러플레이트면 실패
  },
  { "query": "what is a protein", "expectTopPageIds": ["…/wiki/Protein"], "expectProseSnippet": true },
  { "query": "광합성 명반응", "expectTopPageIds": ["…/wiki/Photosynthesis"], "expectProseSnippet": true }
  // 한글→영어 케이스를 반드시 포함 (ADR 0004)
]
```

페이지 id는 `pageIdFromUrl`(`capture-service.ts`)로 만들어 실제 저장 키와 일치시킨다.

### 5.2 하네스가 도는 길 (진짜 파이프라인, 오프라인)

```
fixture HTML
  -> Readability 추출 (+ 수정 A를 켜면 보일러플레이트 제거)   // src/content의 추출 로직(순수부 분리)
  -> ParagraphChunker.chunk()                                  // 진짜 청커
  -> e5-small embed (passage:)                                 // 진짜 모델, 노드
  -> 인메모리 벡터스토어에 적재                                 // src/adapters/memory-vector-store.ts 재사용
  -> 각 질의 embed (query:) -> store.search(vec, text, k)       // 진짜 RRF+topPagesBySnippet
  -> 결과 vs golden 비교 -> 지표 계산
```

핵심: **검색·랭킹·스니펫 선택은 진짜 코드를 그대로 쓴다.** 특히 `src/adapters/memory-vector-store.ts`의 `search`가 `opSearch`와 똑같이 `rrfFuse → hydrate → topPagesBySnippet`을 쓰므로(ADR 0020), 이걸 그대로 import하면 익스텐션과 의미가 동일한 엔진을 오프라인에서 돌린다. FTS5(트라이그램 렉시컬)만 sqlite-wasm이라 노드 재현이 무거우니, 메모리 스토어의 렉시컬 동등물을 쓰거나 v1 하네스는 벡터 레인 중심으로 보고 렉시컬은 별도 단위 테스트로 둔다(아래 정직성 노트).

### 5.3 지표

- **recall@k**: 기대 페이지가 상위 k 안에 있는가 (k=5).
- **precision@1 / MRR**: 기대 페이지가 1등인가 / 첫 정답의 역수 순위 평균.
- **reference-snippet-rate** (이번 회귀 전용 지표): 반환된 1등 스니펫이 `proseScore < τ`(=인용/보일러플레이트)인 질의 비율. **이번 버그를 콕 집어 측정하는 숫자.**
- (보조) 페이지 점수 마진: 1등과 2등 페이지 점수 차 — 작을수록 불안정. 수정 전후 비교용.

### 5.4 임베딩 전략 결정 — **노드에서 진짜 모델 (real-model-in-node)** 권장

세 가지 후보를 따졌다.

| 방식 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **A. 노드에서 진짜 e5-small 추론** | 진짜 벡터 = 이번 버그(인용 청크가 코사인으로 이김)를 **실제로 잡는다.** 청커/접두사/모델을 바꾸면 벡터도 바뀌어 회귀가 그대로 드러남. 노드 실행 이미 검증됨(`embedding-model.node.test.ts`, 본 분석에서 121청크 임베딩 ~48s). | 첫 1회 모델 다운로드(수십 MB), 추론이 단위테스트보다 느림. | **채택** |
| B. 벡터를 픽스처로 기록(record) | 빠르고 네트워크 불필요. | **청커를 바꾸면 청크 텍스트가 바뀌어 기록 벡터가 무효** — 정확히 우리가 측정하려는 변화를 못 본다. 모델/접두사 바꿔도 재생성 필요. 버그를 숨김. | 폴백 한정 |
| C. 가짜(키워드) 임베더 | 즉시·결정적. | 인용 청크가 이기는 현상은 진짜 모델 의미공간에서만 나옴 → 이 버그를 원천적으로 못 봄. | 부적합 |

**결론: A.** 이유 —
- **결정성**: e5-small은 입력이 같으면 출력이 같다(CPU). 픽스처 HTML·청커·접두사를 고정하면 점수가 재현된다. **prod와 맞추려 `dtype:'q8'`로 돌린다**(익스텐션과 동일 양자화 → 마진까지 근사). 모델 리비전을 핀(pin)해 드리프트 방지.
- **CI 실행성**: 모델을 한 번 받아 캐시(`eval/.cache` 또는 CI 캐시 키)하면 매 실행 다운로드 안 함. 또는 이미 레포가 `public/models/`에 모델 일부를 번들하므로 그걸 로컬 소스로 가리켜 네트워크 0로 만들 수 있다(권장: 네트워크 의존 제거 → CI 결정성↑).
- **속도**: ~120청크에 약 50초. `npm run test`(빠른 단위)와 분리해 `npm run eval`로 둔다.
- **폴백(B)**: 만약 CI에서 모델 실행이 불가하면, **수정이 끝난 시점의 청크에 대해** 벡터를 기록해 두고 "랭킹 로직 자체의 회귀"만 가드한다. 단 이건 청커 변경을 못 잡으므로 보조일 뿐.

### 5.5 레포 통합

- `package.json`에 `"eval": "node --experimental-... eval/run.mjs"` (또는 vitest의 별도 프로젝트). **`npm run test`에는 안 넣는다**(느림).
- 출력: 콘솔 스코어카드 + `eval/last-scorecard.json`.

```
QUERY                 P@1   R@5   refSnippet  topPage
박테리아               1.00  1.00  YES(!)      .../Bacteria
what is a protein      1.00  1.00  YES(!)      .../Protein
광합성 명반응           ...
---
P@1=…  MRR=…  recall@5=…  reference-snippet-rate=…
```

- **CI 가드(임계 서브셋)**: 질의 5개 정도의 작은 셋에 임계값을 건다 — 예: `reference-snippet-rate == 0`, `precision@1 >= 0.8`. 모델을 `public/models/`로 로컬 로드하면 네트워크 없이 결정적이라 CI에서 돌릴 수 있다. 전체 셋은 nightly/수동.

### 5.6 파일 맵 + TDD 가능한 순수 조각

```
eval/
  fixtures/
    pages/*.html            # 캡처 스냅샷 (ASCII 파일명)
  golden.json               # 질의 + 기대 페이지/스니펫
  run.mjs                   # 하네스 엔트리: 추출->청크->임베드->검색->지표
  .cache/                   # 모델 캐시 (gitignore) — 또는 public/models 재사용
src/core/
  prose-score.ts            # 순수: proseScore(text):number   [TDD]
  boilerplate-strip.ts      # 순수: stripBoilerplate(html|dom): cleaned   [TDD]
  eval-metrics.ts           # 순수: precisionAt1/mrr/recallAtK/referenceSnippetRate   [TDD]
tests/core/
  prose-score.test.ts       # 인용 청크<임계, 서론>임계 (ASCII 고정 샘플)
  boilerplate-strip.test.ts # References 섹션 제거, 본문 보존
  eval-metrics.test.ts      # 알려진 입력->알려진 지표
```

순수 조각 3개(`prose-score`, `boilerplate-strip`의 DOM-비의존 부분, `eval-metrics`)는 모델·브라우저 없이 단위 테스트가 된다 → 빠른 `npm run test`에 들어가 회귀를 값싸게 막는다. 무거운 모델 추론은 `npm run eval`에만.

> 테스트 코드 규약: 테스트 파일의 이름·주석·문자열·데이터는 ASCII만(레포 규칙). 한글 질의가 필요한 픽스처/golden은 데이터 파일(`golden.json`, `*.html`)에 두고, 테스트 코드 자체엔 한글을 안 박는다.

---

## 6. 권장 순서 (골든셋이 증명한다)

1. **하네스 먼저 만든다 (수정 전).** `eval/run.mjs` + golden 5~6개 + `prose-score`/`eval-metrics` 순수 함수. 지금 상태로 돌려 **베이스라인 스코어카드**를 찍는다. 본 분석이 측정한 베이스라인(질의 "박테리아"):
   - precision@1 = 1.0 (Bacteria가 1등 — 랭킹은 우연히 맞음)
   - **reference-snippet-rate = 1.0 (스니펫이 인용 목록 — 회귀 확인)**
   - 즉 "순위는 맞지만 스니펫이 쓰레기"가 숫자로 분리되어 보인다.
2. **수정 A(보일러플레이트 제거)를 켠다.** 하네스를 다시 돌린다. 기대: `reference-snippet-rate`가 1.0 → 0.0으로 떨어지고, 페이지 점수 마진이 커진다(순위 안정화). 인용 청크가 청크화 전에 사라지므로 2c의 스니펫이 서론 문단으로 바뀐다.
3. **수정 B(저글다움 필터)를 안전망으로 추가**, 블로그/문서 픽스처에서 `reference-snippet-rate`가 0 유지되는지 확인.
4. **필요하면 수정 C(스니펫 글다움 선호)**로 표시 품질을 마무리. 단 A가 잘 들으면 C는 선택.
5. CI에 임계 서브셋(`reference-snippet-rate == 0`)을 걸어, 앞으로 누가 청커/추출을 바꿔도 이 회귀가 못 돌아오게 못박는다.

핵심: **수정 전/후로 같은 하네스를 돌려, "reference-snippet-rate 1.0 → 0.0"을 증거로 남긴다.** 이게 ADR 0004가 말한 "정밀도는 숫자로만 안다"의 실천이다.
