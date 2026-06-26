export type Source = 'winget' | 'apt' | 'hp' | 'wu' | 'sdi'

export interface UpdateItem {
  source: Source
  id: string // winget id / apt name / HP SoftPaq id / WU GUID / SDI driver hardware id
  name: string
  current: string
  available: string
  /** WSL distribution this apt package belongs to. Undefined for winget/hp. */
  distro?: string
  /** HP only: the SoftPaq download URL from the HPIA report, used by the runner. */
  url?: string
}

/** Stable identity for an item across scans (apt ids can collide between distros). */
export function itemKey(item: UpdateItem): string {
  return item.distro ? `${item.source}:${item.distro}:${item.id}` : `${item.source}:${item.id}`
}

/** Progress events streamed from the runner (src/main/updates/run.ts) to the UI. */
export type RunEvent =
  | { kind: 'group-start'; group: string; label: string; count: number }
  | { kind: 'log'; group: string; text: string }
  | { kind: 'group-done'; group: string; ok: boolean; code: number | null }
  | { kind: 'done'; ok: boolean }
  | { kind: 'error'; group?: string; message: string }

/** Result of a checker, including any non-fatal error so the UI can surface it. */
export interface CheckResult {
  source: Source
  /** For apt, which distro this result came from. */
  distro?: string
  items: UpdateItem[]
  /** Present when the checker could not run (tool missing, WSL absent, parse failure). */
  error?: string
}

/**
 * Streamed during a scan so the UI can render fast sources (winget, apt) without
 * waiting for slow ones (HP/HPIA takes ~1 min). `start` announces the group keys
 * being scanned (so placeholders can show); `result` carries each one as it lands.
 */
export type CheckProgress =
  | { phase: 'start'; keys: string[] }
  | { phase: 'result'; result: CheckResult }
