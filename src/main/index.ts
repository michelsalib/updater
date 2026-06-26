import { join } from 'node:path'
import { electronApp, is } from '@electron-toolkit/utils'
import { app, BrowserWindow, Notification, shell } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import icon from '../../build/icon.png?asset'
import { IPC, registerIpc, setCached } from './ipc'
import { checkAll } from './updates'

log.initialize()
Object.assign(console, log.functions)
autoUpdater.logger = log

const isCheckMode = process.argv.includes('--check')

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: 'Weekly Update Checker',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: is.dev
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    return
  }
  mainWindow = createWindow()
}

/** Wires the auto-updater: tells the renderer when an update is ready to install. */
function initAutoUpdater(): void {
  if (is.dev) return
  autoUpdater.on('update-downloaded', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.updateReady)
    }
  })
  autoUpdater.checkForUpdatesAndNotify().catch((err) => console.error('update check failed:', err))
}

/**
 * Headless background scan launched by Task Scheduler. Scans, notifies if there
 * are updates (click opens the UI), then exits. Exits silently when clean.
 */
async function runCheckMode(): Promise<void> {
  try {
    const summary = await checkAll()
    setCached(summary)

    if (summary.items.length === 0) {
      app.quit()
      return
    }

    const n = summary.items.length
    const notification = new Notification({
      title: 'Updates available',
      body: `${n} update${n === 1 ? '' : 's'} ready. Click to review and install.`
    })
    notification.on('click', () => showWindow())
    notification.on('close', () => {
      if (!mainWindow) app.quit()
    })
    notification.show()

    // Safety net for a non-interactive session: don't linger forever.
    setTimeout(() => {
      if (!mainWindow) app.quit()
    }, 60_000)
  } catch (err) {
    console.error('check mode failed:', err)
    app.quit()
  }
}

if (isCheckMode) {
  // --check must not auto-quit just because no window is open yet.
  app.on('window-all-closed', () => {})
} else {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('fr.matchem.weeklyupdatechecker')
  registerIpc()

  if (isCheckMode) {
    runCheckMode()
  } else {
    showWindow()
    initAutoUpdater()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showWindow()
    })
  }
})
