/**
 * WebGazer 래퍼.
 *
 * 책임:
 *   - WebGazer 전역 객체 로드를 기다리고 (script defer로 늦게 등장)
 *   - UI overlay(비디오·페이스 메쉬·예측 도트)를 모두 끄고
 *   - 시선 좌표를 One Euro Filter로 스무딩해서 콜백으로 흘려준다.
 *   - 캘리브레이션 점 클릭을 WebGazer에 전달한다.
 *
 * 보고서 §5.2 — WebGazer ~4° 정확도 (Papoutsaki et al., 2016).
 */

import { OneEuro2D } from './one-euro'
import type { WebGazerAPI } from '../types/webgazer'

export type GazeSample = {
  /** 화면(클라이언트) 좌표계, viewport 기준. (-1, -1)이면 추적 실패 */
  x: number
  y: number
  /** 필터 적용 후 좌표 */
  fx: number
  fy: number
  /** ms (performance.now()) */
  t: number
}

export type TrackerStatus =
  | 'unloaded'      // 스크립트 미로드
  | 'loading'       // begin() 진행 중
  | 'ready'         // 추적 중, 데이터 흐름
  | 'error'         // 시작 실패
  | 'stopped'       // 명시적으로 정지

export interface GazeTracker {
  start(): Promise<void>
  stop(): void
  onSample(cb: (s: GazeSample) => void): () => void
  onStatus(cb: (s: TrackerStatus, error?: string) => void): () => void
  status(): TrackerStatus
  /** 캘리브레이션용 클릭 좌표 입력 */
  recordPoint(x: number, y: number): void
  clearCalibration(): Promise<void>
}

function waitForWebGazer(timeoutMs = 8000): Promise<WebGazerAPI> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    const check = (): void => {
      const wg = window.webgazer
      if (wg) {
        resolve(wg)
        return
      }
      if (performance.now() - start > timeoutMs) {
        reject(new Error('webgazer global not found (script load failure?)'))
        return
      }
      setTimeout(check, 50)
    }
    check()
  })
}

/**
 * 마지막 valid sample 이후 STALE_MS 이상 sample 이 안 들어오면
 * 1회 (-1,-1) sample 을 emit 해서 downstream (EdgeDetector / IntentTracker) 이
 * stale gaze 로 인식하도록 한다. 얼굴 미검출/카메라 가림 등에서 false trigger 차단.
 */
const STALE_MS = 200
const WATCHDOG_TICK_MS = 100
const BLINK_HOLD_MS = 180
const LONG_GAP_RESET_MS = 450
const OFFSCREEN_MARGIN_PX = 160
const SPIKE_DISTANCE_PX = 320
const SPIKE_CONFIRM_MS = 60
const SPIKE_CONFIRM_RADIUS_PX = 170
const SPIKE_MAX_SPEED_PX_PER_MS = 4.5
const MEDIAN_WINDOW_SIZE = 5
const EAR_CLOSED_THRESHOLD = 0.16
const EAR_OPEN_THRESHOLD = 0.2

type Landmark = [number, number, number]

type GazePoint = {
  x: number
  y: number
  t: number
}

type EyeIndices = readonly [number, number, number, number, number, number]

const RIGHT_EYE_EAR: EyeIndices = [33, 160, 158, 133, 153, 144]
const LEFT_EYE_EAR: EyeIndices = [362, 385, 387, 263, 373, 380]

function dist2(a: Landmark, b: Landmark): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function eyeAspectRatio(landmarks: Landmark[], indices: EyeIndices): number | null {
  const pts = indices.map((idx) => landmarks[idx])
  if (pts.some((pt) => !pt)) return null
  const [p1, p2, p3, p4, p5, p6] = pts as Landmark[]
  const horizontal = dist2(p1, p4)
  if (horizontal < 1) return null
  return (dist2(p2, p6) + dist2(p3, p5)) / (2 * horizontal)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

class Median2DFilter {
  private samples: Array<{ x: number; y: number }> = []

  reset(): void {
    this.samples = []
  }

  filter(x: number, y: number): { x: number; y: number } {
    this.samples.push({ x, y })
    if (this.samples.length > MEDIAN_WINDOW_SIZE) this.samples.shift()
    return {
      x: median(this.samples.map((pt) => pt.x)),
      y: median(this.samples.map((pt) => pt.y))
    }
  }
}

class EyeBlinkGate {
  private closed = false

  reset(): void {
    this.closed = false
  }

  update(landmarks: Landmark[] | null): boolean {
    if (!landmarks || landmarks.length < 468) return false
    const right = eyeAspectRatio(landmarks, RIGHT_EYE_EAR)
    const left = eyeAspectRatio(landmarks, LEFT_EYE_EAR)
    const ears = [right, left].filter((v): v is number => v != null && Number.isFinite(v))
    if (ears.length === 0) return this.closed
    const ear = ears.reduce((sum, v) => sum + v, 0) / ears.length
    if (this.closed) {
      this.closed = ear < EAR_OPEN_THRESHOLD
    } else {
      this.closed = ear < EAR_CLOSED_THRESHOLD
    }
    return this.closed
  }
}

class BlinkSpikeFilter {
  private filter = new OneEuro2D({ freq: 60, mincutoff: 1.0, beta: 0.007 })
  private median = new Median2DFilter()
  private lastAccepted: GazePoint | null = null
  private lastOutput: GazePoint | null = null
  private pendingJump: GazePoint | null = null
  private missingSince: number | null = null

  reset(): void {
    this.filter.reset()
    this.median.reset()
    this.lastAccepted = null
    this.lastOutput = null
    this.pendingJump = null
    this.missingSince = null
  }

  sample(x: number, y: number, t: number): GazeSample | null {
    if (!this.isPlausible(x, y)) return this.holdOrStale(t)

    const last = this.lastAccepted
    const gapMs = last ? t - last.t : 0
    this.missingSince = null

    if (!last || gapMs > LONG_GAP_RESET_MS) {
      return this.accept(x, y, t, true)
    }

    const dist = Math.hypot(x - last.x, y - last.y)
    const dynamicLimit = Math.max(
      SPIKE_DISTANCE_PX,
      SPIKE_MAX_SPEED_PX_PER_MS * Math.max(16, gapMs)
    )

    if (dist <= dynamicLimit) {
      this.pendingJump = null
      return this.accept(x, y, t, false)
    }

    const pending = this.pendingJump
    if (!pending || Math.hypot(x - pending.x, y - pending.y) > SPIKE_CONFIRM_RADIUS_PX) {
      this.pendingJump = { x, y, t }
      return this.holdOrStale(t)
    }

    if (t - pending.t >= SPIKE_CONFIRM_MS) {
      this.pendingJump = null
      return this.accept(x, y, t, true)
    }

    return this.holdOrStale(t)
  }

  missing(t: number): GazeSample | null {
    this.missingSince ??= t
    this.pendingJump = null
    if (!this.lastOutput) return null
    if (t - this.missingSince <= BLINK_HOLD_MS) {
      return this.buildSample(this.lastOutput.x, this.lastOutput.y, t)
    }
    this.filter.reset()
    return this.stale(t)
  }

  private accept(x: number, y: number, t: number, resetFilter: boolean): GazeSample {
    if (resetFilter) {
      this.filter.reset()
      this.median.reset()
    }
    const med = this.median.filter(x, y)
    const filtered = this.filter.filter(med.x, med.y, t)
    const point = { x: filtered.x, y: filtered.y, t }
    this.lastAccepted = { x, y, t }
    this.lastOutput = point
    return { x, y, fx: point.x, fy: point.y, t }
  }

  private holdOrStale(t: number): GazeSample | null {
    if (this.lastOutput) return this.buildSample(this.lastOutput.x, this.lastOutput.y, t)
    return null
  }

  private buildSample(x: number, y: number, t: number): GazeSample {
    return { x, y, fx: x, fy: y, t }
  }

  private stale(t: number): GazeSample {
    this.lastAccepted = null
    this.lastOutput = null
    this.pendingJump = null
    return { x: -1, y: -1, fx: -1, fy: -1, t }
  }

  private isPlausible(x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    const w = window.innerWidth
    const h = window.innerHeight
    return (
      x >= -OFFSCREEN_MARGIN_PX &&
      y >= -OFFSCREEN_MARGIN_PX &&
      x <= w + OFFSCREEN_MARGIN_PX &&
      y <= h + OFFSCREEN_MARGIN_PX
    )
  }
}

function mediaErrorName(error: unknown): string {
  if (error instanceof DOMException) return error.name
  if (error instanceof Error && error.name) return error.name
  return 'UnknownError'
}

function mediaErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

const VIRTUAL_CAMERA_RE = /\b(obs|virtual|ndi|snap|droidcam|manycam|xsplit)\b/i
let lastChosenCameraLabel: string | null = null

function baseVideoConstraints(): MediaTrackConstraints {
  return {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30, max: 30 }
  }
}

async function chooseCameraConstraints(): Promise<MediaStreamConstraints> {
  lastChosenCameraLabel = null
  const fallback: MediaStreamConstraints = {
    video: {
      ...baseVideoConstraints(),
      facingMode: 'user'
    },
    audio: false
  }

  try {
    if (!navigator.mediaDevices?.enumerateDevices) return fallback
    const videoInputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'videoinput')

    const selected =
      videoInputs.find((device) => device.label && !VIRTUAL_CAMERA_RE.test(device.label)) ??
      videoInputs[0]

    if (!selected?.deviceId) return fallback
    lastChosenCameraLabel = selected.label || 'unlabeled camera'

    return {
      video: {
        ...baseVideoConstraints(),
        deviceId: { exact: selected.deviceId }
      },
      audio: false
    }
  } catch {
    lastChosenCameraLabel = null
    return fallback
  }
}

async function describeCameraFailure(error: unknown): Promise<string> {
  const name = mediaErrorName(error)
  const message = mediaErrorMessage(error)
  let devices = 'unknown'

  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const videoInputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => device.label || `camera-${index + 1}`)
      devices = videoInputs.length > 0 ? videoInputs.join(', ') : 'none'
    }
  } catch {
    devices = 'enumeration failed'
  }

  const lowerMessage = message.toLowerCase()
  const hint =
    name === 'NotAllowedError' || name === 'SecurityError'
      ? 'Windows camera privacy permission is blocking Electron/desktop apps.'
      : name === 'NotReadableError' || lowerMessage.includes('could not start video source')
        ? 'The webcam exists, but Windows/driver refused the stream. Close camera apps, enable desktop-app camera access, then restart GlanceShift.'
        : name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError'
          ? 'The selected camera did not satisfy WebGazer constraints.'
          : 'Check Windows camera privacy settings and whether another app is using the camera.'

  return `${name}: ${message}. Selected: ${lastChosenCameraLabel ?? 'browser default'}. Video inputs: ${devices}. ${hint}`
}

export function createGazeTracker(): GazeTracker {
  const sampleListeners = new Set<(s: GazeSample) => void>()
  const statusListeners = new Set<(s: TrackerStatus, error?: string) => void>()
  const filter = new BlinkSpikeFilter()
  const blinkGate = new EyeBlinkGate()
  let status: TrackerStatus = 'unloaded'
  let wg: WebGazerAPI | null = null
  /** 마지막 valid sample 의 timestamp (ms). null = 아직 한 번도 안 들어옴. */
  let lastSampleAt: number | null = null
  /** stale 통지를 이미 한 번 보냈는지 — 같은 stale 구간 동안 중복 emit 안 하도록. */
  let staleEmitted = false
  let watchdogTimer: ReturnType<typeof setInterval> | null = null

  function setStatus(next: TrackerStatus, error?: string): void {
    status = next
    statusListeners.forEach((cb) => cb(next, error))
  }

  /** 마지막 sample 이 STALE_MS 이상 오래됐으면 1회 stale sample emit. */
  function watchdogTick(): void {
    if (status !== 'ready') return
    if (lastSampleAt == null) return
    if (staleEmitted) return
    const now = performance.now()
    if (now - lastSampleAt > STALE_MS) {
      staleEmitted = true
      // 필터 리셋해서 다음 valid sample 이 들어와도 stale 값과 보간되지 않게.
      filter.reset()
      const stale: GazeSample = { x: -1, y: -1, fx: -1, fy: -1, t: now }
      sampleListeners.forEach((cb) => cb(stale))
    }
  }

  async function start(): Promise<void> {
    if (status === 'ready' || status === 'loading') return
    setStatus('loading')
    try {
      wg = await waitForWebGazer()

      // begin() 전엔 params만 만진다. WebGazer는 init() 안에서 이 params 값을 보고
      // 비디오·페이스 오버레이·gaze dot 의 초기 display 상태를 결정한다.
      wg.params.showVideo = false
      wg.params.showFaceOverlay = false
      wg.params.showFaceFeedbackBox = false
      wg.params.showGazeDot = false
      wg.params.showVideoPreview = false
      wg.params.camConstraints = await chooseCameraConstraints()
      // 세션 간 캘리브레이션 보존 (localforage / IndexedDB)
      wg.params.saveDataAcrossSessions = true

      wg.setGazeListener((data) => {
        const t = performance.now()
        let s: GazeSample | null
        const landmarks = wg?.getTracker?.()?.getPositions?.() as Landmark[] | null | undefined
        const eyesClosed = blinkGate.update(landmarks ?? null)
        if (!data || eyesClosed) {
          // 얼굴 검출 실패 프레임 — watchdog 이 STALE_MS 이상 지속 시 stale emit.
          s = filter.missing(t)
        } else {
          s = filter.sample(data.x, data.y, t)
        }
        if (!s) return
        lastSampleAt = t
        staleEmitted = s.fx < 0 || s.fy < 0
        sampleListeners.forEach((cb) => cb(s))
      })

      // begin() — 카메라 stream 획득 + MediaPipe face_mesh 모델 로드 + loop() 시작.
      // 여기서 'mediapipe/face_mesh/*' 파일들이 fetch 되므로 public/ 에 복사돼 있어야 한다.
      await wg.begin()

      // ⚠️ 중요: WebGazer 의 기본 패시브 마우스 학습을 끈다.
      //
      // WebGazer 는 document 에 mousemove/click 리스너를 달고 모든 좌표를
      // "사용자가 보고 있는 곳" 으로 가정해 회귀 모델에 계속 주입한다.
      // GlanceShift 의 사용 시나리오는 손(마우스)이 메인 작업에 묶여 있고
      // 시선은 별도로 움직이는 상황이라 이 가정이 깨진다 — 시간이 갈수록
      // 모델이 마우스 궤적 쪽으로 drift 한다.
      //
      // 우리는 ⌘⇧K 의 9-point 캘리브레이션에서 명시적 클릭만 학습 신호로 쓴다.
      try { wg.removeMouseEventListeners() } catch { /* */ }

      // begin 이후에 안전하게 UI 토글 (예방적; params만으로도 충분하지만 명시적으로).
      try {
        wg.showVideo(false)
        wg.showFaceOverlay(false)
        wg.showFaceFeedbackBox(false)
        wg.showPredictionPoints(false)
      } catch {
        // showXxx 가 일부 버전에서 throw 할 수 있어도 begin은 성공한 상태라 무시.
      }

      // ready 직후 watchdog 시작
      if (watchdogTimer == null) {
        watchdogTimer = setInterval(watchdogTick, WATCHDOG_TICK_MS)
      }

      setStatus('ready')
    } catch (e) {
      const msg = await describeCameraFailure(e)
      setStatus('error', msg)
      throw new Error(msg)
    }
  }

  function stop(): void {
    try {
      wg?.end()
    } catch { /* */ }
    if (watchdogTimer != null) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
    lastSampleAt = null
    staleEmitted = false
    filter.reset()
    blinkGate.reset()
    setStatus('stopped')
  }

  function recordPoint(x: number, y: number): void {
    wg?.recordScreenPosition(x, y, 'click')
  }

  async function clearCalibration(): Promise<void> {
    if (!wg) return
    await wg.clearData()
    filter.reset()
    blinkGate.reset()
  }

  return {
    start,
    stop,
    onSample(cb) {
      sampleListeners.add(cb)
      return () => sampleListeners.delete(cb)
    },
    onStatus(cb) {
      statusListeners.add(cb)
      // 현재 상태도 즉시 전달
      cb(status)
      return () => statusListeners.delete(cb)
    },
    status: () => status,
    recordPoint,
    clearCalibration
  }
}
