# GlanceShift

> Hard interruption(손 차용)을 Soft interruption(시선·머리 차용) 으로 변환하는 인터랙션 오버레이.

학기 보고서 *[SWCON312] Term Project — GlanceShift* 의 실제 구현물입니다. 설계 근거와 단계별 계획은 상위 폴더의 다음 문서들을 참고하세요:

- `IMPLEMENTATION_PLAN.md` — 전체 phase 계획 (Phase 0–8)
- `GAZE_ACCURACY_PLAN.md` — 시선 정확도 개선 연구·계획 (NIC-EC, head pose conditioning)
- `EDGE_LOCK_PLAN.md` — 가장자리 인식 강건화 (legacy: sticky / magnetic). 현재 코드는 SNAPPING 으로 대체됨
- `SNAPPING_MODE_PLAN.md` — **현재 3-mode (filtered / raw / snapping) 의 설계서**. IntentTracker + RailFSM 의 알고리즘 원천
- `EVALUATION_PROTOCOL.md` — **측정·시연 절차 (3 mode × 3 pose 매트릭스 + trigger eval)**

---

## 빠른 시작

```bash
cd app
npm install          # postinstall 이 webgazer.js + mediapipe 자산을 자동 준비
npm run dev
```

처음 실행 시 macOS 가 카메라 권한 다이얼로그를 띄웁니다. 모두 허용해 주세요. 권한이 막혀 있으면 HUD 의 `tracker` 가 `error` 가 됩니다.

(선택) 머리 갸웃으로 디스플레이 밝기까지 조작하려면:

```bash
brew install brightness
```

---

## 단축키

| 단축키 | 동작 |
| --- | --- |
| `⌘⇧D` | 디버그 HUD 토글 (좌상단 패널 + 시선 도트 + edge zones) |
| `⌘⇧M` | 마우스 click-through 토글 |
| `⌘⇧K` | 시선 캘리브레이션 (3-phase wizard: 정면 → 자세 변경 → 가장자리 보강) |
| `⌘⇧E` | 5×5 정확도 평가 / trigger 평가 + CSV 저장 |
| `⌘⇧1` | Edge Mode: **filtered** (OneEuro-filtered gaze + classic dwell FSM. baseline) |
| `⌘⇧2` | Edge Mode: **raw** (unfiltered gaze + classic dwell FSM. 필터 기여도 control) |
| `⌘⇧3` | Edge Mode: **snapping** (Intent score + RailFSM + UI snap. 의도/위치 분리) |
| `⌘⇧I` | DevTools (detached) |
| `⌘⇧Q` | 종료 |

캘리브/평가 중에는 자동으로 click-through 가 꺼지고, 완료/ESC 시 다시 켜집니다.

---

## 한 사이클 인터랙션 흐름

```
시선 → 가장자리 진입 (dwell ~150ms, mode 마다 조정)
     → GazeBar slide-in (180ms fade + 10px slide)
     → 항목 hover (시선 위치)
     → 머리 갸웃 (roll ±25°)
     → 슬라이더 값 실시간 변화 + OS 볼륨/밝기 실시간 반영
     → 시선 떼면 commit (콘솔에 [slider] COMMIT volume = 73%)
```

---

## 진행 상태

- [x] Phase 0 — 부트스트랩 + 투명 click-through 오버레이
- [x] Phase 1 — WebGazer 시선 추적 + One Euro Filter + 캘리브
- [x] Phase 2 — face mesh landmarks 에서 head pose (yaw/pitch/roll)
- [x] Phase 3 — Edge gaze detection (dwell + hysteresis)
- [x] Phase 3.5a — Iris landmarks (478) + NIC-EC vector
- [x] Phase 3.5+ — 3-phase calibration wizard (multi-pose + quality gating + edge boost)
- [x] Phase 4 — GazeBar UI (edge-docked, gaze hover)
- [x] Phase 5 — Head Tilt 슬라이더 (Look & Cross commit)
- [x] Phase 7 — OS bridge (loudness 볼륨, brightness CLI 밝기)
- [x] Phase 8 — 5×5 grid 정확도 평가 + CSV 저장
- [x] Edge Lock (legacy) — 3-mode (classic / sticky / magnetic) → SNAPPING 으로 대체
- [x] Snapping Mode — 3-mode (filtered / raw / snapping). Intent score + RailFSM + cursor rail-lock
- [ ] Phase 6 — XState FSM 통합 (선택, 코드 위생)
- [ ] Phase 3.5b — NIC-EC 다항식 백본 (학기 시한 외, future work)

---

## 🧪 테스트 & 평가 워크플로

`EVALUATION_PROTOCOL.md` 에 상세 절차가 있고, 여기엔 빠른 실행 요약만.

### 1) 기본 동작 확인

```bash
npm run dev
```

1. 좌상단 HUD 의 `gaze tracker` 가 `loading → ready` (~5–10초)
2. `head tracker` 가 `ready`, `landmarks: 478 (iris ✓)` 초록색
3. `iris NIC-EC` 가 작은 소수점 숫자로 흐름
4. `⌘⇧K` 로 캘리브 — 3 phase 완주 (~1.5분)
5. 캘리브 후 시선 도트가 응시 지점 근처로 따라옴

### 2) GazeBar 인터랙션 한 사이클

1. 시선을 화면 **오른쪽 가장자리** 로 천천히 → 150ms 후 GazeBar slide-in
2. 시선을 🔊 volume 항목 위에 머무름 → 항목 하이라이트
3. 머리를 오른쪽 어깨로 천천히 갸웃 → **macOS 볼륨이 실시간 변경** (메뉴바 인디케이터 + 청각 둘 다 확인)
4. 시선을 GazeBar 밖으로 → fade-out, 콘솔에 `[slider] COMMIT volume = 73%`

### 3) Edge Mode 3-way 비교

`⌘⇧1` (filtered) ↔ `⌘⇧2` (raw) ↔ `⌘⇧3` (snapping) 로 전환하면서 같은 동작 반복.

- **filtered** : OneEuro-필터된 시선 + 좁은 8% band + 150ms dwell. baseline. 정확도 낮은 사용자는 trigger 자체가 불안정.
- **raw** : 동일 FSM 이지만 unfiltered 좌표 사용. **OneEuro 필터의 기여도** 를 측정하는 control. 시선 도트가 살짝 더 떨림.
- **snapping** : IntentTracker (intent score 누적) + RailFSM (lock 진입 후 cursor 를 1D rail 에 고정). HUD 에 `intent score 113 / 150`, `zone dwell`, `lateral v`, `approach v`, `rail cursor` 가 실시간 표시. Lock 중 perpendicular 시선이 떨려도 GazeBar 항목 hover 는 결정적.

### 4) 정량 측정 — 9-cell 매트릭스

3 mode × 3 자세 = 9 CSV 를 한 캘리브 후 연속 측정 (총 ~8 분):

```
⌘⇧1 → ⌘⇧E → 'gaze accuracy' → '정면 baseline' preset → 시작 → CSV 저장
⌘⇧1 → ⌘⇧E → 'gaze accuracy' → '좌/우 15° 회전'   → 시작 → CSV 저장
⌘⇧1 → ⌘⇧E → 'gaze accuracy' → '거리 +20cm'      → 시작 → CSV 저장
⌘⇧2 → 위 3개 반복   (raw — OneEuro 필터 제외, baseline 의 noise 측정)
⌘⇧3 → 위 3개 반복   (snapping — RailFSM 활성, 항목 hover 정확도는 평가의 의미 다름)
```

추가로 `trigger accuracy` 평가 (`⌘⇧E` → eval type 으로 선택) 가 mode 별 TSR / MTT / WER / FTR 측정 (보고서 §5.1 표 2). 평가 진입 시 화면에 `snapping__yaw-15deg` 같은 자동 condition 라벨이 표시되므로 헷갈릴 일 없음. CSV 는 `~/Library/Application Support/glanceshift/eval-logs/` 에 저장.

### 5) 결과 집계

```bash
npm run compare:evals -- --out ../EVAL_RESULTS.md
```

`EVAL_RESULTS.md` 가 프로젝트 루트에 생성. 9 condition × (mean error, max, std, sample count) 가 markdown 표로 정리되어 보고서 §5.1 에 그대로 복사 붙여 넣기 가능.

### 6) 시연 영상 (1분)

`EVALUATION_PROTOCOL.md` §3 참고. 핵심 컷:

- 0:00–0:10 — 사용자 키보드 작업 중 (hands busy)
- 0:10–0:25 — 기존 방식 (마우스로 메뉴바 클릭) 의 손 이동
- 0:25–0:50 — **GlanceShift** : 손은 그대로, 시선 가장자리 + 머리 갸웃 → 메뉴바 볼륨 변함
- 0:50–1:00 — 한 줄 정의 자막

촬영 전 `⌘⇧D` 로 HUD 끄고 (clean shot), `⌘⇧3` 로 snapping 모드 (가장 견고).

---

## 디렉토리 구조

```
app/
├── electron.vite.config.ts
├── scripts/
│   ├── copy-webgazer.mjs           # node_modules → public/ 동기화 + refineLandmarks patch
│   └── compare-evals.mjs           # eval-logs/ CSV 들 → markdown 표
├── src/
│   ├── main/index.ts               # 투명 오버레이 + globalShortcut + OS bridge IPC
│   ├── preload/index.ts            # contextBridge API
│   └── renderer/
│       ├── index.html              # CSP (WebGazer/TFjs/MediaPipe 호환)
│       ├── public/                  # postinstall 이 채움 (gitignored)
│       │   ├── webgazer.js
│       │   └── mediapipe/face_mesh/...
│       └── src/
│           ├── App.tsx
│           ├── components/
│           │   ├── DebugHud.tsx
│           │   ├── GazeDot.tsx
│           │   ├── EdgeZones.tsx
│           │   ├── Calibration.tsx       # 3-phase wizard
│           │   ├── GazeBar.tsx           # edge-docked sidebar
│           │   └── Evaluation.tsx        # 5×5 grid + CSV
│           ├── perception/
│           │   ├── one-euro.ts           # Casiez et al. (2012)
│           │   ├── webgazer.ts           # WebGazer 래퍼
│           │   ├── face-landmarker.ts    # head pose + iris feature
│           │   ├── euler.ts              # transformation matrix → Euler
│           │   ├── nic-ec.ts             # iris vector (Sun et al. 2016)
│           │   ├── intent-score.ts       # IntentTracker (snapping mode 의 의도 감지)
│           │   ├── edge-detector.ts      # 3-mode FSM (filtered/raw classic + snapping RailFSM)
│           │   ├── slider-mapper.ts      # roll → 0..1
│           │   └── eval-stats.ts         # 평가 통계 + CSV 직렬화
│           └── types/webgazer.d.ts
└── tsconfig*.json
```

---

## 트러블슈팅

### `tracker: error · t is not a function`

`webgazer.js` 옆의 **`mediapipe/face_mesh/` 폴더가 `src/renderer/public/` 에 복사되지 않았을 때**. WebGazer 3.5.x 가 face mesh WASM 을 그 경로에서 fetch 합니다. 해결:

```bash
node scripts/copy-webgazer.mjs
npm run dev
```

### `head tracker: error · abort(Module.noExitRuntime ...)`

이전에 `@mediapipe/tasks-vision` 의존성과 WebGazer 의 구버전 MediaPipe 가 같은 페이지에서 충돌한 흔적이 남아 있을 때 발생. 현재 코드는 WebGazer 의 face mesh 를 재사용하도록 정리되어 발생하지 않음. 그래도 나오면 `node_modules` 재설치 후 dev 재시작.

### `tracker: error · NotAllowedError`

macOS 카메라 권한 거부. 시스템 설정 → 개인정보 보호 → 카메라 → Electron 허용 후 앱 재시작.

### 시선 도트가 안 보임

`⌘⇧D` HUD 켰는지 확인. `tracker: ready` 인데도 도트가 없으면:
- `landmarks: 0` → 얼굴 미검출. 카메라 앞에 얼굴이 있는지, 조명이 너무 어둡지 않은지
- `input: mouse (needs calibration — ⌘⇧K)` → 캘리브 한 번도 안 했음. `⌘⇧K` 진입

### GazeBar 트리거가 잘 안 됨

`⌘⇧3` 로 snapping mode 전환. HUD 에 `intent score`, `zone dwell`, `lateral v`, `approach v` 가 실시간 표시되어 어떤 변에 얼마나 의도가 모이는지 확인 가능. 임계 (`150`) 도달 시 lock. 그래도 안 잡히면 캘리브를 새로 (`⌘⇧K` → "기존 데이터 지우기" → 처음부터).

### `iris NIC-EC` 가 표시되지 않음 / `landmarks: 468`

`refineLandmarks: true` 패치가 webgazer 번들에 적용 안 됐다는 뜻. `copy-webgazer.mjs` 가 실행될 때 콘솔에 `[assets] webgazer.js (refineLandmarks PATCHED)` 로그가 떠야 함. 재실행:

```bash
node scripts/copy-webgazer.mjs
npm run dev
```

---

## 알려진 한계

- WebGazer 노트북 웹캠 기준 약 **4° 오차** baseline (Papoutsaki et al., 2016). snapping mode 가 이 오차에도 robust 한 trigger 를 만들고, lock 후 cursor 를 rail 에 고정해 항목 선택까지 결정적으로 만드는 게 본 보고서의 기여.
- macOS exclusive-fullscreen 일부 게임 위에선 오버레이가 가려질 수 있음 (borderless windowed 권장).
- `brightness` CLI 미설치 시 GazeBar 의 brightness 항목은 시각적으로만 작동.
- 안경 사용자의 iris 검출 정확도는 환경에 따라 변동.
