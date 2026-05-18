/**
 * GazeBar — 가장자리에 도킹되는 미니멀 사이드바.
 *
 * 보고서 매핑:
 *   §1.2  GlanceShift 정의 — "화면 가장자리에 화면을 최소만 가리는 minimal UI"
 *   §3.2  Feel — McLuhan cool 매체: 정보 밀도 낮게, 여백 많이
 *   §3.2  Do  — 시선은 'handle' (탐색), 머리는 'button' (확정 — Phase 5)
 *   §3.3  Mappings — 시선 세로(또는 가로) 좌표로 항목 호버
 *   §4.1  Iqbal & Horvitz — visual occlusion cost 최소화: 폭은 단축의 5–6%
 *
 * Phase 4 범위:
 *   - edge=entered 상태에서 해당 변에 fade+slide 로 등장
 *   - 항목들 (볼륨 / 밝기 placeholder) 을 가로/세로로 배치
 *   - 시선이 항목 중심 ± 반경 안에 들어오면 hover 강조
 *   - 실제 선택(슬라이더 조작) 은 Phase 5 (head tilt) 에서 결선
 */

import { useEffect, useMemo, useRef, useState } from 'react'
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
}

/** 가장자리에서 사이드바가 차지하는 픽셀 폭 / 길이 계산 */
function computeGeometry(edge: Edge, viewport: { w: number; h: number }) {
  const minSide = Math.min(viewport.w, viewport.h)
  // 단축의 ~5.5%. clamp 로 너무 작/큰 화면에서도 적당히.
  const thickness = Math.max(56, Math.min(80, minSide * 0.06))
  // 변의 60% 길이
  const isVertical = edge === 'left' || edge === 'right'
  const majorAxis = isVertical ? viewport.h : viewport.w
  const length = majorAxis * 0.6
  const offset = (majorAxis - length) / 2

  if (edge === 'right') return { thickness, length, isVertical, top: offset, right: 0 }
  if (edge === 'left') return { thickness, length, isVertical, top: offset, left: 0 }
  if (edge === 'top') return { thickness, length, isVertical, top: 0, left: offset }
  return { thickness, length, isVertical, bottom: 0, left: offset } // 'bottom'
}

export function GazeBar({
  edge,
  viewport,
  gazePoint,
  items,
  onHoverChange,
  valuesById,
  liveValue,
  snapHover
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
      // 다음 frame 에 visible 켜서 CSS transition 작동
      const id = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(id)
    }
    // edge null → exit
    setVisible(false)
    exitTimerRef.current = window.setTimeout(() => {
      setRenderedEdge(null)
      exitTimerRef.current = null
    }, 200)
    return () => {
      if (exitTimerRef.current != null) {
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [edge])

  // hover 계산: 시선의 (주축 위치) 와 각 항목 중심의 거리
  // 주축: 변이 vertical 이면 Y, horizontal 이면 X
  const geom = useMemo(
    () => (renderedEdge ? computeGeometry(renderedEdge, viewport) : null),
    [renderedEdge, viewport]
  )

  const hoveredId = useMemo(() => {
    if (!geom || !gazePoint || !items.length) return null
    const isVertical = geom.isVertical
    const major = isVertical ? gazePoint.y : gazePoint.x

    // 항목들의 주축 중심 좌표
    const start = isVertical ? geom.top! : geom.left!
    const itemSize = geom.length / items.length

    if (snapHover) {
      // Deterministic: 양자화. 항상 가장 가까운 항목 (반경 제한 없이).
      // Mode 2/3: along-edge 정확도 손실에도 hover 가 결정적.
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

  // slide-in 시작 위치 (edge 바깥쪽으로 10px)
  const enterTransform = (() => {
    if (!visible) {
      if (renderedEdge === 'right') return 'translateX(10px)'
      if (renderedEdge === 'left') return 'translateX(-10px)'
      if (renderedEdge === 'top') return 'translateY(-10px)'
      return 'translateY(10px)'
    }
    return 'translate(0, 0)'
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
    transition: 'opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0, 0, 1)'
  }

  return (
    <div className="gazebar" style={style} aria-label="GlanceShift GazeBar" role="toolbar">
      {items.map((item) => {
        const isHover = item.id === hoveredId
        // 항목별 표시 값: hover 면 liveValue (engaged), 아니면 stored value, 둘 다 없으면 0.5
        const stored = valuesById?.[item.id] ?? 0.5
        const displayValue = isHover && liveValue != null ? liveValue : stored
        const percent = Math.round(displayValue * 100)

        // 슬라이더 fill 방향: vertical 변 = 아래→위 fill, horizontal 변 = 좌→우 fill
        const fillStyle: React.CSSProperties = isVertical
          ? {
              background: `linear-gradient(to top,
                rgba(90, 169, 255, ${isHover ? 0.32 : 0.16}) 0%,
                rgba(90, 169, 255, ${isHover ? 0.32 : 0.16}) ${percent}%,
                transparent ${percent}%, transparent 100%)`
            }
          : {
              background: `linear-gradient(to right,
                rgba(90, 169, 255, ${isHover ? 0.32 : 0.16}) 0%,
                rgba(90, 169, 255, ${isHover ? 0.32 : 0.16}) ${percent}%,
                transparent ${percent}%, transparent 100%)`
            }

        return (
          <div
            key={item.id}
            className={`gazebar-item${isHover ? ' hover' : ''}`}
            style={{
              flex: 1,
              flexDirection: isVertical ? 'column' : 'row',
              ...fillStyle
            }}
          >
            <span className="gazebar-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="gazebar-label">{item.label}</span>
            {/* 값 표시 — hover 일 때만 강조, 아닐 때도 작게 보여서 현재 상태 인지 */}
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
