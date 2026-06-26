import type { CheckProgress, CheckResult, RunEvent, UpdateItem } from '../main/updates/types'

export interface CheckSummary {
  items: UpdateItem[]
  results: CheckResult[]
  errors: { source: string; distro?: string; error: string }[]
}

export interface TaskInfo {
  hooked: boolean
  lastRun?: string
  nextRun?: string
  lastResult?: string
  state?: string
}

export interface UpdaterApi {
  check(): Promise<CheckSummary>
  onCheckProgress(cb: (msg: CheckProgress) => void): () => void
  getCached(): Promise<CheckSummary | null>
  run(items: UpdateItem[]): Promise<{ ok: boolean }>
  onProgress(cb: (event: RunEvent) => void): () => void
  schedulerInfo(): Promise<TaskInfo>
  schedulerHook(): Promise<TaskInfo>
  schedulerUnhook(): Promise<TaskInfo>
  onUpdateReady(cb: () => void): () => void
  quitAndInstall(): Promise<void>
}

declare global {
  interface Window {
    api: UpdaterApi
  }
}

export type { CheckProgress, RunEvent, UpdateItem }
