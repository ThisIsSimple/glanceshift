/**
 * GazeDot — 시선 도트 + dwell ring.
 *
 * 두 가지 시각 요소:
 *   1) 디버그 도트 본체 — visible (디버그 HUD) 일 때만 표시 (cool 매체 원칙).
 *   2) Dwell ring     — dwellProgress 가 있는 동안 표시. 사용자가 어느 항목을
 *      선택하고 있는지 즉각 피드백. 디버그 HUD 와 독립적으로 노출 (조작 중요 단서).
 *
 * snapAnimating=true (lock 진입 ~220ms) 일 때는 rail 로 흡수되는 transition.
 */

import { memo } from 'react'

type Props = {
  x: number
  y: number
  /** 디버그 HUD 도트 본체 표시 여부 (⌘⇧D). ring 은 이 값과 무관하게 dwellProgress 로 결정. */
  visible: boolean
  /** lock 진입 직후 ~220ms 동안 true. rail 로 끌리는 강한 transition. */
  snapAnimating?: boolean
  /**
   * Dwell-to-select progress (0..1). null 이면 ring 안 보임.
   * 사용자가 GazeBar 항목 위에 시선을 머무르고 있으면 1초 만에 1 로 차오름.
   */
  dwellProgress?: number | null
}

const RING_RADIUS = 22 // 도트 (직경 14) 보다 충분히 큰 반지름 — 도트가 가운데에 보임
const RING_STROKE = 3
const RING_BOX = (RING_RADIUS + RING_STROKE) * 2 // SVG viewBox 크기

function GazeDotImpl({ x, y, visible, snapAnimating, dwellProgress }: Props): JSX.Element | null {
  if (x < 0 || y < 0) return null

  const showDot = visible
  const showRing = dwellProgress != null && dwellProgress > 0
  if (!showDot && !showRing) return null

  return (
    <>
      {showDot && (
        <div
          className={[
            'gaze-dot',
            'snap-active',
            snapAnimating ? 'snapping-in' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ left: x, top: y }}
        />
      )}
      {showRing && (
        <DwellRing x={x} y={y} progress={dwellProgress!} />
      )}
    </>
  )
}

function DwellRing({ x, y, progress }: { x: number; y: number; progress: number }): JSX.Element {
  // 원의 둘레 = 2πr. progress = 0 → 호 길이 0, progress = 1 → 호 전체.
  const circumference = 2 * Math.PI * RING_RADIUS
  const offset = circumference * (1 - Math.min(1, Math.max(0, progress)))
  return (
    <svg
      className="gaze-dot-ring"
      width={RING_BOX}
      height={RING_BOX}
      viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
      style={{ left: x - RING_BOX / 2, top: y - RING_BOX / 2 }}
    >
      {/* 배경 원 (희미) */}
      <circle
        cx={RING_BOX / 2}
        cy={RING_BOX / 2}
        r={RING_RADIUS}
        className="gaze-dot-ring-bg"
        strokeWidth={RING_STROKE}
        fill="none"
      />
      {/* 진행 호 — 12시 방향에서 시작 (rotate -90°), 시계 방향으로 차오름 */}
      <circle
        cx={RING_BOX / 2}
        cy={RING_BOX / 2}
        r={RING_RADIUS}
        className="gaze-dot-ring-fg"
        strokeWidth={RING_STROKE}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${RING_BOX / 2} ${RING_BOX / 2})`}
        strokeLinecap="round"
      />
    </svg>
  )
}

export const GazeDot = memo(GazeDotImpl)
