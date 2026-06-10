import type { HeadPose } from './euler'
import type { IrisFeature } from './nic-ec'

export type GazeSample = {
  x: number
  y: number
  fx: number
  fy: number
  t: number
}

export type TrackerStatus = 'unloaded' | 'loading' | 'ready' | 'error' | 'stopped'

export type HeadSample = HeadPose & {
  fYaw: number
  fPitch: number
  fRoll: number
  t: number
  detected: boolean
  iris: IrisFeature | null
  landmarkCount: number
}

export type HeadTrackerStatus = 'unloaded' | 'waiting-video' | 'ready' | 'error' | 'stopped'
