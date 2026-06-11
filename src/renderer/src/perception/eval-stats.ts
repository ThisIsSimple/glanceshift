/**
 * Eval Stats — 5×5 grid 평가의 통계 계산 (pure functions).
 *
 * 사용처: components/Evaluation.tsx 가 매 target 마다 sample buffer 를 모으고
 *         이 모듈로 mean, std, Euclidean error 를 계산.
 *
 * Active tracker setup validation statistics.
 *   이 모듈이 출력하는 평균 오차(degrees) 가 그 baseline 의 우리 setup 검증 결과.
 */

export type Sample = {
  /** target 픽셀 좌표 */
  tx: number
  ty: number
  /** 측정된 gaze 픽셀 좌표 */
  gx: number
  gy: number
  /** ms */
  t: number
}

export type PerTargetResult = {
  targetIdx: number
  target: { x: number; y: number }
  /** 측정 window 동안 수집된 raw sample 들 */
  samples: Sample[]
  /** gaze 평균 픽셀 좌표 */
  mean: { x: number; y: number }
  /** 표준편차 (px) — 시선 안정성 */
  std: { x: number; y: number }
  /** Euclidean 오차 (px) — |mean - target| */
  errorPx: number
}

export type AggregateResult = {
  /** condition 식별자 (사용자가 입력) */
  condition: string
  /** 시작 시각 (epoch ms) */
  startedAt: number
  /** 화면 viewport (px) */
  viewport: { w: number; h: number }
  /** 추정된 사용자-화면 거리 (cm) — 도(°) 환산용. null 이면 도 표시 안 함 */
  screenDistanceCm: number | null
  /** 화면 가로 물리 폭 (cm) — DPI 계산. 미상 시 null */
  screenWidthCm: number | null
  perTarget: PerTargetResult[]
  /** 전체 mean error px (target 평균) */
  meanErrorPx: number
  /** 전체 max error px */
  maxErrorPx: number
  /** 도(°) 평균. 거리/폭 미상 시 null */
  meanErrorDeg: number | null
}

export function computePerTarget(targetIdx: number, target: { x: number; y: number }, samples: Sample[]): PerTargetResult {
  if (samples.length === 0) {
    return {
      targetIdx, target, samples,
      mean: { x: target.x, y: target.y },
      std: { x: 0, y: 0 },
      errorPx: 0
    }
  }
  const n = samples.length
  let sx = 0, sy = 0
  for (const s of samples) { sx += s.gx; sy += s.gy }
  const mx = sx / n
  const my = sy / n
  let vx = 0, vy = 0
  for (const s of samples) {
    vx += (s.gx - mx) ** 2
    vy += (s.gy - my) ** 2
  }
  const std = { x: Math.sqrt(vx / n), y: Math.sqrt(vy / n) }
  const errorPx = Math.hypot(mx - target.x, my - target.y)
  return {
    targetIdx, target, samples,
    mean: { x: mx, y: my },
    std, errorPx
  }
}

/**
 * 픽셀 오차 → 시각 각도(°). distance, screenWidthCm 둘 다 있어야 계산 가능.
 *   theta = 2 * atan( (errorPx / pxPerCm) / (2 * distance) )
 */
export function pxToDeg(errorPx: number, viewportWidthPx: number, screenWidthCm: number, distanceCm: number): number {
  const pxPerCm = viewportWidthPx / screenWidthCm
  const errCm = errorPx / pxPerCm
  return (2 * Math.atan(errCm / (2 * distanceCm))) * (180 / Math.PI)
}

export function aggregate(
  perTarget: PerTargetResult[],
  meta: {
    condition: string
    startedAt: number
    viewport: { w: number; h: number }
    screenDistanceCm: number | null
    screenWidthCm: number | null
  }
): AggregateResult {
  const errs = perTarget.map((r) => r.errorPx)
  const meanErrorPx = errs.length === 0 ? 0 : errs.reduce((a, b) => a + b, 0) / errs.length
  const maxErrorPx = errs.length === 0 ? 0 : Math.max(...errs)
  let meanErrorDeg: number | null = null
  if (meta.screenWidthCm && meta.screenDistanceCm) {
    meanErrorDeg = pxToDeg(meanErrorPx, meta.viewport.w, meta.screenWidthCm, meta.screenDistanceCm)
  }
  return { ...meta, perTarget, meanErrorPx, maxErrorPx, meanErrorDeg }
}

/** CSV 직렬화 — UTF-8 BOM 포함 (Excel 한글 호환). */
export function toCSV(result: AggregateResult): string {
  const BOM = '﻿'
  const header = [
    'condition', 'started_at_iso',
    'target_idx', 'target_x', 'target_y',
    'gaze_mean_x', 'gaze_mean_y',
    'std_x', 'std_y',
    'error_px', 'error_deg',
    'sample_count', 'viewport_w', 'viewport_h',
    'screen_width_cm', 'screen_distance_cm'
  ].join(',')
  const startIso = new Date(result.startedAt).toISOString()
  const rows: string[] = [header]
  for (const r of result.perTarget) {
    const errDeg =
      result.screenWidthCm && result.screenDistanceCm
        ? pxToDeg(r.errorPx, result.viewport.w, result.screenWidthCm, result.screenDistanceCm)
        : ''
    rows.push(
      [
        JSON.stringify(result.condition),
        startIso,
        r.targetIdx,
        r.target.x.toFixed(1),
        r.target.y.toFixed(1),
        r.mean.x.toFixed(2),
        r.mean.y.toFixed(2),
        r.std.x.toFixed(2),
        r.std.y.toFixed(2),
        r.errorPx.toFixed(2),
        errDeg === '' ? '' : (errDeg as number).toFixed(2),
        r.samples.length,
        result.viewport.w,
        result.viewport.h,
        result.screenWidthCm ?? '',
        result.screenDistanceCm ?? ''
      ].join(',')
    )
  }
  return BOM + rows.join('\n')
}
