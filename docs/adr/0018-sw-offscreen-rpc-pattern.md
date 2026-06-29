# SW↔오프스크린 메시징: channel+id 태깅, 응답은 별도 메시지

서비스워커와 오프스크린 문서 사이 요청/응답은 `chrome.runtime`의 `sendResponse`에 의존하지 않는다. 모든 메시지에 `{ channel:'rpc', dir, id }`를 태깅하고, 받는 쪽이 처리 후 응답을 **새 메시지로** 보내 incrementing id로 상관시킨다. 두 리스너는 자기 앞이 아니면 무시하고 항상 `return false`(응답 슬롯을 점유하지 않음)한다.

## 왜 (MV3 함정)

`chrome.runtime.sendMessage`는 그 익스텐션의 **모든 리스너**(SW·오프스크린·열린 팝업)에 방송되는데 응답 슬롯은 하나뿐이다. 엉뚱한 리스너가 슬롯을 먼저 차지하거나, async 핸들러가 `return true`를 잘못 다루면, 정작 오프스크린의 응답이 사라진다. 한 스파이크에서 naive 방식이 "전달 안 됨"으로 보였던 원인이 이것이다. 응답을 별도 메시지로 보내면 점유할 슬롯 자체가 없어 충돌이 사라진다.

## 검증

스파이크에서 50개 동시 왕복을 cold/warm/idle 3회 모두 **100% 도달, 상관 오류 0, 평균 0.3ms**. 풀체인 popup→SW→offscreen→SW→popup도 통과.

## Consequences

- 헬퍼 `src/offscreen/offscreen-rpc.ts`(`callOffscreen`, `installSwRpcListener`, `installOffscreenRpcHandler`, `registerOffscreenEnsurer`)가 이 패턴을 캡슐화한다. SW↔오프스크린 통신은 모두 이걸 쓴다.
- 타임아웃(30s) + 오프스크린 재생성 후 1회 재시도로 오프스크린이 사라진 경우를 방어한다.
- 진행률 같은 단방향 알림(오프스크린→SW)은 `{channel:'rpc-event', kind}` 메시지로 보내 SW가 팝업에 재방송한다.
- 미래에 "왜 sendResponse를 안 쓰지?" 하고 단순화하려 하면 이 ADR을 본다 — 그건 의도된 회피책이다.
