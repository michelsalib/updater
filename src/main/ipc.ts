import { ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getTaskInfo, hook, type TaskInfo, unhook } from './scheduler'
import { type CheckSummary, checkAll } from './updates'
import { runUpdates } from './updates/run'
import type { CheckProgress, UpdateItem } from './updates/types'

export const IPC = {
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

/** Last scan result, so a window opened from a notification can render
 *  immediately without re-scanning. */
let cached: CheckSummary | null = null

export function setCached(summary: CheckSummary): void {
  cached = summary
}

export function registerIpc(): void {
  ipcMain.handle(IPC.check, async (event): Promise<CheckSummary> => {
    // Stream each source's result as it lands so the UI can render the fast
    // sources (winget, apt) without waiting on the slow one (HP/HPIA, ~1 min).
    const send = (msg: CheckProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.checkProgress, msg)
    }
    cached = await checkAll({
      onStart: (keys) => send({ phase: 'start', keys }),
      onResult: (result) => send({ phase: 'result', result })
    })
    return cached
  })

  ipcMain.handle(IPC.getCached, async (): Promise<CheckSummary | null> => cached)

  ipcMain.handle(IPC.schedulerInfo, async (): Promise<TaskInfo> => getTaskInfo())

  ipcMain.handle(IPC.schedulerHook, async (): Promise<TaskInfo> => {
    await hook()
    return getTaskInfo()
  })

  ipcMain.handle(IPC.schedulerUnhook, async (): Promise<TaskInfo> => {
    await unhook()
    return getTaskInfo()
  })

  // Run selected updates, streaming progress back to the caller's window.
  ipcMain.handle(IPC.run, async (event, items: UpdateItem[]): Promise<{ ok: boolean }> => {
    let ok = true
    await runUpdates(items, (evt) => {
      if (evt.kind === 'done') ok = evt.ok
      if (!event.sender.isDestroyed()) event.sender.send(IPC.progress, evt)
    })
    return { ok }
  })

  ipcMain.handle(IPC.quitAndInstall, () => {
    autoUpdater.quitAndInstall()
  })
}
