/**
 * Test Session — 볼륨 조절 사용자 실험의 데이터 모델 + CSV 직렬화 (pure functions).
 *
 * 사용처: components/TestMode.tsx 가 trial 별로 raw sample 을 모으고 trial 요약을 만든 뒤
 *         이 모듈로 재몰입(re-immersion) proxy 계산 + CSV 직렬화를 수행한다.
 *
 * 측정 목표 (실험 설계):
 *   1. 목표 볼륨 도달 시간 — prompt → 볼륨 모드 최종 이탈 (gaze) / prompt → 완료키 (baseline)
 *   2. 조절 후 게임 재몰입 시간 — 최종 이탈 후 시선이 중앙(게임) 영역으로 복귀·안정화까지
 *
 * 두 조건(gaze / baseline)을 동일 포맷으로 기록해 비교 가능하게 한다.
 * (eval-stats.ts 의 toCSV / BOM 패턴을 그대로 따른다.)
 */

export type TestCondition = 'gaze' | 'baseline'

/** raw 시계열 한 프레임 — 추후 시선 궤적/머리 움직임 분석용 */
export type RawSample = {
  /** trial 진행 단계 */
  phase: 'wait' | 'prompt' | 'adjust' | 'reimmersion'
  /** 현재 trial index (wait 단계는 직전 완료 trial 다음 번호) */
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
  /** 지시된 목표 볼륨 (%) */
  targetPct: number
  /** prompt 직전 OS 볼륨 (%) */
  startVolPct: number
  /** 완료 시점 OS 볼륨 (%) — baseline 은 null (앱이 다이얼을 못 읽음) */
  finalVolPct: number | null
  /** |final - target| (%) — finalVolPct null 이면 null */
  absErrorPct: number | null
  /** prompt 표시 시각 (epoch ms — wall clock) */
  promptShownAt: number
  /** prompt → 첫 볼륨 모드 진입까지 (ms) — gaze 전용, 없으면 null */
  timeToFirstEntryMs: number | null
  /** 첫 진입 → 최종 이탈까지 순수 조절 시간 (ms) — gaze 전용 */
  adjustTimeMs: number | null
  /** prompt → 완료(최종 이탈 / 완료키) 총 시간 (ms) */
  totalTimeMs: number | null
  /** 볼륨 모드 진입 횟수 (gaze) */
  numModeEntries: number
  /** 재몰입 proxy: 완료 → 시선 중앙 영역 안정화까지 (ms). timeout 시 null */
  reimmersionMs: number | null
  /** 재몰입 구간 시선 경로 길이 (px) */
  reimmersionPathPx: number | null
  /** 재몰입 안정화 성공 여부 */
  settled: boolean
}

export type TestSession = {
  participantId: string
  condition: TestCondition
  /** 세션 시작 epoch ms */
  startedAt: number
  viewport: { w: number; h: number }
  /** 재몰입 판정용 중앙 영역 (viewport 비율, 0..1) */
  centralRegionFrac: { x0: number; y0: number; x1: number; y1: number }
  trials: TrialSummary[]
  rawSamples: RawSample[]
}

/** 중앙 영역(px) — viewport × frac */
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

function inRegion(
  gx: number,
  gy: number,
  r: { x0: number; y0: number; x1: number; y1: number }
): boolean {
  return gx >= r.x0 && gx <= r.x1 && gy >= r.y0 && gy <= r.y1
}

/**
 * 재몰입(re-immersion) proxy 계산.
 *
 * 입력: 완료 시점(t0) 이후의 reimmersion 단계 raw sample 들 (시간순, 같은 trial).
 * 정의: 시선이 중앙 region 안에 holdMs 동안 *연속* 체류하기 시작하는 첫 시점까지의 경과 시간.
 *       그 구간 동안의 시선 경로 길이도 함께 반환.
 * 미검출(-1) sample 은 체류를 끊는다 (보수적). timeout 이면 settled=false, reimmersionMs=null.
 */
export function computeReimmersion(
  samples: RawSample[],
  region: { x0: number; y0: number; x1: number; y1: number },
  holdMs: number
): { reimmersionMs: number | null; pathPx: number; settled: boolean } {
  if (samples.length === 0) {
    return { reimmersionMs: null, pathPx: 0, settled: false }
  }
  const t0 = samples[0].t

  // 경로 길이 (전체 reimmersion 구간)
  let pathPx = 0
  let prev: { x: number; y: number } | null = null
  for (const s of samples) {
    if (s.gx >= 0 && s.gy >= 0) {
      if (prev) pathPx += Math.hypot(s.gx - prev.x, s.gy - prev.y)
      prev = { x: s.gx, y: s.gy }
    }
  }

  // holdMs 연속 체류 시작점 탐색
  let holdStart: number | null = null
  for (const s of samples) {
    const ok = s.gx >= 0 && s.gy >= 0 && inRegion(s.gx, s.gy, region)
    if (ok) {
      if (holdStart == null) holdStart = s.t
      if (s.t - holdStart >= holdMs) {
        // holdStart 부터 안정 — 재몰입 완료 시점은 "체류 시작" 으로 본다
        return { reimmersionMs: holdStart - t0, pathPx, settled: true }
      }
    } else {
      holdStart = null
    }
  }
  return { reimmersionMs: null, pathPx, settled: false }
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
    'prompt_shown_at_iso',
    'time_to_first_entry_ms',
    'adjust_time_ms',
    'total_time_ms',
    'num_mode_entries',
    'reimmersion_ms',
    'reimmersion_path_px',
    'settled'
  ].join(',')

  const num = (v: number | null, digits = 1): string =>
    v == null ? '' : v.toFixed(digits)

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
        new Date(t.promptShownAt).toISOString(),
        num(t.timeToFirstEntryMs, 0),
        num(t.adjustTimeMs, 0),
        num(t.totalTimeMs, 0),
        t.numModeEntries,
        num(t.reimmersionMs, 0),
        num(t.reimmersionPathPx, 1),
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
