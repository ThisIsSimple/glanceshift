/**
 * WebGazer 전역 객체에 대한 최소 타입 선언.
 * 공식 .d.ts 가 없어서 우리가 실제 사용하는 메서드만 적는다.
 *
 * 출처: https://webgazer.cs.brown.edu/ + dist/webgazer.js
 */

export type GazePrediction = { x: number; y: number } | null
export type GazeListener = (data: GazePrediction, elapsedTime: number) => void

export interface WebGazerAPI {
  /** 시선 예측 콜백 등록 — chainable */
  setGazeListener(listener: GazeListener): WebGazerAPI

  /** 시선 추적 시작 (카메라 열고 face landmark 모델 로드). */
  begin(): Promise<WebGazerAPI>

  /** 정지 + 카메라 release. */
  end(): WebGazerAPI

  /** 일시 정지 / 재개. */
  pause(): WebGazerAPI
  resume(): WebGazerAPI

  /** 캘리브레이션 좌표를 수동으로 추가. eventType: 'click' | 'move'. */
  recordScreenPosition(x: number, y: number, eventType?: 'click' | 'move'): void

  /** 모든 트레이닝 데이터 삭제. */
  clearData(): Promise<void>

  /** UI overlay 토글 — 우리는 모두 끈다 (직접 그릴 것이므로). */
  showVideo(enabled: boolean): WebGazerAPI
  showFaceOverlay(enabled: boolean): WebGazerAPI
  showFaceFeedbackBox(enabled: boolean): WebGazerAPI
  showPredictionPoints(enabled: boolean): WebGazerAPI

  /** localforage를 통한 세션 간 캘리브레이션 데이터 저장. */
  saveDataAcrossSessions(enabled: boolean): WebGazerAPI

  /** 회귀 모델 선택 ('ridge' | 'weightedRidge' | 'threadedRidge'). */
  setRegression(name: string): WebGazerAPI

  /** 트래커(face mesh) 선택 — 보통 'TFFacemesh'. */
  setTracker(name: string): WebGazerAPI

  /** 비디오 미리보기 위치 조정 — 화면 밖으로 던져두는 용도. */
  setVideoViewerSize(width: number, height: number): WebGazerAPI

  /** isReady — face mesh model 로드 끝났는지. */
  isReady(): boolean

  /** 현재 face-mesh tracker 객체. 478 landmarks 접근에 사용. */
  getTracker(): WebGazerTracker

  params: {
    showVideo: boolean
    showFaceOverlay: boolean
    showFaceFeedbackBox: boolean
    showGazeDot: boolean
    videoViewerWidth?: number
    videoViewerHeight?: number
    [k: string]: unknown
  }
}

/** WebGazer face mesh tracker — 478개 landmark 를 노출. */
export interface WebGazerTracker {
  /** [[x, y, z], ...] — 478개 entry, 카메라 픽셀 좌표(x, y)와 정규화 깊이(z). */
  getPositions(): Array<[number, number, number]> | null
  // (다른 메서드들이 있지만 우리가 쓰는 건 getPositions 뿐)
}

declare global {
  interface Window {
    webgazer?: WebGazerAPI
  }
}

export {}
