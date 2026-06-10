import { BrowserWindow, app, screen } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'

export type TobiiBridgeStatus =
  | 'unloaded'
  | 'starting'
  | 'ready'
  | 'error'
  | 'stopped'

type TobiiRawMessage =
  | {
      type: 'status'
      status: TobiiBridgeStatus
      error?: string
    }
  | {
      type: 'sample'
      valid?: boolean
      present?: boolean
      x?: number
      y?: number
      yaw?: number
      pitch?: number
      roll?: number
      t?: number
      space?: 'window' | 'screen'
    }

export type TobiiRendererSample = {
  valid: boolean
  present: boolean
  x: number
  y: number
  yaw: number
  pitch: number
  roll: number
  t: number
}

let bridgeProcess: ChildProcessByStdio<null, Readable, Readable> | null = null
let bridgeStatus: TobiiBridgeStatus = 'unloaded'
let bridgeError: string | null = null
let stdoutBuffer = ''

function publishStatus(win: BrowserWindow | null, status: TobiiBridgeStatus, error?: string): void {
  bridgeStatus = status
  bridgeError = error ?? null
  win?.webContents.send('glanceshift:tobii-status', { status, error: bridgeError })
}

function helperCandidates(): string[] {
  const envPath = process.env.GLANCESHIFT_TOBII_BRIDGE
  const names = [
    join('tools', 'tobii-bridge', 'bin', 'tobii-bridge.exe'),
    join('tools', 'tobii-bridge', 'bin', 'TobiiBridge.exe'),
    join('tools', 'tobii-bridge', 'bin', 'Release', 'tobii-bridge.exe')
  ]
  return [
    ...(envPath ? [envPath] : []),
    ...names.map((p) => resolve(process.cwd(), p)),
    ...names.map((p) => join(app.getAppPath(), p)),
    join(process.resourcesPath, 'tobii-bridge.exe'),
    join(process.resourcesPath, 'TobiiBridge.exe')
  ]
}

function resolveHelperPath(): string | null {
  for (const candidate of helperCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function hwndArg(win: BrowserWindow): string {
  const handle = win.getNativeWindowHandle()
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  return BigInt(handle.readUInt32LE(0)).toString()
}

function normalizeSample(raw: Extract<TobiiRawMessage, { type: 'sample' }>): TobiiRendererSample {
  const t = typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : Date.now()
  const present = raw.present !== false
  const valid =
    raw.valid !== false &&
    present &&
    typeof raw.x === 'number' &&
    typeof raw.y === 'number' &&
    Number.isFinite(raw.x) &&
    Number.isFinite(raw.y)

  if (!valid) {
    return {
      valid: false,
      present,
      x: -1,
      y: -1,
      yaw: 0,
      pitch: 0,
      roll: 0,
      t
    }
  }

  let x = raw.x as number
  let y = raw.y as number
  if (raw.space === 'screen') {
    const bounds = screen.getPrimaryDisplay().bounds
    x -= bounds.x
    y -= bounds.y
  }

  return {
    valid: true,
    present,
    x,
    y,
    yaw: typeof raw.yaw === 'number' && Number.isFinite(raw.yaw) ? raw.yaw : 0,
    pitch: typeof raw.pitch === 'number' && Number.isFinite(raw.pitch) ? raw.pitch : 0,
    roll: typeof raw.roll === 'number' && Number.isFinite(raw.roll) ? raw.roll : 0,
    t
  }
}

function handleLine(win: BrowserWindow | null, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let message: TobiiRawMessage
  try {
    message = JSON.parse(trimmed) as TobiiRawMessage
  } catch {
    return
  }

  if (message.type === 'status') {
    publishStatus(win, message.status, message.error)
    return
  }
  if (message.type === 'sample') {
    win?.webContents.send('glanceshift:tobii-sample', normalizeSample(message))
  }
}

export function startTobiiBridge(win: BrowserWindow | null): { ok: boolean; status: TobiiBridgeStatus; error?: string } {
  if (process.platform !== 'win32') {
    const error = 'Tobii Eye Tracker 5 support is Windows-only.'
    publishStatus(win, 'error', error)
    return { ok: false, status: 'error', error }
  }
  if (!win) {
    const error = 'Overlay window is not ready.'
    publishStatus(win, 'error', error)
    return { ok: false, status: 'error', error }
  }
  if (bridgeProcess) {
    return { ok: true, status: bridgeStatus, error: bridgeError ?? undefined }
  }

  const helperPath = resolveHelperPath()
  if (!helperPath) {
    const error =
      'Tobii bridge helper was not found. Build it with `npm run build:tobii` or set GLANCESHIFT_TOBII_BRIDGE.'
    publishStatus(win, 'error', error)
    return { ok: false, status: 'error', error }
  }

  publishStatus(win, 'starting')
  stdoutBuffer = ''
  const proc = spawn(helperPath, ['--hwnd', hwndArg(win), '--fps', '60'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  bridgeProcess = proc

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let idx = stdoutBuffer.indexOf('\n')
    while (idx >= 0) {
      const line = stdoutBuffer.slice(0, idx)
      stdoutBuffer = stdoutBuffer.slice(idx + 1)
      handleLine(win, line)
      idx = stdoutBuffer.indexOf('\n')
    }
  })

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    const text = chunk.trim()
    if (text) publishStatus(win, 'error', text)
  })

  proc.on('error', (err) => {
    bridgeProcess = null
    publishStatus(win, 'error', err.message)
  })

  proc.on('exit', (code, signal) => {
    bridgeProcess = null
    if (bridgeStatus !== 'stopped') {
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      publishStatus(win, 'error', `Tobii bridge stopped unexpectedly (${suffix}).`)
    }
  })

  return { ok: true, status: 'starting' }
}

export function stopTobiiBridge(win: BrowserWindow | null): void {
  const proc = bridgeProcess
  bridgeProcess = null
  if (proc && !proc.killed) proc.kill()
  publishStatus(win, 'stopped')
}

export function tobiiBridgeStatus(): { status: TobiiBridgeStatus; error?: string | null } {
  return { status: bridgeStatus, error: bridgeError }
}
