/**
 * Head Pose Tracker — WebGazer 가 이미 추출한 face mesh landmarks 를 재사용.
 *
 * 왜 @mediapipe/tasks-vision 을 쓰지 않는가:
 *   WebGazer 내부 face-landmarks-detection v1(구버전 Emscripten)과
 *   @mediapipe/tasks-vision(신버전 Emscripten)이 같은 페이지의 전역 Module 객체를
 *   공유하면서 충돌하여 "abort(Module.noExitRuntime has been replaced...)" 에러가 발생.
 *   같은 face mesh 인 만큼 WebGazer 의 출력을 재사용하는 게 더 효율적이기도 함.
 *
 * 좌표계:
 *   landmarks[i] = [x, y, z] — 카메라(비-미러) 픽셀 좌표 (x, y), 깊이 z (작을수록 카메라에 가까움)
 *
 * 보고서 §3.3 Modes — Sidenmark & Gellersen (2019), BimodalGaze (2020)
 *   "자연 vs 의도" 분리는 roll 각속도 + yaw 동반 여부로 Phase 5에서 분류.
 */

import { OneEuroFilter } from './one-euro'
import type { HeadPose } from './euler'
import { computeNicEc, getIrisDebugPoints, type IrisFeature } from './nic-ec'

type Landmark = [number, number, number]
export type IrisDebug = ReturnType<typeof getIrisDebugPoints>

// MediaPipe FaceMesh 의 478 landmark 중 head pose 추출에 쓸 인덱스
// (WebGazer 의 facemesh.mjs 주석에 따라 "left/right" 는 subject 기준이다)
const IDX = {
  noseTip: 1,
  forehead: 10,    // 미간 상단
  chin: 152,
  leftEyeOuter: 263,   // subject 의 왼쪽 눈 바깥쪽 끝
  rightEyeOuter: 33    // subject 의 오른쪽 눈 바깥쪽 끝
} as const

export type HeadSample = HeadPose & {
  fYaw: number
  fPitch: number
  fRoll: number
  t: number
  detected: boolean
  /** refineLandmarks=true 일 때만 채워짐 (478 landmarks). null 이면 iris 피처 없음. */
  iris: IrisFeature | null
  /** HUD 시각화용 raw 좌표 — production 에선 안 씀 */
  irisDebug: IrisDebug | null
  /** 본 프레임의 face mesh landmark 개수 (468 vs 478 디버깅용) */
  landmarkCount: number
}

export type HeadTrackerStatus = 'unloaded' | 'waiting-video' | 'ready' | 'error' | 'stopped'

export interface HeadTracker {
  start(): Promise<void>
  stop(): void
  onSample(cb: (s: HeadSample) => void): () => void
  onStatus(cb: (s: HeadTrackerStatus, error?: string) => void): () => void
  status(): HeadTrackerStatus
  tuneFilter(opts: { mincutoff?: number; beta?: number; dcutoff?: number }): void
}

/**
 * 478 landmarks 로부터 yaw/pitch/roll 계산.
 * 결과는 도(°).
 *
 *   roll  : 두 눈 끝을 잇는 선과 수평선의 각도
 *           좌(+) / 우(-) 갸웃 — subject 기준 (양수는 subject의 왼쪽 어깨로 기울임)
 *
 *   yaw   : 두 눈의 z 차이로 좌우 회전 판정
 *           시선이 subject의 오른쪽으로 돌아갈수록 (+)
 *
 *   pitch : 이마-턱의 z 차이로 위아래 끄덕임 판정
 *           고개를 숙일수록 (+) — 턱이 카메라에서 멀어지고 이마가 가까워짐
 *
 * 부호 컨벤션은 데모에서 자연스럽게 매핑되도록 잡았다.
 */
function computeHeadPose(landmarks: Landmark[]): HeadPose | null {
  if (!landmarks || landmarks.length < 468) return null
  const leftEye = landmarks[IDX.leftEyeOuter]
  const rightEye = landmarks[IDX.rightEyeOuter]
  const noseTip = landmarks[IDX.noseTip]
  const forehead = landmarks[IDX.forehead]
  const chin = landmarks[IDX.chin]
  if (!leftEye || !rightEye || !noseTip || !forehead || !chin) return null

  // ROLL — 두 눈을 잇는 선의 수평 각도
  // 이미지 좌표는 Y가 아래로 증가. (leftEye - rightEye) 벡터의 각도가 roll.
  const dx = leftEye[0] - rightEye[0]
  const dy = leftEye[1] - rightEye[1]
  // 머리 upright 일 때 leftEye가 화면 RIGHT (mirrored 영상에서 user 의 왼눈은 화면 오른쪽), dx>0, dy≈0.
  // → 각도 0 근처. 머리를 user 왼쪽 어깨로 기울이면 dy<0 → 각도 음수. 부호를 뒤집어서 user 왼쪽 = +.
  const roll = -Math.atan2(dy, dx) * (180 / Math.PI)

  // 두 눈 사이의 픽셀 거리 — yaw 정규화 기준
  const eyeDist = Math.hypot(dx, dy)
  // YAW — 두 눈의 깊이(z) 차이.  z 는 mediapipe에서 작을수록 카메라에 가까움.
  // 머리를 subject 의 오른쪽으로 돌리면 (camera 기준 왼쪽) leftEye 가 더 멀어짐 → z 증가.
  const yawRaw = (leftEye[2] - rightEye[2]) / Math.max(1, eyeDist)
  const yaw = Math.atan(yawRaw) * (180 / Math.PI) * 1.8   // 약간의 스케일 보정

  // PITCH — 이마/턱의 깊이 차이.
  // 고개를 숙이면 이마가 카메라에 가까워지고 (z 감소), 턱은 멀어진다 (z 증가).
  // chin.z - forehead.z > 0 → 숙임.
  const faceHeight = Math.max(1, chin[1] - forehead[1])
  const pitchRaw = (chin[2] - forehead[2]) / faceHeight
  const pitch = Math.atan(pitchRaw) * (180 / Math.PI) * 1.8

  return { yaw, pitch, roll }
}

/** 얼굴 미검출이 이 시간 넘게 이어지면 watchdog 가 경고를 반복 출력 (ms) */
const FACE_WARN_INTERVAL_MS = 8000

export function createHeadTracker(): HeadTracker {
  const sampleListeners = new Set<(s: HeadSample) => void>()
  const statusListeners = new Set<(s: HeadTrackerStatus, error?: string) => void>()

  // 머리 움직임용 튜닝: mincutoff 1.5, beta 0.05 (시선보다 빠르게 따라가야 함)
  const fYaw = new OneEuroFilter(30, 1.5, 0.05)
  const fPitch = new OneEuroFilter(30, 1.5, 0.05)
  const fRoll = new OneEuroFilter(30, 1.5, 0.05)

  let status: HeadTrackerStatus = 'unloaded'
  let rafHandle: number | null = null
  let stopped = false
  let lastLandmarks: Landmark[] | null = null
  /** 한 번이라도 얼굴을 잡은 적 있는지 — 첫 acquire/loss 전이 로깅용 */
  let everDetected = false
  /** 얼굴 미검출이 길어질 때 주기적으로 경고하는 watchdog */
  let faceWatchTimer: number | null = null

  function setStatus(next: HeadTrackerStatus, error?: string): void {
    status = next
    statusListeners.forEach((cb) => cb(next, error))
  }

  function loop(): void {
    if (stopped) return
    const tracker = window.webgazer?.getTracker?.()
    const positions = tracker?.getPositions?.() as Landmark[] | null | undefined

    if (positions && positions.length > 460) {
      // 얼굴 획득(또는 끊겼다 복구) → ready 로 승격. transition 시에만 listener 통지.
      if (status !== 'ready') {
        setStatus('ready')
        if (!everDetected) {
          everDetected = true
          // eslint-disable-next-line no-console
          console.log('[head-tracker] face acquired → ready')
        } else {
          // eslint-disable-next-line no-console
          console.log('[head-tracker] face re-acquired → ready')
        }
      }

      // WebGazer 가 frame 마다 positionsArray 를 갱신하는데, 같은 reference 이지만
      // 내용이 매번 바뀐다. 변경 감지는 첫 점의 좌표 비교로 충분.
      const changed =
        !lastLandmarks ||
        lastLandmarks[1]?.[0] !== positions[1]?.[0] ||
        lastLandmarks[1]?.[1] !== positions[1]?.[1]

      if (changed) {
        lastLandmarks = positions
        const pose = computeHeadPose(positions)
        const iris = computeNicEc(positions)         // 478 미만이면 null
        const irisDebug = iris ? getIrisDebugPoints(positions) : null
        const t = performance.now()
        if (pose) {
          const sample: HeadSample = {
            yaw: pose.yaw,
            pitch: pose.pitch,
            roll: pose.roll,
            fYaw: fYaw.filter(pose.yaw, t),
            fPitch: fPitch.filter(pose.pitch, t),
            fRoll: fRoll.filter(pose.roll, t),
            t,
            detected: true,
            iris,
            irisDebug,
            landmarkCount: positions.length
          }
          sampleListeners.forEach((cb) => cb(sample))
        }
      }
    } else {
      // 얼굴 미검출 — 필터 리셋하고 detected=false 통지.
      // ready 였다면 waiting-video 로 강등(치명적 아님) — 얼굴이 다시 잡히면 loop 가 ready 로 복구.
      if (status === 'ready') {
        setStatus('waiting-video')
        // eslint-disable-next-line no-console
        console.log('[head-tracker] face lost → waiting-video (자동 복구 대기)')
      }
      fYaw.reset()
      fPitch.reset()
      fRoll.reset()
      sampleListeners.forEach((cb) =>
        cb({
          yaw: 0, pitch: 0, roll: 0,
          fYaw: 0, fPitch: 0, fRoll: 0,
          t: performance.now(),
          detected: false,
          iris: null,
          irisDebug: null,
          landmarkCount: 0
        })
      )
    }
    rafHandle = requestAnimationFrame(loop)
  }

  /**
   * 트래커 시작. 얼굴이 잡힐 때까지 *블로킹하지 않는다* — loop() 를 바로 돌려
   * 매 프레임 face mesh 를 polling 한다. 얼굴이 없으면 detected:false 를 emit 하며
   * 'waiting-video' 상태를 유지하고, 얼굴이 나타나면 loop 가 'ready' 로 승격한다.
   *
   * 이전 구현은 15초 안에 얼굴을 못 잡으면 throw 후 영구히 죽었다(복구 불가).
   * 이제는 참가자가 늦게 앉아도, 잠시 자리를 비웠다 돌아와도 자동 복구된다.
   */
  async function start(): Promise<void> {
    if (status === 'ready' || status === 'waiting-video') return
    stopped = false
    everDetected = false
    setStatus('waiting-video')

    // 얼굴이 오래 안 잡히면 주기적으로 경고 (치명적 아님, loop 는 계속 돈다)
    if (faceWatchTimer != null) window.clearInterval(faceWatchTimer)
    faceWatchTimer = window.setInterval(() => {
      if (stopped || status === 'ready') return
      // eslint-disable-next-line no-console
      console.warn(
        '[head-tracker] 얼굴이 감지되지 않습니다 — 카메라 앞에 얼굴이 보이는지/조명/' +
          '다른 앱의 카메라 점유를 확인하세요. (얼굴이 잡히면 자동으로 복구됩니다)'
      )
    }, FACE_WARN_INTERVAL_MS)

    loop()
  }

  function stop(): void {
    stopped = true
    if (rafHandle != null) cancelAnimationFrame(rafHandle)
    rafHandle = null
    if (faceWatchTimer != null) {
      window.clearInterval(faceWatchTimer)
      faceWatchTimer = null
    }
    setStatus('stopped')
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
      cb(status)
      return () => statusListeners.delete(cb)
    },
    status: () => status,
    tuneFilter(opts) {
      for (const f of [fYaw, fPitch, fRoll]) {
        if (opts.mincutoff != null) f.mincutoff = opts.mincutoff
        if (opts.beta != null) f.beta = opts.beta
        if (opts.dcutoff != null) f.dcutoff = opts.dcutoff
      }
    }
  }
}
