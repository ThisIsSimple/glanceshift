import { OneEuroFilter } from './one-euro'
import type { GazeSample, HeadSample, HeadTrackerStatus, TrackerStatus } from './tracker-types'

type TobiiSample = Parameters<typeof window.glanceshift.onTobiiSample>[0] extends (
  sample: infer S
) => void
  ? S
  : never

type StatusPayload = Parameters<typeof window.glanceshift.onTobiiStatus>[0] extends (
  status: infer S
) => void
  ? S
  : never

export type TobiiTrackerSample = {
  gaze: GazeSample
  head: HeadSample
}

export interface TobiiTracker {
  start(): Promise<boolean>
  stop(): Promise<void>
  onSample(cb: (s: TobiiTrackerSample) => void): () => void
  onGazeStatus(cb: (s: TrackerStatus, error?: string) => void): () => void
  onHeadStatus(cb: (s: HeadTrackerStatus, error?: string) => void): () => void
  status(): TrackerStatus
}

function mapStatus(status: StatusPayload['status']): TrackerStatus {
  if (status === 'starting') return 'loading'
  if (status === 'ready') return 'ready'
  if (status === 'error') return 'error'
  if (status === 'stopped') return 'stopped'
  return 'unloaded'
}

export function createTobiiTracker(): TobiiTracker {
  const sampleListeners = new Set<(s: TobiiTrackerSample) => void>()
  const gazeStatusListeners = new Set<(s: TrackerStatus, error?: string) => void>()
  const headStatusListeners = new Set<(s: HeadTrackerStatus, error?: string) => void>()
  const fYaw = new OneEuroFilter(60, 1.5, 0.05)
  const fPitch = new OneEuroFilter(60, 1.5, 0.05)
  const fRoll = new OneEuroFilter(60, 1.5, 0.05)

  let statusValue: TrackerStatus = 'unloaded'
  let offSample: (() => void) | null = null
  let offStatus: (() => void) | null = null

  function publishStatus(status: TrackerStatus, error?: string): void {
    statusValue = status
    gazeStatusListeners.forEach((cb) => cb(status, error))
    const headStatus: HeadTrackerStatus =
      status === 'ready'
        ? 'ready'
        : status === 'loading'
          ? 'waiting-video'
          : status === 'error'
            ? 'error'
            : status
    headStatusListeners.forEach((cb) => cb(headStatus, error))
  }

  function sampleFromTobii(sample: TobiiSample): TobiiTrackerSample {
    const valid = sample.valid && sample.x >= 0 && sample.y >= 0
    const t = performance.now()
    const gaze: GazeSample = valid
      ? { x: sample.x, y: sample.y, fx: sample.x, fy: sample.y, t }
      : { x: -1, y: -1, fx: -1, fy: -1, t }

    if (!sample.present) {
      fYaw.reset()
      fPitch.reset()
      fRoll.reset()
    }

    const detected = sample.present
    const head: HeadSample = {
      yaw: detected ? sample.yaw : 0,
      pitch: detected ? sample.pitch : 0,
      roll: detected ? sample.roll : 0,
      fYaw: detected ? fYaw.filter(sample.yaw, t) : 0,
      fPitch: detected ? fPitch.filter(sample.pitch, t) : 0,
      fRoll: detected ? fRoll.filter(sample.roll, t) : 0,
      t,
      detected,
      iris: null,
      landmarkCount: 0
    }

    return { gaze, head }
  }

  return {
    async start() {
      publishStatus('loading')
      offSample = window.glanceshift.onTobiiSample((sample) => {
        sampleListeners.forEach((cb) => cb(sampleFromTobii(sample)))
      })
      offStatus = window.glanceshift.onTobiiStatus((payload) => {
        publishStatus(mapStatus(payload.status), payload.error ?? undefined)
      })
      const result = await window.glanceshift.startTobii()
      if (!result.ok) {
        publishStatus('error', result.error)
        return false
      }
      return true
    },
    async stop() {
      offSample?.()
      offStatus?.()
      offSample = null
      offStatus = null
      await window.glanceshift.stopTobii()
      publishStatus('stopped')
    },
    onSample(cb) {
      sampleListeners.add(cb)
      return () => sampleListeners.delete(cb)
    },
    onGazeStatus(cb) {
      gazeStatusListeners.add(cb)
      cb(statusValue)
      return () => gazeStatusListeners.delete(cb)
    },
    onHeadStatus(cb) {
      headStatusListeners.add(cb)
      cb(statusValue === 'loading' ? 'waiting-video' : (statusValue as HeadTrackerStatus))
      return () => headStatusListeners.delete(cb)
    },
    status: () => statusValue
  }
}
