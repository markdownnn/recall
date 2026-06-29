# MV3 서비스워커 제약: 임베딩은 워커가 아니라 서비스워커에서 인라인 실행

원래 플랜은 임베딩을 별도 Web Worker에서 돌리려 했으나, 크롬 MV3 서비스워커(백그라운드)의 실제 제약 때문에 불가능했다. 워킹 스켈레톤 E2E를 실제 익스텐션으로 통과시키는 과정에서 발견했고, 임베딩은 `InlineEmbedder`로 서비스워커 스레드에서 직접 실행한다.

## 발견한 MV3 서비스워커 제약 (E2E에서 확인)

1. **`new Worker(...)` 불가** — 서비스워커 안에서 Worker가 undefined. 백그라운드 모듈이 로드 중 에러나 메시지 리스너 등록조차 실패했다. 그래서 워커 기반 임베딩을 버리고 InlineEmbedder(워커 없이 같은 스레드에서 e5 추론)로 교체했다. 워커 기반 `TransformersEmbedder`와 `embedder.worker.ts`는 죽은 코드가 되어 제거했다.
2. **함수 안 동적 `import()` 불가** — sqlite-wasm을 정적 import로 바꿔 번들에 직접 포함(백그라운드 번들 5KB -> 1MB).
3. **기본 CSP가 WASM 차단** — manifest `content_security_policy.extension_pages`에 `'wasm-unsafe-eval'` 추가.
4. **`URL.createObjectURL` 불가** — ONNX 멀티스레드 백엔드가 이를 써서 프록시 워커를 만들기에, `env.backends.onnx.wasm.numThreads = 1`로 단일 스레드 강제.

## 서비스워커 생존(keepalive)

- **요청-응답 캡처(단일 페이지)는 keepalive가 불필요하다.** 메시지 핸들러가 응답(sendResponse)을 보내기 전까지 크롬이 서비스워커를 종료하지 않으므로, 몇 초짜리 임베딩도 안전하다. 30초 유휴 종료는 in-flight 작업이 없을 때만 적용된다. 워킹 스켈레톤 E2E가 keepalive 없이 통과한 이유다.
- **prefill 백필처럼 단일 메시지에 묶이지 않는 긴 백그라운드 루프**에서만 keepalive가 필요하다. 그때는 `setInterval` 안에서 20초마다 크롬 API(예: `chrome.runtime.getPlatformInfo()`)를 호출해 idle 타이머를 리셋한다. 순수 setInterval만으로는 부족하다(크롬이 활동으로 안 침). 이 keepalive는 prefill을 넣는 Plan 5에서 추가한다(지금 넣으면 미사용 코드, YAGNI).

## Considered Options / 트레이드오프

- **인라인 + keepalive(채택):** 단순. 단 1MB 모델+WASM이 백그라운드에 상주해 메모리/배터리 비용. 크롬 버전별 keepalive 동작 변화에 약간 취약.
- **offscreen document(미래 대안):** 서비스워커가 못 하는 일(Worker/DOM/createObjectURL)을 대신하는 숨은 페이지. 멀티스레드 ONNX 가능, 서비스워커를 상주시킬 필요 없음. 더 복잡. 메모리/배터리나 임베딩 지연이 문제되면 이 방식으로 전환한다(Plan 2+ 후보).

## Consequences

- 플랜·1-pager의 "임베딩은 Web Worker(UI 스레드 절대 금지)"는 백그라운드 서비스워커 맥락에서 "InlineEmbedder(SW 스레드)"로 대체된다. 백그라운드 SW는 이미 UI 스레드가 아니므로 UI 멈춤 문제는 없다.
- 미래에 "왜 임베딩이 워커에 없지?"라는 의문이 들면 이 ADR을 본다. 워커는 MV3 SW에서 불가능했기 때문이다.
