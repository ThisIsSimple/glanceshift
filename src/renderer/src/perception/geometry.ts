/**
 * 가장자리 사이드바(GazeBar) / rail / 디버그 시각화가 공유하는 기하 산식.
 *
 * 이전엔 동일한 thickness 식이 edge-detector / GazeBar / EdgeZones 세 곳에 손으로
 * 복제돼 있었다. 한 곳만 바뀌면 rail 투영과 UI 가 어긋나므로 단일 출처로 통합.
 */

export type Viewport = { w: number; h: number }

/**
 * 사이드바 두께(px) — viewport 단축의 6%, 56~80px 로 clamp.
 * GazeBar 의 폭이자 rail 의 perpendicular 위치(두께/2) 기준.
 */
export function railThickness(vp: Viewport): number {
  const minSide = Math.min(vp.w, vp.h)
  return Math.max(56, Math.min(80, minSide * 0.06))
}
