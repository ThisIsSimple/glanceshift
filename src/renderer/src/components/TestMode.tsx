/**
 * TestMode — 볼륨 조절 사용자 실험 진행 + 데이터 수집 오버레이.
 *
 *   Cmd/Ctrl+Shift+T 로 진입. ESC 로 취소.
 *
 * 시나리오 (영화 시청):
 *   화면 중앙에 영화를 틀어 두고 본다(앱은 투명 오버레이라 영화가 그대로 보임).
 *   trial 반복:
 *     wait(랜덤 3–8초, 영화 시청) → event: 앱이 볼륨을 0 으로 떨어뜨리고
 *     "볼륨을 NN% 로 올리세요" 미션 표시 → 참가자 복구 → 시선이 중앙으로 복귀·안정화 → 다음 trial
 *
 * 두 조건:
 *   · gaze     : GlanceShift(시선+머리). 앱이 볼륨을 0 으로 떨어뜨리고, 참가자가 시선+머리로 복구.
 *                볼륨 모드 진입/이탈을 관찰, 최종 이탈 시 OS 볼륨을 기록.
 *   · baseline : 외장 다이얼. 앱은 다이얼을 못 만지므로 진행자가 다이얼을 0 으로 내린 뒤 미션 시작,
 *                참가자가 복구하고 Space 로 "완료" 마킹 (타이밍만).
 *
 * 측정:
 *   A. 볼륨 조절 완료 시간 (event → 모드 최종 이탈 / Space)
 *   B. 시선 이탈→복귀 시간 (event → 중앙 영화 영역에서 이탈했다 복귀·안정화까지)
 *
 * 수집 데이터는 trial 요약 CSV + raw 시계열 CSV 로 저장 (userData/eval-logs/).
 * 측정/직렬화 로직은 perception/test-session.ts (pure) 에 위임. UI/타이밍 패턴은 Evaluation.tsx 미러.
 */

import { useEffect, useRef, useState } from 'react'
import {
  centralRegionPx,
  computeGazeExcursion,
  inRegion,
  toRawSamplesCSV,
  toTrialSummaryCSV,
  type RawSample,
  type TestCondition,
  type TestSession,
  type TrialSummary
} from '../perception/test-session'

type Props = {
  /** 현재 시선(또는 마우스) 좌표 — 미검출 시 null */
  gazePoint: { x: number; y: number } | null
  /** 머리 roll (°, filtered) */
  headRoll: number
  /** 현재 선택된 control id ('volume' 또는 null) */
  selectedControlId: string | null
  /** commit 된 OS 볼륨 (0..1) */
  volumeValue: number
  /** head tilt 로 실시간 변하는 live 볼륨 (0..1, null 가능) */
  liveVolume: number | null
  /** edge detector 상태 라벨 */
  edgeState: string
  viewport: { w: number; h: number }
  /** event 시 볼륨을 강제로 세팅 (OS + App 상태 동기화). gaze 조건에서 0 으로 드롭하는 데 사용. */
  onForceVolume: (v: number) => void
  onDone: () => void
}

type Screen = 'intro' | 'running' | 'complete'

// ===== 타이밍/프로토콜 상수 =====
const WAIT_MIN_MS = 3000
const WAIT_MAX_MS = 8000
const MISSION_TIMEOUT_MS = 30_000 // 복구/복귀 안전 타임아웃
const SETTLE_HOLD_MS = 800 // 중앙(영화) 영역 연속 체류 → 복귀 완료
const DEFAULT_TRIALS = 10
const DROP_TO_PCT = 0 // event 시 볼륨을 떨어뜨리는 값
const DEFAULT_TARGET_PCT = 50 // 미션 목표 볼륨

/** 중앙(영화) 영역 (viewport 비율) — 화면 중앙 50% 사각형 */
const CENTRAL_REGION_FRAC = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }

function randomWait(): number {
  return WAIT_MIN_MS + Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS)
}

/** 세션 진행을 구동하는 가변 엔진 상태 (RAF 루프에서만 변경) */
type Engine = {
  phase: RawSample['phase']
  trialIdx: number
  waitUntil: number
  // 현재 trial
  eventAt: number
  eventWall: number
  startVolPct: number
  // 볼륨 조절(gaze) 추적
  firstEntryAt: number | null
  numEntries: number
  inMode: boolean
  adjustDoneAt: number | null // gaze: 마지막 모드 이탈 / baseline: Space
  // 시선 이탈→복귀 추적
  gazeLeftAt: number | null
  returnHoldStart: number | null
  missionStartIdx: number
}

export function TestMode({
  gazePoint,
  headRoll,
  selectedControlId,
  volumeValue,
  liveVolume,
  edgeState,
  viewport,
  onForceVolume,
  onDone
}: Props): JSX.Element {
  const [screen, setScreen] = useState<Screen>('intro')
  const [condition, setCondition] = useState<TestCondition>('gaze')
  const [participantId, setParticipantId] = useState('')
  const [numTrials, setNumTrials] = useState(DEFAULT_TRIALS)
  const [targetPct, setTargetPct] = useState(DEFAULT_TARGET_PCT)

  // 진행 표시용 (RAF 엔진이 전이 시에만 갱신)
  const [activeTrialIdx, setActiveTrialIdx] = useState(0)
  const [uiPhase, setUiPhase] = useState<RawSample['phase']>('wait')

  const [session, setSession] = useState<TestSession | null>(null)
  const [summaryPath, setSummaryPath] = useState<string | null>(null)
  const [rawPath, setRawPath] = useState<string | null>(null)

  // ===== live 상태 ref 미러 (RAF stale-closure 방지) =====
  const gazeRef = useRef(gazePoint)
  gazeRef.current = gazePoint
  const headRollRef = useRef(headRoll)
  headRollRef.current = headRoll
  const selectedRef = useRef(selectedControlId)
  selectedRef.current = selectedControlId
  const volRef = useRef(volumeValue)
  volRef.current = volumeValue
  const liveVolRef = useRef(liveVolume)
  liveVolRef.current = liveVolume
  const edgeStateRef = useRef(edgeState)
  edgeStateRef.current = edgeState
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const onForceVolumeRef = useRef(onForceVolume)
  onForceVolumeRef.current = onForceVolume
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  // baseline 완료키 (Space) 눌림 플래그
  const doneKeyRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDoneRef.current()
      if (e.code === 'Space') {
        e.preventDefault()
        doneKeyRef.current = true
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ============================================================
  // 세션 구동 — 단일 RAF 상태머신
  // ============================================================
  useEffect(() => {
    if (screen !== 'running') return

    const cond = condition
    const target = targetPct
    const sessionStart = performance.now()
    const sessionWall = Date.now()
    const raw: RawSample[] = []
    const trials: TrialSummary[] = []
    const region = centralRegionPx(viewportRef.current, CENTRAL_REGION_FRAC)

    const eng: Engine = {
      phase: 'wait',
      trialIdx: 0,
      waitUntil: sessionStart + randomWait(),
      eventAt: 0,
      eventWall: 0,
      startVolPct: 0,
      firstEntryAt: null,
      numEntries: 0,
      inMode: false,
      adjustDoneAt: null,
      gazeLeftAt: null,
      returnHoldStart: null,
      missionStartIdx: 0
    }

    let raf = 0
    let cancelled = false
    doneKeyRef.current = false

    const finalizeTrial = (now: number): void => {
      const missionSamples = raw.slice(eng.missionStartIdx)
      const exc = computeGazeExcursion(missionSamples, region, SETTLE_HOLD_MS)

      const finalVolPct = cond === 'gaze' ? volRef.current * 100 : null
      const absErrorPct = finalVolPct != null ? Math.abs(finalVolPct - target) : null

      trials.push({
        condition: cond,
        trialIdx: eng.trialIdx,
        targetPct: target,
        startVolPct: eng.startVolPct,
        finalVolPct,
        absErrorPct,
        eventShownAt: eng.eventWall,
        timeToAdjustMs: eng.adjustDoneAt != null ? eng.adjustDoneAt - eng.eventAt : null,
        timeToFirstEntryMs:
          cond === 'gaze' && eng.firstEntryAt != null ? eng.firstEntryAt - eng.eventAt : null,
        numModeEntries: eng.numEntries,
        timeToGazeLeaveMs: exc.timeToLeaveMs,
        gazeAwayMs: exc.gazeAwayMs,
        timeToReturnMs: exc.timeToReturnMs,
        gazePathPx: exc.pathPx,
        settled: exc.settled
      })

      // 다음 trial 준비 (또는 종료)
      const next = eng.trialIdx + 1
      if (next >= numTrials) {
        cancelled = true
        cancelAnimationFrame(raf)
        const result: TestSession = {
          participantId,
          condition: cond,
          startedAt: sessionWall,
          viewport: viewportRef.current,
          centralRegionFrac: CENTRAL_REGION_FRAC,
          trials,
          rawSamples: raw
        }
        setSession(result)
        setScreen('complete')
        return
      }
      eng.trialIdx = next
      eng.phase = 'wait'
      eng.waitUntil = now + randomWait()
      eng.firstEntryAt = null
      eng.numEntries = 0
      eng.inMode = false
      eng.adjustDoneAt = null
      eng.gazeLeftAt = null
      eng.returnHoldStart = null
      setActiveTrialIdx(next)
      setUiPhase('wait')
    }

    const tick = (): void => {
      if (cancelled) return
      const now = performance.now()
      const g = gazeRef.current
      const gx = g && g.x >= 0 ? g.x : -1
      const gy = g && g.y >= 0 ? g.y : -1
      const selected = selectedRef.current === 'volume' ? 'volume' : ''

      // 1) raw sample 항상 수집
      raw.push({
        phase: eng.phase,
        trialIdx: eng.trialIdx,
        t: now - sessionStart,
        gx,
        gy,
        headRoll: headRollRef.current,
        liveVolPct: liveVolRef.current != null ? liveVolRef.current * 100 : null,
        osVolPct: volRef.current * 100,
        selected,
        edgeState: edgeStateRef.current
      })

      // 2) phase 진행
      if (eng.phase === 'wait') {
        if (now >= eng.waitUntil) {
          // === EVENT: 볼륨 드롭 + 미션 표시 ===
          if (cond === 'gaze') onForceVolumeRef.current(DROP_TO_PCT / 100)
          eng.phase = 'mission'
          eng.eventAt = now
          eng.eventWall = Date.now()
          eng.startVolPct = DROP_TO_PCT
          eng.firstEntryAt = null
          eng.numEntries = 0
          eng.inMode = false
          eng.adjustDoneAt = null
          eng.gazeLeftAt = null
          eng.returnHoldStart = null
          eng.missionStartIdx = raw.length // 이 프레임은 아직 wait 로 push 됨 → 다음부터 mission
          setUiPhase('mission')
        }
      } else if (eng.phase === 'mission') {
        const inCentral = inRegion(gx, gy, region)

        // (B) 시선 이탈 — 중앙에서 처음 벗어난 시점
        if (eng.gazeLeftAt == null && !inCentral) eng.gazeLeftAt = now

        // (A) 볼륨 조절 완료 추적
        if (cond === 'gaze') {
          const isIn = selected === 'volume'
          if (isIn && !eng.inMode) {
            eng.inMode = true
            eng.numEntries += 1
            if (eng.firstEntryAt == null) eng.firstEntryAt = now
          } else if (!isIn && eng.inMode) {
            eng.inMode = false
            eng.adjustDoneAt = now // 마지막 이탈 시각으로 계속 갱신
          }
        } else if (doneKeyRef.current) {
          doneKeyRef.current = false
          eng.adjustDoneAt = now
        }

        // (B) 시선 복귀·안정화 — 이탈한 뒤 중앙에 SETTLE_HOLD 연속 체류
        if (eng.gazeLeftAt != null && inCentral) {
          if (eng.returnHoldStart == null) eng.returnHoldStart = now
          if (now - eng.returnHoldStart >= SETTLE_HOLD_MS) {
            finalizeTrial(now)
            if (!cancelled) raf = requestAnimationFrame(tick)
            return
          }
        } else {
          eng.returnHoldStart = null
        }

        // 안전 타임아웃
        if (now - eng.eventAt >= MISSION_TIMEOUT_MS) {
          finalizeTrial(now)
          if (!cancelled) raf = requestAnimationFrame(tick)
          return
        }
      }

      raf = requestAnimationFrame(tick)
    }

    setActiveTrialIdx(0)
    setUiPhase('wait')
    raf = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  // ============================================================
  // 액션
  // ============================================================
  const handleStart = (): void => {
    setSession(null)
    setSummaryPath(null)
    setRawPath(null)
    setScreen('running')
  }

  const safeName = (s: string): string => (s || 'anon').replace(/[^\w가-힣-]/g, '_')

  const handleSaveSummary = async (): Promise<void> => {
    if (!session) return
    const ts = new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')
    const filename = `test_summary_${safeName(session.participantId)}_${session.condition}_${ts}.csv`
    try {
      const path = await window.glanceshift.saveEvalCsv(filename, toTrialSummaryCSV(session))
      setSummaryPath(path)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[test] save summary failed:', e)
    }
  }

  const handleSaveRaw = async (): Promise<void> => {
    if (!session) return
    const ts = new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')
    const filename = `test_raw_${safeName(session.participantId)}_${session.condition}_${ts}.csv`
    try {
      const path = await window.glanceshift.saveEvalCsv(filename, toRawSamplesCSV(session))
      setRawPath(path)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[test] save raw failed:', e)
    }
  }

  // ============================================================
  // UI
  // ============================================================
  if (screen === 'intro') {
    return (
      <div className="eval-root">
        <div className="eval-prompt">
          <h3>볼륨 조절 테스트 (영화 시청 시나리오)</h3>
          <div className="eval-field">
            <label>condition</label>
            <div className="eval-pose-grid">
              <button
                type="button"
                className={`eval-pose-btn${condition === 'gaze' ? ' active' : ''}`}
                onClick={() => setCondition('gaze')}
              >
                gaze (GlanceShift)
              </button>
              <button
                type="button"
                className={`eval-pose-btn${condition === 'baseline' ? ' active' : ''}`}
                onClick={() => setCondition('baseline')}
              >
                baseline (다이얼)
              </button>
            </div>
          </div>
          {condition === 'gaze' ? (
            <p>
              화면 중앙에 영화를 틀어 두고 보세요. 랜덤한 타이밍에 <strong>볼륨이 0 으로 떨어지고</strong>{' '}
              "<strong>{targetPct}%</strong> 로 올리세요" 미션이 뜹니다. <strong>시선+머리 기울임</strong>으로
              볼륨을 복구한 뒤 다시 영화(중앙)를 보면 한 trial 이 끝납니다. ESC 취소.
            </p>
          ) : (
            <p>
              화면 중앙에 영화를 틀어 두고 보세요. 미션이 뜨면(진행자가 다이얼을 0 으로) <strong>외장 다이얼</strong>로{' '}
              <strong>{targetPct}%</strong> 까지 맞춘 뒤 <strong>Space</strong> 로 완료를 표시하고 다시
              영화(중앙)를 보세요. ESC 취소.
            </p>
          )}
          <div className="eval-field-row">
            <div className="eval-field">
              <label>participant id</label>
              <input
                type="text"
                value={participantId}
                onChange={(e) => setParticipantId(e.target.value)}
                placeholder="P01"
              />
            </div>
            <div className="eval-field">
              <label>trial 수</label>
              <input
                type="number"
                value={numTrials}
                min={1}
                onChange={(e) => setNumTrials(Math.max(1, parseInt(e.target.value || '1', 10)))}
              />
            </div>
            <div className="eval-field">
              <label>목표 볼륨 %</label>
              <input
                type="number"
                value={targetPct}
                min={1}
                max={100}
                onChange={(e) =>
                  setTargetPct(Math.max(1, Math.min(100, parseInt(e.target.value || '50', 10))))
                }
              />
            </div>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
            저장:{' '}
            <code style={{ color: '#a8d2ff' }}>
              test_*_{safeName(participantId)}_{condition}_*.csv
            </code>
          </div>
          <button type="button" className="calib-continue" onClick={handleStart}>
            시작
          </button>
        </div>
      </div>
    )
  }

  if (screen === 'running') {
    const showPrompt = uiPhase === 'mission'
    return (
      <div className="eval-root running">
        <div className="test-corner">
          {activeTrialIdx + 1} / {numTrials} · {condition}
        </div>
        {showPrompt && (
          <div className="test-prompt" style={{ left: viewport.w / 2, top: viewport.h * 0.12 }}>
            <div className="test-prompt-label">볼륨을</div>
            <div className="test-prompt-value">{targetPct}%</div>
            <div className="test-prompt-label">
              {condition === 'gaze' ? '로 올려 주세요' : '로 맞춘 뒤 Space'}
            </div>
          </div>
        )}
      </div>
    )
  }

  // complete
  if (screen === 'complete' && session) {
    const t = session.trials
    const n = t.length || 1
    const mean = (vals: (number | null)[]): number | null => {
      const xs = vals.filter((v): v is number => v != null)
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    }
    const meanAdjust = mean(t.map((x) => x.timeToAdjustMs))
    const meanReturn = mean(t.map((x) => x.timeToReturnMs))
    const meanErr = mean(t.map((x) => x.absErrorPct))
    const settleRate = t.filter((x) => x.settled).length / n

    return (
      <div className="eval-root">
        <div className="eval-prompt eval-prompt-wide">
          <h3>
            완료 — {session.condition} · {session.trials.length} trials
          </h3>
          <div className="eval-stats">
            <div className="eval-stat">
              <span className="eval-stat-label">mean 조절시간</span>
              <span className="eval-stat-value">
                {meanAdjust != null ? `${(meanAdjust / 1000).toFixed(2)} s` : '—'}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">mean 이탈→복귀</span>
              <span className="eval-stat-value">
                {meanReturn != null ? `${(meanReturn / 1000).toFixed(2)} s` : '—'}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">mean 오차</span>
              <span className="eval-stat-value">
                {meanErr != null ? `${meanErr.toFixed(1)} %p` : '—'}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">복귀 성공률</span>
              <span className="eval-stat-value">{(settleRate * 100).toFixed(0)}%</span>
            </div>
          </div>
          <div className="eval-actions">
            <button type="button" className="calib-continue" onClick={handleSaveSummary}>
              요약 CSV 저장
            </button>
            <button type="button" className="calib-continue" onClick={handleSaveRaw}>
              raw CSV 저장
            </button>
            <button
              type="button"
              className="calib-reset"
              onClick={() => window.glanceshift.revealEvalFolder()}
            >
              폴더 열기
            </button>
            <button type="button" className="calib-reset" onClick={handleStart}>
              다시
            </button>
            <button type="button" className="calib-reset" onClick={() => onDoneRef.current()}>
              완료
            </button>
          </div>
          {(summaryPath || rawPath) && (
            <p style={{ fontSize: 11, marginTop: 8, color: '#7be38a', wordBreak: 'break-all' }}>
              {summaryPath && (
                <>
                  저장됨: {summaryPath}
                  <br />
                </>
              )}
              {rawPath && <>저장됨: {rawPath}</>}
            </p>
          )}
        </div>
      </div>
    )
  }

  return <div className="eval-root" />
}
