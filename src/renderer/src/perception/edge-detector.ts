/**
 * Edge Gaze Detector — 시선이 화면 가장자리에 의도적으로 진입한 순간을 판정.
 *
 * 3가지 mode 를 같은 클래스가 처리한다 (config 로 분기):
 *
 *   1. filtered  — OneEuro-filtered gaze + classic dwell FSM.
 *                  비교 분석 의 baseline. "필터 + 좁은 band + dwell" 의 정직한 구현.
 *
 *   2. raw       — unfiltered gaze + 동일한 classic FSM.
 *                  OneEuro 필터의 기여도를 측정하는 control. snap=null.
 *
 *   3. snapping  — OneEuro-filtered gaze + IntentTracker + RailFSM + UI snap.
 *                  의도(Intent) 와 위치(Position) 를 분리. 의도 임계 도달 시 rail lock.
 *                  Lock 중에는 along-edge 좌표만 유지, perpendicular 는 rail 평면에 강제.
 *
 * 보고서 매핑:
 *   §1.2  시선 = coarse target designation 채널 → snapping mode 가 그 의도 직구현
 *   §4.1  Salvucci et al. (2009) 수백 ms 흡수 가능 → dwell 120~150ms 범위 유지
 *   §4.4  Jacob (1990) Midas Touch → enter dwell + exit hysteresis 로 의도 분리
 *   §4.5  Boundary Conditions → mode 별 trigger success rate 정량 비교
 */

import {
  IntentTracker,
  DEFAULT_SNAP_CONFIG,
  perpendicularDistance,
  vpDim,
  type SnapConfig,
  type IntentSample,
  type Edge
} from './intent-score'

export type { Edge } from './intent-score'
export type EdgeState = 'idle' | 'dwelling' | 'entered'
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

/** 3 mode 프로필 — App 이 globalShortcut ⌘⇧1/2/3 로 전환. */
export const EDGE_MODE_PROFILES: Record<ModeLabel, EdgeDetectorConfig> = {
  filtered: {
    modeLabel: 'filtered',
    enterFrac: 0.08,
    exitFrac: 0.12,
    dwellMs: 150,
    exitGraceMs: 0,
    dwellGraceMs: 0,
    snap: null
  },
  raw: {
    modeLabel: 'raw',
    enterFrac: 0.08,
    exitFrac: 0.12,
    dwellMs: 150,
    exitGraceMs: 0,
    dwellGraceMs: 0,
    snap: null
  },
  snapping: {
    modeLabel: 'snapping',
    // classic 분기 값은 사용 안 함 (호환 위해 유지). 실제 동작은 snap config 으로.
    enterFrac: 0,
    exitFrac: 0,
    dwellMs: 0,
    exitGraceMs: 0,
    dwellGraceMs: 0,
    snap: DEFAULT_SNAP_CONFIG
  }
}

export const DEFAULT_EDGE_CONFIG: EdgeDetectorConfig = EDGE_MODE_PROFILES.filtered

export type EdgeEvent =
  | { type: 'enter'; edge: Edge; t: number; mode: ModeLabel }
  | { type: 'exit'; edge: Edge; t: number; mode: ModeLabel }

export type EdgeSnapshot = {
  state: EdgeState
  edge: Edge | null
  dwellProgress: number // 0..1
  enteredAt: number | null
  /** snapping mode 에서 채워짐 — 각 변별 intent score */
  scores?: Record<Edge, number>
  /** 디버그용 — 마지막으로 본 approach velocity (px/s, edge 안쪽 방향 +) */
  approachVelocity?: number
  /** 현재 mode label */
  modeLabel: ModeLabel
  // snapping 전용 추가:
  intentZoneFrac?: number
  lockZoneFrac?: number
  railCursor?: { x: number; y: number } | null
  intentThreshold?: number
  zoneDwellMs?: number
  lateralVelocity?: number
}

type Point = { x: number; y: number }
type Viewport = { w: number; h: number }

/** Binary classifier — 좌표가 어느 edge band 안에 있는지 (혹은 없음). classic FSM 용. */
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

type SnappingState = 'idle' | 'building_intent' | 'rail_locked'

export class EdgeDetector {
  // ===== classic FSM 상태 (filtered/raw) =====
  private state: EdgeState = 'idle'
  private currentEdge: Edge | null = null
  private dwellAccum = 0
  private outOfBandAccum = 0
  private exitGraceAccum = 0
  private enteredAt: number | null = null
  private lastNow: number | null = null
  private lastPoint: Point | null = null

  // ===== snapping FSM 상태 =====
  private snapState: SnappingState = 'idle'
  private snapCurrentEdge: Edge | null = null
  private snapExitGraceAccum = 0
  private snapRailCursor: { x: number; y: number } | null = null
  private intentTracker: IntentTracker | null = null
  private lastIntentSample: IntentSample | null = null

  constructor(public config: EdgeDetectorConfig = DEFAULT_EDGE_CONFIG) {
    if (config.snap) {
      this.intentTracker = new IntentTracker(config.snap)
    }
  }

  /** mode 전환 시 사용 — 상태 리셋 후 새 config 적용. */
  setConfig(cfg: EdgeDetectorConfig): void {
    this.config = cfg
    this.reset()
    if (cfg.snap) {
      this.intentTracker = new IntentTracker(cfg.snap)
    } else {
      this.intentTracker = null
    }
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

    this.snapState = 'idle'
    this.snapCurrentEdge = null
    this.snapExitGraceAccum = 0
    this.snapRailCursor = null
    this.lastIntentSample = null
    if (this.intentTracker) this.intentTracker.reset()
  }

  update(point: Point, viewport: Viewport, now: number): EdgeEvent | null {
    if (this.config.snap) {
      return this.updateSnapping(point, viewport, now)
    }
    return this.updateClassic(point, viewport, now)
  }

  // ============================================================
  // Classic FSM — filtered / raw mode
  // ============================================================
  private updateClassic(point: Point, viewport: Viewport, now: number): EdgeEvent | null {
    const dt = this.lastNow != null ? Math.max(0, Math.min(200, now - this.lastNow)) : 0

    const primaryEdge = classifyEdge(point, viewport, this.config.enterFrac)
    const primaryScore = primaryEdge ? 1 : 0
    const exitEdge = classifyEdge(point, viewport, this.config.exitFrac)

    let event: EdgeEvent | null = null

    switch (this.state) {
      case 'idle': {
        if (primaryEdge && primaryScore > 0) {
          this.state = 'dwelling'
          this.currentEdge = primaryEdge
          this.dwellAccum = primaryScore * dt
          this.outOfBandAccum = 0
        }
        break
      }

      case 'dwelling': {
        if (primaryEdge === this.currentEdge && primaryScore > 0) {
          this.dwellAccum += primaryScore * dt
          this.outOfBandAccum = 0
        } else if (primaryEdge && primaryEdge !== this.currentEdge && primaryScore > 0.5) {
          this.currentEdge = primaryEdge
          this.dwellAccum = primaryScore * dt
          this.outOfBandAccum = 0
        } else {
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

  // ============================================================
  // Rail FSM — snapping mode
  // ============================================================
  private updateSnapping(point: Point, viewport: Viewport, now: number): EdgeEvent | null {
    const snapCfg = this.config.snap!
    const tracker = this.intentTracker!
    const dt = this.lastNow != null ? Math.max(0, Math.min(200, now - this.lastNow)) : 0

    let event: EdgeEvent | null = null

    switch (this.snapState) {
      case 'idle': {
        // intent 추적만, lock 없음
        this.lastIntentSample = tracker.update(point, viewport, now)
        if (this.lastIntentSample.primary) {
          this.snapState = 'building_intent'
          this.snapCurrentEdge = this.lastIntentSample.primary.edge
        }
        break
      }

      case 'building_intent': {
        this.lastIntentSample = tracker.update(point, viewport, now)
        const primary = this.lastIntentSample.primary
        if (!primary) {
          this.snapState = 'idle'
          this.snapCurrentEdge = null
        } else if (primary.edge !== this.snapCurrentEdge) {
          // 다른 변으로 의도 전환
          this.snapCurrentEdge = primary.edge
        } else if (primary.score >= snapCfg.intentThreshold) {
          // Lock 진입
          this.snapState = 'rail_locked'
          this.enteredAt = now
          this.snapExitGraceAccum = 0
          this.snapRailCursor = projectToRail(point, this.snapCurrentEdge!, viewport)
          tracker.reset() // score 누적 끊고 lock 유지 모드로
          event = {
            type: 'enter',
            edge: this.snapCurrentEdge!,
            t: now,
            mode: this.config.modeLabel
          }
        }
        break
      }

      case 'rail_locked': {
        // intentTracker 는 lock 중에는 호출 안 함 (계산 낭비). lastIntentSample 도 그대로 유지.
        if (this.snapCurrentEdge && inLockZone(point, viewport, this.snapCurrentEdge, snapCfg.lockZoneFrac)) {
          this.snapRailCursor = projectToRail(point, this.snapCurrentEdge, viewport)
          this.snapExitGraceAccum = 0
        } else {
          this.snapExitGraceAccum += dt
          if (this.snapExitGraceAccum >= snapCfg.exitGraceMs) {
            const edge = this.snapCurrentEdge!
            this.snapState = 'idle'
            this.snapCurrentEdge = null
            this.snapRailCursor = null
            this.enteredAt = null
            this.snapExitGraceAccum = 0
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
    if (this.config.snap) {
      // snapping mode → snapState 매핑
      const snapCfg = this.config.snap
      let state: EdgeState = 'idle'
      let progress = 0
      if (this.snapState === 'building_intent') {
        state = 'dwelling'
        const score = this.lastIntentSample?.primary?.score ?? 0
        progress = Math.min(1, score / Math.max(1, snapCfg.intentThreshold))
      } else if (this.snapState === 'rail_locked') {
        state = 'entered'
        progress = 1
      }
      const snap: EdgeSnapshot = {
        state,
        edge: this.snapCurrentEdge,
        dwellProgress: progress,
        enteredAt: this.enteredAt,
        modeLabel: this.config.modeLabel,
        intentZoneFrac: snapCfg.intentZoneFrac,
        lockZoneFrac: snapCfg.lockZoneFrac,
        intentThreshold: snapCfg.intentThreshold,
        railCursor: this.snapRailCursor
      }
      if (this.lastIntentSample) {
        snap.scores = this.lastIntentSample.scores
        snap.approachVelocity = this.lastIntentSample.approachVelocity
        snap.lateralVelocity = this.lastIntentSample.lateralVelocity
        snap.zoneDwellMs = this.lastIntentSample.zoneDwellMs
      }
      return snap
    }

    // classic FSM (filtered / raw)
    let progress = 0
    if (this.state === 'dwelling') {
      progress = Math.min(1, this.dwellAccum / Math.max(1, this.config.dwellMs))
    } else if (this.state === 'entered') {
      progress = 1
    }
    return {
      state: this.state,
      edge: this.currentEdge,
      dwellProgress: progress,
      enteredAt: this.enteredAt,
      modeLabel: this.config.modeLabel
    }
  }
}

// ============================================================
// Rail / snap utilities — snapping mode 전용
// ============================================================

/** GazeBar.tsx 의 computeGeometry 와 같은 thickness 산식. */
function railThickness(vp: Viewport): number {
  const minSide = Math.min(vp.w, vp.h)
  return Math.max(56, Math.min(80, minSide * 0.06))
}

/**
 * edge 의 rail (1D 트랙) 의 perpendicular 좌표.
 * along-edge 좌표는 호출자가 별도로 clamp.
 */
export function railPosition(edge: Edge, vp: Viewport): { x: number; y: number } {
  const thickness = railThickness(vp)
  switch (edge) {
    case 'right':
      return { x: vp.w - thickness / 2, y: 0 }
    case 'left':
      return { x: thickness / 2, y: 0 }
    case 'top':
      return { x: 0, y: thickness / 2 }
    case 'bottom':
      return { x: 0, y: vp.h - thickness / 2 }
  }
}

/**
 * gaze 좌표를 rail (1D) 위로 투영.
 * perpendicular 좌표는 변에서 thickness/2 안쪽 (= GazeBar 의 중심선).
 * along-edge 좌표는 GazeBar 의 활성 영역 (변 중심 ±30%, 총 60%) 으로 clamp.
 */
export function projectToRail(gaze: Point, edge: Edge, vp: Viewport): { x: number; y: number } {
  const rail = railPosition(edge, vp)
  const isVert = edge === 'left' || edge === 'right'
  const along = isVert ? vp.h : vp.w
  const start = along * 0.20
  const end = along * 0.80
  const clamp = (v: number): number => Math.max(start, Math.min(end, v))
  if (isVert) return { x: rail.x, y: clamp(gaze.y) }
  return { x: clamp(gaze.x), y: rail.y }
}

/** lock zone 판정. lockZoneFrac > intentZoneFrac (보통 0.35 vs 0.30) — hysteresis. */
function inLockZone(gaze: Point, vp: Viewport, edge: Edge, lockZoneFrac: number): boolean {
  if (gaze.x < 0 || gaze.y < 0) return false
  const pd = perpendicularDistance(gaze, vp, edge)
  return pd / vpDim(vp, edge) < lockZoneFrac
}

/**
 * (Legacy) Entered 상태에서 effective gaze 를 변에 투영.
 * filtered/raw mode 의 경우 호출자가 사용 — perpendicular 만 강제, along 은 원본.
 * snapping mode 는 EdgeDetector 가 자체적으로 projectToRail 을 쓰므로 이 함수는 불필요.
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
