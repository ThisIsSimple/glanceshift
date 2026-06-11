# GlanceShift — Architecture (현재 상태)

> **이 문서가 현재 구현의 권위 있는 출처(source of truth)다.**
> `plans/` 의 문서들은 historical design spec 이며, 본 문서와 충돌하면 본 문서가 우선한다.
> 마지막 갱신: 2026-06-02.

---

## 1. 한 줄 요약

화면 가장자리에 최소로 떠오르는 데스크탑 오버레이. **시선**으로 가장자리 컨트롤을
coarse 하게 지목하고(designation), **머리 기울임**으로 값을 조절(confirmation)한다.
보고서 §1.2 의 "시선 = coarse target designation, 머리 = confirmation" 설계의 직접 구현.

## 2. 프로세스 구조 (Electron)

- **main** (`app/src/main/index.ts`) — 투명·프레임 없음·항상 위 오버레이 윈도우, 기본
  click-through, 전역 단축키, OS 브리지(볼륨), 카메라 권한, 평가/테스트 CSV 저장.
- **preload** (`app/src/preload/index.ts`) — `contextBridge` 로 좁은 IPC API(`window.glanceshift`) 노출.
- **renderer** (`app/src/renderer/src/**`) — React 오버레이 UI + perception 파이프라인.

## 3. 입력 채널

| 채널 | 소스 | 필터 | 용도 |
| --- | --- | --- | --- |
| 시선(gaze) | WebGazer (face mesh 회귀) | OneEuro `{mincutoff 1.0, beta 0.007}` | 가장자리 의도 감지 |
| 머리(head) | WebGazer face mesh landmark 에서 직접 yaw/pitch/roll 계산 | OneEuro `{mincutoff 1.5, beta 0.05}` | roll = 값 조절(조이스틱) |

> 머리 추정은 `@mediapipe/tasks-vision` 을 쓰지 않고 **WebGazer 가 이미 뽑은 landmark 를 재사용**한다
> (두 Emscripten 런타임 충돌 회피 + 효율). `face-landmarker.ts` 참고.

## 4. 인터랙션 흐름 (단일 모드 = snapping)

```
gaze ──▶ IntentTracker(변별 intent score 누적/감쇠)
            │ score ≥ intentThreshold
            ▼
        Rail FSM: rail_locked ── enter ──▶ GazeBar 가 해당 변에 등장
            │  (lock 중 시선 perpendicular 는 rail 위로 강제, along-edge 만 cursor 반영)
            ▼
        항목 위 1초 dwell(SELECT_DWELL_MS) ──▶ select(commit)
            │
            ▼
        latch(LATCH_MS=3초): 시선이 떠나도 head roll 로 값 조절 가능
            │  head roll(조이스틱) ──▶ liveSliderValue
            ▼
        선택 전환/해제 시 commit ──▶ OS 브리지(setVolume/setBrightness)
```

- **모드는 하나뿐이다.** 과거의 `filtered`/`raw` 비교 모드와 `⌘⇧1/2/3` 전환은 제거됐다.
- GazeBar 항목 hover 는 **deterministic 양자화**(가장 가까운 항목, 반경 제한 없음) — along-edge
  정확도가 떨어져도 선택이 결정적.

## 5. 슬라이더 = 상대 조이스틱 (rate control)

`slider-mapper.ts` 의 `SliderIntentMapper`.

- engage 시작 시점의 head roll 을 **neutral(0)** 로 캡처. 시작 값은 그 control 의 현재 저장값.
- neutral 기준 기운 정도에 비례해 값을 **지속 증감**(위치 매핑 아님):
  - **오른쪽 어깨로 기울임 → 증가**, **왼쪽 → 감소**
  - neutral ± `neutralDeadzoneDeg`(3°) 안에서는 **정지**
  - `fullTiltDeg`(22°)에서 최대 속도 → 0→100% 약 **1.2초** (`maxRatePerSec ≈ 0.83 /s`)
- **의도 판별**: yaw 각속도가 `lookAroundYawRate`(30°/s) 이상이면 "둘러봄"으로 보고 적분 정지.
- `dt` 100ms clamp 로 얼굴 일시 손실 후 재개 시 값 점프 방지.

## 6. 핵심 모듈 (`app/src/renderer/src/perception/`)

| 파일 | 책임 |
| --- | --- |
| `webgazer.ts` | WebGazer 래퍼 — UI 오버레이 off, OneEuro 스무딩, stale watchdog(200ms→(-1,-1) emit), 캘리브 클릭 입력 |
| `face-landmarker.ts` | landmark → head pose(yaw/pitch/roll) + NIC-EC iris feature, OneEuro 필터 |
| `one-euro.ts` | OneEuro 필터 (1D `OneEuroFilter`, 2D `OneEuro2D`) |
| `intent-score.ts` | `IntentTracker` — 변별 intent score, zone dwell, lateral/approach velocity. `DEFAULT_SNAP_CONFIG` |
| `edge-detector.ts` | `EdgeDetector` — Rail FSM(idle→building_intent→rail_locked), rail 투영, `EdgeSnapshot` |
| `slider-mapper.ts` | `SliderIntentMapper` — 조이스틱 rate control. `DEFAULT_SLIDER_CONFIG` |
| `geometry.ts` | `DOCK` 레이아웃 상수 + `gazeBarCenterOffset()` — GazeBar/rail/EdgeZones 공유 (단일 출처). rail 은 독 중심선에 맞춤 |
| `nic-ec.ts` | iris center / eye corner 정규화 벡터 (캘리브 품질 게이팅용) |
| `eval-stats.ts` | 평가 통계(mean/std/px→deg) + CSV 직렬화 |
| `euler.ts` | `HeadPose` 타입만 (행렬→오일러 변환 코드는 제거됨) |

### 컴포넌트 (`app/src/renderer/src/components/`)
`App.tsx`(상태 오케스트레이션) · `GazeBar` · `GazeDot`(dwell ring 포함) · `EdgeZones`(디버그 시각화)
· `DebugHud`(⌘⇧D, 조이스틱 rate/active 행 포함) · `Calibration`(3-phase wizard) · `Evaluation`(gaze/trigger)
· `TestMode`(⌘⇧T, 볼륨 조절 사용자 실험 + CSV 수집 — 영화 시청 중 볼륨 0 드롭 → 목표% 복구 →
  시선 이탈/복귀 측정. `perception/test-session.ts` 의 pure 함수에 위임).

## 7. 단축키 (전역, `main/index.ts`)

| 키 | 동작 |
| --- | --- |
| `⌘⇧D` | 디버그 HUD 토글 |
| `⌘⇧M` | click-through 토글 |
| `⌘⇧K` | 캘리브레이션 wizard |
| `⌘⇧E` | 평가 모드 |
| `⌘⇧T` | 테스트 모드(볼륨 조절 실험 + CSV 수집) |
| `⌘⇧I` | DevTools(detach) |
| `⌘⇧Q` | 종료 |

> `⌘⇧1/2/3` (모드 전환) 은 **제거됨**.

## 8. OS 브리지

- 볼륨: `loudness` 패키지 (macOS 내부적으로 osascript).
- 밝기 조절은 **제거됨** (볼륨 단일 실험을 위해 GazeBar 항목·renderer 분기·main 의 `brightness` CLI 브리지까지 모두 삭제).
- 평가/테스트 CSV: `userData/eval-logs/*.csv` (테스트 모드는 `test_summary_*`, `test_raw_*`).

## 9. 주요 상수

- `App.tsx`: `SELECT_DWELL_MS = 1000`, `LATCH_MS = 3000`
- `DEFAULT_SNAP_CONFIG` (`intent-score.ts`): `intentZoneFrac 0.18`, `lockZoneFrac 0.24`,
  `intentThreshold 150`, `scoreMax 250`, `decayPerMs 0.5`, `dwellBonusAfterMs 200`,
  `dwellBonusRate 0.5`, `lateralVelocityPxs 500`, `lateralPenaltyRate 0.8`, `exitGraceMs 250`
- `DEFAULT_SLIDER_CONFIG` (`slider-mapper.ts`): `neutralDeadzoneDeg 3`, `fullTiltDeg 22`,
  `maxRatePerSec 1/1.2`, `lookAroundYawRate 30`, `yawRateSmoothing 0.35`

## 10. 빌드 / 검증 (모두 `app/` 에서)

```bash
npm run dev          # electron-vite dev (HMR)
npm run typecheck    # tsc (node + web) — 변경 후 필수 게이트
npm run build        # 프로덕션 번들
```

## 11. plans/ 문서와의 차이 (요약)

| plan 문서 | 현재 상태 |
| --- | --- |
| `SNAPPING_MODE_PLAN.md` | rail/intent 알고리즘은 유효. 3-mode 재정의·절대 슬라이더는 historical |
| `EVALUATION_PROTOCOL.md` | 절차는 유효하나 "3 mode × 3 pose" 매트릭스·`⌘⇧1/2/3` 는 무효(단일 모드) |
| `IMPLEMENTATION_PLAN.md` | 단계별 phase 설계 — 대부분 반영됨(historical) |
| `EDGE_LOCK_PLAN.md` | rail/자석 snap 아이디어 — snapping 으로 흡수됨 |
| `GAZE_ACCURACY_PLAN.md` | 캘리브/정확도 계획 — 현재도 유효 |
