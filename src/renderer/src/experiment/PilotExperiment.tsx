import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EdgeSnapshot, Edge } from '../perception/edge-detector'
import type { HeadSample } from '../perception/tracker-types'
import { SliderIntentMapper, DEFAULT_SLIDER_CONFIG } from '../perception/slider-mapper'
import { ExperimentAudioMixer } from './audio-mixer'
import {
  PILOT_ANALYSIS_WINDOW_MS,
  PILOT_BASE_SPEED,
  PILOT_COMMAND_TIMEOUT_MS,
  PILOT_CONDITION_ORDER,
  PILOT_FRAME_SAMPLE_MS,
  PILOT_GOAL_DISTANCE,
  PILOT_INITIAL_VOLUMES,
  PILOT_LOOKAHEAD_DISTANCE,
  PILOT_OBSTACLE_SEED,
  PILOT_PARTICIPANT_TARGET_N,
  PILOT_PLATFORM,
  PILOT_PRACTICE_DURATION_MS,
  PILOT_PROMPT_SEED,
  PILOT_PROMPTS,
  PILOT_RUN_TIMEOUT_MS,
  PILOT_TARGET_DELTA,
  PILOT_TARGETS,
  createPilotObstacles,
  directionLabel,
  nextValueForDirection,
  targetLabel
} from './pilot-config'
import { payloadJson, safeTimestamp, toCsv } from './experiment-logger'
import { RunnerSim } from './runner-sim'
import { RunnerGame } from './RunnerGame'
import { MixerOverlay } from './MixerOverlay'
import type {
  CommandTarget,
  FrameSampleRow,
  GlanceShiftSelectionState,
  MixerVolumes,
  PilotCondition,
  PilotEventRow,
  PilotPhase,
  PromptSpec,
  RunnerCollision,
  RunRow,
  RunnerLane,
  RunnerSnapshot,
  TrialRow
} from './pilot-types'

type Props = {
  viewport: { w: number; h: number }
  gazePoint: { x: number; y: number; t: number } | null
  head: HeadSample
  edgeSnapshot: EdgeSnapshot
  entrySignal: number
}

type RuntimeTrial = {
  spec: PromptSpec
  commandStartedAtMs: number | null
  targetSelectedAtMs: number | null
  firstAdjustmentAtMs: number | null
  lastAdjustmentAtMs: number | null
  commandCompletedAtMs: number | null
  edgeEnterAtMs: number | null
  lastTargetHoverAtMs: number | null
  returnedToPlayAreaAtMs: number | null
  valueStart: number
  valueEnd: number
  collisions5s: number
  speedLossArea5s: number
  gazeOffSelectionMs: number
  gazeOffAdjustmentMs: number
  gazeMissingMs: number
  incomplete: boolean
}

const UPRIGHT_MAX_DEG = DEFAULT_SLIDER_CONFIG.uprightMaxDeg
const RELEASE_GAZE_OUT_MS = 2000
const EXPERIMENT_EDGE: Edge = 'bottom'
const SIDEBAR_TARGET_HITBOXES = [
  { center: 0.14, majorFrac: 0.19, edgeFrac: 0.16, edgeMaxPx: 168 },
  { center: 0.5, majorFrac: 0.1, edgeFrac: 0.065, edgeMaxPx: 76 },
  { center: 0.86, majorFrac: 0.19, edgeFrac: 0.16, edgeMaxPx: 168 }
] as const
const SIDEBAR_BASE_EDGE_MAX_PX = 72
const SIDEBAR_SIDE_EDGE_MAX_PX = 168
const SIDEBAR_SIDE_ACCESS_WIDTH_FRAC = 0.28

const RUN_HEADERS: Array<keyof RunRow & string> = [
  'session_id',
  'participant_id',
  'condition',
  'run_idx',
  'started_at_ms',
  'finished_at_ms',
  'finish_time_ms',
  'finish_delay_ms',
  'distance_at_end',
  'collisions_total',
  'obstacle_seed',
  'prompt_seed',
  'completed',
  'abort_reason'
]

const TRIAL_HEADERS: Array<keyof TrialRow & string> = [
  'session_id',
  'participant_id',
  'condition',
  'run_idx',
  'trial_idx',
  'prompt_target',
  'prompt_direction',
  'prompt_at_ms',
  'analysis_window_ms',
  'command_started_at_ms',
  'target_selected_at_ms',
  'first_adjustment_at_ms',
  'command_completed_at_ms',
  'edge_enter_at_ms',
  'last_target_hover_at_ms',
  'returned_to_play_area_at_ms',
  'selection_time_ms',
  'control_time_ms',
  'total_command_time_ms',
  'incomplete',
  'value_start',
  'value_end',
  'value_delta',
  'target_delta',
  'collisions_5s',
  'speed_loss_area_5s',
  'finish_time_ms_at_export',
  'gaze_off_ms_during_selection',
  'gaze_off_ms_during_adjustment',
  'gaze_off_ms_during_command',
  'gaze_missing_ms_during_command'
]

const EVENT_HEADERS: Array<keyof PilotEventRow & string> = [
  'session_id',
  'participant_id',
  'condition',
  't_ms',
  'event_type',
  'payload_json'
]

const FRAME_HEADERS: Array<keyof FrameSampleRow & string> = [
  'session_id',
  'participant_id',
  'condition',
  't_ms',
  'distance',
  'speed',
  'lane',
  'target_lane',
  'game_volume',
  'voice_volume',
  'master_volume',
  'active_prompt_id',
  'active_command_target',
  'gaze_x',
  'gaze_y',
  'gaze_in_play_area',
  'head_roll',
  'head_yaw',
  'menu_open',
  'overlay_visible'
]

export function PilotExperiment({
  viewport,
  gazePoint,
  head,
  edgeSnapshot,
  entrySignal
}: Props): JSX.Element {
  const [phase, setPhase] = useState<PilotPhase>('lobby')
  const [participantId, setParticipantId] = useState('P01')
  const [audioReady, setAudioReady] = useState(false)
  const [conditionIndex, setConditionIndex] = useState(0)
  const [condition, setCondition] = useState<PilotCondition>(PILOT_CONDITION_ORDER[0])
  const [isPractice, setIsPractice] = useState(false)
  const [lane, setLane] = useState<RunnerLane>(1)
  const [snapshot, setSnapshot] = useState<RunnerSnapshot | null>(null)
  const [upcoming, setUpcoming] = useState(createPilotObstacles())
  const [recentCollision, setRecentCollision] = useState<RunnerCollision | null>(null)
  const [volumes, setVolumes] = useState<MixerVolumes>(PILOT_INITIAL_VOLUMES)
  const [activePrompt, setActivePrompt] = useState<PromptSpec | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [selectedTarget, setSelectedTarget] = useState<CommandTarget | null>(null)
  const [glance, setGlance] = useState<GlanceShiftSelectionState>({
    visibleEdge: null,
    hoveredTarget: null,
    lastHoverAtMs: null,
    edgeEnterAtMs: null,
    returnedToPlayAreaAtMs: null
  })
  const [savedPaths, setSavedPaths] = useState<string[]>([])

  const sessionIdRef = useRef(`pilot-${Date.now()}`)
  const mixerRef = useRef(new ExperimentAudioMixer())
  const simRef = useRef<RunnerSim | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)
  const lastFrameSampleRef = useRef(0)
  const laneRef = useRef<RunnerLane>(1)
  const volumesRef = useRef<MixerVolumes>(PILOT_INITIAL_VOLUMES)
  const gazeRef = useRef<typeof gazePoint>(gazePoint)
  const headRef = useRef(head)
  const edgeSnapshotRef = useRef(edgeSnapshot)
  const glanceRef = useRef(glance)
  const trialsRef = useRef<RuntimeTrial[]>([])
  const activePromptRef = useRef<PromptSpec | null>(null)
  const selectedTargetRef = useRef<CommandTarget | null>(null)
  const menuOpenRef = useRef(false)
  const conditionRef = useRef<PilotCondition>(condition)
  const phaseRef = useRef<PilotPhase>(phase)
  const isPracticeRef = useRef(false)
  const runFlowRef = useRef<'pilot' | 'try'>('pilot')
  const runStartedWallAtRef = useRef(0)
  const runIdxRef = useRef(0)
  const conditionIndexRef = useRef(0)
  const runRowsRef = useRef<RunRow[]>([])
  const trialRowsRef = useRef<TrialRow[]>([])
  const eventRowsRef = useRef<PilotEventRow[]>([])
  const frameRowsRef = useRef<FrameSampleRow[]>([])
  const sliderMapperRef = useRef(new SliderIntentMapper())
  const uprightSinceRef = useRef<number | null>(null)
  const lastGazeOffAtRef = useRef<number | null>(null)
  const lastGazeMissingAtRef = useRef<number | null>(null)
  const collisionFlashTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (collisionFlashTimerRef.current != null) {
        window.clearTimeout(collisionFlashTimerRef.current)
      }
      void mixerRef.current.stop()
    }
  }, [])

  useEffect(() => {
    laneRef.current = lane
  }, [lane])

  useEffect(() => {
    volumesRef.current = volumes
  }, [volumes])

  useEffect(() => {
    gazeRef.current = gazePoint
  }, [gazePoint])

  useEffect(() => {
    headRef.current = head
  }, [head])

  useEffect(() => {
    edgeSnapshotRef.current = edgeSnapshot
  }, [edgeSnapshot])

  useEffect(() => {
    glanceRef.current = glance
  }, [glance])

  useEffect(() => {
    activePromptRef.current = activePrompt
  }, [activePrompt])

  useEffect(() => {
    selectedTargetRef.current = selectedTarget
  }, [selectedTarget])

  useEffect(() => {
    menuOpenRef.current = menuOpen
  }, [menuOpen])

  useEffect(() => {
    conditionRef.current = condition
  }, [condition])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    if (phaseRef.current === 'practice' || phaseRef.current === 'run') return
    setPhase('lobby')
  }, [entrySignal])

  const isGazeInPlayArea = useCallback(
    (g: { x: number; y: number } | null): boolean => {
      if (!g || g.x < 0 || g.y < 0) return false
      const xMin = viewport.w * 0.1
      const xMax = viewport.w * 0.9
      const yMin = viewport.h * 0.08
      const yMax = viewport.h * 0.92
      return g.x >= xMin && g.x <= xMax && g.y >= yMin && g.y <= yMax
    },
    [viewport]
  )

  const logEvent = useCallback(
    (eventType: string, payload: unknown = {}, tMs?: number): void => {
      const current = simRef.current?.snapshot()
      eventRowsRef.current.push({
        session_id: sessionIdRef.current,
        participant_id: participantId.trim() || 'unknown',
        condition: conditionRef.current,
        t_ms: Math.round(tMs ?? current?.elapsedMs ?? 0),
        event_type: eventType,
        payload_json: payloadJson(payload)
      })
    },
    [participantId]
  )

  const activeTrial = useCallback((): RuntimeTrial | null => {
    const prompt = activePromptRef.current
    if (!prompt) return null
    return trialsRef.current[prompt.trialIdx] ?? null
  }, [])

  const createRuntimeTrial = (spec: PromptSpec): RuntimeTrial => ({
    spec,
    commandStartedAtMs: null,
    targetSelectedAtMs: null,
    firstAdjustmentAtMs: null,
    lastAdjustmentAtMs: null,
    commandCompletedAtMs: null,
    edgeEnterAtMs: null,
    lastTargetHoverAtMs: null,
    returnedToPlayAreaAtMs: null,
    valueStart: PILOT_INITIAL_VOLUMES[spec.target],
    valueEnd: PILOT_INITIAL_VOLUMES[spec.target],
    collisions5s: 0,
    speedLossArea5s: 0,
    gazeOffSelectionMs: 0,
    gazeOffAdjustmentMs: 0,
    gazeMissingMs: 0,
    incomplete: false
  })

  const createTrials = (): RuntimeTrial[] =>
    PILOT_PROMPTS.map((spec) => createRuntimeTrial(spec))

  const resetCommandUi = (): void => {
    setActivePrompt(null)
    setMenuOpen(false)
    setSelectedTarget(null)
    uprightSinceRef.current = null
    sliderMapperRef.current.reset()
    setGlance({
      visibleEdge: null,
      hoveredTarget: null,
      lastHoverAtMs: null,
      edgeEnterAtMs: null,
      returnedToPlayAreaAtMs: null
    })
  }

  const resetPilotSession = (): void => {
    sessionIdRef.current = `pilot-${Date.now()}`
    runIdxRef.current = 0
    conditionIndexRef.current = 0
    setConditionIndex(0)
    setCondition(PILOT_CONDITION_ORDER[0])
    conditionRef.current = PILOT_CONDITION_ORDER[0]
    runRowsRef.current = []
    trialRowsRef.current = []
    eventRowsRef.current = []
    frameRowsRef.current = []
    trialsRef.current = []
    setSavedPaths([])
    setSnapshot(null)
    setUpcoming(createPilotObstacles())
    setRecentCollision(null)
    setLane(1)
    laneRef.current = 1
    volumesRef.current = { ...PILOT_INITIAL_VOLUMES }
    setVolumes({ ...PILOT_INITIAL_VOLUMES })
    resetCommandUi()
  }

  const commandSucceeded = (trial: RuntimeTrial): boolean => {
    const delta = trial.valueEnd - trial.valueStart
    if (trial.spec.direction === 'up') return delta >= PILOT_TARGET_DELTA
    return delta <= -PILOT_TARGET_DELTA
  }

  const selectTarget = useCallback(
    (target: CommandTarget, source = 'manual'): void => {
      const trial = activeTrial()
      const current = simRef.current?.snapshot()
      if (!current) return
      if (trial && trial.targetSelectedAtMs == null && target === trial.spec.target) {
        trial.targetSelectedAtMs = current.elapsedMs
      }
      setSelectedTarget(target)
      selectedTargetRef.current = target
      sliderMapperRef.current.reset(volumesRef.current[target])
      logEvent(
        source === 'auto' ? 'target_auto_select' : 'target_select',
        { target, prompted: trial != null },
        current.elapsedMs
      )
    },
    [activeTrial, logEvent]
  )

  const applyVolume = useCallback(
    (target: CommandTarget, value: number, source: string): void => {
      const clamped = Math.max(0, Math.min(1, value))
      const currentVolumes = volumesRef.current
      if (Math.abs(currentVolumes[target] - clamped) < 0.001) return
      const next = mixerRef.current.setVolume(target, clamped, currentVolumes)
      volumesRef.current = next
      setVolumes(next)

      const trial = activeTrial()
      const current = simRef.current?.snapshot()
      if (trial && current && target === trial.spec.target) {
        trial.valueEnd = clamped
        trial.lastAdjustmentAtMs = current.elapsedMs
        if (trial.firstAdjustmentAtMs == null && Math.abs(clamped - trial.valueStart) >= 0.01) {
          trial.firstAdjustmentAtMs = current.elapsedMs
          logEvent('adjust_start', { target, source }, current.elapsedMs)
        }
      }
      if (current) {
        logEvent('audio_value_change', { target, value: clamped, source }, current.elapsedMs)
      }
    },
    [activeTrial, logEvent]
  )

  const startCommand = useCallback(
    (prompt: PromptSpec, elapsedMs: number): void => {
      const trial = trialsRef.current[prompt.trialIdx]
      if (!trial || trial.commandStartedAtMs != null) return
      trial.commandStartedAtMs = elapsedMs
      trial.valueStart = volumesRef.current[prompt.target]
      trial.valueEnd = volumesRef.current[prompt.target]
      setActivePrompt(prompt)
      activePromptRef.current = prompt
      setMenuOpen(false)
      setSelectedTarget(null)
      logEvent('prompt_show', prompt, elapsedMs)
    },
    [logEvent]
  )

  const startPracticeCommand = useCallback(
    (trialIdx: number, elapsedMs: number): void => {
      const prompt = PILOT_PROMPTS[trialIdx % PILOT_PROMPTS.length]
      trialsRef.current[prompt.trialIdx] = createRuntimeTrial(prompt)
      startCommand(prompt, elapsedMs)
    },
    [startCommand]
  )

  const completeActiveCommand = useCallback(
    (reason: string): void => {
      const prompt = activePromptRef.current
      const trial = activeTrial()
      const current = simRef.current?.snapshot()
      if (!current) return
      if (!prompt || !trial) {
        logEvent(
          'command_complete_free',
          { reason, selectedTarget: selectedTargetRef.current },
          current.elapsedMs
        )
        resetCommandUi()
        return
      }
      if (trial.commandCompletedAtMs != null) return

      trial.commandCompletedAtMs = current.elapsedMs
      trial.valueEnd = volumesRef.current[prompt.target]
      trial.incomplete = !commandSucceeded(trial)

      logEvent(
        trial.incomplete ? 'command_complete_incomplete' : 'command_complete',
        {
          reason,
          target: prompt.target,
          direction: prompt.direction,
          valueStart: trial.valueStart,
          valueEnd: trial.valueEnd,
          success: !trial.incomplete,
          practice: isPracticeRef.current
        },
        current.elapsedMs
      )
      resetCommandUi()

      if (isPracticeRef.current) {
        const nextTrialIdx = (prompt.trialIdx + 1) % PILOT_PROMPTS.length
        window.setTimeout(() => {
          const nextElapsedMs = simRef.current?.snapshot().elapsedMs ?? current.elapsedMs
          startPracticeCommand(nextTrialIdx, nextElapsedMs)
        }, 250)
      }
    },
    [activeTrial, logEvent, startPracticeCommand]
  )

  const finishRun = useCallback(
    async (completed: boolean, abortReason = ''): Promise<void> => {
      const sim = simRef.current
      if (!sim) return
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }

      const snap = sim.snapshot()
      resetCommandUi()

      if (!isPracticeRef.current) {
        const finishTime = Math.round(snap.elapsedMs)
        runRowsRef.current.push({
          session_id: sessionIdRef.current,
          participant_id: participantId.trim() || 'unknown',
          condition: conditionRef.current,
          run_idx: runIdxRef.current,
          started_at_ms: runStartedWallAtRef.current,
          finished_at_ms: Date.now(),
          finish_time_ms: finishTime,
          finish_delay_ms: finishTime - 60_000,
          distance_at_end: Math.round(snap.distance),
          collisions_total: snap.collisionsTotal,
          obstacle_seed: PILOT_OBSTACLE_SEED,
          prompt_seed: PILOT_PROMPT_SEED,
          completed,
          abort_reason: abortReason
        })

        for (const trial of trialsRef.current) {
          const selectionTime =
            trial.targetSelectedAtMs != null && trial.commandStartedAtMs != null
              ? trial.targetSelectedAtMs - trial.commandStartedAtMs
              : ''
          const controlEndAtMs =
            trial.lastAdjustmentAtMs ??
            trial.firstAdjustmentAtMs ??
            (
              trial.commandCompletedAtMs != null && trial.targetSelectedAtMs != null
                ? trial.targetSelectedAtMs
                : null
            )
          const controlTime =
            controlEndAtMs != null && trial.targetSelectedAtMs != null
              ? Math.max(0, controlEndAtMs - trial.targetSelectedAtMs)
              : ''
          const totalTime =
            controlEndAtMs != null && trial.commandStartedAtMs != null
              ? Math.max(0, controlEndAtMs - trial.commandStartedAtMs)
              : ''
          trialRowsRef.current.push({
            session_id: sessionIdRef.current,
            participant_id: participantId.trim() || 'unknown',
            condition: conditionRef.current,
            run_idx: runIdxRef.current,
            trial_idx: trial.spec.trialIdx,
            prompt_target: trial.spec.target,
            prompt_direction: trial.spec.direction,
            prompt_at_ms: trial.spec.atMs,
            analysis_window_ms: PILOT_ANALYSIS_WINDOW_MS,
            command_started_at_ms: roundOrBlank(trial.commandStartedAtMs),
            target_selected_at_ms: roundOrBlank(trial.targetSelectedAtMs),
            first_adjustment_at_ms: roundOrBlank(trial.firstAdjustmentAtMs),
            command_completed_at_ms: roundOrBlank(trial.commandCompletedAtMs),
            edge_enter_at_ms: roundOrBlank(trial.edgeEnterAtMs),
            last_target_hover_at_ms: roundOrBlank(trial.lastTargetHoverAtMs),
            returned_to_play_area_at_ms: roundOrBlank(trial.returnedToPlayAreaAtMs),
            selection_time_ms: roundOrBlank(selectionTime),
            control_time_ms: roundOrBlank(controlTime),
            total_command_time_ms: roundOrBlank(totalTime),
            incomplete:
              trial.commandCompletedAtMs == null || trial.incomplete || !commandSucceeded(trial),
            value_start: round3(trial.valueStart),
            value_end: round3(trial.valueEnd),
            value_delta: round3(trial.valueEnd - trial.valueStart),
            target_delta: PILOT_TARGET_DELTA,
            collisions_5s: trial.collisions5s,
            speed_loss_area_5s: Math.round(trial.speedLossArea5s),
            finish_time_ms_at_export: finishTime,
            gaze_off_ms_during_selection: Math.round(trial.gazeOffSelectionMs),
            gaze_off_ms_during_adjustment: Math.round(trial.gazeOffAdjustmentMs),
            gaze_off_ms_during_command: Math.round(
              trial.gazeOffSelectionMs + trial.gazeOffAdjustmentMs
            ),
            gaze_missing_ms_during_command: Math.round(trial.gazeMissingMs)
          })
        }

        logEvent('run_finish', { completed, abortReason, finishTime }, snap.elapsedMs)
      }

      simRef.current = null
      setSnapshot(snap)
      setUpcoming([])
      await mixerRef.current.stop()
      setAudioReady(false)

      if (isPracticeRef.current) {
        if (runFlowRef.current === 'try') {
          setPhase('lobby')
          return
        }
        setPhase('condition-break')
        return
      }

      if (conditionIndexRef.current + 1 < PILOT_CONDITION_ORDER.length) {
        setPhase('condition-break')
      } else {
        setPhase('exporting')
        await exportLogs()
      }
    },
    [logEvent, participantId]
  )

  const tick = useCallback(
    (now: number): void => {
      const sim = simRef.current
      if (!sim) return
      const last = lastTickRef.current ?? now
      lastTickRef.current = now
      const dt = Math.max(0, now - last)

      sim.setLane(laneRef.current)
      const collisions = sim.update(dt)
      const snap = sim.snapshot()
      setSnapshot(snap)
      setUpcoming(sim.upcoming(PILOT_LOOKAHEAD_DISTANCE))

      if (collisions.length > 0) {
        setRecentCollision(collisions[collisions.length - 1])
        if (collisionFlashTimerRef.current != null) {
          window.clearTimeout(collisionFlashTimerRef.current)
        }
        collisionFlashTimerRef.current = window.setTimeout(() => {
          setRecentCollision(null)
          collisionFlashTimerRef.current = null
        }, 650)
      }

      if (!isPracticeRef.current) {
        for (const prompt of PILOT_PROMPTS) {
          if (snap.elapsedMs >= prompt.atMs && !trialsRef.current[prompt.trialIdx]?.commandStartedAtMs) {
            startCommand(prompt, snap.elapsedMs)
            break
          }
        }

        const active = activePromptRef.current
        const trial = active ? trialsRef.current[active.trialIdx] : null
        if (trial && trial.commandCompletedAtMs == null) {
          if (snap.elapsedMs - active!.atMs > PILOT_COMMAND_TIMEOUT_MS) {
            trial.incomplete = true
            completeActiveCommand('timeout')
          }
        }

        for (const trialItem of trialsRef.current) {
          const inWindow =
            snap.elapsedMs >= trialItem.spec.atMs &&
            snap.elapsedMs <= trialItem.spec.atMs + PILOT_ANALYSIS_WINDOW_MS
          if (inWindow) {
            trialItem.speedLossArea5s += Math.max(0, PILOT_BASE_SPEED - snap.speed) * (dt / 1000)
          }
        }

        for (const collision of collisions) {
          logEvent('collision', collision, collision.tMs)
          for (const trialItem of trialsRef.current) {
            if (
              collision.tMs >= trialItem.spec.atMs &&
              collision.tMs <= trialItem.spec.atMs + PILOT_ANALYSIS_WINDOW_MS
            ) {
              trialItem.collisions5s += 1
            }
          }
        }

        collectGazeDurations(dt)
        if (snap.elapsedMs - lastFrameSampleRef.current >= PILOT_FRAME_SAMPLE_MS) {
          lastFrameSampleRef.current = snap.elapsedMs
          frameRowsRef.current.push(makeFrameSample(snap))
        }
      }

      if (snap.finished) {
        void finishRun(true)
        return
      }
      if (snap.elapsedMs >= (isPracticeRef.current ? PILOT_PRACTICE_DURATION_MS : PILOT_RUN_TIMEOUT_MS)) {
        void finishRun(false, isPracticeRef.current ? 'practice_elapsed' : 'timeout')
        return
      }

      rafRef.current = requestAnimationFrame(tick)
    },
    [completeActiveCommand, finishRun, logEvent, startCommand]
  )

  const makeFrameSample = (snap: RunnerSnapshot): FrameSampleRow => {
    const g = gazeRef.current
    const headSample = headRef.current
    return {
      session_id: sessionIdRef.current,
      participant_id: participantId.trim() || 'unknown',
      condition: conditionRef.current,
      t_ms: Math.round(snap.elapsedMs),
      distance: Math.round(snap.distance),
      speed: Math.round(snap.speed),
      lane: laneRef.current,
      target_lane: laneRef.current,
      game_volume: round3(volumesRef.current.game),
      voice_volume: round3(volumesRef.current.voice),
      master_volume: round3(volumesRef.current.master),
      active_prompt_id: activePromptRef.current?.id ?? '',
      active_command_target: activePromptRef.current?.target ?? '',
      gaze_x: g && g.x >= 0 ? Math.round(g.x) : '',
      gaze_y: g && g.y >= 0 ? Math.round(g.y) : '',
      gaze_in_play_area: isGazeInPlayArea(g),
      head_roll: headSample.detected ? round3(headSample.fRoll) : '',
      head_yaw: headSample.detected ? round3(headSample.fYaw) : '',
      menu_open: menuOpenRef.current,
      overlay_visible: overlayVisible()
    }
  }

  const collectGazeDurations = (dt: number): void => {
    const trial = activeTrial()
    if (!trial || trial.commandCompletedAtMs != null) return
    const g = gazeRef.current
    const missing = !g || g.x < 0 || g.y < 0
    const inPlay = isGazeInPlayArea(g)
    const selected = selectedTargetRef.current != null

    if (missing) {
      trial.gazeMissingMs += dt
      if (lastGazeMissingAtRef.current == null) {
        const t = simRef.current?.snapshot().elapsedMs ?? 0
        lastGazeMissingAtRef.current = t
        logEvent('gaze_missing_start', {}, t)
      }
    } else if (lastGazeMissingAtRef.current != null) {
      logEvent('gaze_missing_end', {}, simRef.current?.snapshot().elapsedMs)
      lastGazeMissingAtRef.current = null
    }

    if (!missing && !inPlay) {
      if (selected) trial.gazeOffAdjustmentMs += dt
      else trial.gazeOffSelectionMs += dt
      if (lastGazeOffAtRef.current == null) {
        const t = simRef.current?.snapshot().elapsedMs ?? 0
        lastGazeOffAtRef.current = t
        logEvent('gaze_off_start', { selected }, t)
      }
    } else if (lastGazeOffAtRef.current != null) {
      logEvent('gaze_off_end', {}, simRef.current?.snapshot().elapsedMs)
      lastGazeOffAtRef.current = null
    }
  }

  const startRun = async (nextCondition: PilotCondition, practice: boolean): Promise<void> => {
    const runStartVolumes = { ...PILOT_INITIAL_VOLUMES }
    volumesRef.current = runStartVolumes
    setVolumes(runStartVolumes)
    await mixerRef.current.stop()
    await mixerRef.current.start(runStartVolumes)
    setAudioReady(true)
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    setCondition(nextCondition)
    conditionRef.current = nextCondition
    setIsPractice(practice)
    isPracticeRef.current = practice
    setLane(1)
    laneRef.current = 1
    const sim = new RunnerSim()
    simRef.current = sim
    const initial = sim.snapshot()
    setSnapshot(initial)
    setUpcoming(sim.upcoming(PILOT_LOOKAHEAD_DISTANCE))
    setRecentCollision(null)
    if (collisionFlashTimerRef.current != null) {
      window.clearTimeout(collisionFlashTimerRef.current)
      collisionFlashTimerRef.current = null
    }
    resetCommandUi()
    trialsRef.current = createTrials()
    lastTickRef.current = null
    lastFrameSampleRef.current = 0
    runStartedWallAtRef.current = Date.now()
    if (!practice) {
      runIdxRef.current += 1
      logEvent('run_start', { practice: false }, 0)
    }
    setPhase(practice ? 'practice' : 'run')
    if (practice) {
      startPracticeCommand(0, 0)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  const startCurrentRun = async (): Promise<void> => {
    await startRun(PILOT_CONDITION_ORDER[conditionIndexRef.current], false)
  }

  const startPilotFlow = async (): Promise<void> => {
    resetPilotSession()
    runFlowRef.current = 'pilot'
    await startRun(PILOT_CONDITION_ORDER[0], false)
  }

  const startTryMode = async (nextCondition: PilotCondition): Promise<void> => {
    resetPilotSession()
    runFlowRef.current = 'try'
    const conditionIdx = PILOT_CONDITION_ORDER.indexOf(nextCondition)
    conditionIndexRef.current = Math.max(0, conditionIdx)
    setConditionIndex(conditionIndexRef.current)
    await startRun(nextCondition, true)
  }

  const advanceAfterBreak = async (): Promise<void> => {
    if (isPracticeRef.current) {
      await startCurrentRun()
      return
    }
    const next = conditionIndexRef.current + 1
    if (next < PILOT_CONDITION_ORDER.length) {
      setConditionIndex(next)
      conditionIndexRef.current = next
      setCondition(PILOT_CONDITION_ORDER[next])
      await startRun(PILOT_CONDITION_ORDER[next], false)
    }
  }

  const exportLogs = async (): Promise<void> => {
    const ts = safeTimestamp()
    const base = `pilot_${participantId.trim() || 'unknown'}_${ts}`
    const headers = [
      'session_id',
      'participant_id',
      'condition_order',
      'condition',
      'run_idx',
      'trial_idx',
      'prompt_target',
      'prompt_direction',
      'prompt_at_ms',
      'command_success',
      'incomplete',
      'selection_time_ms',
      'control_time_ms',
      'total_command_time_ms',
      'value_start',
      'value_end',
      'value_delta',
      'target_delta',
      'collisions_5s',
      'speed_loss_area_5s',
      'gaze_off_ms_during_selection',
      'gaze_off_ms_during_adjustment',
      'gaze_missing_ms_during_command',
      'finish_time_ms',
      'finish_delay_ms',
      'distance_at_end',
      'collisions_total',
      'run_completed',
      'abort_reason'
    ]

    const runByKey = new Map<string, RunRow>()
    for (const run of runRowsRef.current) {
      runByKey.set(`${run.condition}:${run.run_idx}`, run)
    }

    const rows: Array<Record<string, string | number | boolean>> = trialRowsRef.current.map((trial) => {
      const run = runByKey.get(`${trial.condition}:${trial.run_idx}`)
      const incomplete = Boolean(trial.incomplete)
      return {
        session_id: trial.session_id,
        participant_id: trial.participant_id,
        condition_order: PILOT_CONDITION_ORDER.join('>'),
        condition: trial.condition,
        run_idx: trial.run_idx,
        trial_idx: trial.trial_idx,
        prompt_target: trial.prompt_target,
        prompt_direction: trial.prompt_direction,
        prompt_at_ms: trial.prompt_at_ms,
        command_success: !incomplete,
        incomplete,
        selection_time_ms: trial.selection_time_ms,
        control_time_ms: trial.control_time_ms,
        total_command_time_ms: trial.total_command_time_ms,
        value_start: trial.value_start,
        value_end: trial.value_end,
        value_delta: trial.value_delta,
        target_delta: trial.target_delta,
        collisions_5s: trial.collisions_5s,
        speed_loss_area_5s: trial.speed_loss_area_5s,
        gaze_off_ms_during_selection: trial.gaze_off_ms_during_selection,
        gaze_off_ms_during_adjustment: trial.gaze_off_ms_during_adjustment,
        gaze_missing_ms_during_command: trial.gaze_missing_ms_during_command,
        finish_time_ms: run?.finish_time_ms ?? '',
        finish_delay_ms: run?.finish_delay_ms ?? '',
        distance_at_end: run?.distance_at_end ?? '',
        collisions_total: run?.collisions_total ?? '',
        run_completed: run?.completed ?? false,
        abort_reason: run?.abort_reason ?? ''
      }
    })

    const csv = toCsv(headers, rows)
    const path = await window.glanceshift.saveEvalCsv(`${base}.csv`, csv)
    setSavedPaths([path])
    setPhase('complete')
  }

  const handleKey = useCallback(
    (e: KeyboardEvent): void => {
      if (phaseRef.current !== 'practice' && phaseRef.current !== 'run') return
      if (e.key === 'Escape') {
        void finishRun(false, 'escape')
        return
      }

      if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') {
        e.preventDefault()
        setLane((cur) => {
          const next = Math.max(0, cur - 1) as RunnerLane
          laneRef.current = next
          logEvent('lane_change', { lane: next }, simRef.current?.snapshot().elapsedMs)
          return next
        })
        return
      }
      if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') {
        e.preventDefault()
        setLane((cur) => {
          const next = Math.min(2, cur + 1) as RunnerLane
          laneRef.current = next
          logEvent('lane_change', { lane: next }, simRef.current?.snapshot().elapsedMs)
          return next
        })
        return
      }

      if (conditionRef.current !== 'mouse-menu') return

      if (e.key === 'Tab' || e.key === ' ') {
        e.preventDefault()
        setMenuOpen((open) => {
          const next = !open
          menuOpenRef.current = next
          logEvent(next ? 'menu_open' : 'menu_close', { source: 'keyboard' }, simRef.current?.snapshot().elapsedMs)
          return next
        })
        return
      }
      if (!menuOpenRef.current) return
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault()
        const target = PILOT_TARGETS[Number(e.key) - 1]
        selectTarget(target)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        completeActiveCommand('baseline_enter')
        return
      }

      const target = selectedTargetRef.current
      if (!target) return
      if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowDown') {
        e.preventDefault()
        applyVolume(target, nextValueForDirection(volumesRef.current[target], 'down', 0.025), 'keyboard')
        mixerRef.current.tick('down')
      } else if (e.key === 'e' || e.key === 'E' || e.key === 'ArrowUp') {
        e.preventDefault()
        applyVolume(target, nextValueForDirection(volumesRef.current[target], 'up', 0.025), 'keyboard')
        mixerRef.current.tick('up')
      }
    },
    [applyVolume, completeActiveCommand, finishRun, logEvent, selectTarget]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  useEffect(() => {
    if (condition !== 'glanceshift') return
    const current = simRef.current?.snapshot()
    if (!current) return

    const inExperimentEdge =
      (edgeSnapshot.state === 'entered' && edgeSnapshot.edge === EXPERIMENT_EDGE) ||
      isInPilotSidebarZone(EXPERIMENT_EDGE, gazePoint, viewport)

    if (inExperimentEdge) {
      const trial = activeTrial()
      if (trial && trial.edgeEnterAtMs == null) trial.edgeEnterAtMs = current.elapsedMs
      uprightSinceRef.current = null
      const wasVisible = glanceRef.current.visibleEdge != null
      const hover = targetFromGaze(EXPERIMENT_EDGE, gazePoint, viewport)
      setGlance((prev) => ({
        visibleEdge: EXPERIMENT_EDGE,
        hoveredTarget: hover ?? (wasVisible ? prev.hoveredTarget : null),
        lastHoverAtMs: hover ? current.elapsedMs : prev.lastHoverAtMs,
        edgeEnterAtMs: wasVisible ? prev.edgeEnterAtMs : current.elapsedMs,
        returnedToPlayAreaAtMs: prev.returnedToPlayAreaAtMs
      }))
      if (hover) {
        if (trial) trial.lastTargetHoverAtMs = current.elapsedMs
        logEvent('target_hover', { target: hover, source: 'gaze' }, current.elapsedMs)
      }
      return
    }

    const wasSidebarVisible = glance.visibleEdge != null
    if (wasSidebarVisible) {
      setGlance((prev) => ({
        ...prev,
        visibleEdge: null
      }))
    }

    const validGaze = gazePoint != null && gazePoint.x >= 0 && gazePoint.y >= 0
    if (!validGaze || !wasSidebarVisible) return
    const target = glanceRef.current.hoveredTarget
    if (!target) return
    const trial = activeTrial()
    if (trial) {
      trial.returnedToPlayAreaAtMs = current.elapsedMs
      if (trial.targetSelectedAtMs == null) trial.targetSelectedAtMs = current.elapsedMs
    }
    setGlance((prev) => ({ ...prev, returnedToPlayAreaAtMs: current.elapsedMs }))
    selectTarget(target, 'auto')
  }, [
    activeTrial,
    condition,
    edgeSnapshot.edge,
    edgeSnapshot.state,
    gazePoint,
    glance.hoveredTarget,
    glance.visibleEdge,
    logEvent,
    selectTarget,
    viewport
  ])

  useEffect(() => {
    if (condition !== 'glanceshift' || !selectedTarget || !head.detected) return
    if (glance.visibleEdge != null) return
    const current = simRef.current?.snapshot()
    if (!current) return
    const update = sliderMapperRef.current.update(head.fRoll, head.fYaw, head.t || performance.now())
    applyVolume(selectedTarget, update.value, 'head-tilt')
  }, [
    applyVolume,
    condition,
    glance.visibleEdge,
    head.detected,
    head.fRoll,
    head.fYaw,
    head.t,
    selectedTarget
  ])

  useEffect(() => {
    if (condition !== 'glanceshift' || !selectedTarget) return
    const id = window.setInterval(() => {
      const current = simRef.current?.snapshot()
      if (!current) return
      const operating = head.detected && Math.abs(head.fRoll) > UPRIGHT_MAX_DEG
      const selecting =
        edgeSnapshot.state === 'entered' && edgeSnapshot.edge === EXPERIMENT_EDGE
      if (selecting || glanceRef.current.visibleEdge != null) {
        uprightSinceRef.current = null
        return
      }
      if (operating) {
        uprightSinceRef.current = null
        return
      }
      uprightSinceRef.current ??= current.elapsedMs
      if (current.elapsedMs - uprightSinceRef.current >= RELEASE_GAZE_OUT_MS) {
        completeActiveCommand('glanceshift_upright_release')
      }
    }, 150)
    return () => window.clearInterval(id)
  }, [
    completeActiveCommand,
    condition,
    edgeSnapshot.edge,
    edgeSnapshot.state,
    head.detected,
    head.fRoll,
    selectedTarget
  ])

  const overlayVisible = (): boolean => {
    if (conditionRef.current === 'mouse-menu') {
      return menuOpenRef.current || activePromptRef.current != null
    }
    return (
      (
        edgeSnapshotRef.current.state === 'entered' &&
        edgeSnapshotRef.current.edge === EXPERIMENT_EDGE
      ) ||
      glanceRef.current.visibleEdge != null
    )
  }

  const currentPromptText = useMemo(() => {
    if (!activePrompt) return ''
    return `${targetLabel(activePrompt.target)} ${directionLabel(activePrompt.direction)}`
  }, [activePrompt])

  if (phase === 'lobby') {
    return (
      <div className="pilot-root">
        <div className="pilot-panel pilot-panel-wide pilot-lobby">
          <div className="pilot-lobby-header">
            <div>
              <h2>GlanceShift Pilot</h2>
              <p>Choose a run mode.</p>
            </div>
            <div className={`pilot-audio-state ${audioReady ? 'ready' : ''}`}>
              {audioReady ? 'audio ready' : 'audio idle'}
            </div>
          </div>

          <div className="pilot-lobby-grid">
            <div className="pilot-field">
              <label>participant id</label>
              <input value={participantId} onChange={(e) => setParticipantId(e.target.value)} />
            </div>
            <div className="pilot-actions">
              <button
                type="button"
                onClick={async () => {
                  await mixerRef.current.start(volumesRef.current)
                  setAudioReady(true)
                }}
              >
                Prepare audio
              </button>
              {savedPaths.length > 0 && (
                <button type="button" onClick={() => void window.glanceshift.revealEvalFolder()}>
                  Open logs
                </button>
              )}
            </div>
          </div>

          <div className="pilot-mode-grid">
            <button type="button" className="pilot-mode-card primary" onClick={startPilotFlow}>
              <span>Full pilot</span>
              <small>Keyboard condition, then GlanceShift condition</small>
            </button>
            <button
              type="button"
              className="pilot-mode-card"
              onClick={() => void startTryMode('mouse-menu')}
            >
              <span>Keyboard practice</span>
              <small>Same mixer UI with keyboard controls</small>
            </button>
            <button
              type="button"
              className="pilot-mode-card"
              onClick={() => void startTryMode('glanceshift')}
            >
              <span>GlanceShift practice</span>
              <small>Bottom edge target boxes with head tilt control</small>
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'condition-break') {
    const wasPractice = isPracticeRef.current
    const hasNextCondition = conditionIndexRef.current + 1 < PILOT_CONDITION_ORDER.length
    const label = wasPractice
      ? `${condition} 본 실험 시작`
      : hasNextCondition
        ? '외부 설문 후 다음 조건'
        : '완료'
    return (
      <div className="pilot-root">
        <div className="pilot-panel">
          <h2>{wasPractice ? '연습 종료' : `${condition} 종료`}</h2>
          <p>{wasPractice ? '본 실험을 시작합니다.' : '외부 설문을 진행한 뒤 계속하세요.'}</p>
          <button type="button" className="primary" onClick={advanceAfterBreak}>
            {label}
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'exporting') {
    return (
      <div className="pilot-root">
        <div className="pilot-panel">
          <h2>로그 저장 중</h2>
        </div>
      </div>
    )
  }

  if (phase === 'complete') {
    return (
      <div className="pilot-root">
        <div className="pilot-panel pilot-panel-wide">
          <h2>실험 완료</h2>
          <div className="pilot-saved-list">
            {savedPaths.map((path) => (
              <div key={path}>{path}</div>
            ))}
          </div>
          <div className="pilot-actions">
            <button type="button" onClick={() => void window.glanceshift.revealEvalFolder()}>
              로그 폴더 열기
            </button>
            <button type="button" className="primary" onClick={() => setPhase('lobby')}>
              Back to lobby
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pilot-root active">
      <RunnerGame
        condition={condition}
        snapshot={snapshot}
        upcoming={upcoming}
        activePrompt={activePrompt}
        lane={lane}
        isPractice={isPractice}
        recentCollision={recentCollision}
      />
      <MixerOverlay
        condition={condition}
        visible={overlayVisible()}
        edge={EXPERIMENT_EDGE}
        activePrompt={activePrompt}
        volumes={volumes}
        hoveredTarget={glance.hoveredTarget}
        selectedTarget={selectedTarget}
        menuOpen={menuOpen}
      />
      {activePrompt && (
        <div className="pilot-command-status">
          {currentPromptText} · {selectedTarget ? `${targetLabel(selectedTarget)} 선택됨` : 'target 선택 중'}
        </div>
      )}
    </div>
  )
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundOrBlank(value: number | '' | null): number | '' {
  if (value === '' || value == null) return ''
  return Math.round(value)
}

function isInPilotSidebarZone(
  edge: Edge,
  gaze: { x: number; y: number } | null,
  viewport: { w: number; h: number }
): boolean {
  if (!gaze || gaze.x < 0 || gaze.y < 0) return false
  if (edge !== 'bottom') return false

  const relX = gaze.x / Math.max(1, viewport.w)
  const leftAccess = Math.max(0, 1 - Math.abs(relX - 0.14) / SIDEBAR_SIDE_ACCESS_WIDTH_FRAC)
  const rightAccess = Math.max(0, 1 - Math.abs(relX - 0.86) / SIDEBAR_SIDE_ACCESS_WIDTH_FRAC)
  const sideAccess = Math.max(leftAccess, rightAccess)
  const edgeLimitPx =
    SIDEBAR_BASE_EDGE_MAX_PX +
    (SIDEBAR_SIDE_EDGE_MAX_PX - SIDEBAR_BASE_EDGE_MAX_PX) * sideAccess

  return viewport.h - gaze.y <= edgeLimitPx
}

function targetFromGaze(
  edge: Edge,
  gaze: { x: number; y: number } | null,
  viewport: { w: number; h: number }
): CommandTarget | null {
  if (!gaze || gaze.x < 0 || gaze.y < 0) return null
  const isVertical = edge === 'left' || edge === 'right'
  const major = isVertical ? gaze.y : gaze.x
  const length = isVertical ? viewport.h : viewport.w
  const edgeDistance =
    edge === 'left'
      ? gaze.x
      : edge === 'right'
        ? viewport.w - gaze.x
        : edge === 'top'
          ? gaze.y
          : viewport.h - gaze.y
  const idx = SIDEBAR_TARGET_HITBOXES.findIndex(
    (box) => Math.abs(major - box.center * length) <= (length * box.majorFrac) / 2
  )
  if (idx < 0) return null

  const box = SIDEBAR_TARGET_HITBOXES[idx]
  const crossLength = isVertical ? viewport.w : viewport.h
  const edgeLimitPx = Math.min(box.edgeMaxPx, crossLength * box.edgeFrac)
  if (edgeDistance < 0 || edgeDistance > edgeLimitPx) return null

  return PILOT_TARGETS[idx]
}
