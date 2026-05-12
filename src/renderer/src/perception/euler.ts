/**
 * MediaPipe FaceLandmarker 의 facial transformation matrix (4x4, column-major) 를
 * Euler angles (yaw / pitch / roll) 로 변환한다.
 *
 * 명칭:
 *   yaw   — Y축 회전 (고개를 좌우로 돌림)
 *   pitch — X축 회전 (고개를 위아래로 끄덕임)
 *   roll  — Z축 회전 (고개를 어깨 쪽으로 갸웃) ← GlanceShift 핵심 신호
 *
 * 회전 순서: YXZ (Three.js의 카메라/머리 표준).
 *
 * MediaPipe 의 matrix 메모리 레이아웃은 column-major:
 *   data[col * 4 + row]
 *
 * 그래서 m_ij (row i, col j) 에 접근하려면 data[j * 4 + i].
 *   m11 = data[0]   m12 = data[4]   m13 = data[8]   m14 = data[12]
 *   m21 = data[1]   m22 = data[5]   m23 = data[9]   m24 = data[13]
 *   m31 = data[2]   m32 = data[6]   m33 = data[10]  m34 = data[14]
 */

export type HeadPose = {
  /** 도(°), 좌(+)/우(-) 회전 */
  yaw: number
  /** 도(°), 아래(+)/위(-) 끄덕임 */
  pitch: number
  /** 도(°), 시계(+)/반시계(-) 갸웃 */
  roll: number
}

const RAD2DEG = 180 / Math.PI

/** 행렬 데이터(Float32Array length=16, column-major) → Euler (도). */
export function matrixToEuler(data: ArrayLike<number>): HeadPose {
  // YXZ 회전 순서 (Three.js Euler 와 동일):
  //   R = R_y(yaw) * R_x(pitch) * R_z(roll)
  //
  //   m23 = -sin(pitch) cos(roll) ... 일반화하면
  //   pitch = asin(-m23) 으로 추출 가능
  const m13 = data[8]
  const m23 = data[9]
  const m33 = data[10]
  const m21 = data[1]
  const m22 = data[5]
  const m11 = data[0]
  const m31 = data[2]

  const clampedM23 = Math.max(-1, Math.min(1, m23))
  const pitch = Math.asin(-clampedM23)

  let yaw: number
  let roll: number
  if (Math.abs(m23) < 0.9999999) {
    yaw = Math.atan2(m13, m33)
    roll = Math.atan2(m21, m22)
  } else {
    // pitch ≈ ±90°: gimbal lock — roll 을 0으로 두고 yaw 로 합산
    yaw = Math.atan2(-m31, m11)
    roll = 0
  }

  return {
    yaw: yaw * RAD2DEG,
    pitch: pitch * RAD2DEG,
    roll: roll * RAD2DEG
  }
}
