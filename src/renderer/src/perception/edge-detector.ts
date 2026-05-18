/**
 * Edge Gaze Detector — 시선이 화면 가장자리에 dwell 한 순간을 판정.
 *
 * 3가지 mode 를 같은 클래스가 처리한다 (config 로 분기):
 *
 *   1. classic  — 보고서 §3.3 Modes 의 baseline. binary band + 즉시 reset/exit.
 *                 비교 분석 의 reference.
 *
 *   2. sticky   — Edge Lock plan Phase A + D.
 *                 band 넓힘 (12% / 20%), dwell 중 grace 80ms, exit grace 120ms.
 *                 entered 상태에서 GazeBar 쪽 gaze snap (호출자가 처리).
 *
 *   3. magnetic — Edge Lock plan Phase A + B + C + D.
 *                 engagement field (0..1 score), score 비례 dwell credit,
 *                 approach velocity 2x bonus, sticky FSM, UI snap.
 *
 * 보고서 매핑:
 *   §1.2  시선 = coarse target designation 채널 → sticky/magnetic 이 그 의도 직구현
 *   §4.1  Salvucci et al. (2009) 수백 ms 흡수 가능 → dwell 120~150ms 범위 유지
 *   §4.4  Jacob (1990) Midas Touch → enter dwell + exit hysteresis 로 의도 분리
 *   §4.5  Boundary Conditions → mode 별 trigger success rate 정량 비교
 */

export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type EdgeState = 'idle' | 'dwelling' | 'entered'

export interface EdgeDetectorConfig {
  /** 진입 band 폭 (각 변에서) — viewport 비율 */
  enterFrac: number
  /** 이탈 band 폭 — 진입보다 안쪽까지 들어와야 함 (hysteresis) */
  exitFrac: number
  /** 진입 dwell 누적 시간 ms */
  dwellMs: number
  /** 0 = 즉시 reset/exit (classic). >0 = grace 기간 동안 jitter 허용 */
  exitGraceMs: number
  /** dwelling 중 band 밖 grace ms. 0 = 즉시 reset */
  dwellGraceMs: number
  /** Engagement field outer boundary (viewport 비율). null = binary (Mode 1/2), 값 = magnetic (Mode 3) */
  approachFrac: number | null
  /** Approach velocity 가 임계 초과 시 dwell credit 2x */
  velocityBonus: boolean
  /** 디버그용 mode 식별자 */
  modeLabel: 'classic' | 'sticky' | 'magnetic'
}

/** 3 mode 프로필 — App 이 globalShortcut ⌘⇧1/2/3 로 전환. */
export const EDGE_MODE_PROFILES: Record<EdgeDetectorConfig['modeLabel'], EdgeDetectorConfig> = {
  classic: {
    enterFrac: 0.08,
    exitFrac: 0.12,
    dwellMs: 150,
    exitGraceMs: 0,
    dwellGraceMs: 0,
    approachFrac: null,
    velocityBonus: false,
    modeLabel: 'classic'
  },
  sticky: {
    enterFrac: 0.12,
    exitFrac: 0.20,
    dwellMs: 120,
    exitGraceMs: 120,
    dwellGraceMs: 80,
    approachFrac: null,
    velocityBonus: false,
    modeLabel: 'sticky'
  },
  magnetic: {
    enterFrac: 0.12,
    exitFrac: 0.20,
    dwellMs: 120,
    exitGraceMs: 150,
    dwellGraceMs: 200,
    approachFrac: 0.22,
    velocityBonus: true,
    modeLabel: 'magnetic'
  }
}

export const DEFAULT_EDGE_CONFIG: EdgeDetectorConfig = EDGE_MODE_PROFILES.classic

export type EdgeEvent =
  | { type: 'enter'; edge: Edge; t: number; mode: EdgeDetectorConfig['modeLabel'] }
  | { type: 'exit'; edge: Edge; t: number; mode: EdgeDetectorConfig['modeLabel'] }

export type EdgeSnapshot = {
  state: EdgeState
  edge: Edge | null
  dwellProgress: number     // 0..1
  enteredAt: number | null
  /** magnetic mode 에서 채워짐 — 각 변별 engagement score (0..1) */
  scores?: Record<Edge, number>
  /** 디버그용 — 마지막으로 본 approach velocity (px/s, edge normal 방향) */
  approachVelocity?: number
  /** 현재 mode label */
  modeLabel: EdgeDetectorConfig['modeLabel']
}

type Point = { x: number; y: number }
type Viewport = { w: number; h: number }

const VELOCITY_THRESHOLD_PXS = 350  // px/s — 이 이상이면 의도적 approach 판정

/** Binary classifier — 좌표가 어느 edge band 안에 있는지 (혹은 없음). */
function classifyEdge(p: Point, vp: Viewport, frac: number): Edge | null {
  if (p.x < 0 || p.y < 0) return null
  const lx = vp.w * frac
  const rx = vp.w * (1 - frac)
  const ty = vp.h * frac
  const by = vp.h * (1 - frac)

  const onLeft = p.x < lx
  const onRight = p.x > rx
  const onTop = p.y < ty
  const onBottom = p.y > by
  if (!(onLeft || onRight || onTop || onBottom)) return null

  const candidates: Array<[Edge, number]> = []
  if (onLeft) candidates.push(['left', p.x])
  if (onRight) candidates.push(['right', vp.w - p.x])
  if (onTop) candidates.push(['top', p.y])
  if (onBottom) candidates.push(['bottom', vp.h - p.y])
  candidates.sort((a, b) => a[1] - b[1])
  return candidates[0][0]
}

/** 변별 engagement score: outer ~ inner 사이를 0..1 로 선형 보간. */
function computeEngagement(
  p: Point,
  vp: Viewport,
  outerFrac: number,
  innerFrac: number
): Record<Edge, number> {
  const w = vp.w, h = vp.h
  // outer = 영향이 0이 되는 거리, inner = 1 이 되는 거리. inner < outer.
  // distance from each edge:
  const dLeft = p.x / w
  const dRight = (w - p.x) / w
  const dTop = p.y / h
  const dBottom = (h - p.y) / h

  function score(distFrac: number): number {
    // distFrac 0 ~ outerFrac 까지가 의미 있는 범위.
    // distFrac < innerFrac 면 score = 1, distFrac > outerFrac 면 0.
    if (distFrac <= innerFrac) return 1
    if (distFrac >= outerFrac) return 0
    return 1 - (distFrac - innerFrac) / (outerFrac - innerFrac)
  }
  return {
    left: score(dLeft),
    right: score(dRight),
    top: score(dTop),
    bottom: score(dBottom)
  }
}

/** 가장 큰 score 의 edge 와 그 값 반환. score 0 이면 null. */
function pickPrimary(scores: Record<Edge, number>): { edge: Edge | null; score: number } {
  let best: Edge | null = null
  let bestScore = 0
  for (const e of ['left', 'right', 'top', 'bottom'] as Edge[]) {
    if (scores[e] > bestScore) {
      bestScore = scores[e]
      best = e
    }
  }
  return { edge: best, score: bestScore }
}

/** edge 의 inward-normal 방향 단위 vector. */
function edgeNormal(edge: Edge): { dx: number; dy: number } {
  if (edge === 'left') return { dx: -1, dy: 0 }
  if (edge === 'right') return { dx: 1, dy: 0 }
  if (edge === 'top') return { dx: 0, dy: -1 }
  return { dx: 0, dy: 1 }
}

/** 시선이 변 쪽으로 얼마나 빨리 이동 중인지 (px/s, 양수 = 가까워짐). */
function approachVelocity(prev: Point, curr: Point, edge: Edge, dt: number): number {
  if (dt <= 0) return 0
  const { dx, dy } = edgeNormal(edge)
  // outward direction toward edge = -normal (normal 은 inward)
  const vx = (curr.x - prev.x) / (dt / 1000)
  const vy = (curr.y - prev.y) / (dt / 1000)
  // outward 성분이 양수면 edge 로 접근 중
  return vx * -dx + vy * -dy
}

export class EdgeDetector {
  private state: EdgeState = 'idle'
  private currentEdge: Edge | null = null
  private dwellAccum = 0
  private outOfBandAccum = 0
  private exitGraceAccum = 0
  private enteredAt: number | null = null
  private lastNow: number | null = null
  private lastPoint: Point | null = null
  private lastScores: Record<Edge, number> | null = null
  private lastVelocity = 0

  constructor(public config: EdgeDetectorConfig = DEFAULT_EDGE_CONFIG) {}

  /** mode 전환 시 사용 — 상태 리셋 후 새 config 적용. */
  setConfig(cfg: EdgeDetectorConfig): void {
    this.config = cfg
    this.reset()
  }

  reset(): void {
    this.state = 'idle'
    this.currentEdge = null
    this.dwellAccum = 0
    this.outOfBandAccum = 0
    this.exitGraceAccum = 0
    this.enteredAt = null
    this.lastNow = null
    this.lastPoint = null
    this.lastScores = null
    this.lastVelocity = 0
  }

  update(point: Point, viewport: Viewport, now: number): EdgeEvent | null {
    // dt 계산 (px/s velocity, ms accumulator 모두에 쓰임)
    const dt = this.lastNow != null ? Math.max(0, Math.min(200, now - this.lastNow)) : 0
    // 한 frame skip 이 너무 크면 영향을 제한 (200ms cap)

    // ===== 1. 입력 분류 =====
    // approachFrac 가 있으면 engagement field, 없으면 binary
    let primaryEdge: Edge | null
    let primaryScore: number
    let scores: Record<Edge, number> | null = null
    if (this.config.approachFrac != null) {
      scores = computeEngagement(point, viewport, this.config.approachFrac, this.config.enterFrac)
      const picked = pickPrimary(scores)
      primaryEdge = picked.edge
      primaryScore = picked.score
    } else {
      primaryEdge = classifyEdge(point, viewport, this.config.enterFrac)
      primaryScore = primaryEdge ? 1 : 0
    }
    this.lastScores = scores

    // exit 판정은 mode 무관하게 binary exitFrac
    const exitEdge = classifyEdge(point, viewport, this.config.exitFrac)

    // velocity factor
    let velocityFactor = 1
    if (this.config.velocityBonus && this.lastPoint && primaryEdge && dt > 0) {
      const v = approachVelocity(this.lastPoint, point, primaryEdge, dt)
      this.lastVelocity = v
      if (v > VELOCITY_THRESHOLD_PXS) velocityFactor = 2
    } else {
      this.lastVelocity = 0
    }

    // ===== 2. 상태 머신 =====
    let event: EdgeEvent | null = null

    switch (this.state) {
      case 'idle': {
        if (primaryEdge && primaryScore > 0) {
          this.state = 'dwelling'
          this.currentEdge = primaryEdge
          this.dwellAccum = primaryScore * dt * velocityFactor
          this.outOfBandAccum = 0
        }
        break
      }

      case 'dwelling': {
        if (primaryEdge === this.currentEdge && primaryScore > 0) {
          // 같은 변에 머무름: credit 누적
          this.dwellAccum += primaryScore * dt * velocityFactor
          this.outOfBandAccum = 0
        } else if (primaryEdge && primaryEdge !== this.currentEdge && primaryScore > 0.5) {
          // 다른 변으로 분명히 옮겨감 → 새 dwell 시작
          this.currentEdge = primaryEdge
          this.dwellAccum = primaryScore * dt * velocityFactor
          this.outOfBandAccum = 0
        } else {
          // band 밖 (또는 score 0) — grace 누적
          this.outOfBandAccum += dt
          if (this.outOfBandAccum > this.config.dwellGraceMs) {
            this.state = 'idle'
            this.currentEdge = null
            this.dwellAccum = 0
            this.outOfBandAccum = 0
          }
        }

        if (this.state === 'dwelling' && this.dwellAccum >= this.config.dwellMs) {
          this.state = 'entered'
          this.enteredAt = now
          this.dwellAccum = 0
          this.exitGraceAccum = 0
          event = { type: 'enter', edge: this.currentEdge!, t: now, mode: this.config.modeLabel }
        }
        break
      }

      case 'entered': {
        if (exitEdge === this.currentEdge) {
          // 여전히 exit band 안 — grace 리셋
          this.exitGraceAccum = 0
        } else {
          this.exitGraceAccum += dt
          if (this.exitGraceAccum >= this.config.exitGraceMs) {
            const edge = this.currentEdge!
            this.state = 'idle'
            this.currentEdge = null
            this.enteredAt = null
            this.exitGraceAccum = 0
            event = { type: 'exit', edge, t: now, mode: this.config.modeLabel }
          }
        }
        break
      }
    }

    this.lastNow = now
    this.lastPoint = point
    return event
  }

  snapshot(_now: number): EdgeSnapshot {
    let progress = 0
    if (this.state === 'dwelling') {
      progress = Math.min(1, this.dwellAccum / this.config.dwellMs)
    } else if (this.state === 'entered') {
      progress = 1
    }
    const snap: EdgeSnapshot = {
      state: this.state,
      edge: this.currentEdge,
      dwellProgress: progress,
      enteredAt: this.enteredAt,
      modeLabel: this.config.modeLabel
    }
    if (this.lastScores) snap.scores = this.lastScores
    if (this.lastVelocity) snap.approachVelocity = this.lastVelocity
    return snap
  }
}

// ===== Gaze snap utilities (Mode 2/3 에서 GazeBar 의 hover 정확도 보강용) =====

/**
 * Entered 상태에서 effective gaze 를 변에 투영.
 * perpendicular 좌표는 변 평면으로 강제, parallel 좌표는 원본 유지.
 */
export function snapToEdge(
  point: Point,
  edge: Edge,
  viewport: Viewport
): { x: number; y: number } {
  switch (edge) {
    case 'right':
      return { x: viewport.w * 0.94, y: point.y }
    case 'left':
      return { x: viewport.w * 0.06, y: point.y }
    case 'top':
      return { x: point.x, y: viewport.h * 0.06 }
    case 'bottom':
      return { x: point.x, y: viewport.h * 0.94 }
  }
}
