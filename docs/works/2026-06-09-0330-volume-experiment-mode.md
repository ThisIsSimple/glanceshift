# 2026-06-09 0330 — 볼륨 조절 사용자 실험 모드 (밝기 제거 + 볼륨 단일화 + 테스트 모드)

## 배경

콘솔 게임(키보드 없음) 상황에서 GlanceShift(시선+머리)로 볼륨을 조절하는 사용자 실험을 위해
앱을 실험 전용 형태로 정리했다. 측정 대상은 ① 목표 볼륨 도달 시간 ② 조절 후 게임 재몰입 시간이며,
뒤로 시선 궤적·모드 진입/이탈·볼륨 변화를 raw 시계열로 수집한다. 비교군(baseline)은 외장 다이얼.

이 작업의 대부분은 과거 커밋 `b94eb2c`(볼륨 단일화 + 테스트 모드)와 `e590eee`(head-tracker
자동 복구)에 이미 구현돼 있었으나 `4edc337` 로 함께 revert됐었다(당시 main 브랜치 혼선의 일부).
두 커밋의 내용을 **현재 머지된 아키텍처에 맞게 재적용**했다. 단, cleanup 머지로 edge mode 비교
기능(`edgeMode`/`onSetEdgeMode`/filtered·raw)이 제거됐으므로 `TestMode` 의 `edgeMode` prop 은 뺐다.

## 변경 내용

### A. 밝기(brightness) 완전 제거
- `App.tsx`: `GAZEBAR_ITEMS` 에서 brightness 제거, `sliderValues` 초기값/throttled push/commit
  분기/마운트 동기화(`getBrightness`)에서 모두 제거.
- `preload/index.ts`: `setBrightness`/`getBrightness` 제거 (`index.d.ts` 는 `typeof api` 라 자동 반영).
- `main/index.ts`: `brightnessBin`, `BRIGHTNESS_CANDIDATES`, `resolveBrightnessBin()`,
  `set/get-brightness` IPC 핸들러, `whenReady` 의 resolve 호출까지 삭제. 그에 따라 미사용이 된
  `exec`/`promisify`/`execAsync`/`access`/`constants` import 정리. 볼륨(`loudness`)은 유지.

### B. 볼륨 단일화 + 타일 확대
- `App.tsx`: `GAZEBAR_ITEMS = [{ id: 'volume', ... }]` 단일. 단일 항목이면 `computeGeometry` 가 자동 reflow.
- `GazeBar.tsx`: `DOCK` `tile 56→64`, `slot 120→240`.
- `styles.css`: `.gazebar-icon 26→30`, `.gazebar-value 10→16`.

### C. 테스트 모드 + CSV 수집 (`⌘⇧T`)
- 신규 `perception/test-session.ts`(pure): `RawSample`/`TrialSummary`/`TestSession` 타입,
  `computeReimmersion()`(중앙 영역 연속 체류 proxy), `centralRegionPx()`,
  `toTrialSummaryCSV()`/`toRawSamplesCSV()`(UTF-8 BOM). `eval-stats.ts` 의 CSV/BOM 패턴 답습.
- 신규 `components/TestMode.tsx`: 단일 RAF FSM `wait→adjust→reimmersion`, 두 조건
  (gaze / 외장 다이얼 baseline=Space 완료), intro/running/complete 3화면, 요약+raw CSV 저장.
- 통합: `App.tsx`(상태/리스너/click-through 해제/렌더), `preload`(`onToggleTestMode`),
  `main`(`⌘⇧T` → `glanceshift:toggle-test-mode`). 저장은 기존 `saveEvalCsv`/`revealEvalFolder` 재사용.
- 수집:
  - 요약 CSV(한 trial=한 행): target/start/final/abs_error, prompt 시각, 첫 진입까지·조절·총시간,
    모드 진입 횟수, 재몰입 ms·경로 px·성공여부.
  - raw CSV(매 프레임): phase, t, gaze x/y(-1=미검출), head_roll, live_vol, os_vol, selected, edge_state.
  - 저장 위치: `userData/eval-logs/test_summary_*.csv`, `test_raw_*.csv`.

### D. head-tracker 자동 복구 (`face-landmarker.ts`)
- `waitForFaceMesh(15s)` 제거 → 비블로킹 `start()`, 즉시 `loop()`.
- `loop()`: 얼굴 획득/재획득 시 `ready` 승격, 상실 시 `waiting-video` 강등(자동 복구 대기).
- 장기 미검출 시 8초 간격 watchdog 경고(`FACE_WARN_INTERVAL_MS`), `stop()` 에서 타이머 정리.
- 효과: 참가자가 늦게 앉거나 일시적으로 얼굴을 놓쳐도 세션 머리 입력이 영구 죽지 않음.

## 검증
- `npm run typecheck`(node+web) 통과, `npm run build` 통과.
- `grep -rni brightness src/` → 0 (코드).
- 런타임 확인(권장): GazeBar 볼륨 단일 타일 확대 표시 / `⌘⇧T` intro·gaze·baseline 흐름 /
  complete 에서 요약·raw CSV 저장 후 "폴더 열기" 로 Excel 한글 확인 / 자동 복구.

## 관련
- 재적용 출처 커밋: `b94eb2c`, `e590eee` (revert: `4edc337`).
- 함께 갱신: `docs/ARCHITECTURE.md`(단축키·컴포넌트·OS 브리지), 루트 `CLAUDE.md`(아키텍처 핵심·단축키).
