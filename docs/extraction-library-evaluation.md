# 본문 추출(content extraction) 라이브러리 평가: Readability 유지 vs 업그레이드 vs Defuddle

> 상태: 평가 + 권고 (코드 변경 없음 - 이 문서는 의사결정용). 실제 추출 코드 수정은 병행 작업이 담당한다.
> 한 줄 결론: **DOM 사전 청소(pre-clean)가 진짜 지렛대다. 라이브러리를 바꾸기 전에, 0.6.0으로 싸게 올리고, 추출을 작은 `ExtractionPort`로 감싸서, 골든셋 하네스로 Readability vs Defuddle을 숫자로 A/B 한 뒤 결정한다.**
> 검증 기준일: 2026-06-30. 버전/기능은 아래 "출처"의 npm/GitHub에서 직접 확인했다.

---

## 1. 지금 우리 상황 (정확히)

추출은 한 곳에 모여 있다. `src/content/capture.ts`의 `extract()` 함수다. 다만 **정식 헥사고날 포트(port)는 아니다.** Readability를 그 함수 안에서 직접 `new` 하고 직접 호출한다(인라인). "한 군데에 격리는 됐지만 인라인"인 상태다.

지금 코드(요지):

```ts
const docClone = document.cloneNode(true) as Document
const article = new Readability(docClone).parse()   // 옵션 없음
const text = article?.textContent?.trim() || document.body?.innerText
```

핵심 사실:
- **라이브러리:** `@mozilla/readability` `^0.5.0`. 옵션을 하나도 안 준다.
- **실행 위치:** content script 안에서 **살아있는 DOM**(`document.cloneNode(true)`)을 대상으로 돈다. MV3(CSP: eval/원격코드 금지), Vite/CRXJS 번들.
- **출력 사용:** `article.textContent` 즉 **평문(plain text)**만 쓴다. HTML 구조(`article.content`)는 버린다.

여기서 두 가지 문제가 나온다.

1. **참고문헌 오염.** 위키백과식 References / Notes / See also / External links 섹션이 추출 텍스트에 그대로 살아남는다. Readability는 글 안에 있는 인용 목록을 "본문"으로 본다. 그 인용 덩어리(citation chunk)가 임베딩되어, 주제 질의에서 리드 문단을 **이긴다** — 레포에서 실측으로 확인된 회귀다(`docs/search-quality-analysis.md`).
2. **문단 경계 붕괴.** `textContent`는 블록 요소 사이 줄바꿈을 뭉갠다. 그래서 문단 단위 청커(`ParagraphChunker`)가 경계를 잘 못 잡는다.

> 중요: 위 어떤 Readability **옵션도 참고문헌을 지우지 못한다.** 참고문헌 제거는 라이브러리 기능이 아니라 **우리가 직접 하는 DOM/텍스트 사전 청소**의 몫이다 (3장, 6장).

---

## 2. Readability 0.5.0 옵션: 무엇을 켜고 무엇을 건너뛰나

`new Readability(doc, options)`에 줄 수 있는 옵션과, **우리 목표**(임베딩용 깨끗한 산문 + 참고문헌 제거 + 청킹용 문단 보존) 기준의 판정이다.

| 옵션 (기본값) | 무엇을 하나 | 우리 케이스에 도움? | 판정 |
|---|---|---|---|
| `debug` (false) | 파싱 과정 콘솔 로깅 | 개발 디버깅용. 품질과 무관 | **건너뜀** |
| `maxElemsToParse` (0=무제한) | 너무 큰 DOM 파싱을 막는 상한 | 병적으로 큰 페이지에서 멈춤(hang) 방지. 품질엔 영향 없음 | **선택** (안전용으로 큰 값 1개만 둘 수 있음) |
| `nbTopCandidates` (5) | 본문 후보를 몇 개 비교할지 | 내부 본문 탐색 튜닝. 참고문헌/문단 문제와 무관 | **건너뜀** |
| `charThreshold` (500) | 결과를 받아들일 최소 글자 수 | 우리 문제는 "너무 적게"가 아니라 "너무 많이(참고문헌 포함)". 낮추면 쓰레기 페이지까지 통과 | **건너뜀** (기본 유지) |
| `classesToPreserve` / `keepClasses` | 결과 HTML에 특정 class 보존 | 우리는 `textContent`(또는 블록 조인)만 쓴다 → class가 사라지므로 **무의미(moot)** | **건너뜀** |
| `serializer` | `article.content`(HTML)를 어떻게 만들지 커스터마이즈 | 문단 보존 경로(아래 4·6장)에서 `content`를 쓸 때만 의미. 기본(HTML 문자열) + 브라우저 `DOMParser`로 충분 | **건너뜀** (기본이면 됨) |
| `disableJSONLD` (false) | JSON-LD 메타데이터 사용 끔 | **켜두면(=false 기본) 제목 정확도가 올라간다.** 우리 `title`이 더 정확해짐 | **유지** (기본 false 그대로 = 도움) |
| `allowedVideoRegex` | 허용할 비디오 임베드 패턴 | 우리는 텍스트만 쓰므로 비디오 무관 | **건너뜀** |

**별도 함수 `isProbablyReaderable(doc, {minScore:20, minContentLength:140})`** — 이건 옵션이 아니라 "이 페이지가 읽을거리(article)인가?"를 미리 묻는 게이트다. 검색 결과 페이지(SERP), 앱 셸, 로그인 화면 같은 비-본문 페이지를 **캡처 전에 거를** 수 있다. 캡처 품질을 올리는 용도로 **고려할 만함**(현재 캡처 게이트 로직과 합치는 건 별건).

**요약:** 옵션으로 얻을 수 있는 건 `disableJSONLD=false` 유지(제목)와, 선택적 `maxElemsToParse` 안전 상한 정도다. **참고문헌 문제도, 문단 붕괴 문제도 옵션으로는 안 풀린다.** 둘 다 우리가 추출 전/후에 직접 손봐야 한다.

---

## 3. Readability 최신(0.6.0) 델타: 올릴 가치 있나

- **최신 버전: 0.6.0** (2025-03-03 배포). 0.6.0이 현재 최신이다(0.7.x 없음). 런타임 의존성 0개 — 번들/MV3에 부담 없음.
- **0.5.0 → 0.6.0 변경점(검증):**
  - `linkDensityModifier` **새 옵션**: 링크가 빽빽한 블록을 본문에서 떨굴 때의 민감도를 조절. 링크/인용이 많은 참고문헌성 블록을 **더 잘 떨굴 수 있는** 손잡이가 하나 생긴 셈 — 우리 케이스에 직접 닿는 유일한 신규 옵션.
  - 버그 픽스: **정당한 짧은 문단이 잘못 제거되던 문제 수정**(리드/짧은 문단 보존에 유리), JSON-LD 후행 슬래시 파싱 버그 수정, byline 메타데이터가 비슷한 비-byline 본문을 지우던 문제 수정, GitLab 헤더 제거 문제, HTML 문자 unescape 개선, 잘못된 속성이 파싱을 깨던 문제 수정.
  - 기타: Parsely 태그/schema.org context를 메타데이터 폴백으로, 데이터 테이블 지원 개선, 성능 개선, TypeScript 타입 개선.
  - **Breaking change: 문서상 없음.**
- **판정:** **싸고 안전한 업그레이드.** 우리가 직접 닿는 신규 옵션(`linkDensityModifier`)과 "짧은 문단 보존" 픽스가 우리 두 문제(참고문헌·문단)와 같은 방향이다. 의존성 0개라 번들·CSP 영향 없음. `^0.5.0` → `^0.6.0` 범프를 권고한다. 단, 이것만으로 참고문헌이 사라지진 않는다(여전히 사전 청소 필요).

---

## 4. 대안 비교: MV3 content script에서 살아있는 DOM에 쓸 수 있는 추출기

우리 제약은 까다롭다: **content script 안 / 살아있는 DOM / MV3 CSP(원격코드·eval 금지) / Vite 번들.** 그리고 청킹을 위해 **문단·제목 구조를 보존**해야 한다.

| 라이브러리 (최신/날짜) | 유지보수 | 라이선스 | 번들/의존성 | 살아있는 DOM에서 동작? | 구조(문단/제목) 보존? | 참고문헌·각주 처리 | MV3/CSP | 출력 |
|---|---|---|---|---|---|---|---|---|
| **@mozilla/readability 0.6.0** (2025-03) | 활발(Mozilla) | Apache-2.0 | 런타임 의존성 **0** | **예** (지금 그렇게 씀) | `content`(HTML)에 보존 — 단 `textContent`는 뭉갬 | **참고문헌을 본문으로 봄(문제의 근원)**, 각주 표준화 없음 | 안전 | HTML(`content`) + 평문(`textContent`) |
| **Defuddle 0.19.1** (2026-06-24) | **활발**(kepano/Obsidian) | MIT | core 번들 의존성 0; full 번들은 turndown/temml 등 선택 의존성 추가. unpacked 2.6MB(전체 번들+CLI 합산) | **예** — 브라우저 번들이 `document`(현재 살아있는 DOM)에서 동작 | **예** (문단·제목 보존, H1→H2 정규화) | **각주/참고문헌을 일관된 형식으로 표준화** + 백레퍼런스, 코드블록/수식 보존 | 안전(원래 Obsidian **Web Clipper 확장**용으로 만듦) | HTML(기본) + 선택적 Markdown |
| **@extractus/article-extractor 8.1.0** (2026-05) | 활발 | MIT | 내부에 **linkedom + sanitize-html** 번들 → 브라우저에선 중복/무거움 | **아니오(부적합)** — URL 또는 **HTML 문자열**을 받아 내부에서 자체 DOM(linkedom)을 만든다. content script의 살아있는 DOM을 안 쓴다 | 구조화된 HTML 유지(sanitize 옵션으로 조절) | 일반 보일러플레이트 제거 위주, 참고문헌 전용 처리는 없음 | Node 지향(브라우저는 proxy 경유) | HTML `content` + 메타데이터 |
| **@postlight/parser (mercury)** (npm 약 5년 전) | **사실상 방치** | Apache-2.0 | cheerio 기반, 무겁다 | 아니오(서버/Node, HTML 문자열) | HTML 유지 | 전용 처리 없음 | 부적합 | HTML + 메타데이터 |

**읽는 법:**
- **article-extractor / mercury**는 "URL/HTML 문자열을 받아 서버에서 본문을 뽑는" 설계다. 우리처럼 이미 살아있는 DOM이 있는 content script에선 자체 DOM 파서(linkedom)를 또 번들해야 해서 **중복이고 무겁다**. 우리 케이스엔 부적합.
- 진짜 후보는 **Readability(0.6.0) vs Defuddle** 둘이다. Defuddle은 (1) **살아있는 `document`에서 바로 동작**하고(브라우저 번들), (2) **구조를 보존**하며, (3) **각주/참고문헌을 표준화**해서 우리 두 문제를 정면으로 겨냥한다. 그리고 (4) 원래 **브라우저 확장(Web Clipper)용**으로 만들어져 MV3 친화적이다. 다만 Readability(의존성 0, 검증된 안정성)보다 신생이고, full 번들은 수식/Markdown 라이브러리로 더 무겁다(core만 쓰면 가벼움).

→ **최우선 대안: Defuddle.** 단, "더 낫다"는 건 그들의 주장이다. 우리 코퍼스에서 **숫자로 확인**해야 한다(6·7장).

---

## 5. DOM 사전 청소(pre-clean): 라이브러리와 무관한 진짜 지렛대

추출 **전에** 클론 DOM에서 참고문헌 흔적을 직접 떼는 방법이다. 라이브러리가 무엇이든 효과가 난다.

```js
// 클론에서, 추출 전에:
//  - 인라인 인용 마커:  sup.reference
//  - 인용 목록 컨테이너: .reflist, ol.references
//  - 보일러플레이트 섹션: #References / #See_also / #Notes / #External_links 아래
```

**판정: 가장 효과가 크고, 라이브러리 선택을 덜 중요하게 만든다.** 이유:
- 참고문헌 오염의 원인은 "Readability가 인용 목록을 본문으로 본다"이다. 그 인용 DOM을 **들어가기 전에 없애면**, 어떤 추출기를 쓰든 인용 청크가 애초에 안 생긴다.
- 진행 중인 Fix 1(`stripBoilerplate`, `docs/search-quality-analysis.md` / 검색 품질 플랜)은 이미 같은 목표를 **텍스트 레벨**에서 한다(블록-조인된 텍스트에서 References 같은 제목 줄부터 끝까지 잘라냄). 효과는 크지만(하네스에서 ref-snippet-rate ~1.0 → ~0 목표), 위키백과식 제목 사전(dictionary)에 의존한다.
- **DOM 레벨 사전 청소는 더 정밀하다.** 인라인 `sup.reference` 마커까지 지우고, 제목 텍스트가 아니라 **구조(셀렉터)**로 잡아 일반 블로그/문서 사이트의 변형에도 덜 깨진다. 다만 위키백과 밖에선 셀렉터가 사이트마다 달라 만능은 아니다 — 그래서 텍스트 레벨 strip(Fix 1) + 저-산문 청크 필터(Fix 2)와 **함께** 쓰는 안전망 조합이 맞다.

핵심 메시지: **사전 청소가 문제의 80%를 라이브러리와 무관하게 푼다.** 즉 "라이브러리를 바꿔야만 해결된다"가 아니다. 라이브러리 교체는 남은 부분(구조 보존, 각주 표준화)에서의 추가 이득을 **데이터로 입증할 때** 정당화된다.

---

## 6. 권고 (핵심)

세 선택지 (a)0.5.0 유지+사전청소+문단보존 / (b)업그레이드+사전청소 / (c)Defuddle 전환 중에서:

**권고 = (b)를 즉시 + (a)의 문단보존을 포함, 그리고 (c)는 하네스로 A/B 한 뒤 데이터로 결정.**

구체적으로 단계(sequencing):

1. **[즉시·저위험] DOM/텍스트 사전 청소를 지금 진행 중인 그대로 밀어붙인다.** 참고문헌 문제의 근원을 라이브러리 무관하게 친다. (병행 작업이 이미 함 — 이 권고는 그걸 **지지**한다.)
2. **[즉시·저위험] 문단 보존으로 전환.** `textContent` 대신 `article.content`(HTML)를 브라우저 native `DOMParser`로 파싱해 블록 요소를 `\n`으로 조인한다(진행 중 Fix 1 방식과 동일). 청커가 문단 경계를 제대로 본다.
3. **[즉시·저위험] Readability `^0.5.0` → `^0.6.0` 범프.** Breaking 없음, 의존성 0, "짧은 문단 보존" 픽스 + `linkDensityModifier`가 우리와 같은 방향. 범프 후 하네스를 한 번 돌려 회귀 없음만 확인.
4. **[작은 한 걸음] 추출을 `ExtractionPort`로 감싼다.** 아래 7장. 그래야 A/B와 미래 교체가 깔끔하다.
5. **[데이터 기반 결정] 골든셋 하네스로 Readability(0.6.0+사전청소) vs Defuddle을 A/B.** ref-snippet-rate / p@1 / recall@5를 같은 코퍼스에서 비교. Defuddle이 **사전청소까지 적용한 Readability를 의미 있게 이길 때만** 전환한다. 안 이기면 의존성 0의 Readability를 유지한다 — 신생 의존성·2.6MB full 번들·재작성 비용을 정당화할 이유가 없으니까.

**트레이드오프 요약:**

| 선택지 | 품질 | 구조 보존 | 유지보수 | 번들 | 교체 비용 | 위험 |
|---|---|---|---|---|---|---|
| (a) 0.5.0 유지 + 사전청소 + 문단보존 | 사전청소가 핵심 이득 | DOMParser 블록조인으로 확보 | 그대로 | 0 추가 | 0 | 가장 낮음 |
| (b) 0.6.0 업그레이드 + 사전청소 | (a) + 짧은문단 픽스·linkDensity 손잡이 | 동일 | 의존성 0 유지 | 0 추가 | 거의 0 | 낮음 |
| (c) Defuddle 전환 | 각주/참고문헌 표준화·구조 보존이 설계로 들어감(주장) | 강함(설계 목표) | 신생, kepano/Obsidian 활발 | core 가벼움 / full 무거움(수식·md) | 추출부 재작성 + 새 의존성 | 중간 (검증 필요) |

→ 즉시 이득은 **(b)**가 가장 가성비 좋다. **(c)는 "데이터 보류(decision pending data)"** — 6단계의 A/B 숫자가 나오기 전엔 결정하지 않는다.

---

## 7. 골든셋 하네스로 후보를 A/B 하는 법 (어떻게 꽂나)

이게 권고의 심장이다. **추측이 아니라 같은 코퍼스의 숫자로 라이브러리를 고른다.**

**지금 하네스 구조** (`eval/run.mjs` + `eval/lib/build-and-search.mjs`):
- 코퍼스는 **미리 추출된 블록-조인 텍스트**(`eval/fixtures/*.txt`)다. 즉 평가가 시작되는 지점이 이미 "Readability로 한 번 추출한 다음"이다. 픽스처는 `eval/lib/build-corpus.mjs` → `extract-fixture.mjs`(`blockJoin`)가 원본 HTML에서 만든다.
- `buildStore(manifest, {strip, minProse})`가 픽스처를 읽어 `ParagraphChunker` → 임베딩 → `MemoryVectorStore.search`(프로덕션과 같은 rrfFuse + topPagesBySnippet)로 검색한다.
- 헤드라인 지표: **reference-snippet-rate**(회귀 숫자), 그 옆에 p@1 / recall@5 / MRR.

**추출기를 A/B 하려면 "픽스처 생성" 한 단계만 추출기별로 갈아끼우면 된다.** 청킹·임베딩·검색·채점은 그대로 둔다(그래야 라이브러리 효과만 격리됨):

1. **원본 HTML을 한 번 캐시.** A/B의 양쪽이 **같은 입력**을 봐야 한다. `build-corpus.mjs`가 받은 원본 HTML을 `eval/.cache/html/<id>.html`에 저장(현재는 추출 텍스트만 저장).
2. **추출기별 픽스처 폴더 생성.**
   - `eval/fixtures-readability/`: 각 캐시 HTML을 `linkedom`/`jsdom`으로 Document화 → **사전 청소 셀렉터 제거** → `new Readability(doc, {linkDensityModifier?}).parse()` → `content`를 블록-조인.
   - `eval/fixtures-defuddle/`: 같은 캐시 HTML을 Document화 → `import Defuddle from 'defuddle/node'`(Node 번들은 linkedom/jsdom/happy-dom Document를 받음) → `.parse()` → `content`(HTML)를 같은 `blockJoin`으로 텍스트화.
   - **두 경로 모두 같은 `blockJoin`을 통과**시켜야 한다. 안 그러면 추출기 차이가 아니라 직렬화 차이를 재게 된다.
3. **manifest의 `file` 경로(또는 fixtures 디렉토리)를 폴더별로 바꿔** 하네스를 두 번 돌린다. 예: `vite-node eval/run.mjs -- --fixtures=fixtures-readability` vs `--fixtures=defuddle`. (`run.mjs`/`build-and-search.mjs`에 fixtures 디렉토리 인자 하나만 추가하면 됨 — 평가 작업 범위.)
4. **스코어카드 두 장을 비교.** 같은 golden.json, 같은 모델, 같은 검색. 차이는 오직 추출기. 보는 숫자:
   - **reference-snippet-rate**(낮을수록 좋음, 목표 0): 어느 추출기가 인용 오염을 덜 남기나.
   - **p@1 / recall@5**: 구조 보존이 청킹·랭킹을 도와 정답 페이지를 더 위로 올리나.
   - 회귀 감시: 한국어(S3) 케이스가 깨지지 않는지(Defuddle의 정규화가 비영어에서 어떤지).

**중요(주의):** Node에서 Defuddle/Readability는 **진짜 DOM Document**가 필요하다(살아있는 브라우저 DOM 대용으로 linkedom/jsdom/happy-dom). 픽스처는 이미 `extract-fixture.mjs`에서 `linkedom`을 쓰므로(devDependency 존재) 같은 도구를 재사용하면 된다 — 새 무거운 의존성 없이 A/B 가능. 단 Defuddle Node 번들은 happy-dom/jsdom을 더 정확히 지원하니, linkedom에서 결과가 이상하면 jsdom로 바꿔 동률 조건을 맞춘다.

이 방식이면 6장 5단계의 결정이 **느낌이 아니라 두 장의 스코어카드 차이**로 내려진다.

---

## 8. ExtractionPort: 작은 래퍼 (권고)

지금 추출은 "한 곳에 격리됐지만 인라인"이다(`extract()` 안에서 Readability 직접 호출). 정식 포트가 아니다. 작은 포트로 감싸면 A/B와 미래 교체가 깔끔해진다.

```ts
// src/core/ports.ts (또는 extraction-port.ts)
export interface ExtractionPort {
  // 살아있는 document(또는 클론)를 받아, 청크 입력이 될 블록-조인 텍스트와 제목을 낸다.
  extract(doc: Document): { title: string; text: string } | null
}
```

- 어댑터 1: `ReadabilityExtractor`(사전청소 + 0.6.0 + content 블록-조인 + stripBoilerplate).
- 어댑터 2(평가용): `DefuddleExtractor`.
- `capture.ts`는 포트만 호출한다. 하네스도 같은 포트 구현을 꽂아 **프로덕션과 동일 경로**로 A/B 한다(현재 하네스는 픽스처를 먼저 만들지만, 포트가 생기면 픽스처 생성 자체를 포트로 통일 가능).

작은 한 걸음이고, 위 A/B의 깔끔함과 미래 스왑 비용을 동시에 낮춘다. 추출 로직 자체는 안 바꾸므로 위험이 낮다.

---

## 9. 결정 보류 노트 (decision pending data)

- **확정(근거 충분):** 사전 청소(라이브러리 무관 최대 지렛대) · 문단 보존(content 블록-조인) · Readability 0.6.0 범프(breaking 없음, 의존성 0) · ExtractionPort 래핑. → 이건 ADR로 적을 만하다(아래 초안).
- **보류(데이터 필요):** Defuddle로의 **전환** 여부. 7장 A/B에서 "사전청소까지 한 Readability 0.6.0"을 ref-snippet-rate / p@1 / recall@5에서 **의미 있게** 이겨야 정당화된다. 이기지 못하면 의존성 0의 Readability를 유지한다.

---

## ADR 초안 (확정 부분만)

> 아래는 9장의 "확정" 부분에 대한 ADR 초안이다. Defuddle 전환은 포함하지 않는다(데이터 보류).

**제목: 본문 추출 — Readability 유지(+0.6.0) + DOM 사전 청소 + 문단 보존 + ExtractionPort**

- **맥락:** content script에서 Readability 0.5.0을 옵션 없이 호출하고 `textContent`만 쓴다. 위키백과식 참고문헌이 본문으로 추출되어 검색을 오염시키고(실측 회귀), `textContent`가 문단 경계를 뭉개 청킹을 해친다.
- **결정:**
  1. 추출 전 클론 DOM/텍스트에서 참고문헌·보일러플레이트를 제거한다(라이브러리 무관 핵심 수정).
  2. `article.content`(HTML)를 브라우저 `DOMParser`로 파싱해 블록 단위 `\n` 조인한 텍스트를 청커에 넘긴다(문단 보존).
  3. `@mozilla/readability`를 `^0.6.0`으로 올린다(breaking 없음, 의존성 0, 짧은문단 픽스 + `linkDensityModifier`).
  4. 추출을 `ExtractionPort`로 감싼다(깔끔한 A/B와 미래 스왑).
- **대안:** Defuddle로의 전환은 골든셋 하네스 A/B 숫자가 사전청소된 Readability를 이길 때만 채택(보류).
- **근거:** 참고문헌 문제의 원인은 라이브러리 기능이 아니라 입력 DOM에 인용 구조가 남는 것 → 사전 청소가 가장 큰 지렛대다. 라이브러리 교체는 데이터로 입증된 추가 이득이 있을 때만 한다.
- **귀결:** 번들·CSP 영향 0(의존성 0 유지). 추출이 포트 뒤로 가 테스트·교체가 쉬워진다. Defuddle 결정은 스코어카드 두 장으로 내린다.

---

## 출처 (검증)

- @mozilla/readability — npm (최신 0.6.0): https://www.npmjs.com/package/@mozilla/readability
- @mozilla/readability 0.6.0 버전 정보 (2025-03-03): https://socket.dev/npm/package/@mozilla/readability/versions/0.6.0
- @mozilla/readability CHANGELOG (0.6.0 변경점, linkDensityModifier, 짧은문단 픽스 등): https://github.com/mozilla/readability/blob/main/CHANGELOG.md
- Defuddle — GitHub (브라우저=현재 document, Node=Document 입력, MIT, 구조/각주 표준화): https://github.com/kepano/defuddle
- Defuddle — npm/npmx (0.19.1, 2026-06-24, MIT, unpacked 2.6MB, 선택 의존성 linkedom/turndown/temml/mathml-to-latex): https://npmx.dev/package/defuddle
- @extractus/article-extractor — GitHub (8.1.0, 2026-05, URL/HTML 문자열 입력, linkedom+sanitize-html 내부, Node 지향): https://github.com/extractus/article-extractor
- @postlight/parser (mercury) — npm/GitHub (사실상 방치, 마지막 npm 배포 약 5년 전): https://github.com/postlight/parser
</content>
</invoke>
