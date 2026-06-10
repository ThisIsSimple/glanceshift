import type { Edge } from '../perception/edge-detector'

export type PilotCondition = 'mouse-menu' | 'glanceshift'
export type CommandTarget = 'game' | 'voice' | 'master'
export type CommandDirection = 'up' | 'down'
export type RunnerLane = 0 | 1 | 2

export type PilotPhase =
  | 'setup'
  | 'practice'
  | 'run'
  | 'condition-break'
  | 'exporting'
  | 'complete'

export type MixerVolumes = Record<CommandTarget, number>

export type PromptSpec = {
  id: string
  trialIdx: number
  atMs: number
  target: CommandTarget
  direction: CommandDirection
}

export type ObstacleSpec = {
  id: string
  distance: number
  lane: RunnerLane
}

export type RunnerCollision = {
  obstacleId: string
  lane: RunnerLane
  distance: number
  tMs: number
}

export type RunnerSnapshot = {
  elapsedMs: number
  distance: number
  speed: number
  speedMultiplier: number
  lane: RunnerLane
  finished: boolean
  collisionsTotal: number
}

export type PilotEventRow = {
  session_id: string
  participant_id: string
  condition: PilotCondition
  t_ms: number
  event_type: string
  payload_json: string
}

export type RunRow = {
  session_id: string
  participant_id: string
  condition: PilotCondition
  run_idx: number
  started_at_ms: number
  finished_at_ms: number
  finish_time_ms: number
  finish_delay_ms: number
  distance_at_end: number
  collisions_total: number
  obstacle_seed: string
  prompt_seed: string
  completed: boolean
  abort_reason: string
}

export type TrialRow = {
  session_id: string
  participant_id: string
  condition: PilotCondition
  run_idx: number
  trial_idx: number
  prompt_target: CommandTarget
  prompt_direction: CommandDirection
  prompt_at_ms: number
  analysis_window_ms: number
  command_started_at_ms: number | ''
  target_selected_at_ms: number | ''
  first_adjustment_at_ms: number | ''
  command_completed_at_ms: number | ''
  edge_enter_at_ms: number | ''
  last_target_hover_at_ms: number | ''
  returned_to_play_area_at_ms: number | ''
  selection_time_ms: number | ''
  control_time_ms: number | ''
  total_command_time_ms: number | ''
  incomplete: boolean
  value_start: number
  value_end: number
  value_delta: number
  target_delta: number
  collisions_5s: number
  speed_loss_area_5s: number
  finish_time_ms_at_export: number | ''
  gaze_off_ms_during_selection: number
  gaze_off_ms_during_adjustment: number
  gaze_off_ms_during_command: number
  gaze_missing_ms_during_command: number
}

export type FrameSampleRow = {
  session_id: string
  participant_id: string
  condition: PilotCondition
  t_ms: number
  distance: number
  speed: number
  lane: RunnerLane
  target_lane: RunnerLane
  game_volume: number
  voice_volume: number
  master_volume: number
  active_prompt_id: string
  active_command_target: CommandTarget | ''
  gaze_x: number | ''
  gaze_y: number | ''
  gaze_in_play_area: boolean
  head_roll: number | ''
  head_yaw: number | ''
  menu_open: boolean
  overlay_visible: boolean
}

export type GlanceShiftSelectionState = {
  visibleEdge: Edge | null
  hoveredTarget: CommandTarget | null
  lastHoverAtMs: number | null
  edgeEnterAtMs: number | null
  returnedToPlayAreaAtMs: number | null
}
