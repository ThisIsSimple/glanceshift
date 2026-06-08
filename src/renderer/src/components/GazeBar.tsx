/**
 * GazeBar — 가장자리에서 떠오르는 iPad 독 스타일 사이드바.
 *
 * 보고서 매핑:
 *   §1.2  GlanceShift 정의 — "화면 가장자리에 화면을 최소만 가리는 minimal UI"
 *   §3.2  Feel — McLuhan cool 매체: 정보 밀도 낮게, 여백 많이
 *   §3.2  Do  — 시선은 'handle' (탐색), 머리는 'button' (확정 — Phase 5)
 *   §3.3  Mappings — 시선 세로(또는 가로) 좌표로 항목 호버
 *   §4.1  Iqbal & Horvitz — visual occlusion cost 최소화
 *
 * 디자인 요약:
 *   - 가장자리에서 DOCK.margin 만큼 떠 있는(floating) content-sized 독
 *   - 항목은 변 방향으로 긴 직사각형 타일 (위/아래=가로로, 좌/우=세로로 김)
 *   - 레벨 fill 은 변 방향에 맞춰: 세로 독=아래→위, 가로 독=좌→우
 *   - 등장/퇴장 시 화면 모서리 바깥에서 안으로 슬라이드
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Edge } from '../perception/edge-detector'

export type GazeBarItem = {
  id: string
  label: string
  icon: string             // 이모지 또는 단문자
  /** 호버 시 보조 텍스트 (값 표시 등) — Phase 5+ 에서 채워짐 */
  hint?: string
}

type Props = {
  /** 현재 entered 변 — null 이면 사이드바 숨김 */
  edge: Edge | null
  viewport: { w: number; h: number }
  /** 현재 시선(또는 마우스) 좌표 — 항목 hover 계산용 */
  gazePoint: { x: number; y: number } | null
  /** 표시할 항목 리스트 */
  items: GazeBarItem[]
  /** 항목이 hover 됐을 때 콜백 — Phase 5/6 FSM 연결용 */
  onHoverChange?: (itemId: string | null) => void
  /** 각 항목별 현재 슬라이더 값 (0..1). 미정의면 0.5 fallback */
  valuesById?: Record<string, number>
  /** hover 중인 항목의 *live* 값 (engaged 상태 — head tilt 로 실시간 변하는 값) */
  liveValue?: number | null
  /** true 면 hover 계산이 deterministic — 항상 가장 가까운 항목 (반경 제한 없이). Mode 2/3 용 */
  snapHover?: boolean
  /**
   * Selected (1초 dwell 로 commit 된) 항목 — head tilt 조작 권한이 있는 control.
   * 시각 강조만 한다 (`.gazebar-item.locked`). hover 결정은 시선 기반 그대로.
   */
  lockedItemId?: string | null
}

/**
 * iPad 독 — 타일/간격/여백 상수 (px). CSS .gazebar 의 padding·gap 과 일치시킬 것.
 *   tile    : 타일의 짧은 변 (cross-axis)
 *   slot    : 항목 하나가 주축에서 차지하는 길이 (= 타일의 긴 변). 키우면 바가 길어짐
 *   gap     : 타일 사이 간격
 *   padding : 독 안쪽 여백
 *   margin  : 화면 가장자리에서 띄우는 거리 (floating)
 */
const DOCK = {
  tile: 64,
  slot: 240,
  gap: 10,
  padding: 12,
  margin: 22
}

/** 가장자리에서 떠 있는 content-sized 독의 위치·크기 계산 */
function computeGeometry(edge: Edge, viewport: { w: number; h: number }, itemCount: number) {
  const isVertical = edge === 'left' || edge === 'right'
  const { tile, slot, gap, padding, margin } = DOCK
  const thickness = tile + padding * 2
  const length = itemCount * slot + Math.max(0, itemCount - 1) * gap + padding * 2
  const majorAxis = isVertical ? viewport.h : viewport.w
  const offset = Math.max(margin, (majorAxis - length) / 2) // 변 따라 가운데 정렬

  if (edge === 'right') return { thickness, length, isVertical, top: offset, right: margin }
  if (edge === 'left') return { thickness, length, isVertical, top: offset, left: margin }
  if (edge === 'top') return { thickness, length, isVertical, top: margin, left: offset }
  return { thickness, length, isVertical, bottom: margin, left: offset } // 'bottom'
}

function GazeBarImpl({
  edge,
  viewport,
  gazePoint,
  items,
  onHoverChange,
  valuesById,
  liveValue,
  snapHover,
  lockedItemId
}: Props): JSX.Element | null {
  // edge 가 null 이면 짧은 exit 애니메이션 후 unmount
  const [renderedEdge, setRenderedEdge] = useState<Edge | null>(edge)
  const [visible, setVisible] = useState(false)
  const exitTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (edge) {
      if (exitTimerRef.current != null) {
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
      setRenderedEdge(edge)
      // 다음 frame 에 visible 켜서 CSS transition 작동 (off-screen → resting)
      const id = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(id)
    }
    // edge null → 같은 변으로 슬라이드 아웃 후 unmount
    setVisible(false)
    exitTimerRef.current = window.setTimeout(() => {
      setRenderedEdge(null)
      exitTimerRef.current = null
    }, 340) // 320ms 슬라이드보다 길게
    return () => {
      if (exitTimerRef.current != null) {
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [edge])

  // hover 계산: 시선의 (주축 위치) 와 각 항목 중심의 거리
  const geom = useMemo(
    () => (renderedEdge ? computeGeometry(renderedEdge, viewport, items.length) : null),
    [renderedEdge, viewport, items.length]
  )

  // hover 결정은 항상 gaze 기반 — lockedItemId 의 영향 받지 않음.
  const hoveredId = useMemo(() => {
    if (!geom || !gazePoint || !items.length) return null
    const isVertical = geom.isVertical
    const major = isVertical ? gazePoint.y : gazePoint.x

    const start = isVertical ? geom.top! : geom.left!
    const itemSize = geom.length / items.length

    if (snapHover) {
      // Deterministic: 양자화. 항상 가장 가까운 항목 (반경 제한 없이).
      const rel = (major - start) / itemSize
      const idx = Math.max(0, Math.min(items.length - 1, Math.round(rel - 0.5)))
      return items[idx].id
    }

    // Classic: 항목 중심 ± 반경 안에 들어와야 hover
    let bestId: string | null = null
    let bestDist = Infinity
    for (let i = 0; i < items.length; i++) {
      const center = start + itemSize * (i + 0.5)
      const dist = Math.abs(major - center)
      if (dist < itemSize / 2 && dist < bestDist) {
        bestDist = dist
        bestId = items[i].id
      }
    }
    return bestId
  }, [geom, gazePoint, items, snapHover])

  // hover 변화 알림
  useEffect(() => {
    onHoverChange?.(hoveredId)
  }, [hoveredId, onHoverChange])

  if (!renderedEdge || !geom) return null

  const isVertical = geom.isVertical

  // slide-in 시작 위치 — 화면 모서리 바깥으로 완전히 (자기 두께 100% + 여백·그림자분).
  const enterTransform = (() => {
    if (visible) return 'translate(0, 0)'
    if (renderedEdge === 'right') return 'translateX(calc(100% + 30px))'
    if (renderedEdge === 'left') return 'translateX(calc(-100% - 30px))'
    if (renderedEdge === 'top') return 'translateY(calc(-100% - 30px))'
    return 'translateY(calc(100% + 30px))' // 'bottom'
  })()

  const style: React.CSSProperties = {
    position: 'fixed',
    width: isVertical ? geom.thickness : geom.length,
    height: isVertical ? geom.length : geom.thickness,
    top: 'top' in geom ? geom.top : 'auto',
    left: 'left' in geom ? geom.left : 'auto',
    right: 'right' in geom ? geom.right : 'auto',
    bottom: 'bottom' in geom ? geom.bottom : 'auto',
    display: 'flex',
    flexDirection: isVertical ? 'column' : 'row',
    opacity: visible ? 1 : 0,
    transform: enterTransform,
    transition: 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease',
    willChange: 'transform'
  }

  return (
    <div className="gazebar" style={style} aria-label="GlanceShift GazeBar" role="toolbar">
      {items.map((item) => {
        const isHover = item.id === hoveredId
        // 항목별 표시 값: hover 면 liveValue (engaged), 아니면 stored value, 둘 다 없으면 0.5
        const stored = valuesById?.[item.id] ?? 0.5
        const displayValue = isHover && liveValue != null ? liveValue : stored
        const percent = Math.round(displayValue * 100)

        // 변 방향에 맞춘 레벨 게이지 + 옅은 베이스 색:
        //   세로 독(left/right) = 아래→위, 가로 독(top/bottom) = 좌→우
        const a = isHover ? 0.34 : 0.18
        const dir = isVertical ? 'to top' : 'to right'
        const fillStyle: React.CSSProperties = {
          background: `linear-gradient(${dir},
            rgba(90, 169, 255, ${a}) 0%,
            rgba(90, 169, 255, ${a}) ${percent}%,
            transparent ${percent}%, transparent 100%),
            rgba(255, 255, 255, 0.06)`
        }

        const isLocked = item.id === lockedItemId
        return (
          <div
            key={item.id}
            className={`gazebar-item${isHover ? ' hover' : ''}${isLocked ? ' locked' : ''}`}
            style={fillStyle}
          >
            <span className="gazebar-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="gazebar-label">{item.label}</span>
            {/* 값 표시 — hover 일 때 강조, 아닐 때도 작게 보여서 현재 상태 인지 */}
            <span
              className={`gazebar-value${isHover ? ' active' : ''}`}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {percent}%
            </span>
          </div>
        )
      })}
    </div>
  )
}

export const GazeBar = memo(GazeBarImpl)
