/**
 * GlanceShift App (Phase 3)
 *
 * 입력 채널:
 *   · 시선 — WebGazer + One Euro Filter, ⌘⇧K 로 9-point 캘리브
 *   · 머리 자세 — WebGazer 의 face mesh landmarks 에서 직접 계산한 yaw/pitch/roll
 *
 * Phase 3 추가:
 *   · Edge Gaze Detector — dwell + hysteresis 로 가장자리 진입/이탈 판정
 *   · 디버그 모드에서 4개 가장자리 zone 시각화
 *   · 진입/이탈 이벤트 콘솔 로그
 */

import { useEffect, useRef, useState } from 'react'
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
  snapToEdge,
  type EdgeSnapshot,
  type EdgeDetectorConfig
} from './perception/edge-detector'
import { rollToValue, DEFAULT_SLIDER_CONFIG } from './perception/slider-mapper'

// GazeBar 의 후보 항목. Phase 5 에서 머리 기울임으로 볼륨·밝기 slider 연결.
const GAZEBAR_ITEMS: GazeBarItem[] = [
  { id: 'volume', label: 'volume', icon: '🔊' },
  { id: 'brightness', label: 'brightness', icon: '☀️' }
]

type Point = { x: number; y: number; t: number }
const ZERO_HEAD: HeadSample = {
  yaw: 0, pitch: 0, roll: 0,
  fYaw: 0, fPitch: 0, fRoll: 0,
  t: 0, detected: false,
  iris: null, irisDebug: null, landmarkCount: 0
}

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
  const [edgeMode, setEdgeMode] = useState<EdgeDetectorConfig['modeLabel']>('classic')
  const edgeDetectorRef = useRef<EdgeDetector>(new EdgeDetector(EDGE_MODE_PROFILES.classic))
  const [edgeSnapshot, setEdgeSnapshot] = useState<EdgeSnapshot>(() =>
    edgeDetectorRef.current.snapshot(performance.now())
  )

  // mode 전환 → 새 config 적용 + 상태 리셋
  useEffect(() => {
    edgeDetectorRef.current.setConfig(EDGE_MODE_PROFILES[edgeMode])
    setEdgeSnapshot(edgeDetectorRef.current.snapshot(performance.now()))
    // eslint-disable-next-line no-console
    console.log(`[edge] mode → ${edgeMode}`)
  }, [edgeMode])
  const [gazeBarHoverId, setGazeBarHoverId] = useState<string | null>(null)
  // 항목별 저장된 슬라이더 값 (commit 된 값) — OS bridge 가 이걸 읽어 적용
  const [sliderValues, setSliderValues] = useState<Record<string, number>>({
    volume: 0.5,
    brightness: 0.5
  })
  // 현재 hover 항목의 *live* 값 — head roll 로 매 프레임 계산
  const [liveSliderValue, setLiveSliderValue] = useState<number | null>(null)
  // commit 처리용: 이전 hover id 를 추적, hover 가 끝나는 순간에 마지막 live 값을 저장
  const prevHoverRef = useRef<string | null>(null)
  const lastLiveRef = useRef<number | null>(null)
  // OS bridge throttle — 같은 항목에 대해 100ms 마다 최대 1회 push
  const lastOsPushRef = useRef<{ itemId: string | null; t: number }>({ itemId: null, t: 0 })

  // 1) 시선 + 머리 트래커 init — 카메라 권한 확인 후 순차 시작
  //     순서가 중요: WebGazer 가 video element 를 만든 다음에야 FaceLandmarker 가 그걸 잡을 수 있음.
  useEffect(() => {
    let cancelled = false
    const gazeTracker = createGazeTracker()
    const headTracker = createHeadTracker()
    trackerRef.current = gazeTracker

    const offGazeSample = gazeTracker.onSample((s: GazeSample) => {
      if (cancelled) return
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
        `[edge] ${evt.type.toUpperCase()} ${evt.edge.padEnd(6)} t=${evt.t.toFixed(0)}ms`
      )
    }
    setEdgeSnapshot(edgeDetectorRef.current.snapshot(point.t || performance.now()))
  }, [point.x, point.y, point.t, viewport.w, viewport.h])

  // 7) dwelling 중에는 point 가 안 움직여도 progress 가 자라야 하므로 RAF 로 보강
  useEffect(() => {
    if (edgeSnapshot.state !== 'dwelling') return
    let raf = 0
    const tick = (): void => {
      setEdgeSnapshot(edgeDetectorRef.current.snapshot(performance.now()))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [edgeSnapshot.state])
  const inputSource = usingGaze
    ? 'WebGazer (filtered)'
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

  // Mode 2/3 일 때 entered 상태에서 gaze 를 변 평면으로 snap.
  // perpendicular 정확도와 무관하게 GazeBar 항목 hover 가 안정.
  const useSnap = edgeMode !== 'classic'
  const gazeBarGaze =
    useSnap && gazeBarEdge && point.x >= 0
      ? snapToEdge({ x: point.x, y: point.y }, gazeBarEdge, viewport)
      : point.x >= 0
        ? { x: point.x, y: point.y }
        : null

  // 8) Slider engagement — hover 중인 항목이 있고 face 가 검출됐으면 head roll 로 live value 계산
  const engaged = gazeBarEdge != null && gazeBarHoverId != null && head.detected
  useEffect(() => {
    if (!engaged) {
      setLiveSliderValue(null)
      return
    }
    const v = rollToValue(head.fRoll, DEFAULT_SLIDER_CONFIG)
    setLiveSliderValue(v)
    lastLiveRef.current = v

    // OS bridge throttled push — 100ms 마다 최대 1회.
    // 같은 항목으로 hover 가 시작됐을 때 (itemId 변화) 는 throttle reset.
    const now = performance.now()
    const last = lastOsPushRef.current
    const reset = last.itemId !== gazeBarHoverId
    if (reset || now - last.t >= 100) {
      lastOsPushRef.current = { itemId: gazeBarHoverId, t: now }
      if (gazeBarHoverId === 'volume') {
        window.glanceshift.setVolume(v)
      } else if (gazeBarHoverId === 'brightness') {
        window.glanceshift.setBrightness(v)
      }
    }
  }, [engaged, head.fRoll, gazeBarHoverId])

  // 9) Commit on hover release — hover 가 다른 항목/없음으로 바뀌면 직전 항목의 live 값을 저장.
  //    OS 에 최종 값을 한 번 더 push 해서 throttle 로 인한 마지막 값 누락을 방지.
  useEffect(() => {
    const prev = prevHoverRef.current
    if (prev && prev !== gazeBarHoverId && lastLiveRef.current != null) {
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
    prevHoverRef.current = gazeBarHoverId
  }, [gazeBarHoverId])

  // 10) 마운트 시 현재 OS 값 읽어 sliderValues 동기화 — GazeBar 가 떴을 때 현재 시스템 상태를
  //     기준선으로 보여주기 위함. brightness 는 brightness CLI 없으면 null → 기본값 유지.
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
        approachFrac={EDGE_MODE_PROFILES[edgeMode].approachFrac}
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
        snapHover={useSnap}
      />

      <GazeDot x={point.x} y={point.y} visible={debugVisible} />

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
        />
      )}

      {calibrating && (
        <Calibration
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
    </>
  )
}
