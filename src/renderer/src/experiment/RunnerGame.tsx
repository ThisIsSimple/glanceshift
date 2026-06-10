import {
  PILOT_GOAL_DISTANCE,
  PILOT_LOOKAHEAD_DISTANCE,
  targetLabel,
  directionLabel
} from './pilot-config'
import type {
  ObstacleSpec,
  PilotCondition,
  PromptSpec,
  RunnerCollision,
  RunnerLane,
  RunnerSnapshot
} from './pilot-types'

type Props = {
  condition: PilotCondition
  snapshot: RunnerSnapshot | null
  upcoming: ObstacleSpec[]
  activePrompt: PromptSpec | null
  lane: RunnerLane
  isPractice: boolean
  recentCollision: RunnerCollision | null
}

const LANE_LABELS = ['L', 'C', 'R'] as const

export function RunnerGame({
  condition,
  snapshot,
  upcoming,
  activePrompt,
  lane,
  isPractice,
  recentCollision
}: Props): JSX.Element {
  const distance = snapshot?.distance ?? 0
  const progress = Math.min(1, distance / PILOT_GOAL_DISTANCE)
  const hitActive = Boolean(recentCollision)

  return (
    <div className="pilot-runner">
      <div className="pilot-runner-hud">
        <div>
          <span className="pilot-hud-label">condition</span>
          <span className="pilot-hud-value">{condition}</span>
        </div>
        <div>
          <span className="pilot-hud-label">time</span>
          <span className="pilot-hud-value">
            {((snapshot?.elapsedMs ?? 0) / 1000).toFixed(1)}s
          </span>
        </div>
        <div>
          <span className="pilot-hud-label">collisions</span>
          <span className="pilot-hud-value">{snapshot?.collisionsTotal ?? 0}</span>
        </div>
      </div>

      <div className="pilot-progress">
        <div className="pilot-progress-fill" style={{ width: `${progress * 100}%` }} />
      </div>

      {activePrompt && (
        <div className="pilot-command-prompt">
          {targetLabel(activePrompt.target)} 소리를 {directionLabel(activePrompt.direction)}
        </div>
      )}

      {isPractice && <div className="pilot-practice-tag">practice</div>}

      <div className={`pilot-road${hitActive ? ' hit' : ''}`} aria-label="runner play area">
        {[0, 1, 2].map((idx) => (
          <div key={idx} className="pilot-lane">
            <span>{LANE_LABELS[idx]}</span>
          </div>
        ))}

        <div
          className={`pilot-player${hitActive ? ' hit' : ''}`}
          style={{ left: `${(lane + 0.5) * (100 / 3)}%` }}
          aria-label="player"
        />

        {hitActive && recentCollision && (
          <div
            className="pilot-hit-burst"
            style={{ left: `${(recentCollision.lane + 0.5) * (100 / 3)}%` }}
          >
            HIT
          </div>
        )}

        {upcoming.map((obstacle) => {
          const rel = Math.max(0, obstacle.distance - distance)
          const y = 92 - (rel / PILOT_LOOKAHEAD_DISTANCE) * 86
          return (
            <div
              key={obstacle.id}
              className="pilot-obstacle"
              style={{
                left: `${(obstacle.lane + 0.5) * (100 / 3)}%`,
                top: `${y}%`
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
