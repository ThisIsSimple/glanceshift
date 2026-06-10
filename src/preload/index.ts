/**
 * Preload — Main process IPC를 안전하게 renderer로 노출.
 * contextIsolation: true 이므로 contextBridge로 좁은 API만 공개.
 */
import { contextBridge, ipcRenderer } from 'electron'

type TobiiStatus = 'unloaded' | 'starting' | 'ready' | 'error' | 'stopped'
type TobiiStatusPayload = { status: TobiiStatus; error?: string | null }
type TobiiSample = {
  valid: boolean
  present: boolean
  x: number
  y: number
  yaw: number
  pitch: number
  roll: number
  t: number
}

const api = {
  /** click-through 마우스 통과 설정 (캘리브레이션 시 false로 토글) */
  setClickThrough: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('glanceshift:set-click-through', enabled),

  startTobii: (): Promise<{ ok: boolean; status: TobiiStatus; error?: string }> =>
    ipcRenderer.invoke('glanceshift:start-tobii'),

  stopTobii: (): Promise<void> =>
    ipcRenderer.invoke('glanceshift:stop-tobii'),

  getTobiiStatus: (): Promise<TobiiStatusPayload> =>
    ipcRenderer.invoke('glanceshift:get-tobii-status'),

  /** OS 볼륨 설정 (0..1). 실패 시 null. */
  setVolume: (value: number): Promise<number | null> =>
    ipcRenderer.invoke('glanceshift:set-volume', value),

  /** 현재 OS 볼륨 (0..1). 읽기 실패 시 null. */
  getVolume: (): Promise<number | null> =>
    ipcRenderer.invoke('glanceshift:get-volume'),

  /** OS 밝기 설정 (0..1, macOS 는 brightness CLI 필요). 실패 시 null. */
  setBrightness: (value: number): Promise<number | null> =>
    ipcRenderer.invoke('glanceshift:set-brightness', value),

  /** 현재 OS 밝기 (0..1). 읽기 실패 시 null. */
  getBrightness: (): Promise<number | null> =>
    ipcRenderer.invoke('glanceshift:get-brightness'),

  /** 평가 CSV 저장 → userData/eval-logs/<filename>. 저장된 절대 경로 반환. */
  saveEvalCsv: (filename: string, content: string): Promise<string> =>
    ipcRenderer.invoke('glanceshift:save-eval-csv', filename, content),

  /** 평가 로그 폴더를 Finder/Explorer 에서 연다. */
  revealEvalFolder: (): Promise<string> =>
    ipcRenderer.invoke('glanceshift:reveal-eval-folder'),

  /** main → renderer 이벤트 구독 */
  onToggleDebug: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('glanceshift:toggle-debug', listener)
    return () => ipcRenderer.removeListener('glanceshift:toggle-debug', listener)
  },

  onClickThroughChange: (cb: (enabled: boolean) => void): (() => void) => {
    const listener = (_e: unknown, enabled: boolean): void => cb(enabled)
    ipcRenderer.on('glanceshift:click-through', listener)
    return () => ipcRenderer.removeListener('glanceshift:click-through', listener)
  },

  onToggleEvaluation: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('glanceshift:toggle-evaluation', listener)
    return () => ipcRenderer.removeListener('glanceshift:toggle-evaluation', listener)
  },

  onTobiiSample: (cb: (sample: TobiiSample) => void): (() => void) => {
    const listener = (_e: unknown, sample: TobiiSample): void => cb(sample)
    ipcRenderer.on('glanceshift:tobii-sample', listener)
    return () => ipcRenderer.removeListener('glanceshift:tobii-sample', listener)
  },

  onTobiiStatus: (cb: (status: TobiiStatusPayload) => void): (() => void) => {
    const listener = (_e: unknown, status: TobiiStatusPayload): void => cb(status)
    ipcRenderer.on('glanceshift:tobii-status', listener)
    return () => ipcRenderer.removeListener('glanceshift:tobii-status', listener)
  }
}

contextBridge.exposeInMainWorld('glanceshift', api)

export type GlanceShiftAPI = typeof api
