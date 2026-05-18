# GlanceShift

> Hard interruption을 Soft interruption으로 변환하는 시선+머리 인터랙션 오버레이.

본 저장소는 학기 보고서 *[SWCON312] Term Project — GlanceShift* 의 구현물입니다.
설계 근거와 단계별 계획은 상위 폴더의 `IMPLEMENTATION_PLAN.md` 를 참고하세요.

## 빠른 시작

```bash
cd app
npm install          # WebGazer 스크립트도 postinstall로 src/renderer/public/ 에 자동 복사됨
npm run dev
```

처음 실행하면 macOS는 카메라 권한 다이얼로그를 띄웁니다. 모두 허용해 주세요. 권한이 막혀 있으면 시선 추적이 시작되지 않고, 디버그 HUD의 `tracker` 가 `error` 로 표시됩니다.

## 단축키

| 단축키 | 동작 |
| --- | --- |
| `⌘⇧D` | 디버그 HUD 토글 (좌상단 패널 + 시선 도트) |
| `⌘⇧M` | 마우스 click-through 토글 |
| `⌘⇧K` | 시선 캘리브레이션 진입 (9-point, 점당 5클릭) |
| `⌘⇧Q` | 종료 |

캘리브레이션 중에는 자동으로 click-through 가 꺼져서 마우스로 점을 클릭할 수 있고, 종료(완료 또는 ESC)시 자동으로 다시 켜집니다.

## 진행 상태

- [x] Phase 0 — 부트스트랩 + 투명 click-through 오버레이 + 디버그 HUD
- [x] Phase 1 — WebGazer 시선 추적 + One Euro Filter + 9-point 캘리브레이션
- [x] Phase 2 — MediaPipe FaceLandmarker 머리 자세 (yaw/pitch/roll)
- [x] Phase 3 — Edge gaze detection (dwell 150 ms + hysteresis 8% → 12%)
- [x] Phase 3.5a — Iris landmarks (478) + NIC-EC vector
- [x] Phase 3.5+ — Multi-pose calibration + quality gating + edge boost
- [x] Phase 4 — GazeBar UI (edge-docked minimal sidebar with gaze hover)
- [x] Phase 5 — Head Tilt 슬라이더 (roll → 0..1, Look & Cross style commit on hover release)
- [ ] Phase 4 — GazeBar UI
- [ ] Phase 5 — Head tilt 슬라이더 (볼륨·밝기)
- [ ] Phase 6 — XState FSM 통합
- [ ] Phase 7 — OS bridge (loudness/brightness)

## 디렉토리 구조

```
app/
├── electron.vite.config.ts
├── package.json
├── scripts/
│   └── copy-webgazer.mjs        # node_modules → src/renderer/public 동기화
├── src/
│   ├── main/index.ts            # 투명 오버레이 윈도우 + 카메라 권한
│   ├── preload/index.ts         # contextBridge IPC API
│   └── renderer/
│       ├── index.html           # CSP (WebGazer/TFjs 호환)
│       ├── public/webgazer.js   # 빌드시 자동 복사
│       └── src/
│           ├── App.tsx
│           ├── components/
│           │   ├── Calibration.tsx
│           │   ├── DebugHud.tsx
│           │   └── GazeDot.tsx
│           ├── perception/
│           │   ├── one-euro.ts  # One Euro Filter (Casiez et al. 2012)
│           │   └── webgazer.ts  # WebGazer 래퍼
│           └── types/webgazer.d.ts
└── tsconfig*.json
```

## Phase 1 검증 체크리스트

`npm run dev` 후 다음을 확인:

1. 좌상단 `GlanceShift · debug` HUD 가 표시되고 `tracker` 가 `loading → ready` 로 전환되는지
2. 시선을 화면 곳곳으로 옮기면 파란 도트(`.gaze-dot`)가 시선을 따라 움직이는지 (초반엔 정확도 낮음 — 캘리브레이션 전)
3. `⌘⇧K` 로 9-point 캘리브레이션을 진행한 후, 도트가 사용자의 응시 지점 가까이에 머무는지
4. `zone` 값이 `LEFT/RIGHT/TOP/BOTTOM` 으로 정확히 바뀌는지 (가장자리 8%)

캘리브레이션 데이터는 WebGazer가 localforage(IndexedDB)에 자동 저장하므로, 앱 재시작 후에도 유지됩니다.

## 트러블슈팅

### `tracker: error · t is not a function`

`webgazer.js` 옆에 있는 **`mediapipe/face_mesh/` 폴더가 `src/renderer/public/`에 복사되지 않았을 때** 나는 증상입니다. WebGazer 3.5.x 는 face mesh WASM/JS 솔루션을 `./mediapipe/face_mesh/*` 에서 fetch 하는데, 파일이 없으면 dev 서버의 HTML 404 응답을 JS로 평가하려다 minified TypeError 가 납니다.

```bash
node scripts/copy-webgazer.mjs   # webgazer.js + mediapipe/face_mesh 전체 복사
npm run dev                      # 재시작
```

### `tracker: error · NotAllowedError`

macOS 카메라 권한 거부됨. 시스템 환경설정 → 개인정보 보호 및 보안 → 카메라 → Electron 항목 허용 후 앱 재시작.

### 시선 도트가 안 보임

먼저 `⌘⇧D`로 디버그 HUD가 켜져 있는지 확인. `tracker`가 `ready`인데도 도트가 안 보이면 얼굴 검출 자체가 실패 중일 수 있음 — 카메라 앞에 얼굴이 들어가 있는지, 조명이 너무 어둡지 않은지 확인.

## 알려진 한계

- WebGazer는 노트북 웹캠 기준 약 **4°** 정확도(Papoutsaki et al., 2016). 캘리브레이션 직후 가장 좋고, 조명·자세가 바뀌면 빠르게 열화됨 → 보고서 §5.2 의 한계와 일치.
- macOS 풀스크린 게임 위에는 잘 뜨지만, exclusive-fullscreen 모드 일부에서는 가려질 수 있음 (borderless windowed 권장).
