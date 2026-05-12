/**
 * NIC-EC — Normalized Iris Center / Eye Corner vector.
 *
 * MediaPipe FaceMesh (refineLandmarks: true) 가 제공하는 478 landmarks 중:
 *   - 0..467   : 일반 face mesh
 *   - 468..472 : 오른쪽 눈 iris (subject's right) — 468 이 iris center
 *   - 473..477 : 왼쪽 눈 iris (subject's left) — 473 이 iris center
 *
 *   안쪽/바깥쪽 corner (FaceMesh 표준):
 *     subject right eye :  inner=133, outer=33
 *     subject left  eye :  inner=362, outer=263
 *
 * 핵심 idea (Sun et al., 2016):
 *   각 눈에 대해 iris center 의 위치를 두 눈꼬리(corner) 의 중점 대비 상대 좌표 로
 *   계산하고, 두 눈 사이 거리(= 눈 가로 폭) 로 정규화한다.
 *     v = (iris - cornerMid) / eyeWidth
 *   이 vector 는 머리의 평행이동과 카메라까지의 거리 변화에 자연스럽게 invariant 하다.
 *   머리 회전에 대한 잔여 비선형성은 head pose 와 함께 다항식 회귀에서 보정한다 (Phase 3.5b).
 */

export type IrisFeature = {
  /** subject right 눈의 NIC-EC 2D 벡터 (no z) */
  right: [number, number]
  /** subject left 눈의 NIC-EC 2D 벡터 */
  left: [number, number]
  /** 양안 평균 (단순 평균) — 회귀 입력으로 가장 자주 쓰임 */
  mean: [number, number]
  /** 검출 신뢰도 — 양안 corner-iris distance 비대칭이 크면 down */
  confidence: number
}

type Landmark = [number, number, number]

// 핵심 인덱스 (Subject 기준 — "left/right" 는 사람 자신의 좌/우)
const IDX = {
  rightIris: 468,
  leftIris: 473,
  // 눈꼬리 — face mesh 표준 인덱스
  rightInner: 133,
  rightOuter: 33,
  leftInner: 362,
  leftOuter: 263
} as const

function vec(a: Landmark, b: Landmark): [number, number] {
  return [a[0] - b[0], a[1] - b[1]]
}

function nicEcEye(iris: Landmark, inner: Landmark, outer: Landmark): [number, number, number] {
  const cx = (inner[0] + outer[0]) / 2
  const cy = (inner[1] + outer[1]) / 2
  const dx = outer[0] - inner[0]
  const dy = outer[1] - inner[1]
  const w = Math.hypot(dx, dy)
  if (w < 1) return [0, 0, 0]
  const ux = (iris[0] - cx) / w
  const uy = (iris[1] - cy) / w
  return [ux, uy, w]
}

/** 478 landmarks 가 들어와야 한다 (refineLandmarks: true 켜진 경우). */
export function computeNicEc(landmarks: Landmark[] | null | undefined): IrisFeature | null {
  if (!landmarks || landmarks.length < 478) return null
  const rIris = landmarks[IDX.rightIris]
  const lIris = landmarks[IDX.leftIris]
  const rIn = landmarks[IDX.rightInner]
  const rOut = landmarks[IDX.rightOuter]
  const lIn = landmarks[IDX.leftInner]
  const lOut = landmarks[IDX.leftOuter]
  if (!rIris || !lIris || !rIn || !rOut || !lIn || !lOut) return null

  const [rx, ry, rw] = nicEcEye(rIris, rIn, rOut)
  const [lx, ly, lw] = nicEcEye(lIris, lIn, lOut)
  if (rw === 0 || lw === 0) return null

  // 두 눈의 width 비율로 confidence 추정 — 머리가 옆으로 돌면 한쪽 눈이 좁아 보임
  const widthRatio = Math.min(rw, lw) / Math.max(rw, lw)
  // vector 비대칭도 — 양안이 거의 일치해야 신뢰 가능
  const dxDiff = Math.abs(rx - lx)
  const dyDiff = Math.abs(ry - ly)
  const symmetry = Math.max(0, 1 - (dxDiff + dyDiff))
  const confidence = Math.max(0, Math.min(1, widthRatio * 0.5 + symmetry * 0.5))

  return {
    right: [rx, ry],
    left: [lx, ly],
    mean: [(rx + lx) / 2, (ry + ly) / 2],
    confidence
  }
}

/**
 * iris-center 와 inner/outer corner 의 픽셀 좌표 (디버그 visualization 용).
 * NIC-EC 계산과 동일한 인덱스를 노출한다.
 */
export function getIrisDebugPoints(landmarks: Landmark[] | null | undefined): {
  rightIris: [number, number] | null
  leftIris: [number, number] | null
  rightInner: [number, number] | null
  rightOuter: [number, number] | null
  leftInner: [number, number] | null
  leftOuter: [number, number] | null
} {
  const empty = {
    rightIris: null, leftIris: null,
    rightInner: null, rightOuter: null,
    leftInner: null, leftOuter: null
  }
  if (!landmarks || landmarks.length < 478) return empty
  const xy = (i: number): [number, number] | null => {
    const p = landmarks[i]
    return p ? [p[0], p[1]] : null
  }
  return {
    rightIris: xy(IDX.rightIris),
    leftIris: xy(IDX.leftIris),
    rightInner: xy(IDX.rightInner),
    rightOuter: xy(IDX.rightOuter),
    leftInner: xy(IDX.leftInner),
    leftOuter: xy(IDX.leftOuter)
  }
}
