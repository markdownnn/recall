# OPFS 영속을 오프스크린의 전용 워커(SAH Pool)로

sqlite를 오프스크린 문서가 띄운 **전용 워커** 안에서 OPFS SAH Pool VFS(`installOpfsSAHPoolVfs` / `OpfsSAHPoolDb`)로 돌려 디스크 영속한다. SW에선 OPFS 동기 핸들이 불가능해 in-memory로 떨어졌고(재시작 시 데이터 소실), 이는 "기억하는 제품"엔 치명적이었다. 스파이크에서 카운터가 브라우저 완전 재시작 후에도 유지(1→2)됨을 확인했고, 본 구현은 persistence e2e로 증명한다(캡처→재시작→재검색에서 동일 결과).

## 왜 이 방식

- OPFS `createSyncAccessHandle`은 **전용 워커에서만** 동작(SW·윈도우·오프스크린 문서 자체에서도 직접은 불가). 그래서 오프스크린이 워커를 띄우고, 그 워커가 OPFS를 잡는다.
- 기본 `OpfsDb`(비동기 프록시 워커 + SharedArrayBuffer 필요)는 우리 환경에서 안 되고, **SAH Pool**은 동기 핸들을 직접 써서 전용 워커에서 깔끔히 동작한다.

## 구조

- 워커가 VectorSearchPort의 SQL을 수행(pages/chunks 테이블, 벡터는 BLOB). 벡터는 오프스크린↔워커 postMessage(structured clone)로 Float32Array 그대로 전달.
- 오프스크린의 `OffscreenWorkerStore`가 VectorSearchPort를 구현해 워커에 위임. 코어는 이 포트만 본다(무수정).
- 임베딩 대기 청크(vector NULL)가 곧 영속 큐다 → 재시작 시 오프스크린 로드에서 drain을 재개해 미완 색인을 잇는다.

## Consequences

- 데이터가 브라우저 재시작·SW 종료에도 살아남는다(persistence.spec.ts로 검증).
- ADR 0012(durability)의 "OPFS 미검증"은 해소. 백업/복구·기기 간 sync는 여전히 후속(무료 백업 파일 / 유료 클라우드).
- 대용량에서 벡터가 용량의 대부분 → 필요 시 int8 양자화가 레버(ADR 0002), 지금은 불필요.
