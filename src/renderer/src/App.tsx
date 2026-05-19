/**
 * GlanceShift App (Phase 3)
 *
 * 입력 채널:
 * · 시선 — WebGazer + One Euro Filter, ⌘⇧K 로 9-point 캘리브
 * · 머리 자세 — WebGazer 의 face mesh landmarks 에서 직접 계산한 yaw/pitch/roll
 *
 * Phase 3 추가:
 * · Edge Gaze Detector — dwell + hysteresis 로 가장자리 진입/이탈 판정
 * · 디버그 모드에서 4개 가장자리 zone 시각화
 * · 진입/이탈 이벤트 콘솔 로그
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { DebugHud } from './components/DebugHud'
import { GazeDot } from './components/GazeDot'
import { Calibration } from './components/Calibration'
import { EdgeZones } from './components/EdgeZones'
import { GazeBar, type GazeBarItem } from './components/GazeBar'
import { Evaluation } from './components/Evaluation'
import { createGazeTracker, type GazeSample, type TrackerStatus } from './perception/webgazer'
import {
  createHeadTracker,
  type HeadSample,
  type HeadTrackerStatus
} from './perception/face-landmarker'
import {
  EdgeDetector,
  EDGE_MODE_PROFILES,
  type EdgeSnapshot,
  type ModeLabel
} from './perception/edge-detector'
import { rollToValue, DEFAULT_SLIDER_CONFIG } from './perception/slider-mapper'

// GazeBar 의 후보 항목. Phase 5 에서 머리 기울임으로 볼륨·밝기 slider 연결.
const GAZEBAR_ITEMS: GazeBarItem[] = [
  { id: 'volume', label: 'volume', icon: '🔊' },
  { id: 'brightness', label: 'brightness', icon: '☀️' }
]

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
  irisDebug: null,
  landmarkCount: 0
}

// [MOD] 마지막으로 바라본 control 유지 시간 (ms)
const LATCH_MS = 3000

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
  const trackerRef = useRef<ReturnType<typeof createGazeTracker> | null>(null)

  // Edge detector — mode 별 config 으로 동작.
  // mode 전환 (⌘⇧1/2/3) 시 setConfig 로 상태 리셋 후 새 config 적용.
  const [edgeMode, setEdgeMode] = useState<ModeLabel>('filtered')
  const edgeDetectorRef = useRef(new EdgeDetector(EDGE_MODE_PROFILES.filtered))
  const [edgeSnapshot, setEdgeSnapshot] = useState<EdgeSnapshot>(() =>
    edgeDetectorRef.current.snapshot(performance.now())
  )

  // gaze source 분기 — 'raw' 모드는 unfiltered 좌표를 listener 에서 직접 받음.
  // listener 안의 useRawGaze 가 stale 되지 않게 ref 로 추적.
  const useRawGazeRef = useRef(false)
  useEffect(() => {
    useRawGazeRef.current = edgeMode === 'raw'
  }, [edgeMode])

  // Snap-in animation 표시 (lock 진입 직후 200ms 동안 GazeDot 의 강한 transition)
  const [snapAnimating, setSnapAnimating] = useState(false)
  const snapAnimTimerRef = useRef<number | null>(null)

  // mode 전환 → 새 config 적용 + 상태 리셋
  useEffect(() => {
    edgeDetectorRef.current.setConfig(EDGE_MODE_PROFILES[edgeMode])
    setEdgeSnapshot(edgeDetectorRef.current.snapshot(performance.now()))
    setSnapAnimating(false)

    if (snapAnimTimerRef.current != null) {
      clearTimeout(snapAnimTimerRef.current)
      snapAnimTimerRef.current = null
    }

    // eslint-disable-next-line no-console
    console.log(`[edge] mode → ${edgeMode}`)
  }, [edgeMode])

  const [gazeBarHoverId, setGazeBarHoverId] = useState<string | null>(null)

  // [MOD] 마지막으로 바라본 control 을 잠깐 유지하는 latch 상태
  const [latchedControlId, setLatchedControlId] = useState<string | null>(null)
  const [latchExpiresAt, setLatchExpiresAt] = useState(0)
  const latchTimerRef = useRef<number | null>(null)

  // 항목별 저장된 슬라이더 값 (commit 된 값) — OS bridge 가 이걸 읽어 적용
  const [sliderValues, setSliderValues] = useState<Record<string, number>>({
    volume: 0.5,
    brightness: 0.5
  })

  // 현재 hover/active 항목의 *live* 값 — head roll 로 매 프레임 계산
  const [liveSliderValue, setLiveSliderValue] = useState<number | null>(null)

  // [MOD] hover 기준이 아니라 실제 active control 기준으로 commit 추적
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

      if (useRawGazeRef.current) {
        // raw mode 에선 필터 거치지 않은 좌표 사용 — OneEuro 기여도 측정용
        setGaze({ x: s.x, y: s.y, t: s.t })
      } else {
        setGaze({ x: s.fx, y: s.fy, t: s.t })
      }

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
    const offMode = window.glanceshift.onSetEdgeMode((m) => setEdgeMode(m))

    return () => {
      offDebug()
      offCt()
      offCalib()
      offEval()
      offMode()
    }
  }, [])

  // 3) viewport 갱신
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 4) Fallback 입력: 마우스 좌표 (트래커가 ready 가 아닐 때)
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      setMouse({ x: e.clientX, y: e.clientY, t: performance.now() })
    }

    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  // 5) 캘리브레이션 / 평가 진입 시 click-through 해제, 종료 시 복귀
  useEffect(() => {
    if (calibrating || evaluating) {
      window.glanceshift.setClickThrough(false)
    } else {
      window.glanceshift.setClickThrough(true)
    }
  }, [calibrating, evaluating])

  // 어떤 입력을 표시할지
  const usingGaze = trackerStatus === 'ready' && gaze.x >= 0
  const point = usingGaze ? gaze : mouse

  // 6) Edge Detector 갱신 — point 가 바뀔 때마다 update, 진입/이탈 이벤트는 콘솔에 로그
  useEffect(() => {
    if (point.x < 0 || point.y < 0) return

    const evt = edgeDetectorRef.current.update(
      { x: point.x, y: point.y },
      viewport,
      point.t || performance.now()
    )

    if (evt) {
      // eslint-disable-next-line no-console
      console.log(
        `[edge] ${evt.type.toUpperCase()} ${evt.edge.padEnd(6)} t=${evt.t.toFixed(0)}ms mode=${evt.mode}`
      )

      // snapping mode 의 lock 진입 → snap-in 모션 트리거
      if (evt.type === 'enter' && edgeMode === 'snapping') {
        setSnapAnimating(true)
        if (snapAnimTimerRef.current != null) clearTimeout(snapAnimTimerRef.current)
        snapAnimTimerRef.current = window.setTimeout(() => {
          setSnapAnimating(false)
          snapAnimTimerRef.current = null
        }, 220)
      }
    }

    setEdgeSnapshot(edgeDetectorRef.current.snapshot(point.t || performance.now()))
  }, [point.x, point.y, point.t, viewport.w, viewport.h, edgeMode])

  // 7) dwelling/building 중에는 point 가 안 움직여도 progress 가 자라야 하므로 RAF 로 보강.
  // snapping mode 에선 intentTracker 도 매 frame 시간 적분이 필요하므로 update() 도 호출.
  useEffect(() => {
    if (edgeSnapshot.state !== 'dwelling') return

    let raf = 0
    const tick = (): void => {
      const now = performance.now()

      if (edgeMode === 'snapping' && point.x >= 0 && point.y >= 0) {
        // 같은 좌표라도 update() 를 불러야 dt 누적 (intent score / dwell)
        const evt = edgeDetectorRef.current.update({ x: point.x, y: point.y }, viewport, now)

        if (evt) {
          // eslint-disable-next-line no-console
          console.log(
            `[edge] ${evt.type.toUpperCase()} ${evt.edge.padEnd(6)} t=${evt.t.toFixed(0)}ms mode=${evt.mode}`
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
  }, [edgeSnapshot.state, edgeMode, point.x, point.y, viewport.w, viewport.h])

  const inputSource = usingGaze
    ? edgeMode === 'raw'
      ? 'WebGazer (raw, unfiltered)'
      : 'WebGazer (OneEuro filtered)'
    : trackerStatus === 'loading'
      ? 'mouse (gaze loading…)'
      : trackerStatus === 'error'
        ? `mouse (gaze error: ${trackerError ?? ''})`
        : trackerStatus === 'ready' && !hasGazeData
          ? 'mouse (needs calibration — ⌘⇧K)'
          : 'mouse (Phase 0 fallback)'

  // GazeBar 는 edge state 가 'entered' 인 동안만 보임.
  // dwelling 단계에서는 EdgeZones 의 highlight 가 미리보기 역할.
  const gazeBarEdge = edgeSnapshot.state === 'entered' ? edgeSnapshot.edge : null

  // effectiveGaze — snapping mode 의 lock 중에는 rail 위로 강제. perpendicular jitter 무관.
  // 그 외 mode 는 그냥 원본 point.
  const effectiveGaze = useMemo<{ x: number; y: number } | null>(() => {
    if (
      edgeMode === 'snapping' &&
      edgeSnapshot.state === 'entered' &&
      edgeSnapshot.railCursor
    ) {
      return edgeSnapshot.railCursor
    }

    return point.x >= 0 ? { x: point.x, y: point.y } : null
  }, [edgeMode, edgeSnapshot.state, edgeSnapshot.railCursor, point.x, point.y])

  const useSnap = edgeMode === 'snapping'
  // GazeBar 의 항목 hover 계산은 effectiveGaze 를 사용 — snapping 중에는 rail 좌표.
  const gazeBarGaze = effectiveGaze

  // [MOD] hover 가 생기면 마지막 선택 항목을 latch 로 저장하고 만료 시간을 갱신
  useEffect(() => {
    if (gazeBarHoverId == null) return

    const expiresAt = performance.now() + LATCH_MS
    setLatchedControlId(gazeBarHoverId)
    setLatchExpiresAt(expiresAt)

    if (latchTimerRef.current != null) {
      window.clearTimeout(latchTimerRef.current)
    }

    latchTimerRef.current = window.setTimeout(() => {
      setLatchedControlId((cur) => (cur === gazeBarHoverId ? null : cur))
      setLatchExpiresAt(0)
      latchTimerRef.current = null
    }, LATCH_MS)
  }, [gazeBarHoverId])

  // [MOD] cleanup 시 latch timer 정리
  useEffect(() => {
    return () => {
      if (latchTimerRef.current != null) {
        window.clearTimeout(latchTimerRef.current)
        latchTimerRef.current = null
      }
    }
  }, [])

  // [MOD] 현재 조절 대상 결정: 마지막으로 선택된 control만 3초 동안 유지
  const activeControlId =
    latchedControlId != null && performance.now() < latchExpiresAt
      ? latchedControlId
      : null

  // 8) Slider engagement — hover 중인 항목이 있고 face 가 검출됐으면 head roll 로 live value 계산
  //const engaged = gazeBarEdge != null && gazeBarHoverId != null && head.detected
  // 8) Slider engagement — control 이 선택된 뒤에는 시선을 중앙으로 옮겨도 3초 동안 head roll 로 조절
  // [MOD] edge 진입 상태와 무관하게 activeControlId + head.detected 만으로 engage
  const engaged = activeControlId != null && head.detected

  useEffect(() => {
    if (!engaged || activeControlId == null) {
      setLiveSliderValue(null)
      return
    }

    const v = rollToValue(head.fRoll, DEFAULT_SLIDER_CONFIG)
    setLiveSliderValue(v)
    lastLiveRef.current = v

    // OS bridge throttled push — 100ms 마다 최대 1회.
    const now = performance.now()
    const last = lastOsPushRef.current
    const reset = last.itemId !== activeControlId

    if (reset || now - last.t >= 100) {
      lastOsPushRef.current = { itemId: activeControlId, t: now }

      if (activeControlId === 'volume') {
        window.glanceshift.setVolume(v)
      } else if (activeControlId === 'brightness') {
        window.glanceshift.setBrightness(v)
      }
    }
  }, [engaged, head.fRoll, activeControlId])

  // 9) Commit on active control release
  // [MOD] hover 종료가 아니라 activeControl 종료/변경 시 commit
  useEffect(() => {
    const prev = prevActiveRef.current

    if (prev && prev !== activeControlId && lastLiveRef.current != null) {
      const committed = lastLiveRef.current
      setSliderValues((cur) => ({ ...cur, [prev]: committed }))

      // eslint-disable-next-line no-console
      console.log(`[slider] COMMIT ${prev} = ${(committed * 100).toFixed(0)}%`)

      if (prev === 'volume') {
        window.glanceshift.setVolume(committed)
      } else if (prev === 'brightness') {
        window.glanceshift.setBrightness(committed)
      }

      lastOsPushRef.current = { itemId: null, t: 0 } // throttle reset
    }

    prevActiveRef.current = activeControlId
  }, [activeControlId])

  // 10) 마운트 시 현재 OS 값 읽어 sliderValues 동기화 — GazeBar 가 떴을 때 현재 시스템 상태를
  // 기준선으로 보여주기 위함. brightness 는 brightness CLI 없으면 null → 기본값 유지.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const [v, b] = await Promise.all([
          window.glanceshift.getVolume(),
          window.glanceshift.getBrightness()
        ])

        if (cancelled) return

        setSliderValues((cur) => ({
          ...cur,
          ...(v != null ? { volume: v } : {}),
          ...(b != null ? { brightness: b } : {})
        }))
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
      <EdgeZones
        enterFrac={EDGE_MODE_PROFILES[edgeMode].enterFrac}
        viewport={viewport}
        snapshot={edgeSnapshot}
        visible={debugVisible}
      />

      <GazeBar
        edge={gazeBarEdge}
        viewport={viewport}
        gazePoint={gazeBarGaze}
        items={GAZEBAR_ITEMS}
        onHoverChange={setGazeBarHoverId}
        valuesById={sliderValues}
        liveValue={liveSliderValue}
      />

      <GazeDot
        x={effectiveGaze?.x ?? point.x}
        y={effectiveGaze?.y ?? point.y}
        visible={debugVisible}
        snap={useSnap}
        snapAnimating={snapAnimating}
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
          edgeMode={edgeMode}
          gazeBarHover={gazeBarHoverId}
          liveSliderValue={liveSliderValue}
          sliderValues={sliderValues}
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
          edgeMode={edgeMode}
        />
      )}
    </>
  )
}