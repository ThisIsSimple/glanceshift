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

import { app, BrowserWindow, globalShortcut, screen, ipcMain, session, systemPreferences } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

let overlayWindow: BrowserWindow | null = null
let clickThrough = true

function createOverlayWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize
  const { x, y } = primaryDisplay.workArea

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
