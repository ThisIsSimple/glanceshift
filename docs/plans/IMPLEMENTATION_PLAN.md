# GlanceShift 구현 계획서

> Hard interruption → Soft interruption 변환을 실제 동작하는 데스크탑 오버레이로 구현하기 위한 단계별 설계 문서.

---

## 0. 결정사항 요약

| 항목 | 결정 | 보고서 근거 |
| --- | --- | --- |
| 플랫폼 | **Electron 데스크탑 오버레이** | §5.2 — 별도 하드웨어 없이 일반 노트북·웹캠 환경에서 즉시 배포 |
| 시선 추적 | **WebGazer.js (1차)** → MediaPipe Iris(2차) | §5.2 — WebGazer ~4° 정확도 (Papoutsaki et al., 2016) |
| 머리 자세 추정 | **MediaPipe Face Landmarker** (yaw/pitch/roll) | §3.3 Modes — Sidenmark & Gellersen (2019), BimodalGaze (2020) |
| 데모 명령 | **연속 슬라이더 (볼륨 · 밝기)** | §3.3 Mappings — Radi-Eye의 Look & Cross 차용 |
| 평가 축 | **Interruption resilience** (속도/정확도 아님) | §5.1 — 비대칭적 회복 탄력성 |
| 인터랙션 예산 | **≤ 1 초** (시각 buffer 한계 내) | §4.1 — Furneaux & Land (1999), Salvucci et al. (2009) |

---

## 1. 시스템 아키텍처

보고서 §3.3 Modes의 4-state FSM을 그대로 코드 레이어로 옮긴다.

```
┌──────────────────────────────────────────────────────────────────┐
│                       Electron Main Process                       │
│   · Transparent click-through overlay window (always-on-top)      │
│   · OS volume / brightness IPC (nut-js / loudness / brightness)   │
│   · Native module bridge ↔ Renderer                              │
└────────────────────────────────────▲─────────────────────────────┘
                                     │ IPC (state, action)
┌────────────────────────────────────▼─────────────────────────────┐
│                        Renderer (BrowserWindow)                   │
│                                                                   │
│   ┌────────────┐   ┌────────────┐   ┌──────────────────────────┐ │
│   │  Webcam    │──►│  Perception │──►│      FSM Controller      │ │
│   │ (getUserMd)│   │  Pipeline   │   │  Idle→Gaze→Tilt→Fire    │ │
│   └────────────┘   └────────────┘   └────────────┬─────────────┘ │
│                          │                       │               │
│              ┌───────────┴────────────┐          ▼               │
│              │  WebGazer (gaze x,y)   │   ┌──────────────┐       │
│              │  MediaPipe (yaw,pitch, │   │  GazeBar UI   │       │
│              │           roll)        │   │  (React + SVG)│       │
│              │  One-Euro Filter       │   └──────────────┘       │
│              └────────────────────────┘                          │
└──────────────────────────────────────────────────────────────────┘
```

핵심 원칙: **인지(Perception) → 결정(FSM) → 표시(UI) → 실행(OS bridge)** 의 단방향 데이터 흐름. 각 레이어를 독립 모듈로 분리해서 시선 알고리즘이나 UI를 교체해도 FSM 로직은 유지된다.

---

## 2. 기술 스택

| 레이어 | 선택 | 대안 / 비고 |
| --- | --- | --- |
| 앱 셸 | Electron 32 + Vite | TS 5.x. `electron-vite` 템플릿 |
| 언어 | TypeScript | 타입 안전성. FSM 상태 타입 강제 |
| UI | React 18 + Tailwind (또는 vanilla SVG) | Cool-media 원칙상 의도적으로 미니멀 |
| 시선 추적 | **WebGazer.js** | 라벨링 없는 빠른 부트스트랩. 한계 시 MediaPipe Iris로 교체 |
| 얼굴/머리 | **MediaPipe Tasks-Vision** (`FaceLandmarker`) | 468-point landmark + transformation matrix (yaw/pitch/roll) |
| 스무딩 필터 | **One Euro Filter** | Casiez et al. (2012). 저지연 + jitter 억제 |
| OS 볼륨 | `loudness` (npm) — Win/Mac/Linux 추상화 | macOS 백업: `osascript` |
| OS 밝기 | `brightness` (npm, macOS) / `monitorcontrol` (Windows) | 보조적 |
| 상태 머신 | **XState** (또는 작은 수제 reducer) | 시각화 도구가 디버깅에 큰 도움 |
| 로깅 | `electron-log` + custom CSV | 평가용 이벤트 로깅 필수 |
| 테스트 | Vitest (유닛) + Playwright-electron (E2E) | 시선·머리 입력은 모킹 |

---

## 3. 단계별 구현 (Phase 0 → 7)

### Phase 0 — 프로젝트 부트스트랩 (반나절)

- `electron-vite` + React + TS 템플릿 생성
- 투명 + click-through + always-on-top 윈도우 설정
  - `transparent: true, frame: false, alwaysOnTop: true, hasShadow: false`
  - `setIgnoreMouseEvents(true, { forward: true })` — GazeBar 호출 전에는 마우스 통과
- 디버그용 카메라 미리보기 토글 (Cmd/Ctrl+Shift+D)
- 결과물: 빈 투명 풀스크린 위에 디버그 HUD만 표시

### Phase 1 — Perception: 시선 추적 (1–2일)

- `getUserMedia` 권한 흐름 + 카메라 선택 UI
- WebGazer.js 통합
  - `.setGazeListener((data, ts) => …)` 으로 raw (x, y) 수신
  - 50–60 Hz 다운샘플링
- **캘리브레이션 화면 (9-point)**
  - 보고서 §5.2의 WebGazer ~4° 정확도를 실측 확인
  - 캘리브 결과를 localStorage에 저장, 다음 실행 시 단축
- 시선 좌표에 **One Euro Filter** 적용
  - `freq=60, mincutoff=1.0, beta=0.007, dcutoff=1.0` 부터 시작해 튜닝
- 결과물: 실시간 시선 도트가 화면을 따라다님 (debug overlay)

### Phase 2 — Perception: 머리 자세 (1일)

- MediaPipe `FaceLandmarker` 로드 (WASM, `runningMode: "VIDEO"`)
- `facialTransformationMatrixes` 옵션 켜고 4×4 행렬 → Euler angles (yaw, pitch, **roll**)
  - roll 이 곁눈질 + 갸웃의 핵심 신호
- One Euro Filter 별도 인스턴스로 각도 스무딩
- 데드존(±2°) 설정으로 자연스러운 머리 흔들림 무시
- 결과물: 디버그 HUD에 roll/pitch/yaw 실시간 표시

### Phase 3 — Edge Gaze Detection (1일)

- 화면을 5 영역으로 분할: LEFT / RIGHT / TOP / BOTTOM / CENTER
- 가장자리 폭: 화면 단축의 **8%** (기본값, 캘리브 정확도에 따라 6–12% 조정 가능)
- **Dwell + Hysteresis** 로 진입/이탈 판정
  - 진입 임계: 가장자리 영역 안에 연속 **150 ms** 머무를 때 트리거
  - 이탈 임계: 가장자리 + 안쪽 마진(영역 폭의 50%) 밖으로 벗어나면 해제
- 결과물: 영역 진입/이탈 이벤트 콘솔 로그

### Phase 4 — GazeBar UI (1–2일)

핵심 원칙: McLuhan **cool 매체** + Iqbal & Horvitz의 **visual occlusion cost 최소화**.

- 가장자리 도킹 컴포넌트 (`<GazeBar edge="right">`)
- 입장 애니메이션: **180 ms** fade + 10 px slide (인지 비용 최소)
- 너비: 화면 단축의 5–6%, 길이: 60% (적당히 여유)
- 배경: 반투명 다크 (opacity 0.55) + backdrop-blur
- 슬라이더 후보(연속 명령) 항목:
  - 🔊 볼륨
  - ☀️ 밝기
  - (추후: 채팅 응답, 미니맵 줌 등)
- **시선 호버 highlight**: 시선의 세로 좌표가 항목 중심 ±r 안에 들어오면 강조
- 결과물: 시선이 오른쪽 가장자리에 닿으면 GazeBar 출현 → 항목 호버 가능

### Phase 5 — Head Tilt Confirmation + 연속 슬라이더 (2일)

이번 단계가 보고서의 핵심 기여(Hard→Soft 변환)를 실제로 체감하는 곳.

- **Discrete vs Continuous 분기**:
  - Discrete (메뉴 진입): roll 절댓값 > **12°** 이고 **180 ms** 유지 시 확정
  - Continuous (슬라이더): roll 각도를 슬라이더 값에 선형 매핑
    - `value = clamp((roll + 25°) / 50°, 0, 1)` — 좌측 -25° → 0%, 우측 +25° → 100%
    - Radi-Eye Look & Cross 스타일: 슬라이더 위로 시선이 머문 동안만 활성
- **자연 vs 의도 구분** (Sidenmark & Gellersen 2019, BimodalGaze):
  - roll 변화율이 **deg/s** 임계 이상이고, 단순 좌우 둘러보기(yaw 동반)가 아닌 경우만 의도로 판단
  - heuristic: `|dRoll/dt| > 30°/s AND |dYaw/dt| < 20°/s`
- 시각 피드백: 슬라이더 thumb 위치 + 작은 수치 (정량 피드백은 cool 매체 원칙상 최소)
- 결과물: 머리만 기울여서 볼륨/밝기를 실시간 조정 가능

### Phase 6 — FSM Controller (1일)

XState 머신 정의:

```ts
type GazeShiftEvent =
  | { type: 'GAZE_ENTER_EDGE'; edge: Edge }
  | { type: 'GAZE_EXIT_EDGE' }
  | { type: 'TILT_START'; roll: number }
  | { type: 'TILT_UPDATE'; roll: number }
  | { type: 'TILT_RELEASE' }
  | { type: 'BUDGET_EXCEEDED' };  // 1초 timeout

states: {
  idle:        { on: { GAZE_ENTER_EDGE: 'gazeDetected' } },
  gazeDetected:{ on: { GAZE_EXIT_EDGE:  'idle',
                       TILT_START:      'headTilting',
                       BUDGET_EXCEEDED: 'idle' } },
  headTilting: { on: { TILT_RELEASE:    'commandFired',
                       GAZE_EXIT_EDGE:  'idle' } },
  commandFired:{ entry: 'executeAction', after: { 200: 'idle' } }
}
```

- 진입 시점에 **1초 budget 타이머** 시작 (보고서 §3.3 — 시각 buffer 한계)
- 모든 전이에 콜백 훅 → CSV 로깅
- 결과물: XState 시각화 도구에서 인터랙션 trace 재생 가능

### Phase 7 — OS Action Bridge (반나절)

- Main process에 IPC 핸들러: `glanceshift:setVolume`, `glanceshift:setBrightness`
- macOS: `loudness` 패키지 (`require('loudness').setVolume(0–100)`)
- Windows: 동일 패키지가 추상화 제공
- 밝기는 OS 권한 이슈가 있어 첫 데모는 볼륨 위주, 밝기는 best-effort

### Phase 8 — 평가 시나리오 + 데모 (1–2일)

- 백그라운드 주작업 윈도우: 간단한 Phaser 미니게임 또는 YouTube 영상
- **A/B 비교 모드**:
  - (A) GlanceShift로 볼륨 조절
  - (B) 단축키/마우스로 볼륨 조절 — control loop 단절 측정
- 로깅 항목 (CSV):
  - 트리거 시각, FSM 상태 천이 시각, 총 인터랙션 시간
  - 보조 명령 동안 주작업 입력 공백 (keyboard idle gap)
  - 취소율 / 오트리거율
- 결과물: 1분짜리 데모 영상 + 측정 CSV 1개

---

## 4. 디자인 결정 → 보고서 매핑 (검증 체크리스트)

구현하면서 "왜 이렇게 했는가"를 보고서로 역추적할 수 있어야 한다.

| 코드 결정 | 보고서 근거 |
| --- | --- |
| 시선 dwell 150 ms | §4.1 Salvucci et al. — 수백 ms는 절차적 자원에 흡수 |
| 전체 budget ≤ 1초 | §1.2 + §4.1 Land & Furneaux — oculomotor buffer ≈ 1s |
| Roll 임계 12°, dwell 180ms | §3.3 Modes — BimodalGaze 자연 vs 의도 구분 |
| Edge 폭 8% / 슬림한 UI | §3.2 Feel — Iqbal & Horvitz의 visual occlusion cost |
| 햅틱·소리 피드백 없음 | §3.2 Feel — McLuhan cool 매체 |
| 시선=영역 지정, 머리=확정 | §3.2 Do — Zhai et al. (1999) MAGIC Pointing |
| 슬라이더는 roll 연속 매핑 | §3.3 Mappings — Radi-Eye Look & Cross |
| 시선 ≥ 1초 머무름 → 강제 해제 | §4.5 Tsimhoni & Green — 시야 차단 허용시간 |

---

## 5. 디렉토리 구조 (제안)

```
glanceshift/
├── electron/
│   ├── main.ts                 # 윈도우·IPC·트레이
│   ├── overlay-window.ts       # transparent click-through 설정
│   └── os-bridge/
│       ├── volume.ts
│       └── brightness.ts
├── src/
│   ├── perception/
│   │   ├── webgazer.ts         # 시선 추적 래퍼
│   │   ├── face-landmarker.ts  # MediaPipe 래퍼
│   │   ├── one-euro.ts         # One Euro Filter
│   │   └── types.ts
│   ├── fsm/
│   │   ├── machine.ts          # XState 정의
│   │   └── budget.ts           # 1s timeout 유틸
│   ├── ui/
│   │   ├── GazeBar.tsx
│   │   ├── Slider.tsx
│   │   ├── DebugHud.tsx
│   │   └── CalibrationScreen.tsx
│   ├── edge-detector.ts        # 영역 분할 + hysteresis
│   ├── logger.ts               # CSV 이벤트 로깅
│   └── app.tsx
├── docs/
│   ├── IMPLEMENTATION_PLAN.md  # ← 이 문서
│   └── eval-protocol.md        # 평가 시나리오
└── package.json
```

---

## 6. 리스크 & 완화책

| 리스크 | 영향 | 완화 |
| --- | --- | --- |
| WebGazer 정확도가 4°보다 나쁨 (조명·웹캠 품질) | edge 영역 오트리거/미트리거 | (a) edge 폭을 동적으로 넓힘 (b) MediaPipe Iris 직접 추적으로 교체 (c) 캘리브 재유도 |
| Midas Touch — 의도 없이 가장자리를 봄 (§4.3 Jacob 1990) | 잦은 GazeBar 출현으로 cool 매체 원칙 훼손 | 150 ms dwell + 출현 후에도 머리 입력 없으면 1초 내 자동 소멸 |
| 자연스러운 고개 끄덕임을 tilt로 오인 | 명령 오발화 | yaw 동반 여부와 각속도 기반 필터 (Phase 5) |
| 60 Hz 미만 카메라에서 jitter 폭증 | 머리 각도 변동성 | One Euro Filter `beta` 자동 조정 |
| Electron transparent overlay가 일부 게임(전체화면 exclusive)에서 가려짐 | 핵심 데모 시나리오 손상 | 데모 환경은 borderless windowed로 제한 명시 |
| 안구 피로 (§4.4 Hirzle et al. 2020) | 장시간 사용 시 사용자 부담 | dwell 짧게, edge 영역 위치 다양화, 사용 시간 추적 후 경고 |

---

## 7. 마일스톤 (제안 일정)

| 주차 | 산출물 |
| --- | --- |
| 1주차 | Phase 0–1: 투명 오버레이 + 시선 raw 데이터 + 캘리브레이션 |
| 2주차 | Phase 2–3: 머리 자세 + edge detection 통합 |
| 3주차 | Phase 4–5: GazeBar UI + 연속 슬라이더 (볼륨/밝기 작동) |
| 4주차 | Phase 6–8: FSM 정리 + OS bridge + 평가 데모 영상 |

---

## 8. 다음 액션 (Action Items)

1. `electron-vite` 템플릿으로 빈 프로젝트 생성 — 투명 윈도우 동작 확인
2. WebGazer.js + MediaPipe 의존성 설치 및 카메라 권한 흐름 검증
3. 캘리브레이션 화면 9-point 1차 구현 → 실측 정확도 측정 (이 수치가 edge 폭의 근거가 됨)
4. One Euro Filter 모듈 작성 및 단위 테스트
5. FSM 다이어그램을 XState Studio 에서 그려 팀 리뷰

— 이 단계까지 끝나면 **§3.3 Modes의 4-state FSM 이 실제로 화면 위에서 돌아가는 최소 데모** 가 완성됩니다.
