/**
 * Head pose Euler angle 타입.
 *
 *   yaw   — Y축 회전 (고개를 좌우로 돌림)
 *   pitch — X축 회전 (고개를 위아래로 끄덕임)
 *   roll  — Z축 회전 (고개를 어깨 쪽으로 갸웃) ← GlanceShift 핵심 신호
 *
 * 실제 각도 계산은 face-landmarker.ts 의 computeHeadPose 가 face mesh landmark 에서
 * 직접 수행한다 (MediaPipe transformation matrix 는 사용하지 않음).
 */

export type HeadPose = {
  /** 도(°), 좌(+)/우(-) 회전 */
  yaw: number
  /** 도(°), 아래(+)/위(-) 끄덕임 */
  pitch: number
  /** 도(°), 시계(+)/반시계(-) 갸웃 */
  roll: number
}
