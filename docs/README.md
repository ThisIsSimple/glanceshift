# docs/

GlanceShift 프로젝트의 모든 문서 기록 위치. 코드 외의 설계·작업·참고 기록은 여기에 남긴다.

## 구조

| 폴더/파일 | 용도 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | **현재 구현의 권위 있는 출처.** 코드와 어긋나면 이 문서가 우선. 구조가 바뀌면 같이 갱신. |
| `plans/` | 작업 **착수 전** 설계/스펙 문서. 무엇을·왜·어떻게 만들지. 구현 후에도 historical record 로 보존(삭제 X), 필요 시 상단에 status 배너로 현재와의 차이를 표기. |
| `works/` | 작업 **수행 후** 기록(work log). 무엇을 바꿨는지·왜·결과. |

> 추가 성격의 기록이 필요하면 새 폴더를 만들어 쓴다. 예: `research/`(외부 자료 조사),
> `decisions/`(ADR), `meetings/`. 새 폴더를 만들면 이 표에 한 줄 추가.

## 파일명 규칙 — 타임스탬프 접두사 (필수)

`plans/` 와 `works/` 에 **새로** 만드는 모든 문서는 파일명 앞에 타임스탬프를 붙인다:

```
YYYY-MM-DD-HHmm-<slug>.md
예) 2026-06-02-1352-refactor-snapping-joystick.md
    2026-06-10-0930-volume-haptics-plan.md
```

- 타임스탬프는 **생성 시각**(로컬). 셸에서 `date "+%Y-%m-%d-%H%M"` 로 얻는다.
- 같은 날 여러 문서가 생겨도 시각으로 자연 정렬된다.
- 기존(레거시) plan 문서(`EDGE_LOCK_PLAN.md` 등)는 이름 인지도 보존을 위해 그대로 둔다 — 규칙은 신규 문서에 적용.

## 작성 규칙

- **plan** 은 착수 전에 `plans/` 에. 구현이 끝나 현재와 어긋나면 본문을 다 고치기보다 상단에
  `> **Status (날짜)**: ...` 배너로 차이를 적고 `ARCHITECTURE.md` 를 가리킨다.
- **work log** 는 작업 묶음(보통 1 PR/세션)이 끝날 때 `works/` 에. 관련 커밋 해시를 남긴다.
- 상대 날짜("어제","다음 주") 금지 — 항상 절대 날짜로.

## 현재 plan 문서 상태

| 문서 | 상태 |
| --- | --- |
| `plans/SNAPPING_MODE_PLAN.md` | ⚠️ 부분 historical (3-mode·절대 슬라이더 무효, rail/intent 유효) |
| `plans/EVALUATION_PROTOCOL.md` | ⚠️ 부분 historical (모드 매트릭스 무효, 단일 모드 기준으로 읽을 것) |
| `plans/IMPLEMENTATION_PLAN.md` | 📦 historical (대부분 반영) |
| `plans/EDGE_LOCK_PLAN.md` | 📦 historical (snapping 으로 흡수) |
| `plans/GAZE_ACCURACY_PLAN.md` | ✅ 현재도 유효 |

> 위치: 이 `docs/` 는 `app/` git 저장소 안에 있어 버전 관리에 추적된다.
> (`CLAUDE.md` 는 자동 로드를 위해 프로젝트 루트에 두며, 이는 추적되지 않는다.)
