# Telemetry 설계 — 익명 옵트인, 기본 OFF (포트만 개방)

> **Status: port opened, sink deferred.** `TelemetryPort` 인터페이스와 무동작 어댑터(`NullTelemetry`)만 `src/core/telemetry.ts`에 열어 두었다. 실제 네트워크 sink는 미구현이고, 어디에도 wiring되지 않았다. 따라서 현재 동작과 zero-egress 약속(`connect-src 'self'`)은 그대로다. 이 문서는 ADR 0013(정밀도 관측을 옵트인 텔레메트리 포트로 미룸)을 구체화한 설계 노트다.

이 문서는 인디 개발자 1인이 나중에 켤 수 있는 익명 제품 텔레메트리를 어떻게 설계했는지 적는다. 두 가지를 담는다. (1) 어떤 서비스를 쓸지 조사·추천, (2) 헥사고날 cross-cutting 설계.

---

## 0. 정직한 긴장: zero-egress vs 텔레메트리

먼저 솔직하게. Recall의 핵심 약속은 "아무것도 기기 밖으로 나가지 않는다"이고, 이는 manifest CSP의 `connect-src 'self'`로 **문자 그대로** 강제된다(ADR 0001).

텔레메트리를 켜는 순간 이 약속은 그 사용자에 한해 깨진다. 익명 이벤트라도 네트워크로 나가려면 CSP에 그 endpoint 하나를 뚫어야 하기 때문이다.

그래서 규칙은 이렇다.

- **기본은 OFF.** 설치 직후, 그리고 아무것도 안 만진 사용자는 영원히 `connect-src 'self'`. zero-egress가 그대로 성립한다.
- **켜는 건 옵트인.** 사용자가 명시적으로 동의해야만 켜진다. 켜면 CSP에 endpoint 하나가 추가된 빌드가 적용되고, 그때만 익명 신호가 나간다.
- **나가더라도 익명.** 이벤트 이름 + 작은 숫자/버킷/enum 값 + 무작위 client id뿐. URL·본문·제목·쿼리·청크 텍스트는 타입 수준에서 실어 보낼 수 없게 막았다(아래 2장).

즉 "zero-egress"는 **기본값의 약속**이고, 텔레메트리는 그 약속을 깨지 않는 선에서만(옵트인 + 익명 + endpoint 1개) 존재한다. 이 문서와 미래 코드에서 "켜도 원문은 안 나간다"는 식의 흐릿한 표현은 쓰지 않는다. 켜면 익명 신호가 나간다, 끄면 아무것도 안 나간다 — 이렇게만 말한다.

---

## 1. 서비스 조사 및 추천

### 비교 기준

인디 + 프라이버시 우선 + MV3 익스텐션(offscreen/service-worker 환경) + 익명 제품 이벤트라는 조건에서 본다. cookie·fingerprinting·데이터 판매는 이 제품에서 **즉시 탈락 사유**다.

| 서비스 | self-host | 무료/가격 | PII 입장 | cookie/fingerprint | CSP endpoint | 제품 이벤트 적합 | MV3 적합 |
|---|---|---|---|---|---|---|---|
| **Aptabase** | 가능 (AGPLv3) | 무료 티어 / 클라우드 ~$14/mo | 익명 전용, 식별자 없음 | **없음** | `eu.aptabase.com` 또는 self-host 1개 | 좋음 (props는 string/number만) | 좋음 (단일 POST, SDK 얇음) |
| **PostHog (EU cloud + self-host)** | 가능 (코어 MIT, ClickHouse 필요) | 월 100만 이벤트 무료, 이후 사용량 과금 | 익명 모드 가능, cookieless 모드 있음 | 옵션(끌 수 있음) | `eu.i.posthog.com` 등 | 매우 강력(과할 수 있음) | 가능하나 SDK 무겁고 기능 과잉 |
| **Plausible / Umami / Simple Analytics** | 가능(Umami MIT, Plausible AGPL) | Umami 무료(self), Plausible 유료, Simple 유료 | 익명, cookieless | 없음 | self-host 또는 각 클라우드 | **약함** — pageview 중심, custom event는 부가 | 가능하나 제품 이벤트 모델이 빈약 |
| **Amplitude** | 불가(SaaS) | 월 1000만 이벤트 무료 | 동의 관리 필요 | **기본 cookie 사용** | `api2.amplitude.com` | 매우 강력 | 무겁고 기업향, 동의배너 전제 → 부적합 |
| **DIY (Cloudflare Worker + Analytics Engine/D1)** | 본인 소유 | Worker 무료 티어 + AE 월 1000만 write 무료 | 본인이 100% 통제 | 본인이 안 만들면 없음 | 본인 Worker 도메인 1개 | 직접 설계(정확히 필요한 것만) | 매우 적합(POST 1개) |

근거 출처는 문서 끝 Sources 참고.

### 탈락 메모

- **Amplitude:** 기본 추적이 cookie와 식별자를 쓰고 EU에선 동의 배너가 전제다. "프라이버시 우선 + 익명 + 기본 OFF" 컨셉과 정면 충돌. 무료 티어가 커도 이 제품엔 부적합.
- **Plausible/Umami/Simple Analytics:** 프라이버시는 훌륭하지만 **웹 pageview**가 본업이다. "recall 지연 버킷", "model_loaded device" 같은 **제품 이벤트**를 1급으로 다루기엔 데이터 모델이 약하다. 익스텐션엔 "페이지뷰"라는 개념 자체가 잘 안 맞는다.
- cookie/fingerprint/데이터 판매를 하는 범용 GA 류는 처음부터 후보가 아니다.

### 순위 추천

1. **1순위 — Aptabase.** 이 제품에 가장 잘 맞는다.
   - 처음부터 **앱/데스크톱/모바일 제품 이벤트**용으로 만들어졌다(웹 pageview가 아니라). 익스텐션의 capture/recall/model_loaded 같은 신호와 결이 같다.
   - **익명이 기본 설계.** device id·cookie·fingerprint·장기 식별자를 쓰지 않는다. 세션은 추적 불가하게 익명. GDPR/CCPA/PECR를 정면으로 겨냥.
   - custom props가 **string과 number만** 허용된다. 우리의 "익명 by construction" 타입 설계와 라이브러리 철학이 일치한다.
   - **AGPLv3로 self-host 가능.** 클라우드가 싫으면 내 서버에 올려 데이터를 100% 내 손에 둔다. 가격도 인디 친화적(무료 티어 + 저가 클라우드).
   - **CSP가 깔끔하다.** endpoint 하나(`https://eu.aptabase.com` 또는 self-host 도메인)만 `connect-src`에 더하면 된다. wire 포맷은 `POST {host}/api/v0/events`, 배치 최대 25개로 단순.
   - MV3 주의: 공식 SDK가 DOM/Electron/모바일 가정을 둘 수 있으니, offscreen/SW에서는 **얇은 fetch 어댑터를 직접** 쓰는 편이 안전하다(포맷이 단순해 어렵지 않다).

2. **2순위 — PostHog (EU Cloud 또는 self-host).** 나중에 퍼널·리텐션·실험까지 원하면 압도적이다.
   - EU(Frankfurt) 호스팅 + IP 익명화 기본 + cookieless 모드 → GDPR 측면 양호.
   - 단점: 이 제품엔 **과하다.** self-host는 ClickHouse라 운영 부담이 크고(8GB RAM+), SDK도 무겁다. 인디 1인 + "작은 익명 신호"엔 오버킬.

3. **DIY — Cloudflare Worker + Analytics Engine(또는 D1).** 통제·비용·미니멀리즘을 최우선하면.
   - endpoint·스키마·보존기간을 **내가 100% 소유**한다. cookie/fingerprint가 아예 존재할 수 없다(내가 안 만드니까).
   - Worker 무료 티어 + Analytics Engine 월 1000만 write 무료 → 인디 규모에선 사실상 공짜.
   - 단점: 대시보드·쿼리·SDK를 직접 만들어야 한다. 우리의 `TelemetryPort`가 작고 이벤트가 5종뿐이라 부담은 작지만, 0순위로 둘 만큼 급하진 않다.

**결론:** 켤 때가 오면 **Aptabase(EU 클라우드 또는 self-host)** 로 시작하고, 통제를 더 원하면 그 자리에 **Cloudflare DIY**를 끼운다. 우리 설계의 핵심은 — **무엇을 고르든 `TelemetryPort` 뒤 어댑터 하나만 바뀐다**는 점이다. core는 손대지 않는다.

---

## 2. Cross-cutting 설계 (어떻게)

### 2.1 포트 모양 (`src/core/telemetry.ts`, 순수)

```ts
interface TelemetryPort {
  track(event: TelemetryEvent): void   // fire-and-forget, never throws/blocks
  flush(): Promise<void>               // best-effort drain
}
```

### 2.2 익명 by construction — 타입으로 강제

핵심 아이디어: **URL이나 텍스트를 이벤트에 넣는 코드가 컴파일조차 안 되게** 만든다.

- 모든 이벤트는 `name`(고정 문자열 리터럴) + props로 구성된다.
- props의 값 타입은 전부 **닫힌 문자열 리터럴 union("버킷")이나 enum**이다. 어디에도 열린 `string`이나 raw `number` 필드가 없다.
- 그래서 `reason: 'https://evil.com'`이나 `chunkCount: 42`(raw 숫자)나 `query: '...'`(여분 필드)는 타입 에러다. 테스트가 `@ts-expect-error`로 이걸 잠가 둔다(tsconfig가 tests/를 포함하므로 `tsc --noEmit`이 검증).

버킷 어휘:
- `CountBucket = '0' | '1-3' | '4-10' | '11-30' | '31-100' | '100+'`
- `LatencyBucket = '<50ms' | '50-200ms' | '200ms-1s' | '1-5s' | '5-20s' | '20s+'`
- `IndexSizeBucket = '0' | '1-50' | '51-500' | '501-5000' | '5000+'`
- `CaptureReason = 'captured' | 'thin' | 'denylisted' | 'paused' | 'duplicate'`
- `EmbedDevice = 'webgpu' | 'wasm'`

raw 측정값을 버킷으로 접는 순수 헬퍼(`bucketCount`, `bucketLatencyMs`, `bucketIndexSize`)를 두어, **이벤트를 만들기 전에** 숫자를 버킷으로 바꾼다. raw 수치가 포트에 도달하지 못한다.

### 2.3 이벤트 분류(taxonomy) — counts/buckets만

| 이벤트 | props | 막는 현실 질문 |
|---|---|---|
| `installed` | (없음) | 설치/업데이트가 일어났나 |
| `capture_result` | `reason: CaptureReason`, `chunkCount: CountBucket` | 캡처가 왜 성공/실패했나, 대략 몇 청크였나 |
| `recall_performed` | `latency: LatencyBucket`, `resultCount: CountBucket` | 검색이 얼마나 빠른가, 결과가 대략 몇 개 나왔나 |
| `model_loaded` | `device: EmbedDevice`, `loadTime: LatencyBucket` | WebGPU/WASM 비율, 모델 로드가 얼마나 걸리나 |
| `index_size` | `size: IndexSizeBucket` | 사람들이 대략 얼마나 많이 저장해 쓰나 |

쿼리 텍스트, URL, 호스트, 제목, 청크 본문, 정확한 카운트/지연, 개별 행동 timestamp는 **하나도 없다.**

### 2.4 기본 어댑터: `NullTelemetry`

`track()`는 빈 함수, `flush()`는 즉시 resolve. 네트워크도 저장도 없다. **이게 기본으로 wiring될(예정) 어댑터**라서 zero-egress가 문자 그대로 유지된다. 실제 네트워크 어댑터로 바꾸는 건 명시적·옵트인·별도 리뷰가 필요한 변경이다.

### 2.5 미래 실어 보내는(real) 어댑터 스케치 — 미구현

offscreen 쪽 어댑터(core 밖)로만 둔다. 대략:

- **opt-in 게이트:** 설정이 꺼져 있으면 `track()`는 즉시 무시(드롭). 큐에 쌓지도 않는다.
- **Do-Not-Track 존중:** `navigator.doNotTrack === '1'`이면 강제 OFF.
- **익명 client id:** 최초 1회 `crypto.randomUUID()`를 만들어 sqlite settings에 영속. 사람과 연결 불가, 사용자가 리셋 가능.
- **배치/큐 + 주기 flush:** 메모리(또는 sqlite) 큐에 모았다가 N초/ N개마다 `POST {endpoint}/api/v0/events`(Aptabase 포맷, 배치 ≤ 25). 실패는 조용히 버린다(재시도 한도 작게).
- **단일 endpoint:** CSP `connect-src`에 정확히 그 호스트 하나만 추가된 빌드에서만 동작.

### 2.6 주입/배선 전략 비교

이벤트를 내는 곳은 셋뿐이다: `CaptureService`, `RecallService`, `IndexingService`(+ 모델 로드는 offscreen의 embedder). 현재 `src/offscreen/offscreen.ts`가 이들을 생성·조립한다.

- **(a) 포트를 services에 생성자 주입.** `new RecallService(localEmbedder, store, telemetry)`처럼. core는 `TelemetryPort` 인터페이스에만 의존, offscreen이 구현체(`NullTelemetry` 또는 real)를 꽂는다.
  - 장점: 헥사고날 순수성·테스트 용이성 최고. 어떤 서비스가 무슨 이벤트를 내는지 시그니처에 드러난다. 테스트에서 fake 포트 주입이 쉽다.
  - 단점: 몇몇 생성자에 인자가 하나 늘고, offscreen 배선이 약간 길어진다.
- **(b) 모듈 레벨 텔레메트리 facade.** offscreen이 한 번 init하고 core가 `telemetry.track(...)`를 직접 부른다.
  - 장점: 배선이 가장 짧다.
  - 단점: core가 전역 싱글턴에 의존 → 순수성·테스트성 손상. core가 인프라를 끌어안게 됨. 우리 코드베이스 철학(ADR들)과 어긋남.
- **(c) 데코레이터/래퍼.** 서비스를 telemetry 래퍼로 감싼다.
  - 장점: 서비스 본문이 깨끗.
  - 단점: 버킷 계산에 필요한 내부 값(지연·청크 수)이 래퍼 밖에선 안 보여서, 의미 있는 이벤트를 못 만든다.

**추천: (a) 생성자 주입.** 헥사고날 순수성 + 테스트성 + 명시성 때문이다. 흐름은: core 서비스가 일을 마치며 raw 수치를 버킷으로 접어 `telemetry.track(event)` 호출 → 주입된 포트가 `NullTelemetry`면 아무 일도 안 일어남 → real 어댑터면 offscreen에서 큐잉·배치·옵트인 체크 후 endpoint로 전송. core는 네트워크를 전혀 모른다.

> 지금은 (a)조차 **아직 wiring하지 않았다.** 포트와 `NullTelemetry`만 존재한다. 켤 때 위 순서대로 주입을 추가한다.

### 2.7 opt-in 설정의 위치

기존 `paused` 설정을 그대로 따라 한다. `AppSettings`에 `telemetryEnabled: boolean`(기본 `false`)을 추가하고, sqlite settings 테이블 + `SettingsPort`(예: `setTelemetryEnabled`)로 영속. real 어댑터가 매 `track`에서 이 값을 읽어 게이트한다. (이 변경은 ADR 0013/이 문서를 "구현"으로 옮길 때 하며, 지금 ports.ts는 건드리지 않았다.)

### 2.8 CSP 예외 + 프라이버시 고지 (켤 때)

- **CSP:** `connect-src 'self'` → `connect-src 'self' https://eu.aptabase.com`(또는 self-host/Worker 도메인) 하나만. 그 외 호스트는 여전히 브라우저가 차단.
- **고지:** ADR 0001 정신대로 정직하게. "익명 사용 통계를 보내려면 이 endpoint 한 곳에 연결합니다. 보내는 것: 이벤트 이름 + 버킷 숫자 + 무작위 ID. 보내지 않는 것: URL·본문·제목·검색어." 옵트인 토글 옆과 프라이버시 정책에 같은 문장을 둔다. 기본값을 조용히 바꾸지 않는다.

---

## 3. 절대 보내지 않는 것 (What we NEVER send)

- URL, 호스트/도메인, 페이지 제목
- 페이지 본문, 청크 텍스트, 하이라이트 텍스트
- 검색 쿼리(그 어떤 형태로도)
- 정확한 카운트·정확한 지연·개별 행동의 timestamp (전부 버킷으로만)
- 사람과 연결되는 식별자(이메일, 계정, 안정적 device id, IP를 우리가 따로 수집)
- cookie / fingerprint — 애초에 만들지 않는다

보내는 것의 전부: **이벤트 이름 + 작은 버킷/enum props + 무작위 익명 client id.**

---

## Sources

- Aptabase — https://aptabase.com/ , https://github.com/aptabase/aptabase , SDK 빌드 가이드(props는 string/number만, `POST /api/v0/events` 배치 ≤ 25) https://github.com/aptabase/aptabase/wiki/How-to-build-your-own-SDK
- PostHog — pricing/self-host/EU/cookieless https://posthog.com/pricing , https://posthog.com/docs/self-host
- Plausible vs Umami(웹 pageview 중심, cookieless) — https://use-apify.com/blog/plausible-vs-umami-2026 , https://scripts.nuxt.com/learn/privacy-first-analytics-compared
- Amplitude(무료 1000만 이벤트, 기본 cookie/동의 필요) — https://amplitude.com/docs/sdks/analytics/browser/cookies-and-consent-management-javascript-sdk , https://amplitude.com/privacy
- Cloudflare Workers Analytics Engine(월 1000만 write 무료) / D1 — https://developers.cloudflare.com/analytics/analytics-engine/ , https://developers.cloudflare.com/workers/examples/analytics-engine/
