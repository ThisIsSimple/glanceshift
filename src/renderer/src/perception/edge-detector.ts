/**
 * Edge Gaze Detector — 시선이 화면 가장자리에 의도적으로 진입한 순간을 판정.
 *
 * Tracker gaze + IntentTracker + Rail FSM + UI snap.
 *   의도(Intent) 와 위치(Position) 를 분리한다. 의도 score 가 임계에 도달하면 rail lock.
 *   Lock 중에는 along-edge 좌표만 유지하고 perpendicular 는 rail 평면에 강제한다.
 *
 * 보고서 매핑:
 *   §1.2  시선 = coarse target designation 채널 → 의도 score 로 직구현
 *   §4.1  Salvucci et al. (2009) 수백 ms 흡수 가능 → intent 임계 도달 ~150–250ms
 *   §4.4  Jacob (1990) Midas Touch → intent dwell + exit hysteresis 로 의도 분리
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
import { railThickness } from './geometry'

export type { Edge } from './intent-score'

/** UI 가 소비하는 추상 상태 — Rail FSM 의 building_intent/rail_locked 를 매핑. */
export type EdgeState = 'idle' | 'dwelling' | 'entered'

export type EdgeEvent =
  | { type: 'enter'; edge: Edge; t: number }
  | { type: 'exit'; edge: Edge; t: number }

export type EdgeSnapshot = {
  state: EdgeState
  edge: Edge | null
  dwellProgress: number // 0..1
  enteredAt: number | null
  intentZoneFrac: number
  lockZoneFrac: number
  intentThreshold: number
  railCursor: { x: number; y: number } | null
  /** 각 변별 intent score — lastIntentSample 이 있을 때만 */
  scores?: Record<Edge, number>
  /** 디버그용 — 마지막으로 본 approach velocity (px/s, edge 안쪽 방향 +) */
  approachVelocity?: number
  zoneDwellMs?: number
  lateralVelocity?: number
}

type Point = { x: number; y: number }
type Viewport = { w: number; h: number }

type SnappingState = 'idle' | 'building_intent' | 'rail_locked'

export class EdgeDetector {
  private snapState: SnappingState = 'idle'
  private snapCurrentEdge: Edge | null = null
  private snapExitGraceAccum = 0
  private snapRailCursor: { x: number; y: number } | null = null
  private enteredAt: number | null = null
  private lastNow: number | null = null
  private intentTracker: IntentTracker
  private lastIntentSample: IntentSample | null = null
  /** 현재 동적 hold zone 비율 (B-1) — operating 시 확장, idle 시 base 로 수축. */
  private holdFrac: number

  constructor(public config: SnapConfig = DEFAULT_SNAP_CONFIG) {
    this.intentTracker = new IntentTracker(config)
    this.holdFrac = config.lockZoneFrac
  }

  /** config 교체 시 사용 — 상태 리셋 후 새 config 적용. */
  setConfig(cfg: SnapConfig): void {
    this.config = cfg
    this.reset()
    this.intentTracker = new IntentTracker(cfg)
    this.holdFrac = cfg.lockZoneFrac
  }

  reset(): void {
    this.snapState = 'idle'
    this.snapCurrentEdge = null
    this.snapExitGraceAccum = 0
    this.snapRailCursor = null
    this.enteredAt = null
    this.lastNow = null
    this.lastIntentSample = null
    this.intentTracker.reset()
    this.holdFrac = this.config.lockZoneFrac
  }

  // ============================================================
  // Rail FSM
  // ============================================================
  // operating: head-tilt 로 값을 조작 중인지 (App 이 전달). true 면 hold zone 확장(B-1).
  update(point: Point, viewport: Viewport, now: number, operating = false): EdgeEvent | null {
    const cfg = this.config
    const tracker = this.intentTracker
    const dt = this.lastNow != null ? Math.max(0, Math.min(200, now - this.lastNow)) : 0

    // 동적 hold zone — 확장은 즉시, 수축은 holdZoneDecayMs 시상수로 부드럽게.
    const targetFrac = operating ? cfg.lockZoneFracActive : cfg.lockZoneFrac
    if (targetFrac >= this.holdFrac) {
      this.holdFrac = targetFrac
    } else {
      const k = cfg.holdZoneDecayMs > 0 ? 1 - Math.exp(-dt / cfg.holdZoneDecayMs) : 1
      this.holdFrac += (targetFrac - this.holdFrac) * k
    }

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
        } else if (primary.score >= cfg.intentThreshold) {
          // Lock 진입
          this.snapState = 'rail_locked'
          this.enteredAt = now
          this.snapExitGraceAccum = 0
          this.snapRailCursor = projectToRail(point, this.snapCurrentEdge!, viewport)
          tracker.reset() // score 누적 끊고 lock 유지 모드로
          event = { type: 'enter', edge: this.snapCurrentEdge!, t: now }
        }
        break
      }

      case 'rail_locked': {
        // intentTracker 는 lock 중에는 호출 안 함 (계산 낭비). lastIntentSample 도 그대로 유지.
        // hold 판정은 동적 holdFrac 사용 — 조작 중엔 확장된 zone 으로 시선이 떠나도 유지.
        if (this.snapCurrentEdge && inLockZone(point, viewport, this.snapCurrentEdge, this.holdFrac)) {
          this.snapRailCursor = projectToRail(point, this.snapCurrentEdge, viewport)
          this.snapExitGraceAccum = 0
        } else {
          this.snapExitGraceAccum += dt
          if (this.snapExitGraceAccum >= cfg.exitGraceMs) {
            const edge = this.snapCurrentEdge!
            this.snapState = 'idle'
            this.snapCurrentEdge = null
            this.snapRailCursor = null
            this.enteredAt = null
            this.snapExitGraceAccum = 0
            event = { type: 'exit', edge, t: now }
          }
        }
        break
      }
    }

    this.lastNow = now
    return event
  }

  snapshot(_now: number): EdgeSnapshot {
    const cfg = this.config
    let state: EdgeState = 'idle'
    let progress = 0
    if (this.snapState === 'building_intent') {
      state = 'dwelling'
      const score = this.lastIntentSample?.primary?.score ?? 0
      progress = Math.min(1, score / Math.max(1, cfg.intentThreshold))
    } else if (this.snapState === 'rail_locked') {
      state = 'entered'
      progress = 1
    }

    const snap: EdgeSnapshot = {
      state,
      edge: this.snapCurrentEdge,
      dwellProgress: progress,
      enteredAt: this.enteredAt,
      intentZoneFrac: this.lastIntentSample?.enterFrac ?? cfg.intentZoneFrac, // 동적 (B-3)
      lockZoneFrac: this.holdFrac, // 동적 (B-1) — EdgeZones/HUD 가 확장/수축을 시각화
      intentThreshold: cfg.intentThreshold,
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
}

// ============================================================
// Rail / snap utilities
// ============================================================

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

/** lock zone 판정. lockZoneFrac > intentZoneFrac (hysteresis). */
function inLockZone(gaze: Point, vp: Viewport, edge: Edge, lockZoneFrac: number): boolean {
  if (gaze.x < 0 || gaze.y < 0) return false
  const pd = perpendicularDistance(gaze, vp, edge)
  return pd / vpDim(vp, edge) < lockZoneFrac
}
