/**
 * GlanceShift App (Phase 2)
 *
 * 입력 채널:
 *   · 시선 — WebGazer + One Euro Filter, ⌘⇧K 로 9-point 캘리브
 *   · 머리 자세 — MediaPipe FaceLandmarker (yaw / pitch / roll)
 *
 * 두 perception 트래커는 같은 카메라 영상을 공유한다:
 *   WebGazer 가 만든 <video id="webgazerVideoFeed"> 를 FaceLandmarker 가 재사용.
 *   따라서 카메라는 한 번만 잡힌다.
 */

import { useEffect, useRef, useState } from 'react'
import { DebugHud } from './components/DebugHud'
import { GazeDot } from './components/GazeDot'
import { Calibration } from './components/Calibration'
import { createGazeTracker, type GazeSample, type TrackerStatus } from './perception/webgazer'
import {
  createHeadTracker,
  type HeadSample,
  type HeadTrackerStatus
} from './perception/face-landmarker'

type Point = { x: number; y: number; t: number }
const ZERO_HEAD: HeadSample = {
  yaw: 0, pitch: 0, roll: 0,
  fYaw: 0, fPitch: 0, fRoll: 0,
  t: 0, detected: false
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
  const trackerRef = useRef<ReturnType<typeof createGazeTracker> | null>(null)

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
    return () => {
      offDebug()
      offCt()
      offCalib()
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

  // 5) 캘리브레이션 진입/종료 시 click-through 토글
  useEffect(() => {
    if (calibrating) {
      window.glanceshift.setClickThrough(false)
    } else {
      window.glanceshift.setClickThrough(true)
    }
  }, [calibrating])

  // 어떤 입력을 표시할지
  const usingGaze = trackerStatus === 'ready' && gaze.x >= 0
  const point = usingGaze ? gaze : mouse
  const inputSource = usingGaze
    ? 'WebGazer (filtered)'
    : trackerStatus === 'loading'
      ? 'mouse (gaze loading…)'
      : trackerStatus === 'error'
        ? `mouse (gaze error: ${trackerError ?? ''})`
        : trackerStatus === 'ready' && !hasGazeData
          ? 'mouse (needs calibration — ⌘⇧K)'
          : 'mouse (Phase 0 fallback)'

  return (
    <>
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
        />
      )}

      {calibrating && (
        <Calibration
          onPointClick={(x, y) => trackerRef.current?.recordPoint(x, y)}
          onDone={() => setCalibrating(false)}
        />
      )}
    </>
  )
}
