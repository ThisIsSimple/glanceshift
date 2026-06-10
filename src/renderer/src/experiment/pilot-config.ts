import type {
  CommandTarget,
  MixerVolumes,
  ObstacleSpec,
  PilotCondition,
  PromptSpec,
  RunnerLane
} from './pilot-types'

export const PILOT_PARTICIPANT_TARGET_N = 10
export const PILOT_PLATFORM = 'windows'

export const PILOT_CONDITION_ORDER: PilotCondition[] = ['mouse-menu', 'glanceshift']
export const PILOT_TARGETS: CommandTarget[] = ['game', 'voice', 'master']

export const PILOT_RUN_DURATION_MS = 60_000
export const PILOT_PRACTICE_DURATION_MS = 20_000
export const PILOT_RUN_TIMEOUT_MS = 90_000
export const PILOT_ANALYSIS_WINDOW_MS = 5_000
export const PILOT_FRAME_SAMPLE_MS = 100

export const PILOT_OBSTACLE_SEED = 'pilot-obstacles-v5'
export const PILOT_PROMPT_SEED = 'pilot-prompts-v1'

export const PILOT_BASE_SPEED = 300
export const PILOT_GOAL_DISTANCE = PILOT_BASE_SPEED * (PILOT_RUN_DURATION_MS / 1000)
export const PILOT_LOOKAHEAD_DISTANCE = 1000
export const PILOT_COLLISION_DISTANCE_BUFFER = 70
export const PILOT_COLLISION_SPEED_MULTIPLIER = 0.65
export const PILOT_COLLISION_PENALTY_MS = 1_200
export const PILOT_LANE_CHANGE_MS = 120

export const PILOT_TARGET_DELTA = 0.2
export const PILOT_COMMAND_TIMEOUT_MS = 8_000

export const PILOT_INITIAL_VOLUMES: MixerVolumes = {
  game: 0.5,
  voice: 0.5,
  master: 0.5
}

export const PILOT_PROMPTS: PromptSpec[] = [
  { id: 'prompt-game-10s', trialIdx: 0, atMs: 10_000, target: 'game', direction: 'down' },
  { id: 'prompt-voice-30s', trialIdx: 1, atMs: 30_000, target: 'voice', direction: 'up' },
  { id: 'prompt-master-50s', trialIdx: 2, atMs: 50_000, target: 'master', direction: 'down' }
]

const OBSTACLE_TIMES: Array<[number, RunnerLane]> = [
  [2.4, 0],
  [3.9, 2],
  [5.3, 1],
  [6.8, 0],
  [8.4, 2],
  [10.1, 1],
  [11.5, 0],
  [13.0, 2],
  [14.7, 1],
  [16.2, 0],
  [17.8, 2],
  [19.3, 1],
  [20.9, 0],
  [22.4, 2],
  [24.1, 1],
  [25.6, 0],
  [27.1, 2],
  [28.8, 1],
  [30.2, 0],
  [31.7, 2],
  [33.4, 1],
  [34.9, 0],
  [36.5, 2],
  [38.0, 1],
  [39.6, 0],
  [41.2, 2],
  [42.7, 1],
  [44.4, 0],
  [45.9, 2],
  [47.5, 1],
  [49.0, 0],
  [50.6, 2],
  [52.1, 1],
  [53.7, 0],
  [55.2, 2],
  [56.8, 1],
  [58.3, 0]
]

export function createPilotObstacles(): ObstacleSpec[] {
  const doubled = OBSTACLE_TIMES.flatMap(([timeSec, lane], idx): Array<[number, RunnerLane]> => {
    const extraTimeSec = Math.min(PILOT_RUN_DURATION_MS / 1000 - 0.6, timeSec + 0.72)
    const extraLane = ((lane + (idx % 2 === 0 ? 1 : 2)) % 3) as RunnerLane
    return [
      [timeSec, lane],
      [extraTimeSec, extraLane]
    ]
  }).sort((a, b) => a[0] - b[0])

  return doubled.map(([timeSec, lane], idx) => ({
    id: `obs-${idx + 1}`,
    distance: Math.round(timeSec * PILOT_BASE_SPEED),
    lane
  }))
}

export function targetLabel(target: CommandTarget): string {
  if (target === 'game') return 'Game'
  if (target === 'voice') return 'Voice chat'
  return 'Master'
}

export function directionLabel(direction: 'up' | 'down'): string {
  return direction === 'up' ? 'increase' : 'decrease'
}

export function nextValueForDirection(value: number, direction: 'up' | 'down', step: number): number {
  const delta = direction === 'up' ? step : -step
  return Math.max(0, Math.min(1, value + delta))
}
