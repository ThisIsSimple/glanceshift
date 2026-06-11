/**
 * EdgeZones — 디버그 모드에서 4개 가장자리 의도 영역을 시각화한다.
 *
 * 평소엔 보이지 않다가 (cool 매체 원칙) ⌘⇧D 를 켜면 다음을 표시:
 *   - IntentZone (intentZoneFrac) — 옅은 파란 사각형 + 점선
 *   - LockZone (lockZoneFrac) — 더 옅은 노랑 점선 외곽 (IntentZone 바깥 hysteresis)
 *   - primary edge 의 IntentZone 은 intent score 에 비례해 진해짐
 *   - rail_locked 상태에서는 rail line 자체도 표시
 */

import { memo } from 'react'
import type { EdgeSnapshot, Edge } from '../perception/edge-detector'
import { gazeBarCenterOffset } from '../perception/geometry'

type Props = {
  /** 화면 viewport */
  viewport: { w: number; h: number }
  /** 현재 detector snapshot — intentZoneFrac/lockZoneFrac 도 여기서 읽음 */
  snapshot: EdgeSnapshot
  visible: boolean
}

function EdgeZonesImpl({ viewport, snapshot, visible }: Props): JSX.Element | null {
  if (!visible) return null
  return (
    <SnappingZones
      intentZoneFrac={snapshot.intentZoneFrac}
      lockZoneFrac={snapshot.lockZoneFrac}
      viewport={viewport}
      snapshot={snapshot}
    />
  )
}

export const EdgeZones = memo(EdgeZonesImpl)

// ============================================================
// IntentZone + LockZone 외곽 + rail line
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
          style={{ right: gazeBarCenterOffset(), top: viewport.h * 0.2, width: 1, height: viewport.h * 0.6 }}
        />
      )}
      {railEdge === 'left' && (
        <div
          className="edge-rail-line"
          style={{ left: gazeBarCenterOffset(), top: viewport.h * 0.2, width: 1, height: viewport.h * 0.6 }}
        />
      )}
      {railEdge === 'top' && (
        <div
          className="edge-rail-line"
          style={{ top: gazeBarCenterOffset(), left: viewport.w * 0.2, height: 1, width: viewport.w * 0.6 }}
        />
      )}
      {railEdge === 'bottom' && (
        <div
          className="edge-rail-line"
          style={{ bottom: gazeBarCenterOffset(), left: viewport.w * 0.2, height: 1, width: viewport.w * 0.6 }}
        />
      )}
    </>
  )
}
