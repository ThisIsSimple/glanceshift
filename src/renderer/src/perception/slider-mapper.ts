/**
 * Slider Mapper — 머리 roll 각도 → 슬라이더 0..1 값.
 *
 * 보고서 §3.3 Mappings — Radi-Eye Look & Cross 스타일:
 *   머리를 어깨 쪽으로 갸웃한 정도가 슬라이더 값에 선형 매핑.
 *   - roll ≈ -25° (오른쪽 어깨로) → 0%
 *   - roll ≈   0° (정중)         → 50%
 *   - roll ≈ +25° (왼쪽 어깨로)  → 100%
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
}

export const DEFAULT_SLIDER_CONFIG: SliderMapperConfig = {
  rollRange: 25,
  deadzone: 1.5
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
