/**
 * TestMode — 볼륨 조절 사용자 실험 진행 + 데이터 수집 오버레이.
 *
 *   Cmd/Ctrl+Shift+T 로 진입. ESC 로 취소.
 *
 * 흐름 (trial 반복):
 *   wait(랜덤 3–8초) → prompt("볼륨을 NN%로 맞추세요") → adjust → reimmersion → 다음 trial
 *
 * 두 조건:
 *   · gaze     : GlanceShift(시선+머리). 볼륨 모드 진입/이탈을 관찰, 최종 이탈 시 볼륨을 기록.
 *   · baseline : 외장 다이얼. 앱은 볼륨을 못 읽으므로 Space 키로 "완료" 마킹 (타이밍만).
 *
 * 재몰입(re-immersion) proxy: 완료 후 시선이 중앙(게임) 영역으로 복귀·안정화까지의 시간.
 *
 * 수집 데이터는 trial 요약 CSV + raw 시계열 CSV 로 저장 (userData/eval-logs/).
 * 측정/직렬화 로직은 perception/test-session.ts (pure) 에 위임. UI/타이밍 패턴은 Evaluation.tsx 미러.
 */

import { useEffect, useRef, useState } from 'react'
import {
  centralRegionPx,
  computeReimmersion,
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
  onDone: () => void
}

type Screen = 'intro' | 'running' | 'complete'

// ===== 타이밍 상수 =====
const WAIT_MIN_MS = 3000
const WAIT_MAX_MS = 8000
const ADJUST_TIMEOUT_MS = 25_000 // 첫 진입/완료 없을 때 안전 타임아웃
const SETTLE_HOLD_MS = 800 // 중앙 영역 연속 체류 → 재몰입 완료
const REIM_TIMEOUT_MS = 8000 // 재몰입 측정 최대 시간
const DEFAULT_TRIALS = 12

/** 재몰입 판정용 중앙 영역 (viewport 비율) — 화면 중앙 50% 사각형 */
const CENTRAL_REGION_FRAC = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }

/** 목표 볼륨 리스트 생성 — 10..90% 사이 5단위 값에서 무작위. */
function makeTargets(n: number): number[] {
  const pool: number[] = []
  for (let v = 10; v <= 90; v += 5) pool.push(v)
  const out: number[] = []
  let last = -1
  for (let i = 0; i < n; i++) {
    let t = pool[Math.floor(Math.random() * pool.length)]
    // 직전과 동일/근접한 목표는 가급적 피해 조절 폭을 확보
    let guard = 0
    while (Math.abs(t - last) < 15 && guard++ < 8) {
      t = pool[Math.floor(Math.random() * pool.length)]
    }
    out.push(t)
    last = t
  }
  return out
}

function randomWait(): number {
  return WAIT_MIN_MS + Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS)
}

/** 세션 진행을 구동하는 가변 엔진 상태 (RAF 루프에서만 변경) */
type Engine = {
  phase: RawSample['phase']
  trialIdx: number
  waitUntil: number
  // 현재 trial
  target: number
  promptAt: number
  promptWall: number
  startVolPct: number
  firstEntryAt: number | null
  numEntries: number
  inMode: boolean
  exitAt: number
  reimStartIdx: number
  reimHoldStart: number | null
  reimStart: number
}

export function TestMode({
  gazePoint,
  headRoll,
  selectedControlId,
  volumeValue,
  liveVolume,
  edgeState,
  viewport,
  onDone
}: Props): JSX.Element {
  const [screen, setScreen] = useState<Screen>('intro')
  const [condition, setCondition] = useState<TestCondition>('gaze')
  const [participantId, setParticipantId] = useState('')
  const [numTrials, setNumTrials] = useState(DEFAULT_TRIALS)

  // 진행 표시용 (RAF 엔진이 전이 시에만 갱신)
  const [activeTrialIdx, setActiveTrialIdx] = useState(0)
  const [activeTarget, setActiveTarget] = useState<number | null>(null)
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
    const targets = makeTargets(numTrials)
    const sessionStart = performance.now()
    const sessionWall = Date.now()
    const raw: RawSample[] = []
    const trials: TrialSummary[] = []
    const region = centralRegionPx(viewportRef.current, CENTRAL_REGION_FRAC)

    const eng: Engine = {
      phase: 'wait',
      trialIdx: 0,
      waitUntil: sessionStart + randomWait(),
      target: targets[0],
      promptAt: 0,
      promptWall: 0,
      startVolPct: 0,
      firstEntryAt: null,
      numEntries: 0,
      inMode: false,
      exitAt: 0,
      reimStartIdx: 0,
      reimHoldStart: null,
      reimStart: 0
    }

    let raf = 0
    let cancelled = false
    doneKeyRef.current = false

    const finalizeTrial = (now: number, settledOverride?: boolean): void => {
      // 재몰입 계산 (reimmersion 단계 raw slice)
      const reimSamples = raw.slice(eng.reimStartIdx)
      const reim =
        settledOverride === false
          ? { reimmersionMs: null, pathPx: null as number | null, settled: false }
          : computeReimmersion(reimSamples, region, SETTLE_HOLD_MS)

      const finalVolPct = cond === 'gaze' ? volRef.current * 100 : null
      const absErrorPct = finalVolPct != null ? Math.abs(finalVolPct - eng.target) : null
      const noEntry = cond === 'gaze' && eng.firstEntryAt == null

      trials.push({
        condition: cond,
        trialIdx: eng.trialIdx,
        targetPct: eng.target,
        startVolPct: eng.startVolPct,
        finalVolPct,
        absErrorPct,
        promptShownAt: eng.promptWall,
        timeToFirstEntryMs:
          cond === 'gaze' && eng.firstEntryAt != null ? eng.firstEntryAt - eng.promptAt : null,
        adjustTimeMs:
          cond === 'gaze' && eng.firstEntryAt != null && !noEntry
            ? eng.exitAt - eng.firstEntryAt
            : null,
        totalTimeMs: noEntry ? null : eng.exitAt - eng.promptAt,
        numModeEntries: eng.numEntries,
        reimmersionMs: reim.reimmersionMs,
        reimmersionPathPx: reim.pathPx,
        settled: reim.settled
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
      eng.target = targets[next]
      eng.phase = 'wait'
      eng.waitUntil = now + randomWait()
      eng.firstEntryAt = null
      eng.numEntries = 0
      eng.inMode = false
      eng.reimHoldStart = null
      setActiveTrialIdx(next)
      setActiveTarget(null)
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
          eng.phase = 'adjust'
          eng.promptAt = now
          eng.promptWall = Date.now()
          eng.startVolPct = volRef.current * 100
          eng.firstEntryAt = null
          eng.numEntries = 0
          eng.inMode = false
          setActiveTarget(eng.target)
          setUiPhase('adjust')
        }
      } else if (eng.phase === 'adjust') {
        if (cond === 'gaze') {
          const isIn = selected === 'volume'
          if (isIn && !eng.inMode) {
            // 진입
            eng.inMode = true
            eng.numEntries += 1
            if (eng.firstEntryAt == null) eng.firstEntryAt = now
          } else if (!isIn && eng.inMode) {
            // 이탈 → reimmersion 측정 시작 (재진입 시 취소됨)
            eng.inMode = false
            eng.exitAt = now
            eng.phase = 'reimmersion'
            eng.reimStart = now
            eng.reimStartIdx = raw.length
            eng.reimHoldStart = null
            setUiPhase('reimmersion')
          } else if (eng.firstEntryAt == null && now - eng.promptAt >= ADJUST_TIMEOUT_MS) {
            // 진입 한 번도 없이 타임아웃 → 실패 처리
            eng.exitAt = now
            finalizeTrial(now, false)
          }
        } else {
          // baseline — Space 완료
          if (doneKeyRef.current) {
            doneKeyRef.current = false
            eng.exitAt = now
            eng.phase = 'reimmersion'
            eng.reimStart = now
            eng.reimStartIdx = raw.length
            eng.reimHoldStart = null
            setUiPhase('reimmersion')
          } else if (now - eng.promptAt >= ADJUST_TIMEOUT_MS) {
            eng.exitAt = now
            finalizeTrial(now, false)
          }
        }
      } else if (eng.phase === 'reimmersion') {
        // gaze: 재진입하면 다시 adjust 로 (완료 아님)
        if (cond === 'gaze' && selected === 'volume') {
          eng.inMode = true
          eng.numEntries += 1
          eng.phase = 'adjust'
          eng.reimHoldStart = null
          setUiPhase('adjust')
        } else {
          const inCentral =
            gx >= 0 && gy >= 0 && gx >= region.x0 && gx <= region.x1 && gy >= region.y0 && gy <= region.y1
          if (inCentral) {
            if (eng.reimHoldStart == null) eng.reimHoldStart = now
            if (now - eng.reimHoldStart >= SETTLE_HOLD_MS) {
              finalizeTrial(now, true)
              raf = requestAnimationFrame(tick)
              return
            }
          } else {
            eng.reimHoldStart = null
          }
          if (now - eng.reimStart >= REIM_TIMEOUT_MS) {
            finalizeTrial(now, true) // computeReimmersion 이 settled=false 처리
            raf = requestAnimationFrame(tick)
            return
          }
        }
      }

      raf = requestAnimationFrame(tick)
    }

    setActiveTrialIdx(0)
    setActiveTarget(null)
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
          <h3>볼륨 조절 테스트</h3>
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
              랜덤한 타이밍에 목표 볼륨이 표시됩니다. <strong>시선+머리 기울임</strong>으로 볼륨을
              맞춰 주세요. 조절 모드를 빠져나오면 한 trial 이 끝나고, 시선이 화면 중앙으로 돌아가는
              시간(재몰입)이 측정됩니다. ESC 취소.
            </p>
          ) : (
            <p>
              랜덤한 타이밍에 목표 볼륨이 표시됩니다. <strong>외장 다이얼</strong>로 볼륨을 맞춘 뒤
              <strong> Space</strong> 키로 완료를 표시해 주세요. 이후 시선이 중앙으로 돌아가는
              시간(재몰입)이 측정됩니다. ESC 취소.
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
    const showPrompt = uiPhase === 'adjust' && activeTarget != null
    return (
      <div className="eval-root running">
        <div className="test-corner">
          {activeTrialIdx + 1} / {numTrials} · {condition}
        </div>
        {showPrompt && (
          <div className="test-prompt" style={{ left: viewport.w / 2, top: viewport.h * 0.18 }}>
            <div className="test-prompt-label">볼륨을</div>
            <div className="test-prompt-value">{activeTarget}%</div>
            <div className="test-prompt-label">
              {condition === 'gaze' ? '로 맞춰 주세요' : '로 맞춘 뒤 Space'}
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
    const totals = t.map((x) => x.totalTimeMs).filter((v): v is number => v != null)
    const meanTotal = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null
    const errs = t.map((x) => x.absErrorPct).filter((v): v is number => v != null)
    const meanErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null
    const reims = t.map((x) => x.reimmersionMs).filter((v): v is number => v != null)
    const meanReim = reims.length ? reims.reduce((a, b) => a + b, 0) / reims.length : null
    const settleRate = t.filter((x) => x.settled).length / n

    return (
      <div className="eval-root">
        <div className="eval-prompt eval-prompt-wide">
          <h3>
            완료 — {session.condition} · {session.trials.length} trials
          </h3>
          <div className="eval-stats">
            <div className="eval-stat">
              <span className="eval-stat-label">mean 도달시간</span>
              <span className="eval-stat-value">
                {meanTotal != null ? `${(meanTotal / 1000).toFixed(2)} s` : '—'}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">mean 오차</span>
              <span className="eval-stat-value">
                {meanErr != null ? `${meanErr.toFixed(1)} %p` : '—'}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">mean 재몰입</span>
              <span className="eval-stat-value">
                {meanReim != null ? `${(meanReim / 1000).toFixed(2)} s` : '—'}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">재몰입 성공률</span>
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
              {summaryPath && <>저장됨: {summaryPath}<br /></>}
              {rawPath && <>저장됨: {rawPath}</>}
            </p>
          )}
        </div>
      </div>
    )
  }

  return <div className="eval-root" />
}
