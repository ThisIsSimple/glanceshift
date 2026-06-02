# 2026-06-02 — Engagement Phase 1: 시간 latch → 활동 기반 이탈 판단

브랜치: `refactor/dead-code-cleanup`.
계획: [`../plans/2026-06-02-1518-engagement-and-dynamic-zone.md`](../plans/2026-06-02-1518-engagement-and-dynamic-zone.md) (Phase 1).

## 배경

컨트롤 조작이 고정 3초(`LATCH_MS`) 타임아웃으로 끊겨 불편. "시간"이 아니라 "사용자가
조작에서 이탈했는가"로 판단하도록 변경 (교수님 동적 zone 아이디어는 Phase 2로 이어짐).

## 변경

- `App.tsx`
  - `LATCH_MS 3000` + `latchTimerRef` (dwell-commit 의 setTimeout, unmount cleanup) 제거.
  - `IDLE_RELEASE_MS = 1200` + 활동 기반 idle 모니터(interval, `selectedControlId` 동안).
    - 유지: `edgeSnapshot.state==='entered'`(시선 zone) **OR** `sliderDebug.active`(head-tilt 조작).
    - 해제: 둘 다 거짓이 1200ms 지속 시 `setSelectedControlId(null)`.
    - interval 에서 최신값 읽도록 `edgeStateRef`/`tiltActiveRef` 미러, `lastEngageActivityRef` 로 누적.
  - 파일 헤더 주석 갱신.
- `DebugHud`: `engage` 행 추가 — reason(active/zone/idle) + idle ms.

## 결정 (사용자 확인)

- 범위: **Phase 1만 먼저**.
- idle grace: **1200ms**.
- (Phase 2 예정) active 중 hold zone: **유한 확장**.

## 검증

- `npm run typecheck` (node+web) 통과, `npm run build` 통과.
- `LATCH_MS`/`latchTimerRef` 잔존 참조 없음(헤더 주석 제외).
- 수동: HUD `engage` 행으로 active/zone 유지 및 idle 1.2s 해제 확인 예정(실측).

## 추가 수정 — 이탈 기준 재정의 (실측 피드백)

초기 구현은 "active(=engage 시점 neutral 대비 3° 초과 기울임)"을 유지 조건으로 썼는데, neutral
이 engage 순간의 한 자세라 그 자세로 정확히 복귀하지 않으면 영원히 active → **해제 불가** 버그.

사용자 요구로 이탈 판정을 조이스틱 ramp(neutral 기준)와 **분리**, 절대 **upright** 기준으로 재정의:
- 조작 중 = 얼굴 검출 + `|head roll(절대)| > UPRIGHT_MAX_DEG(6°)` (기울이면 안 움직여도 유지).
- 해제 = upright(꼿꼿) 지속: 시선 zone 밖 `RELEASE_GAZE_OUT_MS`(1200) / zone 안 `RELEASE_GAZE_IN_MS`(3000).
- `App.tsx` §8b 모니터: `uprightSinceRef` 로 upright 지속시간 누적, inZone 으로 임계 선택.
- DebugHud `engage` 행: `operating` / `upright · NNN/threshold ms`.
- `UPRIGHT_MAX_DEG` 는 HUD roll 값 보고 튜닝(바이어스 흡수).

## 후속

- Phase 2: B-1 동적 hold zone(active 시 유한 확장) → 통합 모델.
- Phase 3(선택): enter zone 정확도/속도 적응 + FTR 검증.
