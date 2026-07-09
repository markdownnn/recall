# English-only Ask to Recall, BGE evaluation, and R2 model delivery

## 결론

Recall은 영어 전용 회수 앱으로 바꾼다.

한국어 UI와 한국어 검색 지원은 제거한다.

임베딩 모델은 감으로 고르지 않는다. 영어 Golden set으로 여러 BGE 계열 모델을 비교한 뒤 고른다.

Ask to Recall은 WebLLM으로 만든다. 먼저 Llama를 붙이고, 그 다음 Gemma를 같은 방식으로 시험한다.

임베딩 모델과 WebLLM 모델은 Cloudflare R2에서 받는다. 단, 사용자가 읽은 본문, 질문, 벡터, 답변은 서버로 보내지 않는다.

## 바뀌는 약속

이전 약속은 "앱이 네트워크를 전혀 쓰지 않음"이었다.

이제 이 말은 맞지 않다. 모델 파일을 R2에서 받기 때문이다.

새 약속은 이것이다.

사용자가 읽은 내용과 질문은 기기 밖으로 나가지 않는다. 앱은 모델 파일만 내려받는다.

## 왜 영어 전용인가

영어만 잘하면 된다는 제품 방향이 정해졌다.

그래서 한국어와 영어를 서로 바꿔 찾는 기능은 버린다.

그 대신 영어 검색 품질, 모델 로딩 속도, 답변 품질에 집중한다.

이 결정은 ADR 0023에 남긴다.

## 임베딩 모델 후보

임베딩 모델은 문장을 숫자 묶음으로 바꾸는 모델이다.

비슷한 뜻의 문장이 가까운 숫자가 나오면 검색이 잘 된다.

후보는 세 개다.

| 후보 | 확인한 파일 크기 | 장점 | 걱정 |
|---|---:|---|---|
| `bge-small-en-v1.5` | int8 ONNX 약 34MB | 아주 작고 빠름 | 품질이 부족할 수 있음 |
| `bge-base-en-v1.5` | int8 ONNX 약 110MB | 현재 Granite 약 107MB와 비슷한 체급 | 벡터 차원이 768이라 저장 공간이 늘어남 |
| `bge-large-en-v1.5` | 원본 ONNX 약 1.34GB | 큰 모델이라 품질 기대가 큼 | 확장 프로그램과 브라우저 메모리에 무거움 |

처음부터 하나를 고정하지 않는다.

영어 Golden set으로 `small`, `base`, 가능하면 `large`까지 비교한다.

결정 기준은 `precision@1`, `recall@5`, `MRR`, 첫 로드 시간, 청크당 임베딩 시간, 모델 파일 크기다.

용량과 속도가 비슷하면 점수가 높은 모델을 고른다.

점수 차이가 작으면 작은 모델을 고른다.

## WebLLM 후보

WebLLM은 찾은 Chunk를 읽고 답을 쓰는 모델이다.

검색은 임베딩 모델이 한다.

답변 작성은 WebLLM이 한다.

첫 후보는 `Llama-3.2-1B-Instruct-q4f16_1-MLC`다.

이유는 1B급이라 너무 작지 않고, 3B급보다 가볍기 때문이다.

그 다음 후보는 `gemma3-1b-it-q4f16_1-MLC`다.

두 모델 모두 R2에 올리고, 같은 Ask 평가 질문으로 비교한다.

3B급 모델은 1B급이 답변 품질에서 부족하다는 증거가 있을 때만 본다.

## Ask to Recall 동작

Ask to Recall은 바로 답하지 않는다.

먼저 관련 Chunk를 넉넉히 찾는다.

그 다음 WebLLM에게 그 Chunk만 주고 답하게 한다.

모델이 저장된 근거에서 답을 못 찾으면, 모르는 척하지 않는다.

사용자에게 "저장된 내용에서는 찾지 못했어요"라고 말한다.

초기값은 이렇게 둔다.

| 값 | 초기값 |
|---|---:|
| 일반 Search 표시 결과 | 5 |
| Ask 검색 후보 | 12 |
| WebLLM 입력 Chunk | 6-8 |
| 답 아래 출처 | 3-5 |

후보를 12개로 늘리는 이유는 간단하다.

답변 모델은 근거가 부족하면 말을 지어낼 수 있다.

먼저 더 넓게 찾고, 그중 좋은 Chunk만 넣어야 한다.

## 다운로드와 로딩 UX

모델이 크기 때문에 사용자는 기다리게 된다.

기다리는 이유를 숨기면 앱이 멈춘 것처럼 보인다.

그래서 상태를 화면에 보여준다.

- 임베딩 모델 다운로드 중
- WebLLM 모델 다운로드 중
- 파일 확인 중
- 모델 로딩 중
- WebGPU 준비 중
- 느린 WASM 경로로 실행 중
- 오프라인이라 모델을 받을 수 없음
- 저장 공간이 부족함
- 이 기기에서는 모델을 실행할 수 없음

다운로드는 한 번 받은 파일을 재사용한다.

테스트할 때도 매번 다시 받지 않는다.

## 다운로드 캐시 원칙

모델 테스트는 반복 실행된다.

매번 모델을 새로 받으면 시간이 낭비되고, R2 비용도 늘어난다.

그래서 모델 파일은 로컬 캐시에 저장한다.

캐시 키는 모델 이름, 모델 버전, 파일 해시로 만든다.

파일이 이미 있고 해시가 맞으면 다시 받지 않는다.

해시가 다르면 그 파일은 버리고 다시 받는다.

개발용 eval도 같은 캐시를 쓴다.

브라우저 런타임도 같은 규칙을 쓴다.

## R2 모델 서빙 구조

R2에는 모델별 폴더를 둔다.

예시는 이렇다.

```text
/models/embedding/bge-base-en-v1.5/q8/manifest.json
/models/embedding/bge-base-en-v1.5/q8/onnx/model_int8.onnx
/models/embedding/bge-base-en-v1.5/q8/tokenizer.json
/models/webllm/llama-3.2-1b-instruct/q4f16_1/manifest.json
/models/webllm/llama-3.2-1b-instruct/q4f16_1/params_shard_*.bin
/models/webllm/gemma3-1b-it/q4f16_1/manifest.json
/models/webllm/gemma3-1b-it/q4f16_1/params_shard_*.bin
```

각 `manifest.json`에는 파일 목록, 크기, SHA-256 해시, 모델 버전, 필요한 실행 엔진을 적는다.

앱은 먼저 manifest를 받고, 각 파일을 받은 뒤 해시를 확인한다.

해시가 맞아야 모델을 로딩한다.

이 결정은 ADR 0022에 남긴다.

## 제거 범위

한국어 지원은 남기지 않는다.

제거 대상은 다음이다.

- `public/_locales/ko/messages.json`
- 한국어 UI 문자열 테스트
- 한국어 store listing
- 한국어 eval fixture
- KO->KO, KO->EN, EN->KO 평가 케이스
- README의 bilingual 설명
- README의 cross-lingual limitation 설명
- 한국어 검색 예시
- Granite 다국어 모델 설명

## 구현 경계

한 번에 모든 것을 만들지 않는다.

순서는 이렇게 한다.

1. 영어 전용 문구와 평가셋 정리
2. BGE 후보 모델 캐시 다운로드와 eval 비교
3. 선택된 BGE 모델로 임베딩 교체와 재색인
4. R2 모델 manifest와 다운로드 캐시
5. Ask to Recall의 검색 후보 확장
6. Llama WebLLM 답변 생성
7. Gemma WebLLM 후보 추가
8. 다운로드와 로딩 UX

## 테스트 계획

각 테스트는 다음 변경을 막는 자산이다.

```text
Scenario: 영어 전용 제품에서 한국어 locale 파일이 다시 들어오면 제품 방향이 흔들린다.
Coverage: ✅ integration
Check: 빌드 산출물과 locale 목록에 ko locale이 없는지 확인한다.
```

```text
Scenario: 임베딩 모델을 감으로 고르면 검색 품질이 나빠져도 모른다.
Coverage: ✅ integration
Check: BGE 후보 모델들이 같은 영어 Golden set으로 평가되고 scorecard가 저장되는지 확인한다.
```

```text
Scenario: 모델 테스트가 실행될 때마다 큰 파일을 다시 받으면 개발이 느려지고 비용이 든다.
Coverage: ✅ integration
Check: 같은 모델 해시가 캐시에 있으면 downloader가 네트워크 다운로드를 건너뛰는지 확인한다.
```

```text
Scenario: 잘못되거나 깨진 R2 파일을 그대로 로딩하면 검색과 답변이 망가진다.
Coverage: ✅ integration
Check: 받은 파일의 SHA-256이 manifest와 다르면 모델 로딩을 막는지 확인한다.
```

```text
Scenario: Ask가 너무 적은 Chunk만 보고 답하면 근거 없는 말을 만들 수 있다.
Coverage: ✅ integration
Check: Ask 요청은 일반 검색보다 많은 후보를 가져오고, WebLLM 입력 Chunk 개수 제한을 지키는지 확인한다.
```

```text
Scenario: 모델 다운로드가 길어질 때 아무 표시가 없으면 사용자는 앱이 고장났다고 느낀다.
Coverage: ✅ integration
Check: 다운로드, 검증, 로딩, WebGPU 준비, 실패 상태가 UI 상태로 전달되는지 확인한다.
```

```text
Scenario: WebLLM이 근거에 없는 답을 지어내면 Recall의 신뢰가 깨진다.
Coverage: ⚠️ mock - 실제 WebLLM은 무겁기 때문에 단위 테스트에서는 같은 입출력 계약을 가진 fake generator를 쓴다.
Check: 근거 부족 응답은 "저장된 내용에서는 찾지 못했어요" 상태로 처리되는지 확인한다.
```

## 열린 결정

아직 하나는 숫자로 확인해야 한다.

`bge-large-en-v1.5`를 브라우저 런타임 후보로 둘지, eval 전용 비교 후보로만 둘지 결정해야 한다.

파일 크기와 메모리 때문에 실제 앱 후보로는 무거울 가능성이 높다.

하지만 Golden set 비교에는 넣어볼 가치가 있다.
