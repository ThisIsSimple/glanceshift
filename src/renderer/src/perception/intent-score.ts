/**
 * IntentTracker — Snapping Mode 의 의도 감지 (의도 = "사용자가 edge 를 보려고 한다")
 *
 * 보고서 매핑:
 *   §1.2  시선을 coarse target designation 채널, 머리를 confirmation 채널로 분리
 *         → "의도(Intent)" 와 "위치(Position)" 의 명시적 분리. IntentTracker 는 *의도* 만 추적.
 *   §4.1  Salvucci et al. (2009) — 수백 ms 흡수 가능. 임계 도달 시간 ~150–250ms 범위가 합리적.
 *   §4.4  Jacob (1990) Midas Touch — dwell + 임계값으로 의도/우연 구분.
 *   §4.5  Boundary Conditions — perpendicular accuracy 가 낮은 사용자도 *along-edge* 만으로 판정.
 *
 * 알고리즘 (SNAPPING_MODE_PLAN.md §4.2):
 *   각 변에 대해 ms-equivalent unit 의 score 를 누적/감쇠.
 *   - intent zone 안 + 변에 가까울수록 (closeness ∈ [0,1]) score 증가
 *   - zone 안에 200ms 이상 머무르면 dwell bonus 추가
 *   - lateral velocity (변과 평행한 속도) 가 임계 초과면 penalty (스캔 false trigger 차단)
 *   - 다른 변의 score 는 감쇠
 *
 * RailFSM 이 매 frame update() 를 호출해서 IntentSample 을 받아간다.
 */

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export interface SnapConfig {
  /** Intent zone — viewport 짧은 변 길이의 비율 (예: 0.30 = outer 30%) */
  intentZoneFrac: number
  /** Lock zone — intent zone 보다 약간 넓음. lock 유지에 사용 (hysteresis) */
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
  intentThreshold: 150, // ms-equivalent
  scoreMax: 250,
  decayPerMs: 0.5,
  dwellBonusAfterMs: 200,
  dwellBonusRate: 0.5,
  lateralVelocityPxs: 500,
  lateralPenaltyRate: 0.8,
  exitGraceMs: 250
}

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

type Point = { x: number; y: number }
type Viewport = { w: number; h: number }

const EDGES: Edge[] = ['left', 'right', 'top', 'bottom']

/** edge 별 perpendicular distance (px) — 항상 양수, 0 = 변 위. */
export function perpendicularDistance(g: Point, vp: Viewport, edge: Edge): number {
  switch (edge) {
    case 'left':
      return g.x
    case 'right':
      return vp.w - g.x
    case 'top':
      return g.y
    case 'bottom':
      return vp.h - g.y
  }
}

/** vp_dim[edge] — 해당 변의 perpendicular 방향 viewport 길이 */
export function vpDim(vp: Viewport, edge: Edge): number {
  return edge === 'left' || edge === 'right' ? vp.w : vp.h
}

/**
 * edge inward normal 단위 vector.
 *   left   → (+1, 0)
 *   right  → (-1, 0)
 *   top    → (0, +1)
 *   bottom → (0, -1)
 */
export function edgeNormalInward(edge: Edge): { x: number; y: number } {
  if (edge === 'left') return { x: 1, y: 0 }
  if (edge === 'right') return { x: -1, y: 0 }
  if (edge === 'top') return { x: 0, y: 1 }
  return { x: 0, y: -1 }
}

/** 양수면 edge 로 접근 중. inward normal 의 반대 = edge 방향. */
export function approachVelocity(edge: Edge, vx: number, vy: number): number {
  const n = edgeNormalInward(edge)
  return -(vx * n.x + vy * n.y)
}

/** |edge 와 평행한 속도 성분| (along-edge) */
export function lateralVelocity(edge: Edge, vx: number, vy: number): number {
  if (edge === 'left' || edge === 'right') return Math.abs(vy)
  return Math.abs(vx)
}

export class IntentTracker {
  private scores: Record<Edge, number> = { left: 0, right: 0, top: 0, bottom: 0 }
  private zoneDwellMs = 0
  private currentZoneEdge: Edge | null = null
  private lastNow: number | null = null
  private lastGaze: Point | null = null
  private lastSample: IntentSample = {
    scores: { left: 0, right: 0, top: 0, bottom: 0 },
    primary: null,
    zoneDwellMs: 0,
    lateralVelocity: 0,
    approachVelocity: 0
  }

  constructor(public cfg: SnapConfig = DEFAULT_SNAP_CONFIG) {}

  setConfig(cfg: SnapConfig): void {
    this.cfg = cfg
  }

  reset(): void {
    this.scores = { left: 0, right: 0, top: 0, bottom: 0 }
    this.zoneDwellMs = 0
    this.currentZoneEdge = null
    this.lastNow = null
    this.lastGaze = null
    this.lastSample = {
      scores: { left: 0, right: 0, top: 0, bottom: 0 },
      primary: null,
      zoneDwellMs: 0,
      lateralVelocity: 0,
      approachVelocity: 0
    }
  }

  /** 가장 최근에 계산된 sample (외부에서 RAF 보강용으로 조회). */
  snapshot(): IntentSample {
    return this.lastSample
  }

  /**
   * 매 frame 호출. 내부적으로 dt 계산.
   * gaze=null 또는 음수 좌표 → 점진 감쇠.
   */
  update(gaze: Point | null, vp: Viewport, now: number): IntentSample {
    // 첫 호출 또는 너무 큰 dt 는 50ms 로 clamp (탭 백그라운드 보호)
    const rawDt = this.lastNow != null ? now - this.lastNow : 0
    const dt = Math.max(0, Math.min(50, rawDt))
    this.lastNow = now

    // gaze 가 없으면 전 변 감쇠
    if (!gaze || gaze.x < 0 || gaze.y < 0) {
      for (const e of EDGES) {
        this.scores[e] = Math.max(0, this.scores[e] - dt * this.cfg.decayPerMs)
      }
      this.zoneDwellMs = 0
      this.currentZoneEdge = null
      this.lastGaze = null
      this.lastSample = this.buildSample(0, 0)
      return this.lastSample
    }

    // 1. perpendicular distance 와 zone 내부 여부
    const pd: Record<Edge, number> = {
      left: 0, right: 0, top: 0, bottom: 0
    }
    const inZone: Record<Edge, boolean> = {
      left: false, right: false, top: false, bottom: false
    }
    for (const e of EDGES) {
      pd[e] = perpendicularDistance(gaze, vp, e)
      inZone[e] = pd[e] / vpDim(vp, e) < this.cfg.intentZoneFrac
    }

    // 2. 가장 가까운 변 = primary candidate
    let primaryEdge: Edge = 'left'
    let minPd = Infinity
    for (const e of EDGES) {
      if (pd[e] < minPd) {
        minPd = pd[e]
        primaryEdge = e
      }
    }
    const primaryInZone = inZone[primaryEdge]

    // 3. velocities
    let vx = 0
    let vy = 0
    if (this.lastGaze && dt > 0) {
      vx = (gaze.x - this.lastGaze.x) / (dt / 1000)
      vy = (gaze.y - this.lastGaze.y) / (dt / 1000)
    }
    const approachV = approachVelocity(primaryEdge, vx, vy)
    const lateralV = lateralVelocity(primaryEdge, vx, vy)

    // 4. zone dwell 추적
    if (primaryInZone && this.currentZoneEdge === primaryEdge) {
      this.zoneDwellMs += dt
    } else if (primaryInZone) {
      this.currentZoneEdge = primaryEdge
      this.zoneDwellMs = dt
    } else {
      this.currentZoneEdge = null
      this.zoneDwellMs = 0
    }

    // 5. primary edge score 갱신
    if (primaryInZone) {
      const closeness =
        1 - pd[primaryEdge] / (vpDim(vp, primaryEdge) * this.cfg.intentZoneFrac)
      const dwellBonus =
        this.zoneDwellMs > this.cfg.dwellBonusAfterMs ? this.cfg.dwellBonusRate : 0
      const lateralPen =
        lateralV > this.cfg.lateralVelocityPxs ? this.cfg.lateralPenaltyRate : 0
      const dscore = dt * (closeness + dwellBonus - lateralPen)
      this.scores[primaryEdge] = Math.max(
        0,
        Math.min(this.cfg.scoreMax, this.scores[primaryEdge] + dscore)
      )
    } else {
      this.scores[primaryEdge] = Math.max(
        0,
        this.scores[primaryEdge] - dt * this.cfg.decayPerMs
      )
    }

    // 6. 다른 edge 의 score 는 모두 감쇠
    for (const e of EDGES) {
      if (e === primaryEdge) continue
      this.scores[e] = Math.max(0, this.scores[e] - dt * this.cfg.decayPerMs)
    }

    this.lastGaze = { x: gaze.x, y: gaze.y }
    this.lastSample = this.buildSample(lateralV, approachV)
    return this.lastSample
  }

  /** primary 결정 = 최대 score 의 edge (score 0 이면 null). */
  private buildSample(lateralV: number, approachV: number): IntentSample {
    let bestEdge: Edge = 'left'
    let bestScore = 0
    for (const e of EDGES) {
      if (this.scores[e] > bestScore) {
        bestScore = this.scores[e]
        bestEdge = e
      }
    }
    const primary = bestScore > 0 ? { edge: bestEdge, score: bestScore } : null
    return {
      scores: { ...this.scores },
      primary,
      zoneDwellMs: this.zoneDwellMs,
      lateralVelocity: lateralV,
      approachVelocity: approachV
    }
  }
}
