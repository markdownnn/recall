# Obsidian 내보내기 (로컬), v1 포함

캡처·하이라이트를 Obsidian 볼트에 마크다운으로 내보내는 기능을 v1에 넣는다. Obsidian은 로컬 파일이라 데이터가 기기 안에서 기기 안으로 갈 뿐이어서 ADR 0001(아무것도 기기 밖으로 안 나간다)과 충돌하지 않는다. 반면 Notion 등 클라우드로의 내보내기는 Recall 데이터가 기기 밖으로 나가므로 OUT(명시적 옵트인 escape hatch로만 가능).

## Considered Options

내보낼 대상을 "전부"로 하면 볼트가 자동 노트로 도배될 우려가 있었다. 그러나 전용 폴더로 격리하고 prefill을 기본 제외하면 "전부"도 안전하다고 판단했다. 깊은 커스텀(템플릿·파일명 패턴·도메인별 폴더·태그 매핑)은 워크플로가 아니라 취향 영역이라 post-v1로 미룬다.

## Consequences

- 메커니즘: File System Access API로 사용자가 볼트 폴더를 한 번 지정·허용(읽기/쓰기). 같은 권한으로 후일 가져오기까지 확장 가능.
- v1 설정 5개(워크플로를 가르는 축만): ① 내보내기 on/off ② 대상(전부 / 하이라이트+Manual save만) ③ prefill 포함 여부(기본 off, 설치 폭탄 방지) ④ 폴더(기본 Recall/) ⑤ 구성(페이지당 노트 1개 / 데일리 노트에 추가).
- 페이지당 .md 1개, frontmatter(url·제목·날짜) + 본문(클린 텍스트 + 하이라이트). URL로 멱등 갱신해 중복 파일을 만들지 않는다(append-only 페이지 모델, ADR 0006과 일치).
- 포트: 내보내기는 `ExportTargetPort` 뒤 ObsidianFsAdapter. 가져오기(노트 -> Recall 색인)는 `KnowledgeSourcePort`로 빈자리만 두고 post-v1.
