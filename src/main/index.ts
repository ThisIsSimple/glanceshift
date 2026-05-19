/**
 * GlanceShift — Electron Main Process
 *
 * Phase 0 책임:
 *   1. 투명 / 프레임 없음 / 항상 위 / 화면 풀-사이즈 오버레이 윈도우 생성
 *   2. 기본적으로 mouse click-through (보조 명령을 부르기 전엔 주작업을 가리지 않음)
 *   3. 글로벌 단축키:
 *        Cmd/Ctrl+Shift+D  → 디버그 HUD 토글
 *        Cmd/Ctrl+Shift+M  → mouse click-through on/off (개발용)
 *        Cmd/Ctrl+Shift+Q  → 종료
 *
 * 보고서 §3.2 (Feel — cool 매체) / Iqbal & Horvitz (visual occlusion cost)
 * 원칙상 오버레이는 기본적으로 "보이지 않는 캔버스"여야 한다.
 */

import { app, BrowserWindow, globalShortcut, screen, ipcMain, session, systemPreferences, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import loudness from 'loudness'

const execAsync = promisify(exec)

const __dirname = dirname(fileURLToPath(import.meta.url))

let overlayWindow: BrowserWindow | null = null
let clickThrough = true

function createOverlayWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay()
  // bounds = 전체 디스플레이 영역 (workArea 와 달리 dock·menu bar 영역도 포함).
  // GlanceShift 의 edge gaze 영역은 화면의 진짜 가장자리를 의미하므로
  // dock 위에도 GazeBar 가 뜰 수 있도록 전체 영역을 덮는다.
  const { x, y, width, height } = primaryDisplay.bounds

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true, // 카메라 권한 prompt 등 위해 일단 true
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 항상-위 + visible-on-all-workspaces (macOS 풀스크린 위에서도 보이게)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 기본: 마우스 통과 (forward: true → renderer가 hover/move 이벤트는 받음)
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  overlayWindow.once('ready-to-show', () => {
    overlayWindow?.show()
  })

  // HMR 지원
  if (process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerShortcuts(): void {
  // 디버그 HUD 토글 — renderer 쪽에서 처리
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    overlayWindow?.webContents.send('glanceshift:toggle-debug')
  })

  // click-through 토글 (개발/캘리브레이션 시 잠시 마우스를 받아야 할 때)
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    clickThrough = !clickThrough
    overlayWindow?.setIgnoreMouseEvents(clickThrough, { forward: true })
    overlayWindow?.webContents.send('glanceshift:click-through', clickThrough)
    // eslint-disable-next-line no-console
    console.log(`[main] click-through = ${clickThrough}`)
  })

  // 캘리브레이션 토글 — globalShortcut 으로 등록해야 click-through 상태에서도
  // 키보드 입력을 받을 수 있다. (renderer 의 keydown 은 window focus 가 있어야 동작)
  globalShortcut.register('CommandOrControl+Shift+K', () => {
    overlayWindow?.webContents.send('glanceshift:toggle-calibration')
  })

  // 평가 모드 토글
  globalShortcut.register('CommandOrControl+Shift+E', () => {
    overlayWindow?.webContents.send('glanceshift:toggle-evaluation')
  })

  // Edge Mode 전환 — 비교 분석용
  //   filtered : OneEuro-filtered + classic FSM (baseline)
  //   raw      : unfiltered + classic FSM (필터 기여도 control)
  //   snapping : OneEuro-filtered + IntentTracker + RailFSM + UI snap
  globalShortcut.register('CommandOrControl+Shift+1', () => {
    overlayWindow?.webContents.send('glanceshift:set-edge-mode', 'filtered')
  })
  globalShortcut.register('CommandOrControl+Shift+2', () => {
    overlayWindow?.webContents.send('glanceshift:set-edge-mode', 'raw')
  })
  globalShortcut.register('CommandOrControl+Shift+3', () => {
    overlayWindow?.webContents.send('glanceshift:set-edge-mode', 'snapping')
  })

  // DevTools (분리 모드)
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    const wc = overlayWindow?.webContents
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  })

  // 빠른 종료
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit()
  })
}

// renderer가 캘리브레이션 등으로 마우스를 잠깐 받아야 할 때 사용
ipcMain.handle('glanceshift:set-click-through', (_e, enabled: boolean) => {
  clickThrough = enabled
  overlayWindow?.setIgnoreMouseEvents(enabled, { forward: true })
  return clickThrough
})

// macOS: 카메라 권한 상태 조회·요청
ipcMain.handle('glanceshift:get-camera-permission', async () => {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('camera')
})

ipcMain.handle('glanceshift:request-camera-permission', async () => {
  if (process.platform !== 'darwin') return true
  return systemPreferences.askForMediaAccess('camera')
})

// ===== OS Action Bridge — Phase 7 =====
//
// 시스템 볼륨은 loudness 패키지 (macOS 에선 내부적으로 osascript 호출).
// 밝기는 macOS 의 경우 `brightness` brew CLI 가 있으면 사용, 없으면 silent fail.
//   $ brew install brightness
// 다른 OS 는 best-effort.

ipcMain.handle('glanceshift:set-volume', async (_e, value: number) => {
  const clamped = Math.max(0, Math.min(1, value))
  try {
    await loudness.setVolume(Math.round(clamped * 100))
    return clamped
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[main] setVolume failed:', e)
    return null
  }
})

ipcMain.handle('glanceshift:get-volume', async () => {
  try {
    const v = await loudness.getVolume()
    return v / 100
  } catch {
    return null
  }
})

ipcMain.handle('glanceshift:set-brightness', async (_e, value: number) => {
  const clamped = Math.max(0, Math.min(1, value))
  if (process.platform === 'darwin') {
    try {
      // brightness CLI (brew). 없으면 ENOENT.
      await execAsync(`brightness ${clamped.toFixed(3)}`)
      return clamped
    } catch (e) {
      // 한 번만 안내하고 이후엔 조용히 실패
      if (!brightnessWarned) {
        brightnessWarned = true
        // eslint-disable-next-line no-console
        console.warn(
          '[main] brightness control unavailable. Install with `brew install brightness` to enable.'
        )
      }
      return null
    }
  }
  return null
})

let brightnessWarned = false

ipcMain.handle('glanceshift:get-brightness', async () => {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execAsync('brightness -l')
      // 출력 예: "display 0: brightness 0.500000"
      const match = stdout.match(/brightness\s+([\d.]+)/)
      if (match) return parseFloat(match[1])
    } catch {
      // brightness CLI 없음 — null 반환, App 은 기본값 사용
    }
  }
  return null
})

// 평가 CSV 저장 — userData/eval-logs/<filename>.csv
ipcMain.handle('glanceshift:save-eval-csv', async (_e, filename: string, content: string) => {
  const safeName = filename.replace(/[^\w.-]/g, '_')
  const dir = join(app.getPath('userData'), 'eval-logs')
  await mkdir(dir, { recursive: true })
  const fullPath = join(dir, safeName)
  await writeFile(fullPath, content, 'utf8')
  return fullPath
})

// Finder/Explorer 에서 평가 폴더 열기
ipcMain.handle('glanceshift:reveal-eval-folder', async () => {
  const dir = join(app.getPath('userData'), 'eval-logs')
  await mkdir(dir, { recursive: true })
  shell.openPath(dir)
  return dir
})

function installPermissionHandlers(): void {
  // getUserMedia 호출 시 Electron 권한 자동 grant
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') return callback(true)
    if (permission === 'mediaKeySystem') return callback(true)
    callback(false)
  })
  // 일부 Chromium 버전에서 사용하는 동기 권한 체크
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'mediaKeySystem'
  })
}

app.whenReady().then(() => {
  // macOS dock 숨김 (오버레이 앱은 dock 노이즈를 줄임)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide()
  }

  installPermissionHandlers()
  createOverlayWindow()
  registerShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
