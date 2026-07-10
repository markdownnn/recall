# Ask 답변 품질 개선 설계

> 상태: 설계 완료, 구현 전.

## 0. 한 줄 결론

Ask(질문에 답하는 기능)가 지금 세 가지를 거짓말하고 있다. 답변 출처가 실제 근거가 아니라 그냥 검색 상위 3개이고, 확장 검색어가 서로 뜻이 같아 검색을 헛돌리며, 관련 자료가 없어도 무조건 그럴듯한 답을 만든다. 이 셋을 고치고, 고쳐졌는지 숫자로 확인할 평가 장치를 만든다.

---

## 1. 왜 이 작업을 하는가

Recall의 Ask 기능은 저장된 페이지에서 근거를 찾아 답을 만드는 기능이다. `CONTEXT.md`의 정의를 그대로 옮기면:

> *"저장된 Chunk를 먼저 찾고, 그 Chunk만 근거로 답을 만드는 질문 기능. 답에는 근거가 된 Chunk와 CapturedPage 출처가 함께 따라온다."*

(Chunk = 페이지를 문단 단위로 잘게 쪼갠 글 조각. CapturedPage = 저장된 한 페이지 전체.)

그런데 실제 코드를 뜯어보니 세 군데가 이 정의를 못 지키고 있었다.

1. **출처가 가짜다.** [webllm-answer-generator.ts:250](../../../src/offscreen/webllm-answer-generator.ts)이 답변 화면에 붙는 출처를 `chunks.slice(0, 3)` — 즉 "검색 상위 3개를 그냥 출처라고 우긴다"로 정한다. 모델이 실제로 어떤 청크를 읽고 답했는지는 전혀 확인하지 않는다.
2. **확장 검색어가 다 같은 말이다.** 사용자가 "who is the inventor of RNN?"이라고 물으면, 지금 프롬프트는 "who invented rnn", "who came up with rnn"처럼 **말만 바꾼 같은 질문 4개**를 만든다. 뜻이 같으면 임베딩(문장을 숫자로 바꾼 값)도 거의 같은 자리에 찍히므로, 5번 검색해도 매번 같은 청크만 나온다. 검색 범위가 하나도 안 넓어진다.
3. **근거가 약해도 무조건 답한다.** 검색 점수가 아무리 낮아도 그 청크를 그대로 모델에 넣어 답을 만들게 한다. 관련 자료가 없는데도 그럴듯한 답(환각)을 지어낼 위험이 있다.

이 세 가지를 고치고, **고쳐졌다는 것을 숫자로 증명하는 평가 장치**를 함께 만드는 게 이번 작업이다. "수동으로 확인했다"는 증거로 안 친다(레포 작업 규칙).

---

## 2. 범위

### 포함

- 답변 출처를 실제 근거 기반으로 바꾼다 (섹션 4)
- 확장 검색어를 서로 다른 측면으로 벌린다 (섹션 5)
- 근거가 약하면 LLM을 부르지 않고 바로 "못 찾음"으로 끝낸다 (섹션 6)
- 위 세 가지 효과를 재는 평가 하네스를 새로 만든다 (섹션 7)

### 제외 (다음 사이클로 미룸)

- **검색 자체의 랭킹 품질 개선** (크로스인코더 리랭커, 청킹 겹침 추가) — 이건 Search와 Ask 둘 다에 걸친 별도 서브스펙이다.
- **다국어 임베딩 모델 교체** — 지금은 영어 전용 모델(`bge-base-en-v1.5`)을 쓴다([ADR 0023](../../adr/0023-english-only-model-evaluation.md)). 한국어 지원 재개는 그 ADR이 명시한 대로 새 제품 결정 + 새 골든셋이 필요한 별개 작업이다.
- **확장 검색어를 영어로 강제 번역하는 것** — 임베딩 모델이 영어 전용이라 한국어 확장 검색어는 검색이 잘 안 될 수 있지만, 이건 "번역해서 검색"이라는 별개 기능이라 이번 스펙에 안 담는다.
- **LLM이 만든 답변 문장 자체의 품질을 자동으로 채점하는 것** — 실제 생성 모델(WebLLM)은 브라우저 GPU에서만 돌고 Node.js 서버·CI에서는 못 돌린다. 그래서 "이 문장이 자연스러운가/사실적인가"는 자동으로 잴 방법이 없다. **이건 숨기는 게 아니라 정직한 한계로 명시한다.** 이번 스펙은 생성 직전 단계(검색·문맥 구성)까지만 숫자로 검증한다.

---

## 3. 지금 파이프라인 (다시 정리)

```
사용자 질문
  -> WebLLM이 확장 검색어 3~4개 생성 (LLM 호출 1)
  -> 원본 + 확장 검색어 각각 임베딩 -> 브루트포스 검색 -> 결과 병합
  -> 상위 14개 청크 확보, 그중 5개만 잘라서 LLM에 전달
  -> WebLLM이 "근거 노트" 작성 (LLM 호출 2)
  -> WebLLM이 최종 답변 작성 (LLM 호출 3, 스트리밍)
  -> 화면에 답변 + 출처 표시
```

이번 스펙이 건드리는 지점: 확장 검색어 생성 직후(다양화), 검색 결과 병합 직후(저신뢰 게이트), 최종 답변 생성 직후(출처 추출).

---

## 4. 출처 정확도

### 4.1 왜 지금 방식이 위험한가

기존 테스트([webllm-answer-generator.test.ts:176](../../../tests/core/webllm-answer-generator.test.ts))의 이름이 `answer returns model text without parser cleanup`이다. 이 테스트는 답변 텍스트에 청크 id가 `[p1#0]`처럼 박혀 있으면 그걸 근거로 뽑아내길 기대하는 것처럼 보이는데, 정작 청크 하나짜리 상황만 테스트해서 "태그를 진짜로 읽는지"와 "그냥 상위 3개를 도는지"를 구분하지 못한다. 실제 코드는 태그를 전혀 안 읽고 무조건 상위 3개를 돌려준다. 청크가 여러 개인 실제 사용에서는 **답이 5등 청크에서 나왔어도 출처엔 1~3등 청크만 뜬다.**

### 4.2 새 방식: 숨김 인용 태그

모델이 최종 답변을 만들 때, 화면엔 안 보이는 인용 표시를 답변 맨 끝에 붙이게 시킨다.

**왜 청크 id가 아니라 순번인가.** 실제 청크 id는 `https://en.wikipedia.org/wiki/Bacteria#3`처럼 **전체 URL + 번호**다([capture-service.ts:6](../../../src/core/capture-service.ts)). Recall이 쓰는 답변 모델은 1B(10억 파라미터)급의 작은 온디바이스 모델이라, 이렇게 긴 문자열을 오타 없이 그대로 베끼길 기대하기 어렵다. 대신 프롬프트에서 발췌를 `Excerpt 1)`, `Excerpt 2)`처럼 순서대로 보여주고, 모델은 **숫자만** 답에 달게 한다. 코드가 그 숫자를 실제 청크 id로 매핑한다.

**태그 형식**: 답변 맨 끝에 `[[cite: 1, 3]]` 같은 줄. 정규식으로 끝부분만 찾아 잘라낸다.

**처리 규칙**:
1. 태그 안 숫자 중 발췌 범위(1~보여준 개수) 밖이거나 중복인 건 버리고, 유효한 번호만 남긴다.
2. 태그가 아예 없거나, 파싱해도 유효한 번호가 하나도 없으면 → **출처를 상위 N개로 대신 채우지 않는다.** `sources: []`로 둔다. "근거가 된 Chunk"인지 확신 못 하면 추측해서 보여주지 않는다는 원칙([ADR 0024](../../adr/0024-ask-shows-only-verified-grounding.md)).
3. 화면에 보이는 답변 텍스트에서는 이 태그를 잘라내 사용자가 `[[cite: 1, 3]]` 같은 내부 표시를 보지 않게 한다.
4. 화면용 텍스트를 trim한 값이 "저장된 자료에서 못 찾았다"는 고정 문구와 정확히 같으면, 태그가 뭐라고 돼 있든 무조건 `sources: []`로 강제한다. "못 찾았다"면서 출처가 뜨는 모순을 막는다.

**작은 함정 하나**: 이 고정 문구가 지금 **두 파일에 따로** 박혀 있다. [ask-service.ts:6](../../../src/core/ask-service.ts)의 `NOT_FOUND`와 [webllm-answer-generator.ts:18](../../../src/offscreen/webllm-answer-generator.ts)의 `NOT_FOUND_ANSWER`가 지금은 우연히 같은 문자열이지만, 서로 다른 상수라 하나만 고치면 조용히 어긋난다. `parseAnswerCitation`이 이 문구와 비교해야 하므로, 이번에 **하나로 합친다.** `src/core/answer-generator.ts`(두 파일이 이미 함께 의존하는 포트 정의 파일)에 `NOT_FOUND_ANSWER`를 export하고, `ask-service.ts`와 `webllm-answer-generator.ts` 둘 다 이걸 가져다 쓰도록 각자의 로컬 상수를 지운다.

**어디에 구현하나**: `src/core/answer-citation.ts` (신규, 순수 함수 — 브라우저·모델 없이 도는 로직).
```
parseAnswerCitation(rawText: string, chunks: RankedResult[])
  -> { displayText: string, citedChunkIds: string[] }
```
`src/offscreen/webllm-answer-generator.ts`의 `answer`/`answerStream`이 완성된 텍스트를 이 함수에 넘기고, 반환된 `displayText`를 화면용으로, `citedChunkIds`를 [ask-service.ts](../../../src/core/ask-service.ts)의 출처 매칭에 그대로 쓴다(이 배선은 이미 있음 — `AskService`는 `citedChunkIds`를 받아 그걸로 출처를 고르는 로직이 이미 구현돼 있고, 이번 수정은 그 `citedChunkIds`가 진짜 값을 담게 고치는 것).

**프롬프트 변경**: [buildAskMessages](../../../src/offscreen/webllm-answer-generator.ts)에 "답변 다음 줄에 사용한 발췌 번호를 `[[cite: N, N]]` 형식으로 붙여라. 이 줄은 사용자에게 안 보인다" 지시를 추가하고, [formatSavedExcerpts](../../../src/offscreen/webllm-answer-generator.ts)가 각 발췌 앞에 `Excerpt N)` 번호를 명시하도록 고친다.

**깨지는 기존 테스트**: `answer returns model text without parser cleanup`은 이번 스펙이 의도적으로 깬다. 태그가 이제 화면에서 잘려나가야 하므로, 이 테스트 이름과 기대값을 새 동작에 맞게 다시 쓴다.

---

## 5. 확장 검색어 다양화

### 5.1 문제의 정확한 모습

사용자가 실제로 겪은 사례:

```
who is the inventor of RNN?          <- 원본
who invented rnn                     <- 확장 1
who is the inventor of rnn           <- 확장 2 (원본과 거의 동일)
who came up with rnn                 <- 확장 3
who invented recurrent neural networks  <- 확장 4
```

다섯 문장이 전부 "RNN 누가 만들었어?" 한 뜻이다. 원인은 [buildQueryExpansionMessages](../../../src/offscreen/webllm-answer-generator.ts)의 지시가 *"다른 키워드나 동의어로 바꿔 써라"*라서, 모델이 **말만 바꾼 같은 질문**을 만들기 때문이다.

### 5.2 프롬프트 재작성

지시를 "말 바꾸기"에서 "질문이 걸칠 수 있는 다른 측면·인물·개념으로 쪼개기"로 바꾼다. 예를 들어 RNN 질문이라면 "RNN 역사", "Elman/Jordan 초기 연구", "LSTM 고안자"처럼 서로 다른 걸 담아야, 임베딩이 서로 다른 자리에 찍혀 실제로 다른 청크를 끌어온다.

이번 스펙에서 **확장 개수(현재 최대 4)와 검색 횟수(현재 최대 5)는 그대로 둔다.** 개수를 줄이는 건 검색 비용을 줄이는 성능 레버이고, 이번 스펙은 품질(서로 다른 근거를 찾아내는 것)에 집중한다.

### 5.3 안전장치: 임베딩 기반 중복 제거

LLM이 프롬프트를 안 따르고 또 비슷한 말을 뱉을 수 있으니, 임베딩 유사도로 걸러내는 안전장치를 둔다.

**흐름 변경이 필요한 이유**: 지금 [ask-service.ts:49-53](../../../src/core/ask-service.ts)은 "확장 검색어 텍스트 확정 → 그 다음에 임베딩" 순서다. 의미 기반 중복 제거를 하려면 벡터가 있어야 비교가 되므로, **임베딩을 확정 전으로 당긴다.**

새 흐름:
1. LLM이 확장 검색어 생성 (실패하면 기존처럼 원본 질문만 사용)
2. 완전히 같은 문장(대소문자 무시)은 먼저 문자열 비교로 제거 — 기존 `uniqueQueries` 그대로 재사용, 굳이 또 임베딩할 필요 없는 것들을 값싸게 거름
3. 남은 후보 전체를 **한 번에** 임베딩 (배치 1번, 호출 횟수 안 늘어남)
4. 코사인 유사도가 문턱 이상이면(이미 채택한 검색어와 뜻이 겹치면) 버림 — 원본 질문은 항상 채택됨
5. 살아남은 (텍스트, 벡터) 쌍으로만 검색 실행

**중복 판정 문턱**: 0.92로 시작. 정확한 값은 아래 평가 하네스로 실측해 조정한다.

**구현 위치**: `src/core/query-dedup.ts` (신규, 순수 함수).
```
dedupeSimilarQueries(items: {text, vector}[], threshold: number) -> {text, vector}[]
```
`src/core/cosine.ts`의 `cosineSimilarity`를 그대로 재사용한다.

**화면 변화 (자연스러운 부작용)**: SearchTab의 "Tried searches" 칩([SearchTab.tsx:150](../../../src/ui/sidepanel/SearchTab.tsx))은 지금 문자열 중복 제거만 끝난 목록을 보여준다. 임베딩 중복 제거가 그 앞에 끼워지면, 이 칩도 자연히 **의미 중복이 사라진 목록**을 보여주게 된다. 맨 처음 발견하신 화면 문제가 이걸로 직접 해소된다.

---

## 6. 저신뢰 게이트 (NOT_FOUND 조기 반환)

### 6.1 점수 스케일 확인

Search와 Ask는 점수 스케일이 다르다. [sqlite-worker.ts의 opSearch](../../../src/offscreen/sqlite-worker.ts)가 반환하는 점수는 RRF(순위 기반 융합) 점수라 절대값에 의미가 없다. 반면 [opSearchForAnswer](../../../src/offscreen/sqlite-worker.ts)가 반환하는 점수는 **원시 코사인 유사도(0~1)** 다 — RRF는 후보를 고르는 데만 쓰이고, 실제로 반환하는 `RankedResult.score`는 코사인 그대로다. [MemoryVectorStore.searchForAnswer](../../../src/adapters/memory-vector-store.ts)도 동일하게 코사인을 반환해서, 프로덕션과 평가 하네스가 같은 스케일을 쓴다는 게 코드로 확인됐다. 그래서 이 점수에 문턱을 거는 게 말이 된다.

### 6.2 게이트 지점

원본 질문과 확장 검색어들의 검색 결과가 [mergeAnswerResults](../../../src/core/ask-service.ts)로 병합·정렬된 **직후**, 병합된 목록의 **1등 점수**를 본다. 원본이든 확장이든 상관없이 "가장 근거다운 것"의 점수를 보는 것이므로, 확장 검색어가 원본이 놓친 좋은 근거를 찾아냈을 때 그 성과가 게이트에 씹히지 않는다.

문턱 아래면 LLM을 아예 호출하지 않고, 기존 빈 검색 결과일 때와 같은 경로로 `"I couldn't find that in your saved pages."`를 즉시 반환한다.

**문턱 값**: 0.3으로 시작. [search-quality-analysis.md](../../search-quality-analysis.md)의 기존 실측치(관련 있는 매칭은 0.75~0.81대)를 참고해 넉넉히 낮게 잡은 보수적 시작값이다. 아래 평가 하네스로 오탐(관련 있는데 막힘)·미탐(무관한데 통과)을 실측해 조정한다.

**구현 위치**: `src/core/ask-service.ts`에 작은 순수 함수로 추가.
```
passesConfidenceGate(topScore: number, minScore: number): boolean
```
`askWithGenerator`에서 `mergeAnswerResults` 직후, 기존 "결과 0개면 NOT_FOUND" 분기 옆에 추가한다.

---

## 7. 평가 하네스 (`eval/run-ask.mjs`)

### 7.1 왜 필요한가

지금 `eval/` 하네스([eval-metrics.ts](../../../src/core/eval-metrics.ts), [golden.json](../../../eval/golden.json))는 **검색 품질만** 잰다(정답 페이지가 1등인가 등). Ask가 실제로 근거를 잘 모으는지, 출처가 정확한지, 저신뢰일 때 잘 멈추는지는 지금 숫자로 하나도 안 잡힌다. 이번 스펙의 절반이 Ask 품질이라, 이 하네스 없이는 "고쳤다"는 근거를 댈 수 없다.

### 7.2 무엇을 재고 무엇을 안 재는가

**잴 수 있는 것 (생성 이전 단계, 결정적)**:
- 검색·확장·병합·문맥 구성까지는 실제 프로덕션 코드를 그대로 재사용해 Node.js에서 돌릴 수 있다([buildStore](../../../eval/lib/build-and-search.mjs)가 이미 실제 청커 + 실제 `bge-base-en-v1.5` 모델 + 실제 `MemoryVectorStore`를 씀).
- **evidence-recall@context**: 최종적으로 LLM에 들어가는 문맥(상위 5개) 안에 정답 페이지의 청크가 실제로 들어있는가. "검색은 정답을 찾았는데 5개로 자르다 놓쳤다"를 잡아낸다.
- **confidence-gate-accuracy**: `expectAnswerable:false` 질문에서 게이트가 실제로 막는가, `expectAnswerable:true` 질문을 잘못 막지 않는가.

**잴 수 없는 것 (정직한 한계)**:
- 실제 답변 문장의 정확성·자연스러움. WebLLM은 브라우저 GPU 전용이라 Node.js 하네스에서 못 돌린다.
- 태그 파싱 성공률(모델이 실제로 `[[cite: ...]]` 형식을 얼마나 잘 지키는지). 이것도 생성이 필요해서 하네스로는 못 잰다. 순수 함수 `parseAnswerCitation`은 입력을 사람이 만든 샘플로 단위테스트하지만, "실제 온디바이스 모델이 이 형식을 얼마나 잘 따르는가"는 이번 스펙 밖이다.

### 7.3 골든셋 (`eval/ask-golden.json`)

```jsonc
[
  { "query": "who invented rnn", "expectAnswerable": true,
    "expectTopPageIds": ["https://en.wikipedia.org/wiki/Recurrent_neural_network"] },
  { "query": "what supplement fixes rnn training", "expectAnswerable": false }
]
```

**정답 단위는 페이지, 청크가 아니다.** `CONTEXT.md`의 "Golden set" 정의가 원래 "정답 Chunk"라고 돼 있었는데, 실제 기존 골든셋(`golden.json`)은 이미 페이지 단위로 돼 있었다. 청크 id는 `pageId#인덱스` 형식이라 청킹 로직이 바뀌면(오버랩 추가 등, 검색 품질 서브스펙에서 다룰 일) 죄다 무효가 된다. 그래서 이번에 `CONTEXT.md`를 코드 현실에 맞게 고쳤다(섹션 9 참고).

**`expectAnswerable:false` 케이스 고르는 법**: 아무 무관한 질문이나 넣으면 게이트 검증이 헐거워진다(문턱이 너무 후해도 통과하는 착시가 생김). 픽스처 코퍼스와 **같은 도메인이지만 실제로는 코퍼스에 없는 구체적 사실**을 묻는 질문으로 고른다.

### 7.4 확장 검색어 픽스처 (`eval/fixtures/expansions.json`)

확장 검색어는 LLM이 만들기 때문에 실행마다 결정적이지 않다. 그래서 **실제 WebLLM으로 한 번 뽑은 확장 검색어를 픽스처로 고정**해 커밋한다. 이건 기존 `eval/fixtures/*.txt`(캡처된 페이지 스냅샷)와 같은 패턴 — 한 번 기록해서 재현 가능하게 만드는 것이지, 매번 검증을 건너뛰는 게 아니다. 중복 제거 함수(`dedupeSimilarQueries`) 자체는 합성 벡터로 매번 결정적으로 단위테스트한다.

### 7.5 새 지표 (`src/core/eval-metrics.ts`에 추가)

```
evidenceRecallAtContext(contextPageIds: string[], expectedPageIds: string[]): number
confidenceGateCorrect(passesGate: boolean, expectAnswerable: boolean): number
```
기존 `precisionAt1`/`recallAtK`와 같은 스타일(순수 함수, 0/1 반환)로 맞춘다.

### 7.6 실행 스크립트

`eval/run-ask.mjs` (신규). `buildStore`로 코퍼스를 인메모리에 올리고, 각 골든 질문에 대해:
1. `eval/fixtures/expansions.json`에서 확장 검색어를 가져옴 (없으면 원본만)
2. 실제 `dedupeSimilarQueries`로 중복 제거
3. 실제 `MemoryVectorStore.searchForAnswer`로 각 검색어 실행
4. 실제 `mergeAnswerResults`(재사용을 위해 `ask-service.ts`에서 export하도록 변경)로 병합
5. 병합된 목록의 **1등 점수**로 `passesConfidenceGate` 판정 (섹션 6.2와 동일한 지점), `evidenceRecallAtContext`도 이 병합된 목록 기준으로 계산. 스코어카드 출력 + `eval/last-ask-scorecard.json` 저장

`package.json`에 `"eval:ask": "npm run eval:fetch-model && vite-node eval/run-ask.mjs"` 추가. **이번엔 CI 게이트를 안 건다.** 새로 도입하는 지표라 적정 임계값이 아직 없다. 몇 번 돌려보며 안정적인 값이 보이면 별도로 `--ci` 게이트를 추가한다(기존 `eval:ci`와 같은 패턴).

---

## 8. 파일 변경 목록

**신규**
- `src/core/answer-citation.ts` — `parseAnswerCitation` 순수 함수
- `src/core/query-dedup.ts` — `dedupeSimilarQueries` 순수 함수
- `eval/ask-golden.json`
- `eval/fixtures/expansions.json`
- `eval/run-ask.mjs`
- `docs/adr/0024-ask-shows-only-verified-grounding.md` (작성 완료)

**수정**
- `src/core/answer-generator.ts` — `NOT_FOUND_ANSWER` 상수를 여기로 옮겨 export (아래 두 파일이 공유)
- `src/offscreen/webllm-answer-generator.ts` — 프롬프트(인용 지시, 발췌 번호, 다양화 지시), `answer`/`answerStream`이 `parseAnswerCitation` 사용하도록 교체, 로컬 `NOT_FOUND_ANSWER` 삭제하고 `answer-generator.ts`에서 가져옴
- `src/core/ask-service.ts` — 확장 검색어 흐름을 임베딩-먼저-중복제거로 재구성, `passesConfidenceGate` 추가, `mergeAnswerResults` export, 로컬 `NOT_FOUND` 삭제하고 `answer-generator.ts`에서 가져옴
- `src/core/eval-metrics.ts` — `evidenceRecallAtContext`, `confidenceGateCorrect` 추가
- `CONTEXT.md` — "Golden set" 정의 수정 (완료)
- `package.json` — `eval:ask` 스크립트 추가

**깨졌다가 다시 쓰는 기존 테스트**
- `tests/core/webllm-answer-generator.test.ts`의 `answer returns model text without parser cleanup`

---

## 9. `CONTEXT.md` 변경 내역

"Golden set" 항목의 "정답 Chunk"를 "정답 CapturedPage"로 고치고, 이유(청킹이 바뀌어도 안 깨지게 페이지 단위로 못박음)를 덧붙였다. 이미 적용 완료.

---

## 10. 테스트 계획

### 10.1 순수 함수 단위테스트 (신규)

**`answer-citation.test.ts`**

- Scenario: 모델이 형식을 정확히 지켜 여러 발췌를 인용하면, 그 발췌들의 청크 id가 그대로 출처가 돼야 한다.
  Coverage: ✅ integration
- Scenario: 모델이 범위 밖 번호(예: 발췌가 3개인데 "7"을 인용)나 중복 번호를 섞어도, 유효한 것만 걸러써야 한다.
  Coverage: ✅ integration
- Scenario: 모델이 태그를 아예 안 달면, 상위 청크로 대신 채우지 말고 출처를 비워야 한다(추측 금지).
  Coverage: ✅ integration
- Scenario: 답변이 "저장된 자료에서 못 찾았다"는 고정 문구면, 태그가 있어도 출처를 강제로 비워야 한다.
  Coverage: ✅ integration
- Scenario: 화면에 보이는 텍스트에서 태그 줄이 깔끔히 잘려나가야 한다(사용자가 내부 표시를 보면 안 됨).
  Coverage: ✅ integration

**`query-dedup.test.ts`**

- Scenario: 코사인이 문턱보다 높은 두 검색어가 있으면, 뒤에 나온 쪽을 버려야 한다.
  Coverage: ✅ integration
- Scenario: 원본 질문은 항상 채택돼야 한다(첫 항목은 절대 버리지 않음).
  Coverage: ✅ integration
- Scenario: 서로 충분히 다른 검색어들은 전부 살아남아야 한다.
  Coverage: ✅ integration

### 10.2 기존 테스트 보강

- Scenario: 청크가 여러 개인 상황에서, 모델이 실제로 인용한 청크만 출처가 되고 인용 안 한 청크는 안 뜬다 — 지금까지 청크 1개짜리 테스트만 있어서 "태그를 읽는지"와 "무조건 상위 3개인지"를 구분 못 했던 구멍을 메운다.
  Coverage: ✅ integration (`ask-service.test.ts`, `webllm-answer-generator.test.ts`에 청크 2개 이상 케이스 추가)
- Scenario: 확장 검색어 중 원본과 뜻이 겹치는 게 있으면 실제로 검색에서 제외돼야 한다.
  Coverage: ⚠️ mock — 실제 WebLLM은 무겁기 때문에 같은 계약의 fake generator를 쓴다. 임베딩 벡터는 테스트가 직접 준 값(합성)이라 실제 모델 유사도가 아니라, "중복 제거 로직이 배선대로 불리는가"만 확인한다. 실제 임베딩으로 진짜 다양화 효과가 나는지는 7절 하네스의 몫.
- Scenario: 검색 결과 1등 점수가 문턱 아래면 생성기를 아예 호출하지 않고 NOT_FOUND를 반환한다.
  Coverage: ✅ integration (`ask-service.test.ts`에 추가, fake generator가 호출되지 않았음을 확인)

### 10.3 평가 하네스 (`npm run eval:ask`)

- Scenario: 정답이 있는 질문들에서, 확장·중복제거·병합을 거친 최종 문맥 안에 정답 페이지가 들어있는가.
  Coverage: ✅ integration — 실제 청커 + 실제 임베딩 모델 + 실제 `MemoryVectorStore.searchForAnswer` + 실제 `dedupeSimilarQueries`/`mergeAnswerResults`를 그대로 실행. `npm run test`엔 안 넣음(느림, 수시 실행).
- Scenario: 답이 없는 질문들에서, 게이트가 실제로 막는가.
  Coverage: ✅ integration — 위와 동일한 실제 파이프라인.

`npm run test`에는 10.1/10.2만 들어간다(빠름, 매번 실행). 10.3은 `npm run eval:ask`로 수시 실행하며 전후 스코어카드를 비교한다.

---

## 11. 남은 임계값 (구현 중 실측 확정)

- 확장 검색어 중복 판정 코사인 문턱: 0.92 (시작값)
- 저신뢰 게이트 점수 문턱: 0.3 (시작값)

두 값 다 하네스로 실측 후 이 문서 대신 코드 주석/커밋 메시지에 최종값과 근거를 남긴다.

---

## 12. 이번에 하지 않는 것 (다시 강조)

- 검색 랭킹 자체 개선(리랭커, 청킹 겹침) — 별도 서브스펙.
- LLM 답변 문장 품질의 자동 채점 — 기술적으로 불가능(WebLLM이 Node에서 안 돎). 수동 확인으로 때우지 않고, 이 하네스가 못 보는 범위로 정직하게 남겨둔다.
- 새 지표의 CI 게이트화 — 임계값이 안정된 뒤 별도 작업.
