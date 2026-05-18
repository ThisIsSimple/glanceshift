/**
 * Slider Mapper — 머리 roll 각도 → 슬라이더 0..1 값.
 *
 * 보고서 §3.3 Mappings — Radi-Eye Look & Cross 스타일:
 *   머리를 어깨 쪽으로 갸웃한 정도가 슬라이더 값에 선형 매핑.
 *   - roll ≈ -25° (오른쪽 어깨로) → 0%
 *   - roll ≈   0° (정중)         → 50%
 *   - roll ≈ +25° (왼쪽 어깨로)  → 100%
 *
 * 보고서 §3.3 Modes — Sidenmark & Gellersen (2019), BimodalGaze (2020):
 *   자연스러운 머리 흔들림 (yaw 와 동반된 작은 roll) 과 의도적 갸웃을 구분.
 *
 * 활성화 정책:
 *   - GazeBar 의 한 항목이 hover 된 동안만 슬라이더가 engage.
 *   - hover 가 종료되면 마지막 값이 commit 된다 (Phase 7 의 OS bridge 가 이걸 받음).
 */

export interface SliderMapperConfig {
  /** 풀-스케일까지의 roll 각도(도). 기본 25°. */
  rollRange: number
  /** 데드존 — |roll| 이 이 값 이하면 50% 로 고정. 미세 떨림 차단. 기본 1.5°. */
  deadzone: number
  /** 의도/자연 구분 — |dRoll/dt| > 이 임계(deg/s) 일 때 의도로 본다. 0 이면 끔. */
  intentRollRate?: number
  /** yaw 가 이 임계(deg/s) 이상이면 "둘러봄" 으로 보고 roll 변화를 의도가 아니라고 판정. */
  noIntentYawRate?: number
}

export const DEFAULT_SLIDER_CONFIG: SliderMapperConfig = {
  rollRange: 25,
  deadzone: 1.5,
  intentRollRate: 0,
  noIntentYawRate: 20
}

/**
 * roll 도(°) → 0..1 값. clamp 포함.
 */
export function rollToValue(roll: number, cfg: SliderMapperConfig = DEFAULT_SLIDER_CONFIG): number {
  // 데드존: 작은 떨림은 무시
  let r = roll
  if (Math.abs(r) <= cfg.deadzone) r = 0
  else r = r - Math.sign(r) * cfg.deadzone

  // 데드존을 뺀 만큼 범위도 축소
  const effective = Math.max(0.001, cfg.rollRange - cfg.deadzone)
  const norm = (r + effective) / (2 * effective)
  return Math.max(0, Math.min(1, norm))
}

/**
 * 정수 퍼센트 (0..100) — 표시용.
 */
export function valueToPercent(value: number): number {
  return Math.round(value * 100)
}

/**
 * 의도/자연 구분 — 머리 회전 속도 기반 heuristic.
 * 둘러보기 (yaw 큼) 와 의도적 갸웃 (roll 변화 + yaw 작음) 을 분리.
 * 현재 값 외에 이전 sample 의 (roll, yaw, t) 가 필요.
 */
export function isIntentionalTilt(
  prev: { roll: number; yaw: number; t: number } | null,
  curr: { roll: number; yaw: number; t: number },
  cfg: SliderMapperConfig = DEFAULT_SLIDER_CONFIG
): boolean {
  if (!prev) return false
  const dt = (curr.t - prev.t) / 1000
  if (dt <= 0) return false
  const dRoll = Math.abs(curr.roll - prev.roll) / dt
  const dYaw = Math.abs(curr.yaw - prev.yaw) / dt
  if (cfg.intentRollRate && cfg.intentRollRate > 0 && dRoll < cfg.intentRollRate) return false
  if (cfg.noIntentYawRate && dYaw > cfg.noIntentYawRate) return false
  return true
}
