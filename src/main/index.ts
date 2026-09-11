import { app, shell, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, session } from 'electron'
import { join } from 'path'
import { getDb, getLatestProfile, saveProfile } from './db'
import { isWhisperAvailable, transcribeWav } from './whisper'
import { readFileSync } from 'fs'

// ------------------------------------------------------------
// .env loader (project root) — no external dependency needed.
// Real env vars always take precedence over .env values.
// ------------------------------------------------------------
function loadEnvFile(): void {
  try {
    const content = readFileSync(join(process.cwd(), '.env'), 'utf-8')
    const newline = String.fromCharCode(10)
    for (const rawLine of content.split(newline)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {
    // no .env file — fall back to openrouter.key / deepgram.key files
  }
}
loadEnvFile()

// Startup diagnostics — verify keys resolved without printing them
console.log(
  '[config] OpenRouter key:',
  process.env['OPENROUTER_API_KEY'] ? 'FOUND' : 'MISSING'
)
console.log(
  '[config] Deepgram key:',
  process.env['DEEPGRAM_API_KEY'] ? 'FOUND' : 'MISSING'
)

// ------------------------------------------------------------
// Single instance lock — prevents two app instances fighting
// over the same Chromium disk cache ("Unable to move the
// cache: Access is denied" errors).
// ------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let isClickThrough = false

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    frame: false,
    transparent: isMac,
    backgroundColor: isMac ? '#00000000' : undefined,
    // macOS: NSPanel floats over fullscreen Spaces; normal window elsewhere.
    // focusable MUST stay true so onboarding / Start Listening remain clickable.
    type: isMac ? 'panel' : undefined,
    fullscreenable: !isMac,
    hasShadow: !isMac,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    hiddenInMissionControl: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // ============================================================
  // ELITE STEALTH MODE
  // ------------------------------------------------------------
  // setContentProtection(true) maps directly to:
  //   - Windows: WDA_EXCLUDEFROMCAPTURE (invisible to Zoom,
  //     Meet, Teams, OBS and any screen capture API)
  //   - macOS:   kCGWindowSharingNone (window sharing disabled)
  // ============================================================
  mainWindow.setContentProtection(true)
  mainWindow.setSkipTaskbar(true)

  const forceOverlay = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    if (process.platform === 'darwin') {
      mainWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      })
      mainWindow.setFullScreenable(false)
    }
    console.log('[window] FORCE overlay re-applied (screen-saver + visibleOnFullScreen)')
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    forceOverlay()
  })
  mainWindow.on('show', forceOverlay)
  mainWindow.on('focus', forceOverlay)
  mainWindow.on('blur', forceOverlay)
  mainWindow.on('restore', forceOverlay)

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      _event.preventDefault()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toggleClickThrough(): void {
  if (!mainWindow) return
  isClickThrough = !isClickThrough
  mainWindow.setIgnoreMouseEvents(isClickThrough, { forward: isClickThrough })
  mainWindow.webContents.send('stealth:click-through-changed', isClickThrough)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  if (!gotTheLock) return

  // ------------------------------------------------------------
  // Screen-share handler — REQUIRED for navigator.mediaDevices
  // .getDisplayMedia() to work in Electron. Without this the
  // renderer throws NotSupportedError ("not supported").
  // Grants the primary display + system loopback audio so the
  // interviewer's voice is captured without a picker dialog.
  // ------------------------------------------------------------
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        const primary = sources[0]
        if (!primary) {
          callback({})
          return
        }
        // 'loopback' captures system audio on Windows AND macOS (Electron 39+ CoreAudio Tap)
        callback({
          video: primary,
          audio: 'loopback' as never
        })
      })
    },
    { useSystemPicker: false }
  )

  createWindow()

  globalShortcut.register('CommandOrControl+Shift+X', toggleClickThrough)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// IPC handlers — stealth
ipcMain.handle('stealth:get-status', () => ({
  contentProtected: true,
  clickThrough: isClickThrough,
  alwaysOnTop: mainWindow ? mainWindow.isAlwaysOnTop() : false
}))

ipcMain.handle('stealth:set-click-through', (_e, enabled: boolean) => {
  if (!mainWindow) return false
  isClickThrough = enabled
  mainWindow.setIgnoreMouseEvents(enabled, { forward: enabled })
  return enabled
})

// IPC handlers — candidate profile (SQLite)
ipcMain.handle('db:save-profile', (_e, profile) => {
  try {
    const row = saveProfile(profile)
    return { ok: true, profile: row }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('db:get-latest-profile', () => {
  try {
    getDb() // ensure schema exists
    const row = getLatestProfile()
    return { ok: true, profile: row ?? null }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// IPC handlers — config (.env first, key-file fallbacks)
ipcMain.handle('config:get-openrouter-key', () => {
  if (process.env['OPENROUTER_API_KEY']) return process.env['OPENROUTER_API_KEY']
  try {
    return readFileSync(join(process.cwd(), 'openrouter.key'), 'utf-8').trim()
  } catch {
    return ''
  }
})

// All distinct OpenRouter keys (.env first, then openrouter.key) so the
// renderer can rotate between accounts when one hits its free-tier limit.
ipcMain.handle('config:get-openrouter-keys', () => {
  const keys: string[] = []
  const envKey = process.env['OPENROUTER_API_KEY']
  if (envKey && envKey.trim()) keys.push(envKey.trim())
  try {
    const fileKey = readFileSync(join(process.cwd(), 'openrouter.key'), 'utf-8').trim()
    if (fileKey) keys.push(fileKey)
  } catch {
    // no key file
  }
  return Array.from(new Set(keys))
})

ipcMain.handle('config:get-deepgram-key', () => {
  if (process.env['DEEPGRAM_API_KEY']) return process.env['DEEPGRAM_API_KEY']
  try {
    return readFileSync(join(process.cwd(), 'deepgram.key'), 'utf-8').trim()
  } catch {
    return ''
  }
})

// IPC handlers — local Whisper STT (offline fallback)
ipcMain.handle('stt:is-available', () => isWhisperAvailable())

ipcMain.handle('stt:transcribe', async (_e, wavArrayBuffer: ArrayBuffer) => {
  try {
    const text = await transcribeWav(Buffer.from(wavArrayBuffer))
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})