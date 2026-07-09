# 임베딩 모델과 청킹 전략은 골든셋으로 고른다

Status: superseded in part by ADR 0023. The measurement-first rule remains. The Korean/English cross-lingual requirement does not.

임베딩 모델과 청킹 전략을 코드에 못박지 않고, 둘 다 포트(`EmbeddingPort`, `ContentChunkerPort`) 뒤 스왑 가능 어댑터로 두고 골든셋 평가 하네스(precision@1/MRR)로 고른다. 골든셋 하네스는 v1 스코프 IN이다 — 정밀도가 이 제품의 핵심 지표인데, 측정 장치가 없으면 모델·청커 선택이 감이 되기 때문이다.

## Considered Options

모델("MiniLM")과 청킹을 그냥 고정해 출고하면 단순하고 빠르다. 그러나 한국어 사용자가 한글로 묻고 영어 자료를 읽는 크로스링구얼 회수가 핵심인데, 영어 전용 MiniLM은 이를 못 한다. 어떤 다국어 모델·어떤 청킹이 실제로 precision@1을 내는지는 숫자로만 알 수 있다. 원문을 로컬에 보관하므로 모델을 바꿔도 재임베딩으로 되돌릴 수 있어, 지금 특정 모델을 ADR로 못박지 않는다.

## Consequences

- 출발 기본값: 임베딩 = `multilingual-e5-small`(한/영 + 검색 학습), 청커 = 문단 기반 + 길이 상하한 + 약간의 겹침. 골든셋 결과에 따라 교체될 수 있다.
- 골든셋은 개발용으로 직접 큐레이션한 한/영 혼합 벤치마크이며, 반드시 한글 질문 -> 영어 구절 케이스를 포함한다. 사용자 데이터는 로컬·비공개라 튜닝에 쓸 수 없다.
- 다국어 모델은 영어 전용보다 첫 로드 용량이 크다(수십~100MB대). IndexedDB 캐싱으로 1회만 받는다.
