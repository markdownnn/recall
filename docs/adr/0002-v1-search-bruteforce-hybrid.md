# v1 검색은 브루트포스 + 하이브리드 합산 스코어링 (FTS5 하드 prefilter 아님)

v1(청크 1만~10만 규모)에서는 모든 청크에 대해 벡터 브루트포스로 검색하고, 렉시컬(FTS5) 점수는 거름망이 아니라 의미 유사도 점수와 **합산**하는 하이브리드 스코어링으로만 쓴다. 이 규모에선 브루트포스가 수십 ms로 충분히 빠르고(무감각), 의미 매칭을 하나도 버리지 않기 때문이다.

## Considered Options

원래 1-pager는 FTS5를 하드 prefilter로 두어 "벡터가 보는 후보 수를 줄이는" 설계였다. 그러나 FTS5는 단어가 겹쳐야 후보를 통과시키므로, 단어가 안 겹치는 의미 매칭("수면 망치는 호르몬" ↔ "cortisol disrupts REM sleep")을 벡터 단계가 보기도 전에 잘라낸다. 이는 임베딩을 쓰는 이유 자체를 무력화하며, precision@1(제품의 핵심 지표)을 직접 깎는다. v1 규모에선 성능상 prefilter가 필요하지도 않아, 정밀도만 손해 보는 역레버였다.

## Consequences

- FTS5 하드 prefilter, int8 양자화, binary coarse, ANN(IVF/HNSW)은 모두 10만+ 규모에서만 켜는 최적화로 내린다 — `VectorSearchPort`/`LexicalIndexPort` 뒤 빈자리. v1 스코프 OUT.
- "벡터가 보는 후보 수를 줄이는 게 레버"라는 1-pager 명제는 스케일이 아플 때(10만+)만 유효하다. v1에선 적용하지 않는다.
- 10만+로 prefilter를 다시 켤 때도, 의미 손실을 막기 위해 prefilter 후보를 넉넉히(예: 수만) 잡는다.
