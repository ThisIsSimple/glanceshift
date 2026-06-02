# 2026-06-02 — 죽은 코드 정리 · 단일 snapping 모드 · 조이스틱 슬라이더

브랜치: `refactor/dead-code-cleanup` (base `main`).

## 배경

중간 발표 이후 "테스트/비교"에서 "프로덕트"로 방향 전환. 비교용 모드를 걷어내고
snapping 을 단일 인터랙션으로 심화. 코드 점검에서 발견한 죽은 코드/중복도 함께 정리.

## 변경 내역 (커밋 순)

1. **`fde8861` refactor: remove dead code + railThickness util**
   - 제거: `matrixToEuler`/`RAD2DEG`, `valueToPercent`, `pause`/`resume`/`tuneFilter`,
     `OneEuro2D.tune`, `IntentTracker.snapshot`, `EdgeDetector.lastPoint`,
     매 프레임 낭비되던 `irisDebug`/`getIrisDebugPoints`.
   - `perception/geometry.ts` 신설 → `railThickness` 3중 복제 통합.

2. **`33b2063` feat(slider): yaw-gated intent detection**
   - `SliderIntentMapper` 도입(당시엔 절대 매핑 + yaw hold). 이후 #4 에서 조이스틱으로 대체.

3. **`01a0c97` refactor: collapse to single snapping mode**
   - `filtered`/`raw` 모드 + `ModeLabel`/`EDGE_MODE_PROFILES`/`EdgeDetectorConfig`/classic FSM
     /`classifyEdge` 제거. `EdgeDetector` 가 `SnapConfig` 직접 수신.
   - `EdgeEvent`/`EdgeSnapshot` 에서 mode 필드 제거.
   - App: `edgeMode` state·전환 effect·raw gaze 분기·`⌘⇧1/2/3` 구독 제거.
   - main: `⌘⇧1/2/3` 단축키 제거. preload: `onSetEdgeMode` 제거.
   - EdgeZones/GazeBar/GazeDot/DebugHud/Evaluation: 모드 분기 props·UI 제거.

4. **`89fcca2` feat(slider): relative joystick head-tilt control**
   - 절대 위치 매핑(왼쪽=0/중앙=50/오른쪽=100) → **상대 rate control**.
   - engage 시점 roll = neutral, 기운 정도에 비례해 지속 증감(오른쪽=증가/왼쪽=감소),
     데드존 3°, 풀 틸트 22°에서 0→100% ~1.2초, yaw 둘러봄 게이트, dt 100ms clamp.
   - 시작 값은 control 의 현재 저장값에서 출발(상대).

5. **`b8e20ac` feat(debug): joystick rate/active rows in DebugHud**
   - engage 중 `joystick(active/idle)`, `rate(±%/s)`, `yaw rate(°/s)` 표시 → 튜닝 지원.

## 검증

- `npm run typecheck` (node+web) 통과, `npm run build` 통과.
- 모드 1/2 잔존 참조 0건 확인.

## 후속 / 열린 항목

- 조이스틱 파라미터 실측 튜닝(`DEFAULT_SLIDER_CONFIG`): neutral bias·속도·yaw 게이트 임계.
- `DebugHud` 의 `FSM state: idle (Phase 6)` 는 stale placeholder — 정리 대상.
- `refactor/dead-code-cleanup` → `main` 병합 시점 결정(PR).
