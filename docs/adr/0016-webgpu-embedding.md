# 임베딩은 WebGPU(transformers.js v4), WASM 폴백

임베딩을 transformers.js v4(`@huggingface/transformers`)의 `device:'webgpu'`로 오프스크린 문서에서 실행하고, WebGPU가 없으면 `device:'wasm'`(단일 스레드)로 폴백한다. 스파이크 실측에서 WebGPU가 WASM 단일스레드 대비 **16.5배 빠르고**(4.4ms vs 72ms per chunk) 결과 벡터가 거의 동일(코사인 0.9975)했기 때문이다.

## 왜 v4 / WebGPU

- WebGPU 백엔드는 v3+에서만 제대로 온다(우리가 쓰던 `@xenova/transformers` v2.17은 미지원) → `@huggingface/transformers` v4로 이전.
- 멀티스레드 WASM은 extension 페이지가 `crossOriginIsolated=false`(SharedArrayBuffer 불가)라 쓸 수 없다 → 속도 경로는 WebGPU, 폴백은 단일스레드 WASM.
- WebGPU는 오프스크린 문서/일반 extension 페이지에서 동작한다(서비스워커에선 불가) → ADR 0015의 오프스크린 이전이 전제.

## 측정으로 밝혀진 지연의 정체

캡처가 느려 보였던 ~25초는 임베딩이 아니라 **일회성 모델 로드**였다(실측):
- `pipeline()` (135MB 다운로드 + ONNX/WebGPU 디바이스 초기화): ~20초 — 거의 전부.
- 워밍업(셰이더 컴파일): ~0.3초.
- 실제 임베딩: 청크당 4~54ms(길이에 따라). 저장: 3ms.
즉 문서 길이는 무관하고, 이 일회성 비용은 설치 시 pre-warm으로 미리 치르고 오프스크린 상주로 재로드를 피한다.

## Consequences

- 모델 가중치는 HF에서 1회 받아 캐시(불변 SHA 핀, ADR 0001/0014), v4의 ONNX 런타임 wasm은 번들(`public/onnx-hf/`)해 CDN 미사용.
- WASM 폴백 경로를 유지해 WebGPU 미지원 하드웨어에서도 동작(느리지만)한다.
- 실제 90청크 페이지 기준 WebGPU ~수 초(비동기 색인이라 비차단), WASM이면 분 단위.
