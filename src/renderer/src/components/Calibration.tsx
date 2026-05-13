/**
 * Calibration — 정확도 향상 wizard (3-phase).
 *
 * Phase A: 'pass-1'  — 9-point 격자, 정면 자세 (3 클릭/점)
 * Phase B: 'pass-2'  — 9-point 격자, **다른 자세** (3 클릭/점, pose-aware)
 * Phase C: 'edges'   — 4 코너 + 4 변 중앙, 가장자리 정확도 보강 (3 클릭/점)
 *
 * 각 클릭은 **quality gating** 을 통과해야 학습 데이터로 채택된다:
 *   - iris 검출 됐고 confidence ≥ 0.6 (refineLandmarks 478 활성 시)
 *   - 또는 face 가 detected (478 미 활성 시 fallback)
 * 그렇지 않으면 클릭이 무시되고 도트가 빨갛게 깜빡임 + 안내 표시.
 *
 * 보고서 매핑:
 *   - §5.1 (회복 탄력성) — 가장자리 가중치는 GazeBar 가 위치할 영역의 정확도가
 *                          inteRruption resilience 의 직접 결정 요인이기 때문.
 *   - §3.2 Feel (cool 매체) — between-pass 안내는 짧고 절제된 톤.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { HeadSample } from '../perception/face-landmarker'

type Phase = 'pass-1' | 'between-1-2' | 'pass-2' | 'between-2-edges' | 'edges' | 'done'

type Props = {
  onPointClick: (x: number, y: number) => void
  onDone: (completed: boolean) => void
  onClearCalibration?: () => Promise<void>
  /** App 에서 흐르는 현재 head/iris 상태. quality gating 용. */
  head?: HeadSample | null
}

type Point = { id: string; x: number; y: number }

const CLICKS_PER_POINT = 3
const IRIS_CONF_THRESHOLD = 0.6

function makeGridPoints(width: number, height: number, margin = 0.1): Point[] {
  const cols = [margin, 0.5, 1 - margin]
  const rows = [margin, 0.5, 1 - margin]
  const out: Point[] = []
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      out.push({ id: `g-${r}-${c}`, x: cols[c] * width, y: rows[r] * height })
    }
  }
  return out
}

/** 가장자리 보강용: 4 코너 + 4 변 중앙. 코너 마진을 더 안쪽으로(가장자리는 시선 정확도가 떨어지므로 너무 끝점은 학습 표본으로 무리). */
function makeEdgePoints(width: number, height: number, margin = 0.06): Point[] {
  return [
    { id: 'e-tl', x: width * margin, y: height * margin },
    { id: 'e-tr', x: width * (1 - margin), y: height * margin },
    { id: 'e-bl', x: width * margin, y: height * (1 - margin) },
    { id: 'e-br', x: width * (1 - margin), y: height * (1 - margin) },
    { id: 'e-t', x: width * 0.5, y: height * margin },
    { id: 'e-b', x: width * 0.5, y: height * (1 - margin) },
    { id: 'e-l', x: width * margin, y: height * 0.5 },
    { id: 'e-r', x: width * (1 - margin), y: height * 0.5 }
  ]
}

export function Calibration({ onPointClick, onDone, onClearCalibration, head }: Props): JSX.Element {
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [phase, setPhase] = useState<Phase>('pass-1')
  // 각 phase 별 클릭 카운트 (id → count)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [clearing, setClearing] = useState(false)
  const [rejectFlash, setRejectFlash] = useState<string | null>(null)

  // resize
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // onDone 의 최신 reference 를 ref 에 보관.
  // 부모(App) 가 매 render 마다 새 arrow function 을 prop 으로 내려보내므로
  // useEffect deps 에 onDone 을 그대로 두면, head 30Hz 갱신에 따라 useEffect 가
  // 매번 cleanup → reschedule 되어 done 단계의 250ms 자동 종료 타이머가 영원히
  // 발화 못 하는 버그가 있었다. ref 로 우회.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  // ESC: 취소
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDoneRef.current(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // phase 가 바뀌면 counts 초기화 (다음 phase 의 점들은 다시 0부터 카운트)
  useEffect(() => {
    if (phase === 'pass-1' || phase === 'pass-2' || phase === 'edges') {
      setCounts({})
    }
  }, [phase])

  const handleClear = async (): Promise<void> => {
    if (!onClearCalibration) return
    setClearing(true)
    try {
      await onClearCalibration()
      setCounts({})
      setPhase('pass-1')
    } finally {
      setClearing(false)
    }
  }

  const points: Point[] = useMemo(() => {
    if (phase === 'edges') return makeEdgePoints(viewport.w, viewport.h)
    if (phase === 'pass-1' || phase === 'pass-2') return makeGridPoints(viewport.w, viewport.h)
    return []
  }, [phase, viewport])

  const totalForPhase = points.length * CLICKS_PER_POINT
  const doneClicks = Object.values(counts).reduce(
    (a, b) => a + Math.min(b, CLICKS_PER_POINT),
    0
  )
  const progress = totalForPhase > 0 ? doneClicks / totalForPhase : 0

  // ===== Quality gating =====
  // iris 정보가 있으면 그것을 우선, 없으면 face.detected fallback
  const qualityOk = head
    ? head.iris
      ? head.iris.confidence >= IRIS_CONF_THRESHOLD
      : head.detected
    : true   // head 정보 자체가 없는 경우는 통과 (예: 시작 직후)

  const handleClick = (p: Point): void => {
    if (!qualityOk) {
      setRejectFlash(p.id)
      setTimeout(() => setRejectFlash((cur) => (cur === p.id ? null : cur)), 350)
      return
    }
    const c = (counts[p.id] ?? 0) + 1
    setCounts({ ...counts, [p.id]: c })
    onPointClick(p.x, p.y)

    // 모두 채웠으면 다음 phase 로
    const next = { ...counts, [p.id]: c }
    const finished = points.every((q) => (next[q.id] ?? 0) >= CLICKS_PER_POINT)
    if (finished) {
      // 다음 phase 결정
      setTimeout(() => {
        if (phase === 'pass-1') setPhase('between-1-2')
        else if (phase === 'pass-2') setPhase('between-2-edges')
        else if (phase === 'edges') setPhase('done')
      }, 80)
    }
  }

  // phase === 'done' 이면 자동 종료. onDone 은 ref 로 잡아서
  // head 30Hz 갱신에 따른 재렌더로 타이머가 reset 되지 않도록 한다.
  useEffect(() => {
    if (phase === 'done') {
      const t = setTimeout(() => onDoneRef.current(true), 600)
      return () => clearTimeout(t)
    }
    return undefined
  }, [phase])

  // ===== UI 분기 =====

  if (phase === 'between-1-2') {
    return (
      <div className="calib-root">
        <div className="calib-prompt">
          <h3>2단계: 자세를 살짝 바꿔주세요</h3>
          <p>
            잠깐, 의자에서 살짝 앞으로 기울이거나 위치를 약간 옮긴 다음<br />
            계속해 주세요. 같은 자세로만 캘리브하면 그 자세에서만 정확합니다.
          </p>
          <button
            type="button"
            className="calib-continue"
            onClick={() => setPhase('pass-2')}
          >
            계속
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'between-2-edges') {
    return (
      <div className="calib-root">
        <div className="calib-prompt">
          <h3>3단계: 가장자리 정확도 보강</h3>
          <p>
            GazeBar 가 화면 가장자리에서 떠오르기 때문에<br />
            모서리·변 중앙 8 지점만 한 번 더 학습합니다.
          </p>
          <button
            type="button"
            className="calib-continue"
            onClick={() => setPhase('edges')}
          >
            계속
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <div className="calib-root">
        <div className="calib-prompt">
          <h3>캘리브레이션 완료</h3>
          <p style={{ color: 'rgba(255,255,255,0.6)' }}>곧 종료됩니다…</p>
        </div>
      </div>
    )
  }

  // pass-1 / pass-2 / edges — 점 표시 단계
  const phaseLabel =
    phase === 'pass-1'
      ? '1 / 3 · 정면 자세'
      : phase === 'pass-2'
        ? '2 / 3 · 변경된 자세'
        : '3 / 3 · 가장자리 보강'

  return (
    <div className="calib-root">
      <div className="calib-header">
        <h3>시선 캘리브레이션</h3>
        <p>
          각 점을 응시하면서 <strong>{CLICKS_PER_POINT}번 클릭</strong>해 주세요. ESC 로 취소.
        </p>
        <div className="calib-phase-pill">{phaseLabel}</div>
        <div className="calib-progress">
          <div className="calib-progress-bar" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="calib-progress-text">
          {doneClicks} / {totalForPhase}
        </div>
        {!qualityOk && (
          <div className="calib-quality-warning">
            얼굴 또는 iris 인식이 약합니다 — 카메라를 정면으로 보세요
          </div>
        )}
        {onClearCalibration && phase === 'pass-1' && doneClicks === 0 && (
          <button
            type="button"
            className="calib-reset"
            onClick={handleClear}
            disabled={clearing}
            title="이전 세션의 학습 데이터를 모두 지우고 새로 시작합니다"
          >
            {clearing ? '지우는 중…' : '기존 데이터 지우기'}
          </button>
        )}
      </div>

      {points.map((p) => {
        const c = counts[p.id] ?? 0
        const filled = c >= CLICKS_PER_POINT
        const rejected = rejectFlash === p.id
        return (
          <button
            key={p.id}
            className={
              `calib-dot${filled ? ' filled' : ''}${rejected ? ' rejected' : ''}${qualityOk ? '' : ' quality-bad'}`
            }
            style={{ left: p.x, top: p.y }}
            onClick={() => handleClick(p)}
            aria-label={`calibration point ${p.id}`}
          >
            <span className="calib-dot-count">{Math.min(c, CLICKS_PER_POINT)}</span>
          </button>
        )
      })}
    </div>
  )
}
