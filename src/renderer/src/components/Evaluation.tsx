/**
 * Evaluation — 두 가지 평가 type 을 제공.
 *
 *   1. gaze accuracy : 5×5 grid 시선 정확도 (기존). 보고서 §5.1 의 정확도 baseline.
 *
 *   2. trigger accuracy : SNAPPING_MODE_PLAN §13. 각 trial 에서 화살표가 가리키는 변에
 *                         사용자가 시선만으로 lock 되는지 측정. 20 trials + 30s FTR.
 *                         보고서 §5.1 표 2 (TSR / MTT / WER / FTR per mode) 의 원천.
 *
 * Cmd/Ctrl+Shift+E 로 진입. ESC 로 취소.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  computePerTarget,
  aggregate,
  toCSV,
  type Sample,
  type PerTargetResult,
  type AggregateResult
} from '../perception/eval-stats'
import { EdgeDetector, type Edge, type EdgeEvent } from '../perception/edge-detector'

type EvalType = 'gaze' | 'trigger'

type Phase = 'intro' | 'running' | 'free30s' | 'complete'

type Props = {
  gazePoint: { x: number; y: number } | null
  onDone: () => void
}

/** 단일 모드 — CSV/condition 라벨용 고정 식별자. */
const MODE = 'snapping'

const N_ROWS = 5
const N_COLS = 5
const MARGIN_FRAC = 0.1
const PREP_MS = 500
const MEASURE_MS = 1500
const SAMPLING_START_MS = PREP_MS + 500

// ===== Trigger eval 상수 =====
const TRIGGER_TRIALS = 20
const TRIGGER_FIX_MS = 500 // fixation cross
const TRIGGER_ARROW_MS = 300 // 화살표 표시 (cue)
const TRIGGER_MAX_RESPONSE_MS = 2000 // 화살표 사라진 뒤 최대 응답 시간
const FREE_30S_MS = 30_000

function makeTargets(width: number, height: number): { x: number; y: number; idx: number }[] {
  const out: { x: number; y: number; idx: number }[] = []
  const cols: number[] = []
  const rows: number[] = []
  for (let c = 0; c < N_COLS; c++) {
    cols.push(MARGIN_FRAC + (1 - 2 * MARGIN_FRAC) * (c / (N_COLS - 1)))
  }
  for (let r = 0; r < N_ROWS; r++) {
    rows.push(MARGIN_FRAC + (1 - 2 * MARGIN_FRAC) * (r / (N_ROWS - 1)))
  }
  let idx = 0
  for (let r = 0; r < N_ROWS; r++) {
    for (let c = 0; c < N_COLS; c++) {
      out.push({ x: cols[c] * width, y: rows[r] * height, idx: idx++ })
    }
  }
  return out
}

const POSE_PRESETS = [
  { id: 'baseline-frontal', label: '정면 baseline' },
  { id: 'yaw-15deg', label: '좌/우 15° 회전' },
  { id: 'dist-far', label: '거리 +20cm' },
  { id: 'dist-near', label: '거리 -10cm' },
  { id: 'drift-5min', label: '5분 자유작업 후' }
]

const EDGES: Edge[] = ['left', 'right', 'top', 'bottom']

type TriggerTrial = {
  trialIdx: number
  targetEdge: Edge
  /** lock 진입한 edge — timeout 시 null */
  lockedEdge: Edge | null
  /** ms — cue offset 부터 lock 까지 (null = timeout) */
  triggerTimeMs: number | null
  /** 시선 경로 길이 (px) — cue offset 부터 lock 또는 timeout 까지 */
  pathLengthPx: number
  /** 성공 = lockedEdge === targetEdge */
  success: boolean
  /** wrong-edge / timeout / success */
  outcome: 'success' | 'wrong-edge' | 'timeout'
}

type TriggerResult = {
  mode: string
  pose: string
  startedAt: number
  trials: TriggerTrial[]
  /** Free 30s 동안 발생한 lock 횟수 */
  ftrLockCount: number
  /** FTR 측정에 걸린 실제 ms (보통 30000) */
  ftrDurationMs: number
}

export function Evaluation({ gazePoint, onDone }: Props): JSX.Element {
  const [evalType, setEvalType] = useState<EvalType>('gaze')
  const [phase, setPhase] = useState<Phase>('intro')
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [pose, setPose] = useState<string>('baseline-frontal')
  const condition = `${MODE}__${pose}`
  const [screenWidthCm, setScreenWidthCm] = useState<string>('')
  const [screenDistanceCm, setScreenDistanceCm] = useState<string>('')

  // gaze accuracy state
  const [targetIdx, setTargetIdx] = useState(0)
  const [phaseInTarget, setPhaseInTarget] = useState<'prep' | 'measure'>('prep')
  const [results, setResults] = useState<PerTargetResult[]>([])
  const [aggResult, setAggResult] = useState<AggregateResult | null>(null)

  // trigger eval state
  const [triggerTrials, setTriggerTrials] = useState<TriggerTrial[]>([])
  const [triggerTrialIdx, setTriggerTrialIdx] = useState(0)
  const [triggerStage, setTriggerStage] = useState<'fix' | 'cue' | 'response'>('fix')
  const [triggerTargetEdge, setTriggerTargetEdge] = useState<Edge>('right')
  const [ftrCountdownMs, setFtrCountdownMs] = useState<number>(FREE_30S_MS)
  const [triggerResult, setTriggerResult] = useState<TriggerResult | null>(null)

  const [savedPath, setSavedPath] = useState<string | null>(null)
  const startedAtRef = useRef<number>(0)

  // gazePoint ref + onDone ref (stale closure 방지)
  const gazeRef = useRef<{ x: number; y: number } | null>(gazePoint)
  gazeRef.current = gazePoint
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  // Trigger eval 에서 자체적으로 사용하는 EdgeDetector (App 과 독립)
  // 평가 시작 시 mode profile 로 초기화. ftr 측정 중에도 같은 인스턴스 사용.
  const triggerDetectorRef = useRef<EdgeDetector | null>(null)

  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDoneRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const targets = useMemo(() => makeTargets(viewport.w, viewport.h), [viewport])

  // ============================================================
  // GAZE ACCURACY  — 기존 5×5 grid 평가
  // ============================================================
  useEffect(() => {
    if (evalType !== 'gaze' || phase !== 'running') return
    if (targetIdx >= targets.length) {
      const widthCm = parseFloat(screenWidthCm)
      const distCm = parseFloat(screenDistanceCm)
      const agg = aggregate(results, {
        condition,
        startedAt: startedAtRef.current,
        viewport,
        screenWidthCm: Number.isFinite(widthCm) && widthCm > 0 ? widthCm : null,
        screenDistanceCm: Number.isFinite(distCm) && distCm > 0 ? distCm : null
      })
      setAggResult(agg)
      setPhase('complete')
      return
    }
    const target = targets[targetIdx]
    setPhaseInTarget('prep')
    const measureTimer = window.setTimeout(() => setPhaseInTarget('measure'), PREP_MS)
    const samples: Sample[] = []
    let samplingActive = false
    const samplingStartTimer = window.setTimeout(() => {
      samplingActive = true
    }, SAMPLING_START_MS)
    let raf = 0
    const collect = (): void => {
      if (samplingActive) {
        const g = gazeRef.current
        if (g && g.x >= 0 && g.y >= 0) {
          samples.push({ tx: target.x, ty: target.y, gx: g.x, gy: g.y, t: performance.now() })
        }
      }
      raf = requestAnimationFrame(collect)
    }
    raf = requestAnimationFrame(collect)
    const endTimer = window.setTimeout(() => {
      const r = computePerTarget(target.idx, { x: target.x, y: target.y }, samples)
      setResults((cur) => [...cur, r])
      setTargetIdx((i) => i + 1)
    }, PREP_MS + MEASURE_MS)
    return () => {
      clearTimeout(measureTimer)
      clearTimeout(samplingStartTimer)
      clearTimeout(endTimer)
      cancelAnimationFrame(raf)
    }
  }, [evalType, phase, targetIdx, targets, condition, screenWidthCm, screenDistanceCm, viewport])

  // ============================================================
  // TRIGGER ACCURACY  — fixation → cue → response × 20 trials
  // ============================================================
  useEffect(() => {
    if (evalType !== 'trigger' || phase !== 'running') return
    if (triggerTrialIdx >= TRIGGER_TRIALS) {
      // 모든 trial 끝 → free-30s 단계로
      setPhase('free30s')
      return
    }

    const target: Edge = EDGES[Math.floor(Math.random() * EDGES.length)]
    setTriggerTargetEdge(target)
    setTriggerStage('fix')

    // detector 는 매 trial 시작 시 reset (이전 trial 의 잔여 state 제거)
    triggerDetectorRef.current?.reset()

    let cueStartedAt = 0
    let pathLength = 0
    let lastG: { x: number; y: number } | null = null
    let raf = 0
    let stage: 'fix' | 'cue' | 'response' = 'fix'
    let cueTimer = 0
    let responseTimer = 0
    let finished = false

    const finishTrial = (
      outcome: 'success' | 'wrong-edge' | 'timeout',
      lockedEdge: Edge | null,
      lockNow: number
    ): void => {
      if (finished) return
      finished = true
      const triggerTimeMs = lockedEdge != null ? lockNow - cueStartedAt : null
      const trial: TriggerTrial = {
        trialIdx: triggerTrialIdx,
        targetEdge: target,
        lockedEdge,
        triggerTimeMs,
        pathLengthPx: pathLength,
        success: outcome === 'success',
        outcome
      }
      setTriggerTrials((cur) => [...cur, trial])
      setTriggerTrialIdx((i) => i + 1)
    }

    const tick = (): void => {
      if (finished) return
      const now = performance.now()
      const g = gazeRef.current

      // 경로 길이 누적 (cue 이후)
      if (stage !== 'fix' && g) {
        if (lastG) pathLength += Math.hypot(g.x - lastG.x, g.y - lastG.y)
        lastG = { x: g.x, y: g.y }
      }

      // edge detector 갱신 (response 단계에서만 의미 있음, fix 중에도 reset 상태 유지를 위해 호출 안 함)
      if (stage === 'response' && g && g.x >= 0 && g.y >= 0 && triggerDetectorRef.current) {
        const evt = triggerDetectorRef.current.update({ x: g.x, y: g.y }, viewport, now)
        if (evt && evt.type === 'enter') {
          finishTrial(evt.edge === target ? 'success' : 'wrong-edge', evt.edge, now)
        }
      }
      raf = requestAnimationFrame(tick)
    }

    // Stage 진행 — fix (500ms) → cue (300ms) → response (max 2000ms or trigger)
    const fixTimer = window.setTimeout(() => {
      stage = 'cue'
      setTriggerStage('cue')
      cueTimer = window.setTimeout(() => {
        stage = 'response'
        setTriggerStage('response')
        cueStartedAt = performance.now()
        lastG = null
        // response window 안에 lock 안 되면 timeout
        responseTimer = window.setTimeout(() => {
          finishTrial('timeout', null, performance.now())
        }, TRIGGER_MAX_RESPONSE_MS)
      }, TRIGGER_ARROW_MS)
    }, TRIGGER_FIX_MS)

    raf = requestAnimationFrame(tick)

    return () => {
      finished = true
      clearTimeout(fixTimer)
      clearTimeout(cueTimer)
      clearTimeout(responseTimer)
      cancelAnimationFrame(raf)
    }
  }, [evalType, phase, triggerTrialIdx, viewport])

  // ============================================================
  // FREE 30s — FTR (False Trigger Rate) 측정
  // ============================================================
  useEffect(() => {
    if (phase !== 'free30s') return
    const start = performance.now()
    triggerDetectorRef.current?.reset()
    let ftrCount = 0
    let raf = 0
    let interval: number | null = null

    const tick = (): void => {
      const now = performance.now()
      const elapsed = now - start
      if (elapsed >= FREE_30S_MS) return
      const g = gazeRef.current
      if (g && g.x >= 0 && g.y >= 0 && triggerDetectorRef.current) {
        const evt: EdgeEvent | null = triggerDetectorRef.current.update(
          { x: g.x, y: g.y },
          viewport,
          now
        )
        if (evt && evt.type === 'enter') {
          ftrCount += 1
        }
      }
      raf = requestAnimationFrame(tick)
    }

    interval = window.setInterval(() => {
      const now = performance.now()
      setFtrCountdownMs(Math.max(0, FREE_30S_MS - (now - start)))
    }, 100)
    raf = requestAnimationFrame(tick)

    const endTimer = window.setTimeout(() => {
      cancelAnimationFrame(raf)
      if (interval != null) clearInterval(interval)
      const result: TriggerResult = {
        mode: MODE,
        pose,
        startedAt: startedAtRef.current,
        trials: triggerTrials,
        ftrLockCount: ftrCount,
        ftrDurationMs: FREE_30S_MS
      }
      setTriggerResult(result)
      setPhase('complete')
    }, FREE_30S_MS)

    return () => {
      cancelAnimationFrame(raf)
      if (interval != null) clearInterval(interval)
      clearTimeout(endTimer)
    }
  }, [phase, viewport, pose, triggerTrials])

  // ============================================================
  // 액션
  // ============================================================
  const handleStart = (): void => {
    setSavedPath(null)
    setResults([])
    setTargetIdx(0)
    setAggResult(null)
    setTriggerTrials([])
    setTriggerTrialIdx(0)
    setTriggerResult(null)
    setFtrCountdownMs(FREE_30S_MS)
    startedAtRef.current = Date.now()
    if (evalType === 'trigger') {
      // detector 인스턴스 새로 생성 (App 과 독립, 기본 snap config)
      triggerDetectorRef.current = new EdgeDetector()
    }
    setPhase('running')
  }

  const handleSaveGazeCSV = async (): Promise<void> => {
    if (!aggResult) return
    const csv = toCSV(aggResult)
    const ts = new Date(aggResult.startedAt).toISOString().replace(/[:.]/g, '-')
    const safeCondition = aggResult.condition.replace(/[^\w가-힣-]/g, '_')
    const filename = `eval_${safeCondition}_${ts}.csv`
    try {
      const fullPath = await window.glanceshift.saveEvalCsv(filename, csv)
      setSavedPath(fullPath)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[eval] save failed:', e)
    }
  }

  const handleSaveTriggerCSV = async (): Promise<void> => {
    if (!triggerResult) return
    const csv = toTriggerCSV(triggerResult)
    const ts = new Date(triggerResult.startedAt).toISOString().replace(/[:.]/g, '-')
    const safeMode = (triggerResult.mode || 'unknown').replace(/[^\w-]/g, '_')
    const filename = `trigger_${safeMode}_${ts}.csv`
    try {
      const fullPath = await window.glanceshift.saveEvalCsv(filename, csv)
      setSavedPath(fullPath)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[trigger-eval] save failed:', e)
    }
  }

  // ============================================================
  // UI
  // ============================================================
  if (phase === 'intro') {
    return (
      <div className="eval-root">
        <div className="eval-prompt">
          <h3>평가</h3>
          <div className="eval-field">
            <label>eval type</label>
            <div className="eval-pose-grid">
              <button
                type="button"
                className={`eval-pose-btn${evalType === 'gaze' ? ' active' : ''}`}
                onClick={() => setEvalType('gaze')}
              >
                gaze accuracy (5×5)
              </button>
              <button
                type="button"
                className={`eval-pose-btn${evalType === 'trigger' ? ' active' : ''}`}
                onClick={() => setEvalType('trigger')}
              >
                trigger accuracy (20)
              </button>
            </div>
          </div>
          {evalType === 'gaze' ? (
            <p>
              화면에 25 개의 점이 순서대로 표시됩니다. 각 점이 나타나면
              <strong> 점의 중심을 응시</strong>해 주세요. ESC 로 취소.
            </p>
          ) : (
            <p>
              20 trials. fixation cross 후 짧게 화살표가 가리키는 방향의
              <strong> 가장자리를 응시</strong>해서 lock 되도록 해주세요. 마지막에 30초 동안
              자연 시선의 false-trigger 빈도도 측정합니다. ESC 취소.
            </p>
          )}
          <div className="eval-field">
            <label>pose / condition</label>
            <div className="eval-pose-grid">
              {POSE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`eval-pose-btn${pose === p.id ? ' active' : ''}`}
                  onClick={() => setPose(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
              저장될 condition: <code style={{ color: '#a8d2ff' }}>{condition}</code>
            </div>
          </div>
          {evalType === 'gaze' && (
            <>
              <div className="eval-field-row">
                <div className="eval-field">
                  <label>화면 가로 (cm, 선택)</label>
                  <input
                    type="number"
                    value={screenWidthCm}
                    onChange={(e) => setScreenWidthCm(e.target.value)}
                    placeholder="34.5"
                    step="0.1"
                  />
                </div>
                <div className="eval-field">
                  <label>화면까지 거리 (cm, 선택)</label>
                  <input
                    type="number"
                    value={screenDistanceCm}
                    onChange={(e) => setScreenDistanceCm(e.target.value)}
                    placeholder="55"
                    step="1"
                  />
                </div>
              </div>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: -8 }}>
                (둘 다 입력하면 결과가 도(°) 단위로도 환산됩니다)
              </p>
            </>
          )}
          <button type="button" className="calib-continue" onClick={handleStart}>
            시작
          </button>
        </div>
      </div>
    )
  }

  // ===== GAZE running =====
  if (
    evalType === 'gaze' &&
    phase === 'running' &&
    targetIdx < targets.length
  ) {
    const target = targets[targetIdx]
    const isPrep = phaseInTarget === 'prep'
    return (
      <div className="eval-root running">
        <div className="eval-progress">
          <div className="eval-progress-text">{targetIdx + 1} / {targets.length}</div>
          <div className="eval-progress-bar">
            <div
              className="eval-progress-fill"
              style={{ width: `${((targetIdx + 1) / targets.length) * 100}%` }}
            />
          </div>
        </div>
        <div
          className={`eval-target${isPrep ? ' prep' : ' measure'}`}
          style={{ left: target.x, top: target.y }}
        />
      </div>
    )
  }

  // ===== TRIGGER running =====
  if (evalType === 'trigger' && phase === 'running' && triggerTrialIdx < TRIGGER_TRIALS) {
    return (
      <div className="eval-root running">
        <div className="eval-progress">
          <div className="eval-progress-text">{triggerTrialIdx + 1} / {TRIGGER_TRIALS}</div>
          <div className="eval-progress-bar">
            <div
              className="eval-progress-fill"
              style={{ width: `${((triggerTrialIdx + 1) / TRIGGER_TRIALS) * 100}%` }}
            />
          </div>
        </div>
        {triggerStage === 'fix' && (
          <div
            className="eval-fixation-cross"
            style={{ left: viewport.w / 2, top: viewport.h / 2 }}
          >
            +
          </div>
        )}
        {triggerStage === 'cue' && (
          <div
            className="eval-arrow"
            style={{ left: viewport.w / 2, top: viewport.h / 2 }}
          >
            {arrowGlyph(triggerTargetEdge)}
          </div>
        )}
        {triggerStage === 'response' && (
          <div className="eval-response-hint" style={{ left: viewport.w / 2, top: 60 }}>
            응시하세요
          </div>
        )}
      </div>
    )
  }

  // ===== FREE 30s =====
  if (phase === 'free30s') {
    const seconds = (ftrCountdownMs / 1000).toFixed(1)
    return (
      <div className="eval-root running">
        <div className="eval-prompt">
          <h3>자유 시선 단계 (False-Trigger 측정)</h3>
          <p style={{ marginBottom: 8 }}>
            이제 30초 동안 <strong>평소처럼</strong> 화면을 둘러봐 주세요. 가장자리에 의도적으로 머무르지 마세요.
            그 동안 발생한 의도하지 않은 lock 횟수를 셉니다.
          </p>
          <div style={{ fontSize: 32, fontWeight: 600, textAlign: 'center', color: '#5aa9ff' }}>
            {seconds}s
          </div>
        </div>
      </div>
    )
  }

  // ===== GAZE complete =====
  if (evalType === 'gaze' && phase === 'complete' && aggResult) {
    const { meanErrorPx, maxErrorPx, meanErrorDeg, perTarget } = aggResult
    return (
      <div className="eval-root">
        <div className="eval-prompt eval-prompt-wide">
          <h3>완료 — {aggResult.condition}</h3>
          <div className="eval-stats">
            <div className="eval-stat">
              <span className="eval-stat-label">mean error</span>
              <span className="eval-stat-value">
                {meanErrorPx.toFixed(1)} px
                {meanErrorDeg != null && (
                  <span className="eval-stat-sub"> · {meanErrorDeg.toFixed(2)}°</span>
                )}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">max error</span>
              <span className="eval-stat-value">{maxErrorPx.toFixed(1)} px</span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">samples / target</span>
              <span className="eval-stat-value">
                {Math.round(
                  perTarget.reduce((a, b) => a + b.samples.length, 0) /
                    Math.max(1, perTarget.length)
                )}
              </span>
            </div>
          </div>
          <EvalMiniPlot viewport={viewport} perTarget={perTarget} />
          <div className="eval-actions">
            <button type="button" className="calib-continue" onClick={handleSaveGazeCSV}>
              CSV 저장
            </button>
            <button type="button" className="calib-reset" onClick={handleStart}>
              다시 측정
            </button>
            <button type="button" className="calib-reset" onClick={() => onDoneRef.current()}>
              완료
            </button>
          </div>
          {savedPath && (
            <p style={{ fontSize: 11, marginTop: 8, color: '#7be38a', wordBreak: 'break-all' }}>
              저장됨: {savedPath}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ===== TRIGGER complete =====
  if (evalType === 'trigger' && phase === 'complete' && triggerResult) {
    const summary = summarizeTrigger(triggerResult)
    return (
      <div className="eval-root">
        <div className="eval-prompt eval-prompt-wide">
          <h3>완료 — {condition}</h3>
          <div className="eval-stats">
            <div className="eval-stat">
              <span className="eval-stat-label">TSR</span>
              <span className="eval-stat-value">{(summary.tsr * 100).toFixed(0)}%</span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">mean trigger time</span>
              <span className="eval-stat-value">
                {summary.mtt != null ? `${summary.mtt.toFixed(0)} ms` : '—'}
              </span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">wrong-edge</span>
              <span className="eval-stat-value">{(summary.wer * 100).toFixed(0)}%</span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-label">FTR / 30s</span>
              <span className="eval-stat-value">{triggerResult.ftrLockCount}</span>
            </div>
          </div>
          <div className="eval-actions">
            <button type="button" className="calib-continue" onClick={handleSaveTriggerCSV}>
              CSV 저장
            </button>
            <button type="button" className="calib-reset" onClick={handleStart}>
              다시 측정
            </button>
            <button type="button" className="calib-reset" onClick={() => onDoneRef.current()}>
              완료
            </button>
          </div>
          {savedPath && (
            <p style={{ fontSize: 11, marginTop: 8, color: '#7be38a', wordBreak: 'break-all' }}>
              저장됨: {savedPath}
            </p>
          )}
        </div>
      </div>
    )
  }

  return <div className="eval-root" />
}

function arrowGlyph(edge: Edge): string {
  return edge === 'left' ? '←' : edge === 'right' ? '→' : edge === 'top' ? '↑' : '↓'
}

function summarizeTrigger(r: TriggerResult): {
  tsr: number
  mtt: number | null
  wer: number
} {
  const n = r.trials.length || 1
  const successes = r.trials.filter((t) => t.outcome === 'success')
  const wrong = r.trials.filter((t) => t.outcome === 'wrong-edge')
  const tsr = successes.length / n
  const wer = wrong.length / n
  const mtt =
    successes.length === 0
      ? null
      : successes.reduce((a, b) => a + (b.triggerTimeMs ?? 0), 0) / successes.length
  return { tsr, mtt, wer }
}

function toTriggerCSV(r: TriggerResult): string {
  const BOM = '﻿'
  const header = [
    'mode',
    'trial_idx',
    'target_edge',
    'locked_edge',
    'success',
    'trigger_time_ms',
    'gaze_path_length_px',
    'outcome'
  ].join(',')
  const rows = [header]
  for (const t of r.trials) {
    rows.push(
      [
        JSON.stringify(r.mode),
        t.trialIdx,
        t.targetEdge,
        t.lockedEdge ?? '',
        t.success ? '1' : '0',
        t.triggerTimeMs != null ? t.triggerTimeMs.toFixed(1) : '',
        t.pathLengthPx.toFixed(1),
        t.outcome
      ].join(',')
    )
  }
  // FTR row
  rows.push(
    [
      JSON.stringify(r.mode),
      `"free-${(r.ftrDurationMs / 1000).toFixed(0)}s"`,
      '',
      '',
      '',
      '',
      '',
      `ftr_${r.ftrLockCount}`
    ].join(',')
  )
  return BOM + rows.join('\n')
}

function EvalMiniPlot({
  viewport,
  perTarget
}: {
  viewport: { w: number; h: number }
  perTarget: PerTargetResult[]
}): JSX.Element {
  const SIZE = 280
  const sx = SIZE / viewport.w
  const sy = (SIZE * viewport.h / viewport.w) / viewport.h
  const h = (SIZE * viewport.h) / viewport.w
  return (
    <svg className="eval-miniplot" width={SIZE} height={h} viewBox={`0 0 ${SIZE} ${h}`}>
      <rect
        x={0}
        y={0}
        width={SIZE}
        height={h}
        fill="rgba(255,255,255,0.04)"
        stroke="rgba(255,255,255,0.18)"
      />
      {perTarget.map((r) => {
        const tx = r.target.x * sx
        const ty = r.target.y * sy
        const mx = r.mean.x * sx
        const my = r.mean.y * sy
        return (
          <g key={r.targetIdx}>
            <line x1={tx} y1={ty} x2={mx} y2={my} stroke="rgba(90, 169, 255, 0.6)" strokeWidth={1} />
            <circle cx={tx} cy={ty} r={2.5} fill="rgba(255,255,255,0.7)" />
            <circle cx={mx} cy={my} r={2.5} fill="rgba(90, 169, 255, 0.95)" />
          </g>
        )
      })}
    </svg>
  )
}
