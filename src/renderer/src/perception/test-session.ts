/**
 * Test Session — 볼륨 조절 사용자 실험의 데이터 모델 + CSV 직렬화 (pure functions).
 *
 * 실험 시나리오 (영화 시청):
 *   화면 중앙에 영화를 틀어 놓고 본다. 랜덤한 타이밍에 앱이 **볼륨을 0 으로 떨어뜨리고**
 *   "볼륨을 NN% 로 올리세요" 미션을 준다. 참가자는 (gaze / 외장 다이얼) 로 볼륨을 복구한다.
 *
 * 측정 목표:
 *   A. 볼륨 조절 완료 시간 — event(볼륨 0) → 조절 완료 (gaze: 볼륨 모드 최종 이탈 / baseline: Space)
 *   B. 시선 이탈→복귀 시간 — event 시점 화면 중앙(영화)에서 시선이 떨어졌다가 다시 중앙으로
 *      복귀·안정화되기까지. "영화에서 얼마나 오래 끌려 나갔는가" 의 proxy.
 *
 * 두 조건(gaze / baseline)을 동일 포맷으로 기록해 비교 가능하게 한다.
 * (eval-stats.ts 의 toCSV / BOM 패턴을 그대로 따른다.)
 */

export type TestCondition = 'gaze' | 'baseline'

/** raw 시계열 한 프레임 — 추후 시선 궤적/머리 움직임 분석용 */
export type RawSample = {
  /** trial 진행 단계: wait(영화 시청) → mission(event 이후 복구·복귀) */
  phase: 'wait' | 'mission'
  /** 현재 trial index */
  trialIdx: number
  /** ms — 세션 시작(performance.now 기준) 으로부터의 상대 시각 */
  t: number
  /** 시선 픽셀 좌표 (미검출 시 -1) */
  gx: number
  gy: number
  /** 머리 roll (°, filtered) — 볼륨 조절 입력 */
  headRoll: number
  /** live 볼륨 (%, head tilt 로 실시간 변하는 값; null 이면 빈값) */
  liveVolPct: number | null
  /** commit 된(저장된) OS 볼륨 (%) */
  osVolPct: number
  /** 현재 선택된 control id ('volume' 또는 '') */
  selected: string
  /** edge detector 상태 (idle/dwelling/entered 등) */
  edgeState: string
}

/** trial 한 건의 요약 (요약 CSV 한 행) */
export type TrialSummary = {
  condition: TestCondition
  trialIdx: number
  /** 미션 목표 볼륨 (%) */
  targetPct: number
  /** event 직후(드롭된) 시작 볼륨 (%) — 보통 0 */
  startVolPct: number
  /** 완료 시점 OS 볼륨 (%) — baseline 은 null (앱이 다이얼을 못 읽음) */
  finalVolPct: number | null
  /** |final - target| (%) — finalVolPct null 이면 null */
  absErrorPct: number | null
  /** event(볼륨 드롭) 발생 시각 (epoch ms — wall clock) */
  eventShownAt: number
  /** [A] event → 조절 완료 (gaze: 볼륨 모드 최종 이탈 / baseline: Space) (ms) */
  timeToAdjustMs: number | null
  /** event → 첫 볼륨 모드 진입까지 (ms) — gaze 전용 */
  timeToFirstEntryMs: number | null
  /** 볼륨 모드 진입 횟수 (gaze) */
  numModeEntries: number
  /** [B-1] event → 시선이 중앙(영화)에서 처음 이탈하기까지 (ms) */
  timeToGazeLeaveMs: number | null
  /** [B-2] 시선 이탈 → 중앙 복귀·안정화까지 (ms) — "끌려나가 있던 시간" */
  gazeAwayMs: number | null
  /** [B-3] event → 중앙 복귀·안정화까지 총 시간 (ms) — 핵심 산출물 */
  timeToReturnMs: number | null
  /** 이탈~복귀 구간 시선 경로 길이 (px) */
  gazePathPx: number
  /** 중앙 복귀·안정화 성공 여부 (timeout 전 복귀했는지) */
  settled: boolean
}

export type TestSession = {
  participantId: string
  condition: TestCondition
  /** 세션 시작 epoch ms */
  startedAt: number
  viewport: { w: number; h: number }
  /** 중앙(영화) 영역 (viewport 비율, 0..1) — 이탈/복귀 판정용 */
  centralRegionFrac: { x0: number; y0: number; x1: number; y1: number }
  trials: TrialSummary[]
  rawSamples: RawSample[]
}

/** 중앙(영화) 영역(px) — viewport × frac */
export function centralRegionPx(
  viewport: { w: number; h: number },
  frac: { x0: number; y0: number; x1: number; y1: number }
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: frac.x0 * viewport.w,
    y0: frac.y0 * viewport.h,
    x1: frac.x1 * viewport.w,
    y1: frac.y1 * viewport.h
  }
}

export function inRegion(
  gx: number,
  gy: number,
  r: { x0: number; y0: number; x1: number; y1: number }
): boolean {
  return gx >= 0 && gy >= 0 && gx >= r.x0 && gx <= r.x1 && gy >= r.y0 && gy <= r.y1
}

export type GazeExcursion = {
  timeToLeaveMs: number | null
  gazeAwayMs: number | null
  timeToReturnMs: number | null
  pathPx: number
  settled: boolean
}

/**
 * 시선 이탈→복귀 excursion 계산.
 *
 * 입력: event(볼륨 드롭) 시점 이후의 mission 단계 raw sample 들 (시간순, 같은 trial).
 *   - leave : event 후 시선이 중앙 region 밖(또는 미검출)으로 처음 벗어난 시점.
 *   - return: leave 이후 시선이 중앙 region 안에 holdMs 동안 *연속* 체류하기 시작하는 첫 시점.
 *   - pathPx: [leave, return] 구간 시선 경로 길이 (복귀 못하면 마지막 sample 까지).
 * timeout(복귀 전 미션 종료)이면 settled=false, return 계열 null.
 */
export function computeGazeExcursion(
  samples: RawSample[],
  region: { x0: number; y0: number; x1: number; y1: number },
  holdMs: number
): GazeExcursion {
  const EMPTY: GazeExcursion = {
    timeToLeaveMs: null,
    gazeAwayMs: null,
    timeToReturnMs: null,
    pathPx: 0,
    settled: false
  }
  if (samples.length === 0) return EMPTY
  const t0 = samples[0].t

  // 1) leave — 중앙 밖으로 처음 벗어난 시각
  let leftAt: number | null = null
  for (const s of samples) {
    if (!inRegion(s.gx, s.gy, region)) {
      leftAt = s.t
      break
    }
  }
  if (leftAt == null) return EMPTY

  // 2) return — leave 이후 holdMs 연속 체류 시작점
  let holdStart: number | null = null
  let returnAt: number | null = null
  for (const s of samples) {
    if (s.t < leftAt) continue
    if (inRegion(s.gx, s.gy, region)) {
      if (holdStart == null) holdStart = s.t
      if (s.t - holdStart >= holdMs) {
        returnAt = holdStart
        break
      }
    } else {
      holdStart = null
    }
  }

  // 3) path — [leave, return(또는 마지막)] 구간
  const end = returnAt ?? samples[samples.length - 1].t
  let pathPx = 0
  let prev: { x: number; y: number } | null = null
  for (const s of samples) {
    if (s.t < leftAt || s.t > end) continue
    if (s.gx >= 0 && s.gy >= 0) {
      if (prev) pathPx += Math.hypot(s.gx - prev.x, s.gy - prev.y)
      prev = { x: s.gx, y: s.gy }
    }
  }

  return {
    timeToLeaveMs: leftAt - t0,
    gazeAwayMs: returnAt != null ? returnAt - leftAt : null,
    timeToReturnMs: returnAt != null ? returnAt - t0 : null,
    pathPx,
    settled: returnAt != null
  }
}

const BOM = '﻿'

/** trial 요약 CSV — UTF-8 BOM 포함 (Excel 한글 호환). */
export function toTrialSummaryCSV(session: TestSession): string {
  const header = [
    'participant_id',
    'condition',
    'trial_idx',
    'target_pct',
    'start_vol_pct',
    'final_vol_pct',
    'abs_error_pct',
    'event_shown_at_iso',
    'time_to_adjust_ms',
    'time_to_first_entry_ms',
    'num_mode_entries',
    'time_to_gaze_leave_ms',
    'gaze_away_ms',
    'time_to_return_ms',
    'gaze_path_px',
    'settled'
  ].join(',')

  const num = (v: number | null, digits = 1): string => (v == null ? '' : v.toFixed(digits))

  const rows: string[] = [header]
  for (const t of session.trials) {
    rows.push(
      [
        JSON.stringify(session.participantId),
        t.condition,
        t.trialIdx,
        num(t.targetPct, 0),
        num(t.startVolPct, 0),
        num(t.finalVolPct, 0),
        num(t.absErrorPct, 1),
        new Date(t.eventShownAt).toISOString(),
        num(t.timeToAdjustMs, 0),
        num(t.timeToFirstEntryMs, 0),
        t.numModeEntries,
        num(t.timeToGazeLeaveMs, 0),
        num(t.gazeAwayMs, 0),
        num(t.timeToReturnMs, 0),
        num(t.gazePathPx, 1),
        t.settled ? '1' : '0'
      ].join(',')
    )
  }
  return BOM + rows.join('\n')
}

/** raw 시계열 CSV — 매 프레임 한 행. UTF-8 BOM 포함. */
export function toRawSamplesCSV(session: TestSession): string {
  const header = [
    'participant_id',
    'condition',
    'trial_idx',
    'phase',
    't_ms',
    'gaze_x',
    'gaze_y',
    'head_roll',
    'live_vol_pct',
    'os_vol_pct',
    'selected',
    'edge_state'
  ].join(',')

  const rows: string[] = [header]
  for (const s of session.rawSamples) {
    rows.push(
      [
        JSON.stringify(session.participantId),
        session.condition,
        s.trialIdx,
        s.phase,
        s.t.toFixed(1),
        s.gx.toFixed(1),
        s.gy.toFixed(1),
        s.headRoll.toFixed(2),
        s.liveVolPct == null ? '' : s.liveVolPct.toFixed(0),
        s.osVolPct.toFixed(0),
        s.selected,
        s.edgeState
      ].join(',')
    )
  }
  return BOM + rows.join('\n')
}
