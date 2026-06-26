import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'

// Keep these channel names in sync with src/main/ipc.ts.
const IPC = {
  check: 'updates:check',
  checkProgress: 'updates:check-progress',
  getCached: 'updates:get-cached',
  run: 'updates:run',
  progress: 'updates:progress',
  schedulerInfo: 'scheduler:info',
  schedulerHook: 'scheduler:hook',
  schedulerUnhook: 'scheduler:unhook',
  updateReady: 'updater:ready',
  quitAndInstall: 'updater:quit-and-install'
} as const

// biome-ignore lint/suspicious/noExplicitAny: bridge is typed in index.d.ts
type Any = any

const api = {
  /** Run a fresh scan for winget + HP + apt updates across all WSL distros. */
  check: () => ipcRenderer.invoke(IPC.check),
  /** Subscribe to per-source scan progress (so fast sources render first). */
  onCheckProgress: (cb: (msg: Any) => void) => {
    const listener = (_e: IpcRendererEvent, msg: Any): void => cb(msg)
    ipcRenderer.on(IPC.checkProgress, listener)
    return () => ipcRenderer.removeListener(IPC.checkProgress, listener)
  },
  /** Most recent scan without re-running (used when opened from a notification). */
  getCached: () => ipcRenderer.invoke(IPC.getCached),
  /** Run updates for the given items; progress arrives via onProgress. */
  run: (items: Any[]) => ipcRenderer.invoke(IPC.run, items),
  /** Subscribe to run progress events. Returns an unsubscribe function. */
  onProgress: (cb: (event: Any) => void) => {
    const listener = (_e: IpcRendererEvent, event: Any): void => cb(event)
    ipcRenderer.on(IPC.progress, listener)
    return () => ipcRenderer.removeListener(IPC.progress, listener)
  },
  /** Scheduled-task status. */
  schedulerInfo: () => ipcRenderer.invoke(IPC.schedulerInfo),
  /** Register the weekly task. */
  schedulerHook: () => ipcRenderer.invoke(IPC.schedulerHook),
  /** Remove the weekly task. */
  schedulerUnhook: () => ipcRenderer.invoke(IPC.schedulerUnhook),
  /** Fires when an auto-update has been downloaded and is ready to install. */
  onUpdateReady: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.updateReady, listener)
    return () => ipcRenderer.removeListener(IPC.updateReady, listener)
  },
  /** Restart and install the downloaded update. */
  quitAndInstall: () => ipcRenderer.invoke(IPC.quitAndInstall)
}

contextBridge.exposeInMainWorld('api', api)

export type UpdaterApi = typeof api
