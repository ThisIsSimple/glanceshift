import {
  PILOT_BASE_SPEED,
  PILOT_COLLISION_DISTANCE_BUFFER,
  PILOT_COLLISION_PENALTY_MS,
  PILOT_COLLISION_SPEED_MULTIPLIER,
  PILOT_GOAL_DISTANCE,
  createPilotObstacles
} from './pilot-config'
import type { ObstacleSpec, RunnerCollision, RunnerLane, RunnerSnapshot } from './pilot-types'

type RuntimeObstacle = ObstacleSpec & {
  passed: boolean
}

export class RunnerSim {
  private obstacles: RuntimeObstacle[]
  private elapsedMs = 0
  private distance = 0
  private speed = PILOT_BASE_SPEED
  private speedMultiplier = 1
  private penaltyUntilMs = 0
  private collisionsTotal = 0
  private finished = false
  private lane: RunnerLane = 1

  constructor(obstacles: ObstacleSpec[] = createPilotObstacles()) {
    this.obstacles = obstacles.map((o) => ({ ...o, passed: false }))
  }

  setLane(lane: RunnerLane): void {
    this.lane = lane
  }

  update(dtMs: number): RunnerCollision[] {
    if (this.finished) return []
    const safeDt = Math.max(0, Math.min(80, dtMs))
    const prevDistance = this.distance

    this.speedMultiplier =
      this.elapsedMs < this.penaltyUntilMs ? PILOT_COLLISION_SPEED_MULTIPLIER : 1
    this.speed = PILOT_BASE_SPEED * this.speedMultiplier
    this.distance += this.speed * (safeDt / 1000)
    this.elapsedMs += safeDt

    const prevHitDistance = prevDistance + PILOT_COLLISION_DISTANCE_BUFFER
    const hitDistance = this.distance + PILOT_COLLISION_DISTANCE_BUFFER
    const collisions: RunnerCollision[] = []
    for (const obstacle of this.obstacles) {
      if (obstacle.passed) continue
      if (obstacle.distance <= prevHitDistance) {
        obstacle.passed = true
        continue
      }
      if (obstacle.distance > hitDistance) break

      obstacle.passed = true
      if (obstacle.lane === this.lane) {
        this.collisionsTotal += 1
        this.penaltyUntilMs = Math.max(
          this.penaltyUntilMs,
          this.elapsedMs + PILOT_COLLISION_PENALTY_MS
        )
        collisions.push({
          obstacleId: obstacle.id,
          lane: obstacle.lane,
          distance: obstacle.distance,
          tMs: this.elapsedMs
        })
      }
    }

    if (this.distance >= PILOT_GOAL_DISTANCE) {
      this.distance = PILOT_GOAL_DISTANCE
      this.finished = true
    }

    return collisions
  }

  snapshot(): RunnerSnapshot {
    return {
      elapsedMs: this.elapsedMs,
      distance: this.distance,
      speed: this.speed,
      speedMultiplier: this.speedMultiplier,
      lane: this.lane,
      finished: this.finished,
      collisionsTotal: this.collisionsTotal
    }
  }

  upcoming(lookaheadDistance: number): ObstacleSpec[] {
    return this.obstacles
      .filter((o) => !o.passed && o.distance >= this.distance && o.distance <= this.distance + lookaheadDistance)
      .map(({ passed: _passed, ...o }) => o)
  }
}
