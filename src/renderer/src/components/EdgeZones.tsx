/**
 * EdgeZones — 디버그 모드에서 4개 가장자리 band 를 시각화한다.
 *
 * 평소엔 보이지 않다가 (cool 매체 원칙) ⌘⇧D 를 켜면 다음을 표시:
 *
 *   filtered/raw mode:
 *     - 가장자리 영역 (enterFrac 폭, ~8%)
 *     - 현재 dwelling 중인 변은 진행률에 비례해 강조
 *     - entered 상태에 들어간 변은 진한 색으로 강조
 *
 *   snapping mode:
 *     - IntentZone (intentZoneFrac, ~30%) — 옅은 파란 사각형 + 점선
 *     - LockZone (lockZoneFrac, ~35%) — 더 옅은 노랑 점선 외곽 (IntentZone 바깥)
 *     - primary edge 의 IntentZone 은 intent score 에 비례해 진해짐
 *     - rail_locked 상태에서는 rail line 자체도 표시
 *
 * 실제 사용자에게 보일 GazeBar UI 는 Phase 4 에서 구현.
 */

import { memo } from 'react'
import type { EdgeSnapshot, Edge } from '../perception/edge-detector'
import { railThickness } from '../perception/geometry'

type Props = {
  /** 진입 band 폭 비율 (filtered/raw 의 enterFrac) */
  enterFrac: number
  /** Intent zone 폭 비율 (snapping mode 에서만 설정) */
  intentZoneFrac?: number | null
  /** Lock zone 폭 비율 (snapping mode 에서만 설정) — IntentZone 바깥 hysteresis */
  lockZoneFrac?: number | null
  /** 화면 viewport */
  viewport: { w: number; h: number }
  /** 현재 detector snapshot */
  snapshot: EdgeSnapshot
  visible: boolean
}

function EdgeZonesImpl({
  enterFrac,
  intentZoneFrac,
  lockZoneFrac,
  viewport,
  snapshot,
  visible
}: Props): JSX.Element | null {
  if (!visible) return null

  // snapping mode (intentZone 설정됨) → snap 시각화 분기, 아니면 classic 시각화
  const isSnapping = intentZoneFrac != null && intentZoneFrac > 0

  if (isSnapping) {
    return (
      <SnappingZones
        intentZoneFrac={intentZoneFrac}
        lockZoneFrac={lockZoneFrac ?? intentZoneFrac}
        viewport={viewport}
        snapshot={snapshot}
      />
    )
  }

  return <ClassicZones enterFrac={enterFrac} viewport={viewport} snapshot={snapshot} />
}

export const EdgeZones = memo(EdgeZonesImpl)

// ============================================================
// Classic (filtered / raw) — narrow enter band 만 표시
// ============================================================
function ClassicZones({
  enterFrac,
  viewport,
  snapshot
}: {
  enterFrac: number
  viewport: { w: number; h: number }
  snapshot: EdgeSnapshot
}): JSX.Element {
  const xBand = viewport.w * enterFrac
  const yBand = viewport.h * enterFrac

  function activity(edge: Edge): number {
    if (snapshot.state === 'entered' && snapshot.edge === edge) return 2
    if (snapshot.edge === edge && snapshot.state === 'dwelling')
      return Math.max(0.3, snapshot.dwellProgress)
    return 0
  }

  function zoneStyle(act: number): React.CSSProperties {
    if (act === 0) {
      return {
        background: 'rgba(90, 169, 255, 0.05)',
        borderColor: 'rgba(90, 169, 255, 0.18)'
      }
    }
    if (act >= 2) {
      return {
        background: 'rgba(90, 169, 255, 0.22)',
        borderColor: 'rgba(90, 169, 255, 0.9)'
      }
    }
    const alpha = 0.05 + act * 0.15
    const bAlpha = 0.18 + act * 0.5
    return {
      background: `rgba(90, 169, 255, ${alpha})`,
      borderColor: `rgba(90, 169, 255, ${bAlpha})`
    }
  }

  return (
    <>
      <div
        className="edge-zone-debug"
        style={{ ...zoneStyle(activity('left')), left: 0, top: 0, width: xBand, height: viewport.h }}
      />
      <div
        className="edge-zone-debug"
        style={{ ...zoneStyle(activity('right')), right: 0, top: 0, width: xBand, height: viewport.h }}
      />
      <div
        className="edge-zone-debug"
        style={{ ...zoneStyle(activity('top')), left: 0, top: 0, width: viewport.w, height: yBand }}
      />
      <div
        className="edge-zone-debug"
        style={{ ...zoneStyle(activity('bottom')), left: 0, bottom: 0, width: viewport.w, height: yBand }}
      />
    </>
  )
}

// ============================================================
// Snapping — IntentZone + LockZone 외곽 + rail line
// ============================================================
function SnappingZones({
  intentZoneFrac,
  lockZoneFrac,
  viewport,
  snapshot
}: {
  intentZoneFrac: number
  lockZoneFrac: number
  viewport: { w: number; h: number }
  snapshot: EdgeSnapshot
}): JSX.Element {
  const xIntent = viewport.w * intentZoneFrac
  const yIntent = viewport.h * intentZoneFrac
  const xLock = viewport.w * lockZoneFrac
  const yLock = viewport.h * lockZoneFrac

  // primary edge 의 score 비례 강조 — score / threshold 로 정규화 (0..1)
  const threshold = snapshot.intentThreshold ?? 1
  function intentEmphasis(edge: Edge): number {
    if (snapshot.state === 'entered' && snapshot.edge === edge) return 1
    const s = snapshot.scores?.[edge] ?? 0
    if (s === 0) return 0
    return Math.min(1, s / Math.max(1, threshold))
  }

  function intentZoneStyle(emp: number): React.CSSProperties {
    // base 0.04 → max 0.22 alpha. 외곽 dash 도 emp 에 따라 진해짐.
    const bg = 0.04 + emp * 0.18
    const border = 0.22 + emp * 0.55
    return {
      background: `rgba(90, 169, 255, ${bg})`,
      borderColor: `rgba(90, 169, 255, ${border})`
    }
  }

  // rail line 표시 — entered 상태에서만
  const railEdge = snapshot.state === 'entered' ? snapshot.edge : null

  return (
    <>
      {/* Lock zone outlines (외곽) — 가장 옅은 노랑 점선 */}
      <div
        className="edge-lock-zone-outline"
        style={{ left: 0, top: 0, width: xLock, height: viewport.h }}
      />
      <div
        className="edge-lock-zone-outline"
        style={{ right: 0, top: 0, width: xLock, height: viewport.h }}
      />
      <div
        className="edge-lock-zone-outline"
        style={{ left: 0, top: 0, width: viewport.w, height: yLock }}
      />
      <div
        className="edge-lock-zone-outline"
        style={{ left: 0, bottom: 0, width: viewport.w, height: yLock }}
      />

      {/* Intent zones — primary 면 score 비례 강조 */}
      <div
        className="edge-intent-zone"
        style={{
          ...intentZoneStyle(intentEmphasis('left')),
          left: 0,
          top: 0,
          width: xIntent,
          height: viewport.h
        }}
      />
      <div
        className="edge-intent-zone"
        style={{
          ...intentZoneStyle(intentEmphasis('right')),
          right: 0,
          top: 0,
          width: xIntent,
          height: viewport.h
        }}
      />
      <div
        className="edge-intent-zone"
        style={{
          ...intentZoneStyle(intentEmphasis('top')),
          left: 0,
          top: 0,
          width: viewport.w,
          height: yIntent
        }}
      />
      <div
        className="edge-intent-zone"
        style={{
          ...intentZoneStyle(intentEmphasis('bottom')),
          left: 0,
          bottom: 0,
          width: viewport.w,
          height: yIntent
        }}
      />

      {/* Rail line — entered 일 때만, 1px 얇은 파란 선 */}
      {railEdge === 'right' && (
        <div
          className="edge-rail-line"
          style={{ right: railThicknessHalfPx(viewport), top: viewport.h * 0.2, width: 1, height: viewport.h * 0.6 }}
        />
      )}
      {railEdge === 'left' && (
        <div
          className="edge-rail-line"
          style={{ left: railThicknessHalfPx(viewport), top: viewport.h * 0.2, width: 1, height: viewport.h * 0.6 }}
        />
      )}
      {railEdge === 'top' && (
        <div
          className="edge-rail-line"
          style={{ top: railThicknessHalfPx(viewport), left: viewport.w * 0.2, height: 1, width: viewport.w * 0.6 }}
        />
      )}
      {railEdge === 'bottom' && (
        <div
          className="edge-rail-line"
          style={{ bottom: railThicknessHalfPx(viewport), left: viewport.w * 0.2, height: 1, width: viewport.w * 0.6 }}
        />
      )}
    </>
  )
}

/** rail line 위치 = 변에서 thickness/2 안쪽 (GazeBar 중심선과 일치). */
function railThicknessHalfPx(viewport: { w: number; h: number }): number {
  return railThickness(viewport) / 2
}
