# GlanceShift — Gaze Accuracy 개선 계획

> 머리 위치·회전 변화에 강건한 시선 추정으로 업그레이드하기 위한 연구 기반 구현 계획.

---

## 0. 문제 분석 — 왜 지금 방식은 머리 움직임에 약한가

현재 GlanceShift 의 시선 추적은 WebGazer.js (Papoutsaki et al., 2016) 에 의존합니다. 이 방식의 작동 원리:

1. 매 프레임 webcam 영상에서 face mesh → 두 눈 patch 추출
2. 눈 patch 픽셀을 회귀의 입력 feature 로 직접 사용 (RidgeRegression)
3. 캘리브레이션 클릭 시점에 (eye_patch_feature, click_xy) 쌍을 학습 데이터로 추가

**근본 한계**: 회귀 모델은 *"이 픽셀 패턴 = 이 화면 좌표"* 를 외울 뿐이다. 머리가 움직이면:

- **평행이동** : 눈이 카메라 frame 의 다른 위치로 이동 → patch 픽셀 분포가 통째로 shift → 매핑 무효
- **회전 (yaw/pitch/roll)** : 같은 시선 방향이라도 눈 patch 의 perspective 가 달라짐 → 같은 시선 = 다른 픽셀 → 매핑 무효
- **거리 변화** : 눈 patch scale 이 달라짐 → 모델이 처음 보는 입력
- **조명** : appearance-based 라서 light 조건이 바뀌면 학습 데이터 자체가 무의미

WebGazer 가 "~4° 오차" 라고 보고된 건 *바로 캘리브 직후 + 머리 거의 안 움직임* 의 best case 입니다. 운영 중에는 사람들이 의식 없이 head bobbing/스크롤/자세 변화를 하기 때문에 실제 오차는 더 크게 떠 있습니다.

이건 패치(parameter tuning, 캘리브 더 많이)로 해결되는 문제가 아니라 **알고리즘적 한계**입니다. *"머리 자세를 모델 입력에 명시적으로 반영"* 하거나 *"머리 자세에 본질적으로 invariant 한 feature 를 쓰는"* 두 길 중 하나로 가야 합니다.

---

## 1. 관련 연구 정리

### 1.1 Browser SOTA — WebEyeTrack (2025)

[WebEyeTrack: Scalable Eye-Tracking for the Browser via On-Device Few-Shot Personalization](https://arxiv.org/abs/2508.19544) (Tan et al., arXiv:2508.19544, Aug 2025) 는 현재 browser-only gaze tracking 의 최신 SOTA 입니다.

핵심 설계:

- **3D face reconstruction + radial procrustes** 로 model-based 머리자세 추출
- **BlazeGaze** — BlazeBlocks 기반 670 KB CNN (모바일 CPU 에서 실시간)
- **MAML (Model-Agnostic Meta-Learning)** — 9 샘플 few-shot personalization
- TF.js + MediaPipe 로 [JS/TS 구현체 공개](https://github.com/RedForestAI/WebEyeTrack)
- 깜빡임 검출 (EAR) 로 blink 동안 prediction suppress
- continuous clickstream 캘리브 (UI 클릭을 implicit 학습 신호로)

이게 우리가 "장기적으로 가고 싶은 곳" 입니다. 하지만 즉시 도입에는 부담이 큽니다:

- MAML 학습 데이터를 외부에서 pre-train 해야 함 (GazeCapture 등 large-scale dataset 필요)
- 모델 inference 의 CPU/메모리 부담 (저사양 노트북에서 다른 작업과 동시 실행 시 부담)
- 학기 프로젝트 시한 안에 fork + 통합은 큼

### 1.2 Implicit Recalibration — vGaze (2022)

[vGaze: Continuous Gaze Tracking With Implicit Saliency-Aware Calibration on Mobile Devices](https://arxiv.org/abs/2209.15196) (Sun et al., IEEE TMC 2022). 화면에 saliency 가 강한 frame 을 자동 식별 → 그 순간 시선이 그 saliency 위에 있다고 가정 → 캘리브 신호로 사용. 사용자에게 명시적 캘리브를 요구하지 않으면서 모델을 계속 갱신합니다.

우리 맥락에서 응용 가능성: **GazeBar 인터랙션 자체가 ground truth 학습 신호**가 됩니다. 사용자가 GazeBar 의 특정 항목 위에서 머리를 기울여 select 했다면, 그 순간 시선은 거의 확실하게 그 항목 위에 있었습니다 → free calibration sample.

### 1.3 Data Normalization — Sugano · Zhang

[Revisiting Data Normalization for Appearance-Based Gaze Estimation](https://www.researchgate.net/publication/325634646_Revisiting_data_normalization_for_appearance-based_gaze_estimation) (Zhang, Sugano, Bulling, ETRA 2018) — 가상 카메라를 머리에 align 되도록 회전시켜 모든 입력 영상을 canonical pose 로 변환. 그 다음 가뇌 추정. 결과를 다시 실세계 자세로 inverse 변환.

이상적이지만 우리 task 에 적용하려면 3D face 모델과 perspective 변환이 필요해 무겁습니다. 부분적 아이디어 (yaw/pitch 보정만이라도)는 차용 가능.

### 1.4 Geometric / Iris-Vector — NIC-EC

[Robust Gaze Estimation via Normalized Iris Center-Eye Corner Vector](https://link.springer.com/chapter/10.1007/978-3-319-43506-0_26) (Sun et al., 2016) — 핵심 idea:

- 각 눈에 대해 `v_eye = (iris_center - eye_corner_midpoint) / eye_width` 계산
- 두 눈의 vector 를 평균하거나 concat → **NIC-EC vector**
- 머리 평행이동이나 거리 변화에 자연 invariant (정규화가 들어가니까)
- 다항식 회귀 또는 RBF 로 (NIC-EC, head_pose) → screen 매핑

[MediaPipe Iris and Kalman Filter for Robust Eye Gaze Tracking](https://www.atlantis-press.com/article/126011300.pdf) (2024) 등이 실용 검증.

**우리에게 가장 ROI 가 높은 접근**: MediaPipe Face Mesh 의 iris landmark (이미 468 + 10 = 478 사용 가능) 로 NIC-EC vector 를 직접 계산. WebGazer 의 patch-feature 기반 회귀를 **iris-vector + head-pose 기반 다항식 회귀**로 대체하면 머리 평행이동·소회전에 자연 강건해집니다.

### 1.5 3D Eye-Ball Model — geometric backbone

[3D Eye Modeling and Geometry-based Gaze Estimation](https://sites.ecse.rpi.edu/~cvrl/3DFace_Eye/3D_eye.html), [Iris Feature-Based 3-D Gaze Estimation](https://www.researchgate.net/publication/345353970_Iris_Feature-Based_3-D_Gaze_Estimation_Method_Using_a_One-Camera-One-Light-Source_System) 등. 안구를 두 sphere (eyeball + cornea) 로 modeling, iris center 와 추정된 eyeball center 를 잇는 vector 가 optical axis. visual axis 와 약 5° offset (kappa angle). 카메라·screen calibration 후 ray-screen 교점 계산.

**정확도 최상, 구현 비용 최대.** webcam 만으로 eyeball center 의 6 DoF 위치 추정이 필요 — refineLandmarks + head pose 만으로는 한계가 있어 통상 IR illuminator 또는 multi-camera 가 필요. 학기 프로젝트 범위 밖.

---

## 2. 접근 비교 표

| 접근 | 머리 강건성 | 정확도 잠재력 | 구현 비용 | 학기 시한 안 가능? |
| --- | --- | --- | --- | --- |
| WebGazer + head-pose feature 추가 | ★★ | ★ | ★ | ✓ 매우 쉬움 |
| **NIC-EC iris-vector + 다항식 회귀** | ★★★ | ★★★ | ★★ | ✓ 권장 |
| NIC-EC + head-pose conditioning | ★★★★ | ★★★ | ★★ | ✓ |
| Saliency-based implicit 재캘리브 | ★★ | ★★ | ★★ | ✓ (GazeBar interaction 활용) |
| Data normalization (Sugano) | ★★★★ | ★★★★ | ★★★★ | △ 시간 빠듯 |
| WebEyeTrack 통합 | ★★★★★ | ★★★★★ | ★★★★★ | ✗ (외부 pretrain 필요) |
| 3D eye-ball geometric | ★★★★★ | ★★★★★ | ★★★★★ | ✗ |

**전략**: NIC-EC + head-pose conditioning 을 **새 기본 backbone** 으로 도입하고, GazeBar 인터랙션을 implicit 재캘리브 신호로 활용한다. WebEyeTrack 은 future work 으로 명시.

---

## 3. 제안 구현 — 3-Layer 강건 시선 추적

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer C: Implicit Recalibration                                  │
│   GazeBar 진입/선택 성공 시 (gaze, target) 쌍을 학습 데이터로 추가 │
│   recent samples 가중치 ↑ → drift 자동 보정                       │
└────────────────────────┬────────────────────────────────────────┘
                         │ (re-fit polynomial coeffs)
┌────────────────────────▼────────────────────────────────────────┐
│ Layer B: NIC-EC + Head-Pose 다항식 회귀  ★ Layer 핵심 ★         │
│   input : [iris_vec_x, iris_vec_y, head_yaw, head_pitch, head_z] │
│   output: [screen_x, screen_y]                                   │
│   mapping: 2차 다항식 (per-axis 12 계수)                          │
│   calibration: 9-point × 5 click = 45 (input, output) 샘플       │
└────────────────────────┬────────────────────────────────────────┘
                         │ (samples)
┌────────────────────────▼────────────────────────────────────────┐
│ Layer A: Perception (MediaPipe Face Mesh 478 landmarks)         │
│   - refineLandmarks: true → iris landmarks (468-477)            │
│   - 기존 head-pose 계산 코드 재사용                                │
│   - iris_center, eye_corner_inner/outer → NIC-EC vector 계산     │
└─────────────────────────────────────────────────────────────────┘
```

### Layer A — Perception 확장

**현재 상태**: WebGazer 내부의 `face-landmarks-detection` v1 이 face mesh 를 추출하지만 `refineLandmarks` 옵션이 꺼져 있어 468 landmarks 만 받음 (iris 없음).

**필요 변경**:
- Option α: WebGazer 의 `facemesh.mjs` 의 detectorConfig 에 `refineLandmarks: true` 를 주입 — 우리 `copy-webgazer.mjs` 가 복사할 때 sed 로 1줄 patch 또는 런타임 monkey-patch
- Option β: WebGazer 의 face mesh 를 무시하고 **우리 자체 face-landmarks-detection 인스턴스** 운영 — 같은 패키지(`@tensorflow-models/face-landmarks-detection` v1)면 WASM 충돌 없음. 같은 video element 공유

Option β 가 깔끔하고 WebGazer 와 결합도 분리에 좋음. 추가 GPU/CPU 비용은 동일 비디오 frame 에서 동일 모델 1회 추가 inference (~5-10ms).

**계산**:
```ts
// Subject 시점 기준 인덱스
const irisRight = landmarks[468]   // 오른쪽 눈 iris center (subject's right)
const irisLeft  = landmarks[473]   // 왼쪽 눈 iris center

const rightInner = landmarks[133]  // right eye inner corner
const rightOuter = landmarks[33]   // right eye outer corner
const leftInner  = landmarks[362]
const leftOuter  = landmarks[263]

// 각 눈 별 NIC-EC vector (3D — z 도 포함하면 거리 정규화 효과)
function nicEc(iris, inner, outer) {
  const cx = (inner[0] + outer[0]) / 2
  const cy = (inner[1] + outer[1]) / 2
  const w  = Math.hypot(outer[0]-inner[0], outer[1]-inner[1])
  return [(iris[0]-cx)/w, (iris[1]-cy)/w]
}

const vR = nicEc(irisRight, rightInner, rightOuter)
const vL = nicEc(irisLeft,  leftInner,  leftOuter)
// 두 눈 평균 (또는 신뢰도 가중 평균)
const v = [(vR[0]+vL[0])/2, (vR[1]+vL[1])/2]
```

### Layer B — Polynomial Mapping with Head-Pose Conditioning

**모델**:
```
screen_x = a₀ + a₁·vx + a₂·vy + a₃·vx² + a₄·vy² + a₅·vx·vy
         + a₆·yaw + a₇·pitch + a₈·z_face
         + a₉·vx·yaw + a₁₀·vy·pitch + a₁₁·z_face·vx

(screen_y 동일 구조, 별도 12 계수 b)
```

12 계수 × 2 축 = 24 unknowns. 9-point × 5 click = 45 샘플 → over-determined → least-squares 안정적.

선형 회귀라서 closed-form 으로 `numeric.js` 또는 자체 구현된 `solveLeastSquares` 로 즉시 풀린다.

**왜 다항식 + head-pose cross terms**: NIC-EC 자체가 머리 평행이동에는 invariant 하지만, **머리 회전은 여전히 시선 매핑을 비선형으로 변형**시킨다. 머리 yaw 가 우리 시야에 보이는 iris 의 위치를 살짝 회전시키니까. cross term `vx·yaw` 가 그 효과를 catch.

**계산 비용**: per-frame inference 는 25개 곱셈 + 11개 덧셈, 무시 가능.

### Layer C — Implicit Recalibration via GazeBar Interaction

**Trigger**: 사용자가 `entered` 상태에서 머리를 기울여 GazeBar 항목을 **성공적으로 선택**했을 때 (Phase 5/6 완성 후 가능).

**가정**: 항목 선택 직전 ~300ms 동안 사용자는 그 항목을 응시하고 있었다 (이게 깨지면 선택 자체가 안 일어났을 것 → 가정의 자기 정당화).

**Action**: 그 300ms 동안의 NIC-EC vector 평균 + head pose 평균을 input 으로, 항목 중심 좌표를 output 으로 하는 새 (input, output) 샘플을 buffer 에 추가.

**Re-fit policy**:
- 새 sample 가 20 개 누적되면 polynomial 계수 re-fit
- 최근 200 샘플만 유지 (sliding window) — 자세 변화에 따라 모델이 따라옴
- 캘리브 sample 은 weight 2x (anchor 역할), implicit sample 은 1x

이걸로 사용자가 의식적으로 재캘리브 안 해도 시간이 지나면서 모델이 현재 자세에 맞춰진다. vGaze 가 saliency 로 하는 일을 GlanceShift 는 *명시적 의도가 있는 인터랙션 그 자체*로 한다.

---

## 4. Phase 별 작업 (Phase 4 GazeBar 와 병행/이전 가능)

> 이 작업은 Phase 4 (GazeBar UI) 이전에 끝내는 게 좋아요. GazeBar 가 의미 있게 동작하려면 시선 정확도가 baseline 보다 확실히 좋아야 하니까.

### Phase 3.5a — Iris Landmark 활성화 (반나절)

- 우리 `@tensorflow-models/face-landmarks-detection` v1 인스턴스 별도 생성, `refineLandmarks: true`
- WebGazer 와 같은 video element 공유 (`webgazerVideoFeed`)
- RAF 루프에서 478 landmarks 추출 → 478 길이 확인 로그
- HUD 에 iris landmark visualization (디버그용 작은 점 4개)

### Phase 3.5b — NIC-EC Backbone (1일)

- `perception/nic-ec.ts` — 478 landmarks → 양안 NIC-EC vector 계산
- 새 `perception/gaze-tracker.ts` — Layer B 다항식 회귀 구현
  - `addCalibrationSample(input, output)`
  - `refit()` — least-squares
  - `predict(input) → {x, y}`
  - 계수 영구화 (electron `userData` 폴더의 JSON)
- 캘리브레이션 UI 가 이쪽 tracker 로도 sample 을 동시 입력
- HUD 에 두 도트 표시: `webgazer` (지금까지의 것, 파란색) vs `new` (NIC-EC, 초록색) — **나란히 보면서 정성적 비교**

### Phase 3.5c — Switch over & Cleanup (반나절)

- 새 tracker 가 더 정확하다는 게 검증되면 WebGazer 의존도 줄임
- 단, WebGazer 의 face mesh 자체는 head pose 계산에 계속 쓸 수도 (또는 새 face landmarker 와 통합)
- 가장 깔끔한 종착지: WebGazer 의존성 제거, MediaPipe face mesh 하나로 통합

### Phase 6+ — Implicit Recalibration (Phase 5/6 이후)

- GazeBar 선택 성공 이벤트 hook
- 직전 300ms NIC-EC + head pose 평균 → 항목 좌표 와 함께 sample buffer 에 추가
- 20 sample 마다 re-fit
- HUD 에 "implicit samples: 17 / drift score: 0.42°" 같은 진단 정보

---

## 5. 검증 방법 — 정량 평가 설계

### 5.1 측정 프로토콜

1. 사용자가 의자에 자연스럽게 앉아 캘리브 진행
2. **5×5 격자 (25개 target)** 의 점을 5초 간격으로 화면에 표시
3. 각 target 에 대해 사용자가 응시하는 1초 동안의 gaze prediction 을 기록
4. 두 backbone (WebGazer vs new) 의 prediction 을 동시에 측정
5. 각 점에서 평균 오차 (Euclidean pixel distance, 그리고 각도 변환) 기록

### 5.2 머리 자세 변화 시나리오

같은 25-target 평가를 다음 조건들에서 반복:

- **A** : 캘리브 직후, 머리 정면 — *baseline*
- **B** : 머리를 왼쪽으로 15° yaw 후 — *대표 회전 변화*
- **C** : 카메라에서 20cm 멀어진 자세 — *거리 변화*
- **D** : 캘리브 후 5분간 자유롭게 작업하다 — *natural drift*

### 5.3 성공 기준

- 조건 A 에서: new backbone 이 WebGazer 대비 **동등 또는 ±10% 이내**
- 조건 B/C/D 에서: new backbone 이 WebGazer 대비 **30% 이상 오차 감소**
- 이 결과를 보고서 §5/6 (Significance, Necessity) 의 실증 근거로 사용 가능

### 5.4 평가 자동화

- `eval/grid-runner.tsx` — 25점 grid 띄우고 자동 진행 + CSV 로깅
- 평가 시점에 click-through 자동 해제

---

## 6. 위험 · 완화

| 위험 | 영향 | 완화 |
| --- | --- | --- |
| MediaPipe face mesh 의 iris landmark 가 노트북 웹캠 해상도에서 noisy | NIC-EC 가 불안정 | One Euro Filter 강화 + EMA + 양안 평균 |
| 사용자가 캘리브 후 자세를 너무 크게 바꿈 (head pose 가 calibration distribution 밖) | 다항식 외삽 = 큰 오차 | head pose 가 캘리브 범위 밖이면 HUD 에 경고 + 재캘리브 권장 |
| 다항식 12계수가 over-fit (45 샘플 미달) | 운영 정확도 ↓ | 5-fold CV 로 자동 검증, 너무 다항도 높으면 1차로 fallback |
| WebGazer 와 새 tracker 동시 운영의 CPU 부담 | 메인 작업 fps 저하 | 새 tracker ready 되면 WebGazer 종료 (Phase 3.5c) |
| iris landmark 가 안경 착용자에서 부정확 | 안경 사용자에서 성능 저하 | 안경 사용자도 평가 대상에 포함, 한계 명시 |
| 학기 시한 안에 implicit recal 까지 못 들어감 | Layer C 누락 | Layer A+B 만으로도 의미 있는 개선, Layer C 는 future work 으로 명시 |

---

## 7. 다음 액션 (즉시)

1. `Phase 3.5a` 부터 시작 — 별도 `@tensorflow-models/face-landmarks-detection` v1 인스턴스를 띄워 478 landmarks 가 잘 뽑히는지 확인
2. NIC-EC vector 계산 모듈 작성 + HUD 에 raw 값 표시 (캘리브 전이라도 보임)
3. 9-point 캘리브 가 두 tracker 에 동시 입력되도록 결선
4. Layer B 다항식 회귀 모듈 (closed-form least-squares) 작성 + 영구화
5. HUD 에 두 backbone 도트 동시 표시 → 정성 비교
6. 평가 grid (Phase 5.1–5.3) 자동화 → 정량 비교 → 보고서에 그래프

---

## 8. 보고서 §5/6 연결

이 개선이 보고서의 어디로 연결되는가:

- **§5.1 (기존 방식과의 차별성)** — "MRT 의 대칭적 자원 분리에서 비대칭적 interruption resilience 로의 패러다임 이동" 에 더해, *appearance-based gaze 의 head-pose dependency 를 명시적 모델링으로 분리해낸 정량적 기여* 추가 가능
- **§5.2 (즉시 배포 가능성)** — WebGazer 기반에 NIC-EC + head pose conditioning 을 얹는 것은 *추가 하드웨어 없이* 가능 → 본 보고서가 주장한 "현재 기술 스택 위에서 즉시" 라는 명제 강화
- **§4.5 (Boundary Conditions)** — 머리 자세 변화에 따른 성능 곡선 자체가 GlanceShift 의 boundary condition 의 하나의 정량 윈도우가 됨
- **§6.3 (개선점 / 향후 방향)** — WebEyeTrack 통합, vGaze-style implicit recal 의 발전된 형태가 자연스러운 다음 단계로 framing 가능

---

## 9. 출처 (Sources)

- [WebGazer.js: Scalable Webcam EyeTracking Using User Interactions](https://cs.brown.edu/people/apapouts/papers/ijcai2016webgazer.pdf) — Papoutsaki et al., IJCAI 2016
- [WebEyeTrack: Scalable Eye-Tracking for the Browser via On-Device Few-Shot Personalization](https://arxiv.org/abs/2508.19544) — Tan et al., arXiv:2508.19544, Aug 2025 / [GitHub](https://github.com/RedForestAI/WebEyeTrack)
- [Continuous Gaze Tracking With Implicit Saliency-Aware Calibration on Mobile Devices](https://arxiv.org/abs/2209.15196) — Sun et al., IEEE TMC 2022
- [Revisiting Data Normalization for Appearance-Based Gaze Estimation](https://www.researchgate.net/publication/325634646_Revisiting_data_normalization_for_appearance-based_gaze_estimation) — Zhang, Sugano, Bulling, ETRA 2018
- [ETH-XGaze: A Large Scale Dataset for Gaze Estimation Under Extreme Head Pose and Gaze Variation](https://link.springer.com/chapter/10.1007/978-3-030-58558-7_22) — Zhang et al., ECCV 2020 / [GitHub](https://github.com/xucong-zhang/ETH-XGaze)
- [MediaPipe Iris: Real-time Iris Tracking & Depth Estimation](https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/) — Google Research
- [Robust Gaze Estimation via Normalized Iris Center-Eye Corner Vector](https://link.springer.com/chapter/10.1007/978-3-319-43506-0_26) — Sun et al., 2016 (NIC-EC)
- [MediaPipe Iris and Kalman Filter for Robust Eye Gaze Tracking](https://www.atlantis-press.com/article/126011300.pdf) — 2024
- [Appearance-based Gaze Estimation with Deep Learning: A Review and Benchmark](https://arxiv.org/html/2104.12668v2) — Cheng et al., arXiv 2104.12668
- [Webcam-based gaze estimation for computer screen interaction](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2024.1369566/full) — Frontiers Robotics & AI, 2024
- [3D Eye Modeling and Geometry-based Gaze Estimation](https://sites.ecse.rpi.edu/~cvrl/3DFace_Eye/3D_eye.html) — RPI
