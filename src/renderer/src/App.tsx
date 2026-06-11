/**
 * GlanceShift App — 최상위 컴포넌트.
 *
 * 입력 채널:
 *   · 시선  — WebGazer + One Euro Filter (raw mode 는 필터 off), ⌘⇧K 로 캘리브
 *   · 머리  — face mesh landmarks 에서 직접 계산한 yaw/pitch/roll
 *
 * 핵심 책임:
 *   · gaze/head/edge state 를 컴포넌트 트리로 prop 전달
 *   · EdgeDetector (snapping rail FSM) 갱신 (sample useEffect + RAF tick)
 *   · engagement 해제 — 머리가 기울어져 있으면 조작 중으로 유지(조이스틱), 머리가 꼿꼿(upright)
 *     해지면 시선 위치별 임계(zone 밖 1.2s / zone 안 3s) 후 해제 (이탈 판단)
 *   · OS bridge (volume) throttled push + commit on release
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DebugHud } from './components/DebugHud'
import { GazeDot } from './components/GazeDot'
import { Calibration } from './components/Calibration'
import { EdgeZones } from './components/EdgeZones'
import { GazeBar, type GazeBarItem } from './components/GazeBar'
import { Evaluation } from './components/Evaluation'
import { TestMode } from './components/TestMode'
import { createGazeTracker, type GazeSample, type TrackerStatus } from './perception/webgazer'
import {
  createHeadTracker,
  type HeadSample,
  type HeadTrackerStatus
} from './perception/face-landmarker'
import { EdgeDetector, type Edge, type EdgeSnapshot } from './perception/edge-detector'
import { DEFAULT_SNAP_CONFIG } from './perception/intent-score'
import { SliderIntentMapper, DEFAULT_SLIDER_CONFIG } from './perception/slider-mapper'

// GazeBar 의 후보 항목. 머리 기울임으로 볼륨 slider 연결.
// (밝기 항목은 볼륨 단일 실험을 위해 제거 — 단일 항목이면 computeGeometry 가 자동 reflow.)
const GAZEBAR_ITEMS: GazeBarItem[] = [{ id: 'volume', label: 'volume', icon: '🔊' }]

type Point = { x: number; y: number; t: number }

const ZERO_HEAD: HeadSample = {
  yaw: 0,
  pitch: 0,
  roll: 0,
  fYaw: 0,
  fPitch: 0,
  fRoll: 0,
  t: 0,
  detected: false,
  iris: null,
  landmarkCount: 0
}

/**
 * 항목 위 시선이 머물러야 "선택" 으로 간주되는 dwell 시간 (ms).
 * 짧은 hover (탐색) 와 의도적 선택을 구분. dwell 진행은 GazeDot 주변 원형 ring 으로 시각화.
 */
const SELECT_DWELL_MS = 1000

/**
 * 조작 이탈 판단 (engagement 해제).
 *
 * 조이스틱 ramp(값 증감)는 engage 시점 neutral 기준이지만, "이탈" 판정은 그것과 분리한다.
 * 머리를 (움직이지 않아도) 기울이고 있으면 조이스틱처럼 계속 조작 중으로 본다. 따라서 이탈은
 * **머리가 꼿꼿이(절대 기준) 서 있는가** + 시선 위치로 판단한다:
 *
 *   upright = |head roll (절대)| <= UPRIGHT_MAX_DEG
 *   - 시선 zone 밖  + upright 가 RELEASE_GAZE_OUT_MS 지속 → 해제
 *   - 시선 zone 안  + upright 가 RELEASE_GAZE_IN_MS  지속 → 해제 (오래 안 만지면)
 *
 * UPRIGHT_MAX_DEG 는 조이스틱 ramp 의 조작 인식 기준(SliderIntentMapper.uprightMaxDeg)과
 * **동일한 값을 공유**한다 — "꼿꼿하면 조작 안 함" 기준을 ramp/이탈 양쪽에서 일치시킴.
 *
 * (plans/2026-06-02-1518-engagement-and-dynamic-zone.md — 활동 기준 재정의)
 */
const UPRIGHT_MAX_DEG = DEFAULT_SLIDER_CONFIG.uprightMaxDeg
const RELEASE_GAZE_OUT_MS = 1200
const RELEASE_GAZE_IN_MS = 3000

export function App(): JSX.Element {
  const [debugVisible, setDebugVisible] = useState(true)
  const [clickThrough, setClickThrough] = useState(true)
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })

  const [trackerStatus, setTrackerStatus] = useState<TrackerStatus>('unloaded')
  const [trackerError, setTrackerError] = useState<string | null>(null)
  const [gaze, setGaze] = useState<Point>({ x: -1, y: -1, t: 0 })
  const [mouse, setMouse] = useState<Point>({ x: -1, y: -1, t: 0 })
  /** WebGazer가 한 번이라도 (data ≠ null)인 예측을 내놨는지 — 즉 캘리브 후 작동 중 */
  const [hasGazeData, setHasGazeData] = useState(false)

  const [headStatus, setHeadStatus] = useState<HeadTrackerStatus>('unloaded')
  const [headError, setHeadError] = useState<string | null>(null)
  const [head, setHead] = useState<HeadSample>(ZERO_HEAD)

  const [calibrating, setCalibrating] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [testMode, setTestMode] = useState(false)
  const trackerRef = useRef<ReturnType<typeof createGazeTracker> | null>(null)

  // Edge detector — IntentTracker + Rail FSM (snapping).
  const edgeDetectorRef = useRef(new EdgeDetector(DEFAULT_SNAP_CONFIG))
  const [edgeSnapshot, setEdgeSnapshot] = useState<EdgeSnapshot>(() =>
    edgeDetectorRef.current.snapshot(performance.now())
  )

  // EdgeDetector.update 의 마지막 호출 시각 (ms). sample useEffect 와 RAF tick 의
  // 이중 호출 방지를 위해 사용 — 같은 frame 내 양쪽에서 update 가 일어나면 dt≈0 으로
  // intent score 의 시간 적분이 약간 왜곡될 수 있다. 8ms 내 호출은 skip.
  const lastEdgeUpdateAtRef = useRef(0)

  // "조작 중(operating)" = 얼굴 검출 + 머리가 upright 범위를 벗어나 기울어짐 (절대 roll 기준).
  // edge-detector(hold zone 확장, Phase 2)와 engagement 이탈 판정(§8b)이 공유하는 단일 신호.
  // ref 로 미러 — effect 안에서 deps 없이 최신값을 읽는다.
  const operatingRef = useRef(false)
  operatingRef.current = head.detected && Math.abs(head.fRoll) > UPRIGHT_MAX_DEG

  // Snap-in animation 표시 (lock 진입 직후 200ms 동안 GazeDot 의 강한 transition)
  const [snapAnimating, setSnapAnimating] = useState(false)
  const snapAnimTimerRef = useRef<number | null>(null)

  const [gazeBarHoverId, setGazeBarHoverId] = useState<string | null>(null)

  // ===== Dwell-to-select + Engagement(upright 기반 해제) =====
  // 1) hover → 같은 항목 위 SELECT_DWELL_MS 동안 시선 유지 시 selectedControlId 로 commit
  // 2) selected 후 머리를 기울이고 있으면(움직이지 않아도) 조작 중으로 무한 유지. 머리가
  //    꼿꼿(upright)해지면 시선 위치별 임계(zone 밖 1.2s / zone 안 3s) 후 해제. (§8b)
  // 3) selected 중에도 다른 항목에 다시 SELECT_DWELL_MS dwell 하면 새 선택으로 전환.
  //
  // 짧은 hover 는 "탐색", 1초 dwell 은 "선택 의도" 로 해석한다.
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null)
  /** GazeDot ring 표시용 — null 이면 ring 안 보임. itemId 는 디버깅용. */
  const [dwellProgress, setDwellProgress] = useState<{ itemId: string; progress: number } | null>(null)
  /** 현재 dwell 누적 중인 hover 시작 정보. progress 는 setInterval 로 계산. */
  const hoverDwellRef = useRef<{ itemId: string; startedAt: number } | null>(null)

  // 항목별 저장된 슬라이더 값 (commit 된 값) — OS bridge 가 이걸 읽어 적용
  const [sliderValues, setSliderValues] = useState<Record<string, number>>({
    volume: 0.5
  })

  // 현재 hover/active 항목의 *live* 값 — head roll 로 매 프레임 계산
  const [liveSliderValue, setLiveSliderValue] = useState<number | null>(null)
  // 조이스틱 디버그 — engage 중에만 채워짐 (DebugHud 표시용)
  const [sliderDebug, setSliderDebug] = useState<{
    rate: number
    active: boolean
    yawRate: number
  } | null>(null)

  // commit 추적 — hover 가 아니라 activeControl 변화 시 마지막 값을 OS 에 한 번 더 push
  const prevActiveRef = useRef<string | null>(null)
  const lastLiveRef = useRef<number | null>(null)

  // OS bridge throttle — 같은 항목에 대해 100ms 마다 최대 1회 push
  const lastOsPushRef = useRef<{ itemId: string | null; t: number }>({ itemId: null, t: 0 })

  // 1) 시선 + 머리 트래커 init — 카메라 권한 확인 후 순차 시작
  // 순서가 중요: WebGazer 가 video element 를 만든 다음에야 FaceLandmarker 가 그걸 잡을 수 있음.
  useEffect(() => {
    let cancelled = false
    const gazeTracker = createGazeTracker()
    const headTracker = createHeadTracker()
    trackerRef.current = gazeTracker

    const offGazeSample = gazeTracker.onSample((s: GazeSample) => {
      if (cancelled) return
      // OneEuro 필터된 좌표 사용
      setGaze({ x: s.fx, y: s.fy, t: s.t })
      setHasGazeData(true)
    })

    const offGazeStatus = gazeTracker.onStatus((s, err) => {
      if (cancelled) return
      setTrackerStatus(s)
      setTrackerError(err ?? null)
    })

    const offHeadSample = headTracker.onSample((s: HeadSample) => {
      if (cancelled) return
      setHead(s)
    })

    const offHeadStatus = headTracker.onStatus((s, err) => {
      if (cancelled) return
      setHeadStatus(s)
      setHeadError(err ?? null)
    })

    ;(async () => {
      try {
        const status = await window.glanceshift.getCameraPermission()
        if (status !== 'granted') {
          await window.glanceshift.requestCameraPermission()
        }

        if (cancelled) return
        await gazeTracker.start()

        // WebGazer ready → video element 존재 → 머리 트래커 시작
        if (cancelled) return
        await headTracker.start()
      } catch (e) {
        // 에러는 상태 콜백으로 이미 전파됨
      }
    })()

    return () => {
      cancelled = true
      offGazeSample()
      offGazeStatus()
      offHeadSample()
      offHeadStatus()
      headTracker.stop()
      gazeTracker.stop()
    }
  }, [])

  // 2) main process 단축키 동기화
  useEffect(() => {
    const offDebug = window.glanceshift.onToggleDebug(() => setDebugVisible((v) => !v))
    const offCt = window.glanceshift.onClickThroughChange((enabled) => setClickThrough(enabled))
    const offCalib = window.glanceshift.onToggleCalibration(() => setCalibrating((v) => !v))
    const offEval = window.glanceshift.onToggleEvaluation(() => setEvaluating((v) => !v))
    const offTest = window.glanceshift.onToggleTestMode(() => setTestMode((v) => !v))

    return () => {
      offDebug()
      offCt()
      offCalib()
      offEval()
      offTest()
    }
  }, [])

  // 3) viewport 갱신
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 4) Fallback 입력: 마우스 좌표 (gaze tracker 가 ready 가 아닐 때만).
  //    gaze 가 작동 중일 땐 mousemove 가 setState 를 트리거하지 않게 막아
  //    불필요한 30~60Hz rerender 를 차단한다.
  const fallbackMouseRef = useRef(false)
  useEffect(() => {
    fallbackMouseRef.current = !(trackerStatus === 'ready' && hasGazeData)
  }, [trackerStatus, hasGazeData])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!fallbackMouseRef.current) return
      setMouse({ x: e.clientX, y: e.clientY, t: performance.now() })
    }

    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  // 5) 캘리브레이션 / 평가 / 테스트 진입 시 click-through 해제, 종료 시 복귀
  //    (테스트는 baseline 의 Space 완료키 + intro 입력을 위해 마우스/키보드를 받아야 함)
  useEffect(() => {
    if (calibrating || evaluating || testMode) {
      window.glanceshift.setClickThrough(false)
    } else {
      window.glanceshift.setClickThrough(true)
    }
  }, [calibrating, evaluating, testMode])

  // 어떤 입력을 표시할지
  const usingGaze = trackerStatus === 'ready' && gaze.x >= 0
  const point = usingGaze ? gaze : mouse

  // 6) Edge Detector 갱신 — point 가 바뀔 때마다 update, 진입/이탈 이벤트는 콘솔에 로그
  useEffect(() => {
    if (point.x < 0 || point.y < 0) return

    const now = point.t || performance.now()
    const evt = edgeDetectorRef.current.update(
      { x: point.x, y: point.y },
      viewport,
      now,
      operatingRef.current
    )
    lastEdgeUpdateAtRef.current = now

    if (evt) {
      // eslint-disable-next-line no-console
      console.log(
        `[edge] ${evt.type.toUpperCase()} ${evt.edge.padEnd(6)} t=${evt.t.toFixed(0)}ms`
      )

      // lock 진입 → snap-in 모션 트리거
      if (evt.type === 'enter') {
        setSnapAnimating(true)
        if (snapAnimTimerRef.current != null) clearTimeout(snapAnimTimerRef.current)
        snapAnimTimerRef.current = window.setTimeout(() => {
          setSnapAnimating(false)
          snapAnimTimerRef.current = null
        }, 220)
      }
    }

    setEdgeSnapshot(edgeDetectorRef.current.snapshot(point.t || performance.now()))
  }, [point.x, point.y, point.t, viewport.w, viewport.h])

  // 7) building_intent 중에는 point 가 안 움직여도 score 시간 적분이 진행돼야 하므로 RAF 로 보강.
  // gaze stale (point.x < 0) 인 경우에도 update 를 호출해 score 가 자연 decay 되도록.
  useEffect(() => {
    if (edgeSnapshot.state !== 'dwelling') return

    let raf = 0
    const tick = (): void => {
      const now = performance.now()

      // sample useEffect 가 이미 update 했다면 (8ms 이내) skip — dt≈0 이중호출 방지.
      const recentlyUpdated = now - lastEdgeUpdateAtRef.current < 8
      if (!recentlyUpdated) {
        // point 가 stale (음수) 이면 사실상 null gaze. IntentTracker.update 는
        // null/음수 좌표를 받으면 모든 edge score 를 decay 시킨다.
        const validPoint = point.x >= 0 && point.y >= 0
        const evt = validPoint
          ? edgeDetectorRef.current.update({ x: point.x, y: point.y }, viewport, now, operatingRef.current)
          : edgeDetectorRef.current.update({ x: -1, y: -1 }, viewport, now, operatingRef.current)
        lastEdgeUpdateAtRef.current = now

        if (evt) {
          // eslint-disable-next-line no-console
          console.log(
            `[edge] ${evt.type.toUpperCase()} ${evt.edge.padEnd(6)} t=${evt.t.toFixed(0)}ms`
          )

          if (evt.type === 'enter') {
            setSnapAnimating(true)
            if (snapAnimTimerRef.current != null) clearTimeout(snapAnimTimerRef.current)
            snapAnimTimerRef.current = window.setTimeout(() => {
              setSnapAnimating(false)
              snapAnimTimerRef.current = null
            }, 220)
          }
        }
      }

      setEdgeSnapshot(edgeDetectorRef.current.snapshot(now))
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [edgeSnapshot.state, point.x, point.y, viewport.w, viewport.h])

  const inputSource = usingGaze
    ? 'WebGazer (OneEuro filtered)'
    : trackerStatus === 'loading'
      ? 'mouse (gaze loading…)'
      : trackerStatus === 'error'
        ? `mouse (gaze error: ${trackerError ?? ''})`
        : trackerStatus === 'ready' && !hasGazeData
          ? 'mouse (needs calibration — ⌘⇧K)'
          : 'mouse (fallback)'

  // GazeBar onHoverChange — setState 함수는 React 가 stable reference 를 보장하므로
  // 직접 setGazeBarHoverId 를 넘겨도 되지만, 명시적 useCallback 으로 의도를 분명히.
  const handleHoverChange = useCallback((id: string | null) => {
    setGazeBarHoverId(id)
  }, [])

  // GazeBar 는 edge state 가 'entered' 인 동안 보임.
  // 추가로 — activeControl 이 latch 되어 있는 동안에는 시선이 중앙으로 돌아가도
  // 마지막으로 진입했던 edge 를 유지해 GazeBar 를 그대로 띄워둔다.
  // (조작 모드 중에는 값 변화가 시각화돼야 사용자가 head tilt 결과를 확인 가능)
  const lastEnteredEdgeRef = useRef<Edge | null>(null)
  useEffect(() => {
    if (edgeSnapshot.state === 'entered' && edgeSnapshot.edge) {
      lastEnteredEdgeRef.current = edgeSnapshot.edge
    }
  }, [edgeSnapshot.state, edgeSnapshot.edge])

  // effectiveGaze — lock 중에는 rail 위로 강제 (perpendicular jitter 무관), 그 외엔 원본 point.
  // useMemo 를 제거: deps 가 매 sample 마다 변하므로 메모이제이션 효과가 없고, 매 render
  // 새 객체 할당이 동일하다.
  const effectiveGaze: { x: number; y: number } | null =
    edgeSnapshot.state === 'entered' && edgeSnapshot.railCursor
      ? edgeSnapshot.railCursor
      : point.x >= 0
        ? { x: point.x, y: point.y }
        : null

  // GazeBar 의 항목 hover 계산은 effectiveGaze 를 사용 — lock 중에는 rail 좌표.
  const gazeBarGaze = effectiveGaze

  // hover 변화 → dwell 시작/리셋. 같은 항목 유지 시 startedAt 보존, 다른 항목으로 바뀌면 새 dwell.
  // selected 가 이미 있어도 dwell 추적은 계속 — 사용자가 새 항목으로 1초 dwell 하면 재선택 허용.
  useEffect(() => {
    if (gazeBarHoverId == null) {
      hoverDwellRef.current = null
      setDwellProgress(null)
      return
    }
    const cur = hoverDwellRef.current
    if (cur && cur.itemId === gazeBarHoverId) {
      // 같은 항목 위 hover 유지 — startedAt 보존
      return
    }
    // 새 항목 hover 시작
    hoverDwellRef.current = { itemId: gazeBarHoverId, startedAt: performance.now() }
    setDwellProgress({ itemId: gazeBarHoverId, progress: 0 })
  }, [gazeBarHoverId])

  // dwell 진행 감시 — 50ms 마다 progress 갱신, SELECT_DWELL_MS 도달 시 selected commit.
  // dwell 충족 후엔 hoverDwellRef = null (selected 가 책임). 같은 항목에 다시 머무르려면
  // 일단 hover 가 끊긴 뒤 (다른 항목 또는 GazeBar 영역 밖) 새로 진입해야 dwell 재개 — 자연스러움.
  useEffect(() => {
    if (gazeBarHoverId == null) return
    const intervalId = window.setInterval(() => {
      const dwell = hoverDwellRef.current
      if (!dwell) return
      const now = performance.now()
      const progress = Math.min(1, (now - dwell.startedAt) / SELECT_DWELL_MS)
      setDwellProgress({ itemId: dwell.itemId, progress })

      if (progress >= 1) {
        // commit — engagement 시작. 해제는 upright 기반 모니터가 담당(고정 타이머 없음).
        const commitId = dwell.itemId
        hoverDwellRef.current = null
        setDwellProgress(null)
        setSelectedControlId(commitId)
      }
    }, 50)
    return () => window.clearInterval(intervalId)
  }, [gazeBarHoverId])

  // gazeBarEdge — entered 상태이면 현재 edge, 그 외엔 selectedControlId 가 살아있는 동안
  // 마지막 entered edge 로 fallback. 시선이 중앙으로 돌아가도 engagement 유지 동안 UI 유지.
  const gazeBarEdge: Edge | null =
    edgeSnapshot.state === 'entered' && edgeSnapshot.edge
      ? edgeSnapshot.edge
      : selectedControlId != null
        ? lastEnteredEdgeRef.current
        : null

  // 8) Slider engagement — selectedControlId 가 latch 되어 있는 동안 시선과 무관하게
  //    head roll 로 그 control 의 값을 조절. SELECT_DWELL_MS dwell → select 의 결과로만 켜짐.
  //    의도 판별: yaw 로 둘러보는 동안엔 roll 입력을 무시(hold) — SliderIntentMapper 담당.
  const engaged = selectedControlId != null && head.detected
  const sliderMapperRef = useRef(new SliderIntentMapper())

  // 매 render 최신 sliderValues 를 ref 로 미러 — reset effect 가 deps 없이 시작 값을 읽도록.
  const sliderValuesRef = useRef(sliderValues)
  sliderValuesRef.current = sliderValues

  // 새 control 로 선택이 바뀌면 매퍼를 그 control 의 현재 값에서부터 시작하도록 리셋.
  // neutral roll 은 다음 update 의 head roll 로 캡처된다 ("들어간 시점" 머리 위치 = 0).
  // (engagement effect 보다 먼저 선언해 같은 render 에서 reset 이 먼저 실행되도록 함)
  useEffect(() => {
    if (selectedControlId == null) {
      sliderMapperRef.current.reset()
      return
    }
    sliderMapperRef.current.reset(sliderValuesRef.current[selectedControlId] ?? 0.5)
  }, [selectedControlId])

  useEffect(() => {
    if (!engaged || selectedControlId == null) {
      setLiveSliderValue(null)
      setSliderDebug(null)
      return
    }

    const sampleT = head.t || performance.now()
    const { value: v, rate, active, yawRate } = sliderMapperRef.current.update(
      head.fRoll,
      head.fYaw,
      sampleT
    )
    setLiveSliderValue(v)
    setSliderDebug({ rate, active, yawRate })
    lastLiveRef.current = v

    // OS bridge throttled push — 100ms 마다 최대 1회.
    const now = performance.now()
    const last = lastOsPushRef.current
    const reset = last.itemId !== selectedControlId

    if (reset || now - last.t >= 100) {
      lastOsPushRef.current = { itemId: selectedControlId, t: now }

      if (selectedControlId === 'volume') {
        window.glanceshift.setVolume(v)
      }
    }
  }, [engaged, head.t, head.fRoll, head.fYaw, selectedControlId])

  // 8b) Engagement 해제 모니터 — "머리가 꼿꼿(upright)" 이 시선 위치별 임계 시간 지속되면 해제.
  //     머리를 기울이고 있으면(움직이지 않아도) 조작 중으로 보고 유지(조이스틱).
  //     interval 안에서 최신 값을 읽도록 ref 로 미러.
  const edgeStateRef = useRef(edgeSnapshot.state)
  edgeStateRef.current = edgeSnapshot.state
  /** 머리가 upright 상태로 들어선 시각(ms). null = 지금 기울이고 있음(조작 중). */
  const uprightSinceRef = useRef<number | null>(null)
  const [engageDebug, setEngageDebug] = useState<{
    operating: boolean
    uprightMs: number
    thresholdMs: number
  } | null>(null)

  useEffect(() => {
    if (selectedControlId == null) {
      setEngageDebug(null)
      uprightSinceRef.current = null
      return
    }
    const id = window.setInterval(() => {
      const now = performance.now()
      const inZone = edgeStateRef.current === 'entered'
      const operating = operatingRef.current
      const thresholdMs = inZone ? RELEASE_GAZE_IN_MS : RELEASE_GAZE_OUT_MS

      if (operating) {
        uprightSinceRef.current = null
        setEngageDebug({ operating: true, uprightMs: 0, thresholdMs })
        return
      }
      if (uprightSinceRef.current == null) uprightSinceRef.current = now
      const uprightMs = now - uprightSinceRef.current
      setEngageDebug({ operating: false, uprightMs, thresholdMs })
      if (uprightMs >= thresholdMs) {
        setSelectedControlId(null)
      }
    }, 150)
    return () => window.clearInterval(id)
  }, [selectedControlId])

  // 9) Commit on selection change — selectedControlId 가 다른 항목/null 로 변하면
  //    직전 항목의 마지막 live 값을 OS 에 한 번 더 push (throttle 누락 방지) + sliderValues 저장.
  useEffect(() => {
    const prev = prevActiveRef.current

    if (prev && prev !== selectedControlId && lastLiveRef.current != null) {
      const committed = lastLiveRef.current
      setSliderValues((cur) => ({ ...cur, [prev]: committed }))

      // eslint-disable-next-line no-console
      console.log(`[slider] COMMIT ${prev} = ${(committed * 100).toFixed(0)}%`)

      if (prev === 'volume') {
        window.glanceshift.setVolume(committed)
      }

      lastOsPushRef.current = { itemId: null, t: 0 } // throttle reset
    }

    prevActiveRef.current = selectedControlId
  }, [selectedControlId])

  // 10) 마운트 시 현재 OS 볼륨 읽어 sliderValues 동기화 — GazeBar 가 떴을 때 현재 시스템 상태를
  // 기준선으로 보여주기 위함.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const v = await window.glanceshift.getVolume()
        if (cancelled || v == null) return
        setSliderValues((cur) => ({ ...cur, volume: v }))
      } catch {
        /* ignore */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <EdgeZones viewport={viewport} snapshot={edgeSnapshot} visible={debugVisible} />

      <GazeBar
        edge={gazeBarEdge}
        viewport={viewport}
        gazePoint={gazeBarGaze}
        items={GAZEBAR_ITEMS}
        onHoverChange={handleHoverChange}
        valuesById={sliderValues}
        liveValue={liveSliderValue}
        lockedItemId={selectedControlId}
      />

      <GazeDot
        x={effectiveGaze?.x ?? point.x}
        y={effectiveGaze?.y ?? point.y}
        visible={debugVisible}
        snapAnimating={snapAnimating}
        dwellProgress={dwellProgress?.progress ?? null}
      />

      {debugVisible && (
        <DebugHud
          point={point}
          viewport={viewport}
          clickThrough={clickThrough}
          inputSource={inputSource}
          trackerStatus={trackerStatus}
          headStatus={headStatus}
          headError={headError}
          head={head}
          edge={edgeSnapshot}
          gazeBarHover={gazeBarHoverId}
          liveSliderValue={liveSliderValue}
          sliderValues={sliderValues}
          sliderDebug={sliderDebug}
          engageDebug={engageDebug}
        />
      )}

      {calibrating && (
        <Calibration
          viewport={viewport}
          onPointClick={(x, y) => trackerRef.current?.recordPoint(x, y)}
          onDone={() => setCalibrating(false)}
          onClearCalibration={async () => {
            await trackerRef.current?.clearCalibration()
            setHasGazeData(false)
          }}
          head={head}
        />
      )}

      {evaluating && (
        <Evaluation
          gazePoint={usingGaze ? { x: gaze.x, y: gaze.y } : null}
          onDone={() => setEvaluating(false)}
        />
      )}

      {testMode && (
        <TestMode
          gazePoint={point.x >= 0 ? { x: point.x, y: point.y } : null}
          headRoll={head.fRoll}
          selectedControlId={selectedControlId}
          volumeValue={sliderValues.volume ?? 0.5}
          liveVolume={liveSliderValue}
          edgeState={edgeSnapshot.state}
          viewport={viewport}
          onForceVolume={(v) => {
            // event 시 볼륨 드롭 — OS + App 저장값 동기화. 저장값을 바꿔두면 이후 engage 시
            // SliderIntentMapper 가 이 값(0)부터 시작한다 (reset effect 가 sliderValuesRef 를 읽음).
            window.glanceshift.setVolume(v)
            setSliderValues((cur) => ({ ...cur, volume: v }))
          }}
          onDone={() => setTestMode(false)}
        />
      )}
    </>
  )
}