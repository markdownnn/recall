# Recall

영어 웹 리서치 회수 익스텐션. 사용자가 읽은 것을 게이트를 통과한 것만 자동으로 쌓고, 자연어 질문에 정확한 구절과 출처로 답한다.

## Language

**Chunk**:
회수의 단위. 한 페이지를 문단 경계로 쪼갠 몇 백 단어짜리 토막이며, 임베딩·검색·랭킹이 모두 이 단위로 일어난다. "정확한 구절"이 곧 Chunk.
_Avoid_: Passage, segment, snippet

**CapturedPage**:
게이트를 통과해 저장된 한 페이지. Readability 본문·메타·하이라이트를 담고, 자신을 쪼갠 Chunk들을 가진다.
_Avoid_: Document, article, record

**Highlight**:
사용자가 손수 고른 본문 일부. 항상 자기만의 Chunk로 따로 임베딩되고 랭킹 가점을 받는다(자동 청크에 흡수되지 않음). 자동 청크와 겹치면 검색 시점에 dedup으로 합친다. 손수 표시 = 명시적 "기억해" 의도라 soft gate를 무시하고 캡처를 강제한다.
_Avoid_: Annotation, mark

**Capture candidate**:
캡처 후보가 된 한 페이지 진입. 일반 페이지 load 또는 SPA의 URL 변화(pushState/replaceState/popstate)로 생긴다. Dwell 타이머를 통과해야 CapturedPage가 된다.
_Avoid_: Visit, pageview

**Dwell**:
후보가 떠 있은 뒤 캡처 판정까지 기다리는 시간. 기본 10초이며 사용자가 더 길게 늘릴 수 있다. 도중에 URL이 바뀌면(튕김) 타이머가 취소돼 캡처되지 않는다.
_Avoid_: Delay, timeout

**Hard gate**:
프라이버시 목적의 캡처 차단. denylist·시크릿창·금융/헬스 등. 잘못 담으면 프라이버시 사고이므로 공격적으로(빡세게) 막는다.
_Avoid_: Blocklist filter

**Soft gate**:
참여/품질 기반 캡처 판정. dwell·thin page·스크롤 등. 못 담으면 복구 불가한 손해이므로 관대하게(애매하면 담는 쪽) 둔다.
_Avoid_: Engagement filter

**Manual save**:
게이트가 버렸을 페이지를 사용자가 직접 담는 버튼. False negative(놓친 기억)의 탈출구. v1 IN.
_Avoid_: Pin, bookmark

**Prefill**:
설치 시 빈 메모리를 채우려고 브라우저 히스토리의 URL을 골라 다시 받아(쿠키 없이) 캡처하는 백필. denylist를 적용하고 기간을 설정하며(기본 30일), 라이브 캡처보다 후순위로 큐에서 처리한다.
_Avoid_: Import, backfill, seed

**Export**:
캡처·하이라이트를 외부 노트앱으로 내보내는 것. v1은 로컬인 Obsidian만(마크다운 파일). Notion 등 클라우드 내보내기는 ADR 0001 위반이라 제외. 가져오기(노트->Recall 색인)와 반대 방향.
_Avoid_: Sync, publish

**Golden set**:
개발용으로 직접 큐레이션한 (샘플 페이지 + 질문 + 1등이어야 할 정답 Chunk) 묶음. precision@1/MRR을 숫자로 내어 영어 임베딩 모델과 청킹 전략을 고르는 기준이다. 사용자 데이터는 로컬·비공개라 튜닝에 못 쓰므로 별도로 만든다.
_Avoid_: Test set, eval data

**Ask to Recall**:
저장된 Chunk를 먼저 찾고, 그 Chunk만 근거로 답을 만드는 질문 기능. 답에는 근거가 된 Chunk와 CapturedPage 출처가 함께 따라온다.
_Avoid_: Chat, assistant, Q&A
