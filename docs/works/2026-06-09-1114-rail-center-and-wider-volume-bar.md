# 2026-06-09 1114 — rail 을 볼륨 UI 중심선으로 + 볼륨 바 확대 + 테스트 프로토콜 재설계

## 배경

볼륨 단일 실험을 앞두고 GazeBar 사용성과 테스트 모드 프로토콜을 다듬었다.

1. **rail(시선 고정선)을 화면 안쪽으로** — locked GazeDot 이 볼륨 UI 정중앙에 박히도록.
2. **볼륨 바를 더 넓게** — 액션이 볼륨 하나뿐이라 충분히 큰 타깃을 줌.
3. **테스트 프로토콜 재설계** — "영화 시청 중 볼륨 드롭 → 복구" 시나리오로 변경.

## A. rail → 볼륨 UI 중심선 / B. 볼륨 바 확대

### 문제
rail 의 perpendicular 위치는 `railThickness(vp)/2`(≈32px)였는데, GazeBar 독은 `DOCK`(margin 22 +
두께 88/2)로 그려져 **중심선이 ≈66px** 였다. 둘이 어긋나 lock 시 GazeDot 이 볼륨 바보다 바깥에 찍혔다.

### 변경
- `perception/geometry.ts`: `DOCK` 레이아웃 상수를 이 파일로 이동(단일 출처). `slot 240 → 480`.
  `railThickness()` 제거 → `dockThickness()` + `gazeBarCenterOffset()`(= margin + 두께/2) 추가.
- `perception/edge-detector.ts`: `railPosition()` 이 `gazeBarCenterOffset()` 사용 → rail 이 독 중심선 일치.
- `components/EdgeZones.tsx`: 디버그 rail line 도 `gazeBarCenterOffset()` 로 정렬. `railThicknessHalfPx` 제거.
- `components/GazeBar.tsx`: 로컬 `DOCK` 제거하고 `geometry.ts` 의 `DOCK` import.

### 효과
- lock 시 GazeDot 이 볼륨 바 정중앙에 박힘. 볼륨 바 길이 264px → 504px(주축). hover/선택 범위도 확대.

## C. 테스트 프로토콜 재설계 (영화 시청 시나리오)

### 변경 전 → 후
- (전) wait → "볼륨을 랜덤% 로 맞추세요"(앱은 볼륨 안 건드림) → 조절 → 재몰입.
- (후) **영화 시청** → 랜덤 타이밍에 앱이 **볼륨을 0 으로 드롭** + "목표%(기본 50)로 올리세요" 미션 →
  복구 → 시선이 중앙(영화)으로 복귀·안정화 → 다음 trial.

### 측정 (요약 CSV)
- **A. 조절 완료 시간** `time_to_adjust_ms` — event → gaze: 볼륨 모드 최종 이탈 / baseline: Space.
  부수: `time_to_first_entry_ms`, `num_mode_entries`, `final_vol_pct`, `abs_error_pct`(gaze).
- **B. 시선 이탈→복귀** — `time_to_gaze_leave_ms`(event→중앙 이탈), `gaze_away_ms`(이탈→복귀),
  `time_to_return_ms`(event→복귀·안정화, **핵심**), `gaze_path_px`, `settled`.
- raw 시계열은 기존과 동일(phase 는 `wait`/`mission`).

### 구현
- `perception/test-session.ts`: 데이터 모델 교체. `computeReimmersion` → `computeGazeExcursion`
  (event 후 첫 이탈 + 이후 holdMs 연속 중앙 체류 = 복귀). `inRegion` export(미검출 -1 은 중앙 밖 취급).
- `components/TestMode.tsx`: RAF FSM 을 `wait → mission` 으로 단순화. event 시 `onForceVolume(0)`
  (gaze), 미션 중 이탈/복귀 + 볼륨 모드 진입/이탈 추적, 복귀 안정화 또는 30s 타임아웃에 finalize.
  intro 에 "목표 볼륨 %" 필드 추가(기본 50). 프롬프트는 화면 상단(영화 중앙 안 가림).
- `App.tsx`: `onForceVolume` prop 구현 — `setVolume(v)` + `setSliderValues({volume:v})`.
  저장값을 바꿔두면 이후 engage 시 `SliderIntentMapper` 가 0 부터 시작(reset effect 가 ref 를 읽음).

### running 오버레이 투명화 (이전 발견 버그)
복원된 TestMode 가 `Evaluation` 의 불투명 풀스크린 모달을 물려받아 gaze trial 중 GazeBar(z-index 7000)·
영화가 가려졌다. `.eval-root.running` 을 **투명 + pointer-events:none(통과)** 로 수정. (`styles.css`)

## 검증
- `npm run typecheck`(node+web) 통과, `npm run build` 통과.
- 런타임 확인(권장): 영화 틀고 `⌘⇧T` → 볼륨 0 드롭 + 미션 → gaze 복구 → 중앙 복귀로 trial 종료,
  complete 에서 조절시간·이탈→복귀·CSV 저장 확인.

## 관련
- 함께 갱신: `docs/ARCHITECTURE.md`(geometry.ts·TestMode 행), 루트 `CLAUDE.md`(테스트 모드 설명).
- 테스트 모드 본체 work log: `2026-06-09-0330-volume-experiment-mode.md`.
