/**
 * 가장자리 사이드바(GazeBar) / rail / 디버그 시각화가 공유하는 기하 산식.
 *
 * 이전엔 동일한 thickness 식이 edge-detector / GazeBar / EdgeZones 세 곳에 손으로
 * 복제돼 있었다. 한 곳만 바뀌면 rail 투영과 UI 가 어긋나므로 단일 출처로 통합.
 *
 * 핵심: rail(시선이 고정되는 선)은 **GazeBar 독의 중심선** 에 맞춘다 — 그래야 lock 시
 * GazeDot 이 볼륨 UI 정중앙에 박힌다. 과거엔 rail 이 변에서 railThickness/2(≈32px) 였는데
 * 독 중심선(margin + 두께/2 ≈ 66px)과 어긋나 dot 이 바보다 바깥에 찍혔다.
 */

export type Viewport = { w: number; h: number }

/**
 * GazeBar(iPad 독) 레이아웃 상수 (px). rail 투영·EdgeZones·CSS 가 공유하므로 단일 출처.
 * CSS `.gazebar` 의 padding·gap 과 일치시킬 것.
 *   tile    : 타일의 짧은 변 (cross-axis = 독 두께 성분)
 *   slot    : 항목 하나가 주축에서 차지하는 길이 (= 타일의 긴 변). 키우면 바가 길어짐.
 *             볼륨 단일 항목이므로 충분히 길게 — 좌우 독은 세로로, 상하 독은 가로로 길어짐.
 *   gap     : 타일 사이 간격
 *   padding : 독 안쪽 여백
 *   margin  : 화면 가장자리에서 띄우는 거리 (floating)
 */
export const DOCK = {
  tile: 64,
  slot: 480,
  gap: 10,
  padding: 12,
  margin: 22
} as const

/** 독의 두께(cross-axis 총 길이) = tile + padding*2. GazeBar 폭이기도 함. */
export function dockThickness(): number {
  return DOCK.tile + DOCK.padding * 2
}

/**
 * GazeBar 독의 *중심선* 이 변에서 떨어진 거리(px) = margin + 두께/2.
 * rail(시선 고정선)·rail line·locked GazeDot 이 모두 이 선에 맞춰 화면 안쪽으로 들어온다.
 */
export function gazeBarCenterOffset(): number {
  return DOCK.margin + dockThickness() / 2
}
