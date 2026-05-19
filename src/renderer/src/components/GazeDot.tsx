/**
 * GazeDot — 디버그용 시선 도트.
 * 보고서 §3.2 Feel(cool 매체)에 따라 평소엔 보이지 않게,
 * 디버그 HUD가 켜져 있을 때만 표시한다.
 *
 * snapping=true 일 때는 rail 로 흡수되는 transition 을 강하게 — 사용자에게 *"snap 됐다"* 단서.
 */

type Props = {
  x: number
  y: number
  visible: boolean
  /** snapping mode 의 lock 진입 순간 200ms 동안 true. transition 을 강하게. */
  snapping?: boolean
}

export function GazeDot({ x, y, visible, snapping }: Props): JSX.Element | null {
  if (!visible || x < 0 || y < 0) return null
  return (
    <div
      className={`gaze-dot${snapping ? ' snapping-in' : ''}`}
      style={{ left: x, top: y }}
    />
  )
}
