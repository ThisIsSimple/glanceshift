# GlanceShift — Edge Lock (자석 snap) 구현 계획

> 시선 자체의 정확도를 더 올리지 않고, **가장자리 인식만 확률적·관성적으로 만들어** GazeBar 진입을 안정화한다. 보고서 §1.2 의 *"시선은 coarse target designation 채널"* 설계 의도와 정확히 일치.

---

## 0. 현재 edge-detector 의 4가지 약점

`perception/edge-detector.ts` 의 현재 동작을 정리하면:

```
update(point, viewport, now):
  enterEdge ← classifyEdge(point, viewport, 0.08)   // 8% band
  exitEdge  ← classifyEdge(point, viewport, 0.12)   // 12% band

  idle      → enterEdge 있으면 dwelling 시작
  dwelling  → 단 한 frame 이라도 band 밖이면 즉시 idle 리셋
              150ms 누적되면 entered + 'enter' 이벤트
  entered   → exit band 밖이면 즉시 idle + 'exit' 이벤트
```

### 약점 1 — Hard binary threshold

가장자리에 "거의 다 왔지만 아직 8% 밖" 인 시선에 대해 **0의 dwell credit**. 정확도가 떨어지는 사용자에겐 GazeBar 가 영원히 안 열리거나 운에 의존.

### 약점 2 — Single-frame reset in dwelling

dwelling 중 jitter 한 프레임이라도 band 를 벗어나면 **누적된 dwell 시간이 통째로 증발**. 시선이 떨리는 사용자는 150ms dwell 을 절대 못 채움.

### 약점 3 — Single-frame exit in entered

GazeBar 가 떠 있는 상태에서 시선이 1프레임 만 화면 안쪽으로 튀어도 **즉시 사이드바 닫힘**. 사용자가 머리를 갸웃하면서 미세하게 시선이 흔들리는 자연스러운 동작이 깨짐.

### 약점 4 — No trajectory awareness

시선이 빠르게 가장자리를 향해 이동 중이면 *명백한 의도가 있는데* dwell 만 본다. 빠른 saccade 가 band 안에 들어왔다가 살짝 over-shoot 후 돌아오는 경우 (very common!) 가 검출 안 됨.

---

## 1. 사용자 제안의 수학적 해석

*"edge 근처에 시선이 가면 자석처럼 착 달라붙어서 edge 를 보고 있다고 판정"*

이걸 두 개의 분리된 메커니즘으로 풀어볼 수 있어요:

### (a) Engagement field — 가장자리 주변에 "끌어당기는" 확률장
각 변 별로 화면 전체에 걸쳐 *"이 위치에서 사용자가 그 변을 응시하고 있을 확률"* 함수를 정의:

```
E_right(x, y) = clamp(0, 1, (x - x_outer) / (x_inner - x_outer))
```

- `x_outer` : 영향이 0 이 되는 안쪽 경계 (예: viewport.w × 0.80, 즉 outer 20%)
- `x_inner` : 영향이 1 이 되는 가장자리 경계 (예: viewport.w × 0.92, 즉 outer 8%)
- 중간 영역은 선형 보간 → 점진적 자석 효과

기존 binary threshold 대신 이 score 를 사용한다.

### (b) Effective gaze snap — entered 상태일 때 시선을 변에 투영
일단 entered 상태가 되면 사용자가 *"그 변을 보고 있다고 굳이 가정"* 한다. 그래서 GazeBar 항목 hover 계산 시 시선의 **변에 수직인 좌표는 무시** 하고 **변과 평행인 좌표만** 본다.

`right` edge 의 경우:
```
effective_gaze.x = viewport.w * 0.94   // 변 위로 snap
effective_gaze.y = gaze.y               // 원본 유지
```

이렇게 하면 항목 선택은 시선의 perpendicular 정확도 와 무관해지고, *변의 어느 위치를 보고 있는가* 만 중요해집니다.

### (c) Item snap — along-edge 정확도도 거칠게 양자화
GazeBar 항목이 2개라면 along-edge 좌표를 2 구간으로 양자화해서 **변의 위쪽 절반 = 항목 1, 아래쪽 절반 = 항목 2** 로 단순 매핑. 시선이 항목 중심에 정확히 안 있어도 "더 가까운 항목" 으로 무조건 hover. 코너에서의 정확도 손실을 신경 안 써도 됨.

---

## 2. 4-Layer 개선 전략

```
Layer 4 (UI snap):  effective gaze → edge 평면에 투영 + 항목 양자화
       ↑
Layer 3 (Sticky FSM):  단일-frame reset 제거, 100ms exit grace period
       ↑
Layer 2 (Velocity bonus):  edge-방향 속도 > 임계 → dwell credit 2x
       ↑
Layer 1 (Engagement field):  binary band → 0..1 점진적 score
```

각 layer 가 독립적으로 효과를 내므로 **점진적 적용 + 측정** 이 가능.

---

## 3. Phase 별 구현 (3.5h ~ 1.5d)

### Phase A — Quick wins (30분, 누적 효과 큼)

`edge-detector.ts` 의 config 만 조정 + 단순 sticky 추가.

- `enterFrac` 0.08 → **0.12** (band 확장)
- `exitFrac` 0.12 → **0.20** (히스테리시스 강화)
- `dwellMs` 150 → **120** (band 넓어진 만큼 살짝 짧게)
- 새 `exitGraceMs: 120` — entered 상태에서 exit band 밖에 **연속 120ms** 머물러야 진짜 exit

이 한 번의 변경만으로 *체감 안정성* 이 크게 올라갈 가능성이 큽니다.

### Phase B — Engagement field (1~2h)

새 모듈 `perception/edge-magnet.ts`:

```ts
type EngagementScore = {
  edge: Edge | null    // 가장 강한 score 의 변
  score: number        // 0..1
  perEdge: Record<Edge, number>
}

function computeEngagement(
  point, viewport, config: { outerFrac: 0.20, innerFrac: 0.12 }
): EngagementScore
```

선형 보간이라 매 frame 4번 곱하기 + 비교, 무시 가능한 비용.

`EdgeDetector` 가 binary `classifyEdge` 대신 `computeEngagement` 의 score 를 input 으로:

- score ≥ 1 (inner band 안): 기존과 동일 (dwell 100% rate)
- 0 < score < 1 (approach zone): **dwell credit 을 score 에 비례해서 누적** (예: score=0.5면 70ms 머물러야 35ms 적립)
- score = 0: dwell 누적 안 함, 단 누적된 credit 의 **감쇠는 천천히** (200ms time constant) → jitter 한 프레임에 reset 안 됨

이게 약점 1, 2 를 한 번에 해결.

### Phase C — Velocity bonus + sticky FSM (1h)

`edge-magnet.ts` 에 velocity tracking 추가:

```ts
function computeApproachVelocity(prev, curr, edge): number {
  // 가장자리 방향 단위 벡터에 시선 변화량을 내적
  // 양수 = edge 로 접근 중, 음수 = 멀어짐
}
```

- approach velocity > 300px/s → dwell credit 2x bonus (사용자가 명백히 의도)
- approach velocity 가 매우 큰데 잠시 band 안에 머무름 → over-shoot 인지, instant trigger 도 검토

`EdgeDetector` 가 `entered` 상태에서 exit grace 구현 (Phase A 의 exitGraceMs):

```
case 'entered':
  if (score >= exit_threshold) reset exitGraceStart
  else if (now - exitGraceStart > exitGraceMs) → exit
```

### Phase D — UI snap (30분~1h)

`App.tsx` 가 `EdgeDetector` 의 entered state 일 때 GazeBar 로 넘기는 gaze point 를 변경:

```ts
const effectiveGaze = useMemo(() => {
  if (edgeSnapshot.state !== 'entered' || !edgeSnapshot.edge) return point
  return snapToEdge(point, edgeSnapshot.edge, viewport)
}, [edgeSnapshot, point, viewport])
```

`GazeBar.tsx` 의 hover 계산도 항목 양자화로 단순화:

```ts
// hover = 가장 가까운 항목, 항상 (반경 제한 제거)
const index = Math.round((major - start) / itemSize)
const clamped = Math.max(0, Math.min(items.length - 1, index))
hoveredId = items[clamped].id
```

이게 약점 3, 4 도 자연스럽게 해결 (entered 상태가 유지되는 한 hover 가 항상 결정적).

---

## 4. 디버그 시각화 추가 (별도 30분)

검증 위해 `EdgeZones.tsx` 가 engagement score 를 보이도록:

- 각 변의 alpha 가 그 변의 engagement score 에 비례 (0~1)
- dwelling 중인 변은 score 와 dwell progress 둘 다 표시
- entered 상태에서 effective gaze (snapped) 위치도 다른 색 도트로 표시

이게 있어야 자석 효과가 잘 작동하는지 한눈에 확인 가능.

---

## 5. 위험 / 완화

| 위험 | 영향 | 완화 |
| --- | --- | --- |
| 가장자리 진입이 너무 쉬워져 false trigger 폭증 | 사용자가 평소 작업 중에도 GazeBar 가 튀어나옴 | enterFrac × dwellMs 조합으로 *"진짜 의도하는 행동"* 만 통과하도록. 평가 시 false positive 율 측정 |
| sticky 가 너무 강해 의도된 exit 도 지연됨 | UI 가 "안 닫히는" 느낌 | exitGraceMs 를 100~150ms 로 짧게. 빠른 시선 이동엔 즉시 반응 |
| Velocity bonus 가 무의식적 saccade 를 의도로 오인 | 빠른 화면 훑기 중에 GazeBar 점등 | velocity 임계를 높게 (>400px/s) + saccade fixation 종료까지 dwell 도 같이 봄 |
| GazeBar 항목 양자화로 의도 외 항목 호버 | volume 보려 했는데 brightness 가 잡힘 | 항목 사이에 작은 dead zone (e.g., 항목 경계 ±10% 는 hover 없음) |
| 디버그 시 score 값이 매번 바뀌어 HUD 가 깜빡임 | UX | HUD 의 score 표시에만 추가 EMA 적용 (감지 로직과 별개) |

---

## 6. 검증 — Phase 8 평가 도구 재활용

이미 만들어둔 `⌘⇧E` 5×5 grid 평가에 **새 모드** 추가:

- **edge-trigger eval** — 화면의 4 변 × 임의 위치 8지점에 target 표시. 사용자가 그 위치를 응시하고 GazeBar 가 떠야 함. 성공률 + 시간 측정
- condition 라벨에 `edge-lock-on` 또는 `edge-lock-off` 를 명시해서 A/B 비교 가능

지표:

- **Trigger success rate (%)** — 시선을 가장자리에 두고 1.5초 안에 entered 까지 도달한 비율
- **Mean trigger time (ms)** — 시선이 처음 band 안에 진입한 시각부터 entered 까지의 시간
- **False trigger rate (per minute)** — 평소 작업 중에 의도 없이 GazeBar 가 뜬 빈도 (별도 측정 모드)

목표:

- before (current): trigger success ≈ 60-70%
- after Phase A: ≈ 85%
- after Phase B+C: ≥ 95%
- after Phase D: GazeBar 항목 선택까지 일관되게 성공

---

## 7. 실행 순서 (권장)

1. **Phase A (30분)** 부터 — typecheck 통과만 보고 바로 사용자 테스트. 효과 즉시 체감
2. 부족하면 **Phase B (1~2h)** — engagement field
3. 시간 있으면 **Phase D (1h)** — UI snap (제일 큰 체감 효과)
4. **Phase C (1h)** — velocity bonus 는 fine-tuning 영역
5. **디버그 시각화 (30분)** — Phase B 이상 갈 때 같이

Phase A 만으로 충분히 좋으면 거기서 멈추고 보고서로. 보고서엔 Phase 0–8 + Edge Lock 의 4-layer 전략을 함께 적으면 §5/6 의 *"interruption resilience" 정량 평가 + 시스템 측 보강* 으로 깔끔하게 마무리됩니다.

---

## 8. 보고서 연결

이 작업은 보고서의 두 곳에 직접 닿아요:

- **§1.2 GlanceShift 정의** — *"시선을 coarse target designation 채널로, 머리 기울임을 confirmation 채널로 분리"*. Edge Lock 은 시선 채널이 *coarse* 해도 되도록 시스템이 받쳐주는 명시적 메커니즘. 이름까지 정확히 일치.
- **§4.5 Boundary Conditions** — 시각 요구도가 높은 구간에서 GlanceShift 의 트리거 안정성. Edge Lock 의 sticky 특성이 그 boundary 를 옮김.
- **§6.3 향후 방향** — *"시각 demand 자동 추정 → context-aware GlanceShift"* 의 첫 구현 단계로 frame 할 수 있음 (engagement field 가 context-aware 의 단순 형태).
