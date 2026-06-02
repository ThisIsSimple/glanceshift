# GlanceShift — Snapping Mode (Rail Snap + Intent Detection)

> **Status (2026-06-02 갱신)**: ✅ 구현 완료 — 단, 이후 아키텍처가 변경됨. **historical design doc** 로 보존.
> **현재 코드와의 차이** (권위 있는 현재 상태는 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)):
> - **모드 통합**: `filtered`/`raw` 비교 모드는 제거됨. snapping 이 **유일한 모드**다. 따라서
>   `ModeLabel`, `EDGE_MODE_PROFILES`, `EdgeDetectorConfig`(classic 필드), classic FSM,
>   `⌘⇧1/2/3` 단축키는 모두 제거됨. `EdgeDetector` 는 `SnapConfig` 를 직접 받는다.
> - **슬라이더 매핑 변경**: head roll 절대 매핑(왼쪽=0/중앙=50/오른쪽=100)이 아니라,
>   engage 시점 roll 을 neutral 로 잡는 **상대 조이스틱(rate control)** 이다 (오른쪽=증가/왼쪽=감소).
> - 아래 본문의 `EDGE_MODE_PROFILES`, mode 재정의, 절대 슬라이더 설명은 **historical** 이다.
>
> _원본 spec — 의도 감지 score / Rail FSM / rail 투영 알고리즘 부분은 현재도 유효._

---

## 1. 배경 및 동기

보고서 §1.2 는 GlanceShift 를 *"시선을 coarse target designation 채널로, 머리 기울임을 confirmation 채널로 분리"* 한 설계로 정의한다. 현재 구현은 *coarse* 의 의미를 "8–12% band" 정도의 공간적 너그러움으로만 풀고 있는데, **인터랙션이 활성화된 후의 시선 좌표** 도 여전히 raw gaze 의 노이즈를 그대로 GazeBar 호버 계산에 사용한다. perpendicular 정확도가 떨어지는 사용자는 그만큼 항목 선택이 불안정해진다.

**Snapping Mode 의 핵심 변환**: *intent* 와 *position* 을 분리한다.

- **Intent** : 사용자가 "edge 를 보려는 의도" 가 있는가? — 의도 감지 score 가 임계 도달 시 lock
- **Position** : lock 된 이후의 cursor 좌표 — *시선의 perpendicular 좌표는 강제로 rail 위에 고정*, along-edge 좌표만 cursor 에 반영

결과: 인터랙션 활성화 후 시선이 떨려도 cursor 는 1D rail 위에서만 미끄러진다. GazeBar 항목 선택의 결정성이 보장된다.

이 plan 의 mode 재정의는 비교 분석의 변수를 깨끗하게 분리하기 위한 목적도 겸한다 — `raw` 모드는 OneEuro 필터의 기여도를 측정하는 control 그룹이다.

---

## 2. Mode 재정의

`⌘⇧1/2/3` 단축키 매핑은 유지하되, 의미를 다음과 같이 바꾼다.

| key | modeLabel | gaze source | edge detector | UI snap |
| --- | --- | --- | --- | --- |
| `⌘⇧1` | `filtered` | OneEuro-filtered `(s.fx, s.fy)` | classic FSM | off |
| `⌘⇧2` | `raw` | unfiltered `(s.x, s.y)` | classic FSM | off |
| `⌘⇧3` | `snapping` | OneEuro-filtered `(s.fx, s.fy)` | **new** `RailFSM` | on (rail snap) |

기존 `sticky`, `magnetic` 두 mode 는 제거. 코드 history 에는 git 으로 남으므로 필요 시 복원 가능. *직전 평가에서 의미 있는 데이터가 나왔던 mode 가 있으면* 보고서 figure 만 유지하고 코드는 정리한다.

### 2.1 EDGE_MODE_PROFILES 변경

`src/renderer/src/perception/edge-detector.ts` 의 export 를 다음과 같이 바꾼다:

```ts
export type ModeLabel = 'filtered' | 'raw' | 'snapping'

export interface EdgeDetectorConfig {
  modeLabel: ModeLabel
  // classic FSM 용 (filtered / raw)
  enterFrac: number
  exitFrac: number
  dwellMs: number
  exitGraceMs: number
  dwellGraceMs: number
  // snapping mode 가 활성화될 때만 사용 — IntentTracker config 으로 전달
  snap: SnapConfig | null
}

export const EDGE_MODE_PROFILES: Record<ModeLabel, EdgeDetectorConfig> = {
  filtered: {
    modeLabel: 'filtered',
    enterFrac: 0.08, exitFrac: 0.12, dwellMs: 150,
    exitGraceMs: 0, dwellGraceMs: 0,
    snap: null
  },
  raw: {
    modeLabel: 'raw',
    enterFrac: 0.08, exitFrac: 0.12, dwellMs: 150,
    exitGraceMs: 0, dwellGraceMs: 0,
    snap: null
  },
  snapping: {
    modeLabel: 'snapping',
    // classic 분기 의 값은 사용 안 함 (호환 위해 유지). 실제 동작은 snap config 으로.
    enterFrac: 0, exitFrac: 0, dwellMs: 0, exitGraceMs: 0, dwellGraceMs: 0,
    snap: DEFAULT_SNAP_CONFIG
  }
}
```

App 은 modeLabel 만 보고 다음 두 가지를 분기:
1. gaze source: `raw` 면 `s.x, s.y`, 아니면 `s.fx, s.fy`
2. EdgeDetector 의 update 경로: `snap != null` 이면 RailFSM, 아니면 classic

---

## 3. Snapping Mode 데이터 흐름

```
gaze sample (s.fx, s.fy)
        │
        ▼
┌─────────────────────────────────────────┐
│ IntentTracker.update(gaze, vp, dt)      │
│   per-edge intent score 누적 / 감쇠      │
│   → scores: { left, right, top, bottom } │
│   → primary: { edge, score }            │
└───────────────────┬─────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│ RailFSM (in EdgeDetector when snap≠null) │
│   idle → building_intent → rail_locked   │
│   transitions on primary.score vs threshold│
└───────────────────┬─────────────────────┘
                    │ emits: enter / exit events
                    │ exposes: snapshot.railCursor
                    ▼
┌─────────────────────────────────────────┐
│ App                                     │
│   if rail_locked: gaze for downstream = │
│       snapshot.railCursor                │
│   else:           gaze                   │
└───────────────────┬─────────────────────┘
                    │
                    ▼
           GazeBar / GazeDot
           (이미 deterministic snap 가능, snapHover prop 유지)
```

---

## 4. IntentTracker — 의도 감지

### 4.1 입력 / 출력 / 상태

```ts
// src/renderer/src/perception/intent-score.ts  (NEW)

export interface SnapConfig {
  /** Intent zone — viewport 짧은 변 길이의 비율 (예: 0.30 = outer 30%) */
  intentZoneFrac: number
  /** Lock zone — intent zone 보다 약간 넓음. lock 유지에 사용 */
  lockZoneFrac: number
  /** Score 임계값 (ms-equivalent unit). 도달 시 rail lock */
  intentThreshold: number
  /** Score cap. 누적 폭주 방지 */
  scoreMax: number
  /** Score 감쇠율 (per ms) — primary 가 아닌 edge 의 score 가 줄어드는 속도 */
  decayPerMs: number
  /** Dwell bonus 발동 시간 — zone 안 머문 시간 (ms) */
  dwellBonusAfterMs: number
  /** Dwell bonus 가중치 (per ms 추가 적립) */
  dwellBonusRate: number
  /** Along-edge 속도 임계 (px/s). 이 이상이면 lateral penalty 적용 */
  lateralVelocityPxs: number
  /** Lateral penalty 가중치 (per ms 차감) */
  lateralPenaltyRate: number
  /** Lock 유지 위해 lock zone 밖 머무를 수 있는 grace (ms) */
  exitGraceMs: number
}

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  intentZoneFrac: 0.30,
  lockZoneFrac: 0.35,
  intentThreshold: 150,    // ms-equivalent
  scoreMax: 250,
  decayPerMs: 0.5,
  dwellBonusAfterMs: 200,
  dwellBonusRate: 0.5,
  lateralVelocityPxs: 500,
  lateralPenaltyRate: 0.8,
  exitGraceMs: 250
}

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export interface IntentSample {
  scores: Record<Edge, number>
  primary: { edge: Edge; score: number } | null
  /** zone 안에 머문 시간 (해당 primary edge 기준). 0 = 밖 */
  zoneDwellMs: number
  /** along-edge velocity (px/s) — 디버그용 */
  lateralVelocity: number
  /** perpendicular velocity (px/s, edge 안쪽 방향 +) — 디버그용 */
  approachVelocity: number
}

export class IntentTracker {
  constructor(cfg: SnapConfig)
  /** 매 frame 호출. 내부적으로 dt 계산. */
  update(gaze: {x:number;y:number} | null, viewport: {w:number;h:number}, now: number): IntentSample
  reset(): void
  setConfig(cfg: SnapConfig): void
}
```

### 4.2 알고리즘 — pseudo code

```ts
state:
  scores: { left:0, right:0, top:0, bottom:0 }
  zoneDwellMs: 0
  lastNow: number | null
  lastGaze: Point | null
  currentZoneEdge: Edge | null   // 가장 최근에 zone 진입한 변

update(gaze, vp, now):
  dt = clamp(0, 50, now - lastNow)   // 첫 호출 또는 큰 갭은 0
  lastNow = now

  if gaze is null or gaze.x < 0:
    decay_all(dt)
    zoneDwellMs = 0
    lastGaze = null
    return snapshot

  // 1. perpendicular distance 와 zone 내부 여부 per edge
  for edge in [left, right, top, bottom]:
    pd[edge] = perpendicularDistance(gaze, vp, edge)    // 0 at edge, larger inward
    inZone[edge] = pd[edge] / vp_dim[edge] < intentZoneFrac

  // 2. 가장 가까운 변 = primary candidate
  primaryEdge = argmin_edge pd[edge]
  primaryInZone = inZone[primaryEdge]

  // 3. velocities (px/s)
  if lastGaze:
    vx = (gaze.x - lastGaze.x) / (dt/1000)
    vy = (gaze.y - lastGaze.y) / (dt/1000)
  else: vx=vy=0

  approachV = approachVelocity(primaryEdge, vx, vy)   // edge 방향 정성분
  lateralV  = lateralVelocity(primaryEdge, vx, vy)    // edge 평행 |성분|

  // 4. zone dwell 추적
  if primaryInZone and currentZoneEdge == primaryEdge:
    zoneDwellMs += dt
  elif primaryInZone:
    currentZoneEdge = primaryEdge
    zoneDwellMs = dt
  else:
    currentZoneEdge = null
    zoneDwellMs = 0

  // 5. primary edge score 갱신
  if primaryInZone:
    closeness = 1 - (pd[primaryEdge] / (vp_dim[primaryEdge] * intentZoneFrac))
    base = closeness                                       // unit: 1 per ms
    dwellBonus = (zoneDwellMs > dwellBonusAfterMs ? dwellBonusRate : 0)
    lateralPen = (lateralV > lateralVelocityPxs ? lateralPenaltyRate : 0)
    dscore = dt * (base + dwellBonus - lateralPen)
    scores[primaryEdge] = clamp(0, scoreMax, scores[primaryEdge] + dscore)
  else:
    scores[primaryEdge] = max(0, scores[primaryEdge] - dt * decayPerMs)

  // 6. 다른 edge 의 score 는 모두 감쇠
  for e in others:
    scores[e] = max(0, scores[e] - dt * decayPerMs)

  lastGaze = gaze

  // 7. primary 결정 (최대 점수의 edge, 0 이면 null)
  bestEdge = argmax scores
  bestScore = scores[bestEdge]
  primary = bestScore > 0 ? { edge: bestEdge, score: bestScore } : null

  return { scores, primary, zoneDwellMs, lateralVelocity: lateralV, approachVelocity: approachV }
```

### 4.3 보조 함수

```ts
// edge 별 perpendicular distance (px) — 항상 양수
perpendicularDistance(g, vp, edge):
  switch edge:
    case 'left':   return g.x
    case 'right':  return vp.w - g.x
    case 'top':    return g.y
    case 'bottom': return vp.h - g.y

// vp_dim[edge] — 해당 변의 perpendicular 방향 viewport 길이
vp_dim:
  left, right → vp.w
  top, bottom → vp.h

// edge inward normal 방향 단위 vec
edgeNormalInward(edge):
  left   → (+1, 0)
  right  → (-1, 0)
  top    → (0, +1)
  bottom → (0, -1)

// 양수면 edge 로 접근 중
approachVelocity(edge, vx, vy):
  n = edgeNormalInward(edge)
  // 사용자가 edge 로 다가갈 때 = inward normal 의 반대 방향으로 이동
  return -(vx * n.x + vy * n.y)

// |edge 와 평행한 속도 성분|
lateralVelocity(edge, vx, vy):
  switch edge:
    case 'left' or 'right': return |vy|
    case 'top'  or 'bottom':return |vx|
```

### 4.4 수치 예시 (sanity check)

**예시 A — 정면에서 우측 가장자리 빠르게 응시**

- viewport 1920×1080. intentZoneFrac=0.30 → right zone 은 x > 1344 영역.
- t=0ms: gaze (1500, 540). pd_right = 420px. closeness = 1 − 420/(1920*0.30) ≈ 0.27. dscore ≈ 0.27 × 33ms ≈ 9. scores.right = 9.
- t=33ms: gaze (1700, 540). 빠르게 이동, lateral velocity ≈ 0. pd_right=220, closeness=0.62. dscore = 33 × 0.62 ≈ 21. scores.right = 30.
- t=66ms: gaze (1820, 540). pd_right=100, closeness=0.83. dscore ≈ 27. scores.right = 57.
- t=99ms: 같은 위치 머무름. closeness 0.83 그대로. scores.right = 84.
- t=132ms: scores.right = 111.
- t=165ms: scores.right = 138.
- t=200ms: zone 안 머문 누적 200ms 도달 → dwellBonus 발동. closeness 0.83 + 0.5 = 1.33. dscore = 33 × 1.33 ≈ 44.
- t≈200~250ms: 임계 150 도달 → lock 진입.

총 trigger time ≈ **170~200ms**. 빠른 응시에 자연스러운 반응.

**예시 B — 페이지를 가로로 스캔 중 우측 가장자리 잠깐 통과**

- gaze (200, 400) → 매 frame 60px 만큼 우측으로 (lateral velocity ≈ 1800 px/s).
- t≈600ms: gaze 가 (1400, 400) 도달. zone 진입.
- closeness 0.31, lateral 1800 > 500 → penalty 발동. dscore = 33 × (0.31 - 0.8) = -16. scores.right 즉시 음수 → 0 clamp.
- 몇 frame 후 (1600, 400): closeness 0.55, penalty 그대로. dscore = 33 × (-0.25) = -8. 여전히 0.
- 빠르게 통과 → trigger 없음.

스캔 false trigger 차단 확인.

**예시 C — 의도 없이 가장자리 근처 머무름**

- gaze (1700, 540) 에 정지. closeness 0.62.
- dscore = 33 × 0.62 = 21. 매 frame.
- t=240ms 즈음: scores ≈ 150 도달 → lock.

**이건 의도 없는 lock!** 사용자가 *우연히* 가장자리 근처를 보고 있어도 240ms 면 trigger 됨. mitigation:
1. 사용자가 화면 가장자리 근처를 *240ms 이상 응시* 하는 건 사실 의도일 가능성 높음 — 일반적 시선 fixation 이 200–400ms 라 false trigger 가 아주 흔하진 않음
2. 정 거슬리면 `dwellBonusAfterMs` 를 200 → 300 으로, 또는 `closeness` 에 거듭제곱 (closeness²) 을 적용해 mid-zone 의 누적을 늦춤

평가에서 FTR (False Trigger Rate per minute) 측정해서 튜닝.

---

## 5. RailFSM — Edge Detector 분기

`src/renderer/src/perception/edge-detector.ts` 의 `update()` 가 `snap != null` 일 때 다음 로직으로 분기.

### 5.1 상태

```ts
type SnappingState = 'idle' | 'building_intent' | 'rail_locked'

private snapState: SnappingState = 'idle'
private snapCurrentEdge: Edge | null = null
private snapEnteredAt: number | null = null
private snapExitGraceAccum: number = 0
private snapRailCursor: {x:number;y:number} | null = null
private intentTracker: IntentTracker | null = null   // snap config 있을 때만 생성
```

### 5.2 전이

```
idle:
  intentTracker.update(gaze, vp, now)
  if intent.primary != null:
    state = building_intent
    snapCurrentEdge = intent.primary.edge

building_intent:
  intentTracker.update(gaze, vp, now)
  if intent.primary == null:
    state = idle
    snapCurrentEdge = null
  elif intent.primary.edge != snapCurrentEdge:
    snapCurrentEdge = intent.primary.edge   // 다른 변으로 의도 전환
  elif intent.primary.score >= cfg.intentThreshold:
    state = rail_locked
    snapEnteredAt = now
    intentTracker.reset()   // score 누적 끊고 시작
    snapRailCursor = projectToRail(gaze, snapCurrentEdge, vp)
    snapExitGraceAccum = 0
    emit { type:'enter', edge: snapCurrentEdge, mode:'snapping' }

rail_locked:
  // intentTracker 는 lock 중에는 호출 안 함 (계산 낭비 회피)
  if gaze in lockZone of snapCurrentEdge:
    snapRailCursor = projectToRail(gaze, snapCurrentEdge, vp)
    snapExitGraceAccum = 0
  else:
    snapExitGraceAccum += dt
    if snapExitGraceAccum >= cfg.exitGraceMs:
      emit { type:'exit', edge: snapCurrentEdge, mode:'snapping' }
      state = idle
      snapCurrentEdge = null
      snapRailCursor = null
      snapEnteredAt = null
      snapExitGraceAccum = 0
```

### 5.3 lockZone 판정

```ts
function inLockZone(gaze, vp, edge, lockZoneFrac):
  pd = perpendicularDistance(gaze, vp, edge)
  return pd / vp_dim(edge) < lockZoneFrac
```

intentZoneFrac (0.30) 보다 약간 큰 lockZoneFrac (0.35) 을 쓰는 이유: lock 진입 후 사용자의 시선이 *살짝 더 안쪽* 으로 들어와도 lock 유지. hysteresis.

### 5.4 projectToRail

```ts
// thickness = max(56, min(80, min(vp.w, vp.h) * 0.06))
// 이미 GazeBar.tsx 의 computeGeometry 와 동일하게 계산

export function railPosition(edge: Edge, vp: {w:number;h:number}): {x:number;y:number} | null {
  const thickness = Math.max(56, Math.min(80, Math.min(vp.w, vp.h) * 0.06))
  // edge 의 perpendicular 좌표는 변에서 thickness/2 안쪽
  // along-edge 좌표는 호출자가 클램프
  switch (edge) {
    case 'right':  return { x: vp.w - thickness / 2, y: 0 }
    case 'left':   return { x: thickness / 2, y: 0 }
    case 'top':    return { x: 0, y: thickness / 2 }
    case 'bottom': return { x: 0, y: vp.h - thickness / 2 }
  }
}

export function projectToRail(gaze, edge, vp): {x:number;y:number} {
  const rail = railPosition(edge, vp)
  // bar 의 along-edge 활성 영역 = vp 중심 ±30% (총 60%)
  const isVert = edge === 'left' || edge === 'right'
  const along = isVert ? vp.h : vp.w
  const start = along * 0.20
  const end = along * 0.80
  const clampAlong = v => Math.max(start, Math.min(end, v))
  if (isVert) return { x: rail.x, y: clampAlong(gaze.y) }
  return { x: clampAlong(gaze.x), y: rail.y }
}
```

### 5.5 snapshot 확장

```ts
export type EdgeSnapshot = {
  state: EdgeState              // classic: idle/dwelling/entered
                                // snapping: idle/building_intent/rail_locked 가 매핑
  edge: Edge | null
  dwellProgress: number         // classic 호환. snapping 에선 intent score / threshold
  enteredAt: number | null
  scores?: Record<Edge, number> // snapping mode 에서 채워짐
  approachVelocity?: number
  modeLabel: ModeLabel
  // snapping 전용 추가:
  intentZoneFrac?: number
  lockZoneFrac?: number
  railCursor?: {x:number;y:number} | null
}
```

snapping state 와 classic state 의 매핑:
- `idle` (snap) → `idle` (snapshot)
- `building_intent` (snap) → `dwelling` (snapshot.state) — UI 가 같은 진행 효과 적용
- `rail_locked` (snap) → `entered` (snapshot.state) — GazeBar 표시 트리거

dwellProgress 는 snapping 에서 `clamp(0, 1, intentScore / intentThreshold)` 로 채움.

---

## 6. App 결선

### 6.1 gaze source 분기

`src/renderer/src/App.tsx` 의 gaze sample listener:

```ts
const useRawGaze = edgeMode === 'raw'
...
const offGazeSample = gazeTracker.onSample((s: GazeSample) => {
  if (cancelled) return
  if (useRawGaze) {
    setGaze({ x: s.x, y: s.y, t: s.t })
  } else {
    setGaze({ x: s.fx, y: s.fy, t: s.t })
  }
  setHasGazeData(true)
})
```

⚠️ `useRawGaze` 가 stale closure 가 되지 않도록 `useRef` 로 최신 값 추적:

```ts
const useRawGazeRef = useRef(false)
useEffect(() => { useRawGazeRef.current = edgeMode === 'raw' }, [edgeMode])
// listener 안에서 useRawGazeRef.current 참조
```

### 6.2 effective gaze (downstream 으로 전달)

```ts
const effectiveGaze = useMemo(() => {
  if (edgeMode === 'snapping' && edgeSnapshot.state === 'entered' && edgeSnapshot.railCursor) {
    return edgeSnapshot.railCursor   // rail 위로 강제
  }
  return point.x >= 0 ? { x: point.x, y: point.y } : null
}, [edgeMode, edgeSnapshot, point])
```

GazeBar 와 GazeDot 모두 `effectiveGaze` 를 사용. Lock 중에는 cursor 가 rail 에 붙어 있는 시각 단서가 됨.

### 6.3 snapHover prop

```tsx
<GazeBar
  ...
  gazePoint={effectiveGaze}
  snapHover={edgeMode === 'snapping'}
/>
```

이미 구현된 `snapHover` 동작 (deterministic nearest-item) 을 활용.

---

## 7. EdgeZones 시각화

`src/renderer/src/components/EdgeZones.tsx` 가 snapping mode 에서 intentZone 외곽선 + lockZone 외곽선을 별도 색으로 표시.

```tsx
type Props = {
  enterFrac: number              // classic: enterFrac, snapping: intentZoneFrac
  approachFrac?: number | null   // (deprecate; lockZoneFrac 로 대체)
  lockZoneFrac?: number | null   // snapping mode
  ...
}
```

snapping mode 활성화 시 EdgeZones 는:
- IntentZone (outer 30%): 옅은 파란 사각형 + 점선 외곽선
- LockZone (outer 35%): 더 옅은 노랑 점선 외곽선 (IntentZone 의 외곽)
- primary edge 의 IntentZone 은 intent score 에 비례해 색이 진해짐
- rail_locked 상태에서는 IntentZone 이 강조 + rail 자체(얇은 가로/세로 선)도 표시

CSS:
```css
.edge-intent-zone {
  position: fixed;
  background: rgba(90, 169, 255, 0.04);
  border: 1px dashed rgba(90, 169, 255, 0.22);
  pointer-events: none;
  z-index: 99;
  transition: background 100ms ease;
}
.edge-lock-zone-outline {
  position: fixed;
  border: 1px dotted rgba(255, 200, 90, 0.22);
  pointer-events: none;
  z-index: 98;
}
.edge-rail-line {
  position: fixed;
  background: rgba(90, 169, 255, 0.5);
  pointer-events: none;
  z-index: 101;
}
```

---

## 8. Snap 진입 시각 피드백

Lock 진입 순간 (`enter` 이벤트 시점) GazeDot 이 *rail 로 흡수되는* 짧은 모션. 사용자에게 *"snap 됐다"* 인지 단서.

구현: `App.tsx` 가 enter 이벤트를 받으면 잠시 `snapAnimating` state 를 `true` 로 설정 (200ms), GazeDot 컴포넌트가 그 동안:
- transition duration 200ms
- 시작 위치: 이전 gaze 좌표 (lock 직전의 자유 gaze)
- 끝 위치: railCursor

CSS:
```css
.gaze-dot.snapping-in {
  transition: left 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
              top  220ms cubic-bezier(0.2, 0.8, 0.2, 1),
              box-shadow 220ms ease;
  box-shadow: 0 0 24px rgba(90, 169, 255, 0.9);
}
```

200ms 후 `snapAnimating` 해제, 일반 transition 으로 복귀.

---

## 9. DebugHud 추가 정보

snapping mode 일 때 추가 row:

| label | value | source |
| --- | --- | --- |
| `intent score` | `113 / 150` (score / threshold) | snapshot.scores[primary] / cfg.intentThreshold |
| `zone dwell` | `247 ms` | intentSample.zoneDwellMs |
| `lateral v` | `342 px/s` | intentSample.lateralVelocity |
| `approach v` | `+128 px/s` | intentSample.approachVelocity |
| `rail cursor` | `(1885, 540)` 또는 `—` | snapshot.railCursor |

filtered/raw mode 에서는 이 row 들 숨김.

---

## 10. main process 변경

`src/main/index.ts` 의 globalShortcut 핸들러 라벨 변경:

```ts
globalShortcut.register('CommandOrControl+Shift+1', () => {
  overlayWindow?.webContents.send('glanceshift:set-edge-mode', 'filtered')
})
globalShortcut.register('CommandOrControl+Shift+2', () => {
  overlayWindow?.webContents.send('glanceshift:set-edge-mode', 'raw')
})
globalShortcut.register('CommandOrControl+Shift+3', () => {
  overlayWindow?.webContents.send('glanceshift:set-edge-mode', 'snapping')
})
```

`preload/index.ts` 의 `onSetEdgeMode` 시그니처 갱신:

```ts
onSetEdgeMode: (cb: (mode: 'filtered' | 'raw' | 'snapping') => void): (() => void) => ...
```

---

## 11. 변경 파일 매니페스트

| 파일 | 변경 종류 | 핵심 변경 |
| --- | --- | --- |
| `src/renderer/src/perception/intent-score.ts` | **NEW** | `IntentTracker` 클래스, `SnapConfig`, `DEFAULT_SNAP_CONFIG`, `IntentSample` 타입 |
| `src/renderer/src/perception/edge-detector.ts` | 수정 | `ModeLabel` 재정의, `EDGE_MODE_PROFILES` 갱신, `update()` 가 snap config 있을 때 RailFSM 으로 분기, `snapToEdge` 는 그대로 두되 `projectToRail`/`railPosition` 추가 export, `EdgeSnapshot` 에 `railCursor` 등 신규 필드 |
| `src/renderer/src/components/EdgeZones.tsx` | 수정 | snapping mode 의 intentZone + lockZone + rail line 시각화 |
| `src/renderer/src/components/GazeBar.tsx` | (no change) | 기존 `snapHover` prop 그대로 사용 |
| `src/renderer/src/components/GazeDot.tsx` | 수정 | `snapping` prop 추가 — true 면 transition 강화 (snap-in 모션) |
| `src/renderer/src/components/DebugHud.tsx` | 수정 | snapping mode 전용 row 추가 |
| `src/renderer/src/App.tsx` | 수정 | gaze source 분기, effectiveGaze 계산, snapAnimating state, EdgeZones·GazeBar·GazeDot 에 새 props |
| `src/main/index.ts` | 수정 | mode 라벨 3개 (filtered/raw/snapping) |
| `src/preload/index.ts` | 수정 | `onSetEdgeMode` 시그니처 |
| `src/renderer/src/styles.css` | 추가 | `.edge-intent-zone`, `.edge-lock-zone-outline`, `.edge-rail-line`, `.gaze-dot.snapping-in` |
| `README.md` | 수정 | mode 표 갱신, snapping 설명 |
| `EVALUATION_PROTOCOL.md` | 수정 | mode 라벨 3개 (filtered/raw/snapping) 로 매트릭스 갱신 + edge-trigger eval (§13 참고) 절차 추가 |

---

## 12. 구현 순서 — Phase 별 Acceptance

각 phase 끝나면 `npm run typecheck` 통과 + 명시된 manual smoke test 통과.

### Phase α — Mode 재정의 (30분)

**변경**: EDGE_MODE_PROFILES, main process labels, preload signature, HUD label rendering.

**Acceptance**:
1. typecheck 통과
2. 앱 실행 → HUD 의 `edge mode` 가 `filtered` 표시
3. `⌘⇧2` → HUD 가 `raw`. 시선 도트가 *살짝 더 떨림* 으로 보임 (필터 off)
4. `⌘⇧3` → HUD 가 `snapping` 표시. 이 시점 동작은 아직 magnetic 그대로 (snap=null 이면 classic FSM 으로 fallback, 이후 phase 에서 구현)

### Phase β — IntentTracker (1.5h)

**변경**: `intent-score.ts` 신규 작성. 단위 테스트 작성 권장 (Vitest, 시간상 안 되면 콘솔 로그로 sanity check).

**Acceptance**:
1. typecheck 통과
2. App 에서 임시로 IntentTracker 를 mode 와 무관하게 매 frame 호출해 콘솔에 `[intent] scores L:0 R:42 T:0 B:0 dwell:147` 형태 로그 출력 (개발용)
3. §4.4 의 예시 A 시나리오 (정면→우측 빠르게 응시) 가 약 200ms 안에 score 150 도달 확인
4. §4.4 의 예시 B 시나리오 (가로 스캔) 가 score 50 미만 유지 확인

### Phase γ — RailFSM in EdgeDetector (2h)

**변경**: `edge-detector.ts` 의 `update()` 가 `snap != null` 일 때 RailFSM 으로 분기. `EdgeSnapshot` 확장.

**Acceptance**:
1. typecheck 통과
2. `⌘⇧3` 로 snapping 활성화 후 시선을 우측 가장자리로 이동
3. HUD 가 `edge state: dwelling` 으로 표시되며 `intent score: 50/150` 같은 값이 증가
4. score 150 도달 시 `edge state: entered` 로 전환 + 콘솔에 `[edge] ENTER right t=... mode=snapping`
5. lockZone 밖으로 시선 빠르게 이동 → 250ms 후 `EXIT` 이벤트, idle 복귀

### Phase δ — UI 결선 (1h)

**변경**: App 의 `effectiveGaze`, GazeBar 에 snap gaze 전달, GazeDot 의 snap-in 모션.

**Acceptance**:
1. Lock 진입 순간 GazeDot 이 rail 위치로 부드럽게 이동 (200ms transition)
2. Lock 중 시선을 자유롭게 움직여도 cursor 는 rail 위에서만 움직임 (perpendicular 잠김 확인)
3. Lock 중 시선의 along-edge 좌표 이동에 따라 GazeBar 항목 hover 가 결정적으로 바뀜
4. lock 해제 후 GazeDot 이 다시 자유 gaze 따라감

### Phase ε — EdgeZones 시각화 + DebugHud (45분)

**변경**: 새 zone outline, HUD row 추가.

**Acceptance**:
1. snapping mode 에서 디버그 HUD 켜면 intentZone (옅은 파란) + lockZone (노랑 점선) 둘 다 보임
2. 시선을 가장자리에 가까이 가져가면 해당 변의 IntentZone 색이 진해짐
3. Lock 진입 시 rail 라인이 짧게 표시됨
4. HUD 의 `intent score / zone dwell / lateral v / approach v / rail cursor` 5개 row 가 snapping mode 에서만 보임

### Phase ζ — 평가 도구 보강 (1h, 선택)

**변경**: `Evaluation.tsx` 에 edge-trigger eval 추가 (§13).

**Acceptance**: §13 의 절차대로 측정 가능.

### Phase η — 문서 갱신 (30분)

**변경**: README, EVALUATION_PROTOCOL.

**Acceptance**: 단축키 표·진행 상태·trouble shooting 모두 새 mode 이름 반영.

---

## 13. 평가 — Edge-Trigger Evaluation

`⌘⇧E` 의 기존 5×5 grid 평가 외에 *trigger 정확도* 측정을 위한 새 evaluation 모드.

### 13.1 절차

```
1. Evaluation intro 에 새 옵션: "Eval type: gaze accuracy" vs "trigger accuracy"
2. trigger accuracy 선택 시:
   - 20 trials
   - 각 trial:
     · 화면 중앙에 fixation cross 0.5s
     · 큰 화살표가 0.3s 표시 (→ ← ↑ ↓ 중 하나, random)
     · 사용자가 그 변을 보고 GazeBar 호출
     · 최대 2초 안에 정답 edge 에 lock 되면 성공
     · 시간 초과 또는 다른 edge lock 은 실패 (각각 timeout / wrong-edge 로 기록)
   - 통계: Trigger Success Rate, Mean Trigger Time, Wrong-Edge Rate
3. CSV 저장 — `trigger_<mode>_<ts>.csv` (eval-logs 와 동일 폴더)
```

CSV 컬럼:
```
mode, trial_idx, target_edge, locked_edge, success, trigger_time_ms, gaze_path_length_px
```

### 13.2 false trigger rate 측정 (별도)

20 trials 끝나고 자동으로 시작:
```
- "이제 30초 동안 자연스럽게 화면을 둘러봐 주세요" 안내
- 30초 카운트다운
- 그 동안 발생한 모든 lock 이벤트 횟수 기록 (자유 작업 시뮬레이션)
- FTR = lock_count / 30 (events per 30s)
```

CSV 마지막에 한 줄 추가:
```
mode, "<free-30s>", -, -, ftr_count, -, -
```

### 13.3 목표 수치

| Mode | TSR | MTT | WER | FTR (per 30s) |
| --- | --- | --- | --- | --- |
| filtered | ≥ 80% | ≤ 500 ms | ≤ 10% | ≤ 1 |
| raw | (필터 off 영향 측정용 — 기준 없음) | | | |
| snapping | ≥ 95% | ≤ 300 ms | ≤ 2% | ≤ 0.5 |

이 표가 보고서 §5.1 의 표 2 가 됨.

---

## 14. Edge Cases & 의도된 동작

| 상황 | 의도된 동작 |
| --- | --- |
| 화면 모서리 (right + top 같은 코너) 응시 | IntentTracker 가 두 edge 모두 zone 안. perpendicularDistance 가 더 작은 edge 가 primary 후보. 양쪽 score 가 비슷하게 누적 → 결국 한 쪽이 먼저 임계 도달 (보통 더 짧은 변 쪽). 의도 모호 → ms 단위 random 동전 던지기. 사용자가 더 명확히 응시하면 자연 해소 |
| Lock 중 다른 변으로 시선 이동 | lockZone 을 벗어남 → 250ms 후 exit. 새 변에서 다시 의도 감지 시작. lock 직접 전이 없음 (의도된 디자인: 한 번에 하나의 보조명령) |
| 얼굴 검출 실패 (gaze null) | IntentTracker.update(null, …) → `decay_all`. scores 가 점차 0. Lock 중이면 lockZone 이탈로 처리 → exit grace 후 idle |
| 캘리브 안 된 상태에서 snapping 사용 | gaze 가 매우 부정확 → IntentTracker 는 정상 동작하지만 score 누적이 들쭉날쭉. 사용자에게 무방. 캘리브 권장 toast 는 향후 작업 |
| viewport resize 중 | EdgeDetector 가 매 update 에 viewport 받음. 다음 frame 에 새 dimension 반영 |
| 매우 큰 dt (탭 백그라운드 등) | `update()` 가 dt 를 50ms 로 clamp. 점수 폭주 없음 |

---

## 15. 호환성 / 마이그레이션

- 기존 평가 CSV (sticky, magnetic condition) 는 그대로 보존 — `compare-evals.mjs` 가 알파벳 정렬해 표시할 뿐, 새 mode 이름과 별개로 비교 가능
- 보고서에 이미 *sticky / magnetic* 결과를 인용 중이면 그 자체로 유효 (코드 history 에 남음)
- `EDGE_MODE_PROFILES.sticky` 와 `.magnetic` 의 export 는 제거 — 외부 참조가 있으면 typecheck 실패로 잡힘. App 의 `setEdgeMode` 콜백이 새 mode 라벨만 받게 됐는지 확인

---

## 16. 향후 작업 (out-of-scope)

- **IntentTracker 의 가중치 자동 튜닝**: 사용자가 평가 모드에서 false trigger 를 마킹하면 그 패턴을 negative example 로 가중치 조정
- **`brightness CLI` 없을 때 brightness 항목 표시 약화** (이미 작동하지만 시각 단서 추가)
- **머리 자세를 intent 신호로 추가**: 사용자가 머리 자체를 가장자리로 향하고 있으면 intent score 보너스. 현재 구현은 head pose 를 selector(slider) 에만 사용
- **사용자별 가중치 프로필 저장** — localStorage 영구화. multi-user 환경에 대비
- **rail 의 ergonomic 위치 학습** — 사용자가 자주 보는 항목이 위쪽이면 rail 의 시작점을 위로 옮김 (frequency-based)

---

## 17. 참고

- Sun et al. (2016) — Robust Gaze Estimation via NIC-EC vector (이미 구현). intent 의 spatial component 와 직접 관련.
- Sidenmark & Gellersen (2019) — Eye&Head. velocity_bonus / lateral_penalty 의 영감.
- Jacob (1990) — Midas Touch. dwell + 임계값 디자인의 근거.
- Iqbal & Horvitz (2007) — visual occlusion cost. intentZoneFrac 의 상한 (outer 30% 이상 침범 안 함).
- 보고서 §3.2 (Do · Feel · Know), §3.3 (Mappings, Modes), §4.5 (Boundary Conditions), §6.3 (context-aware GlanceShift).
