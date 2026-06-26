import { execFile } from 'node:child_process'

export const TASK_NAME = 'WeeklyUpdateCheck'

export interface TaskInfo {
  hooked: boolean
  lastRun?: string
  nextRun?: string
  lastResult?: string
  state?: string
}

/**
 * Path to the executable Task Scheduler should launch. When packaged this is
 * the app .exe; in dev it's the electron.exe binary (hooking still works, it
 * just points at the dev binary).
 */
function executablePath(): string {
  return process.execPath
}

function runPwsh(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      }
    )
  })
}

/** Single-quote escaping for embedding a value in a PowerShell single-quoted string. */
function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Registers a weekly task that launches the app with `--check`.
 *
 * No `-WakeToRun` and no SYSTEM principal → the task runs in the current user's
 * interactive context only, which Windows allows registering WITHOUT elevation
 * (no UAC). `-StartWhenAvailable` catches runs missed while logged off.
 */
export async function hook(opts: { dayOfWeek?: string; at?: string } = {}): Promise<void> {
  const day = opts.dayOfWeek ?? 'Sunday'
  const at = opts.at ?? '10:00'
  const exe = psQuote(executablePath())

  const script = `
    $action   = New-ScheduledTaskAction -Execute '${exe}' -Argument '--check'
    $trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${day} -At ${at}
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName '${psQuote(TASK_NAME)}' -Action $action -Trigger $trigger -Settings $settings -Description 'Weekly check for winget and WSL apt updates.' -Force | Out-Null
  `
  await runPwsh(script)
}

/** Removes the scheduled task. Idempotent: a missing task is treated as success. */
export async function unhook(): Promise<void> {
  const script = `
    if (Get-ScheduledTask -TaskName '${psQuote(TASK_NAME)}' -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName '${psQuote(TASK_NAME)}' -Confirm:$false
    }
  `
  await runPwsh(script)
}

export async function isHooked(): Promise<boolean> {
  const script = `
    if (Get-ScheduledTask -TaskName '${psQuote(TASK_NAME)}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }
  `
  const { stdout } = await runPwsh(script)
  return stdout.trim() === 'yes'
}

/**
 * Returns task status via the ScheduledTasks cmdlets, which expose stable,
 * non-localized property names (unlike `schtasks.exe` text output, whose field
 * labels are translated per Windows display language). We emit JSON and parse.
 */
export async function getTaskInfo(): Promise<TaskInfo> {
  const name = psQuote(TASK_NAME)
  const script = `
    $t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue
    if (-not $t) { '{"hooked":false}' }
    else {
      $i = $t | Get-ScheduledTaskInfo
      [pscustomobject]@{
        hooked     = $true
        state      = [string]$t.State
        lastRun    = if ($i.LastRunTime)  { $i.LastRunTime.ToString('s') }  else { $null }
        nextRun    = if ($i.NextRunTime)  { $i.NextRunTime.ToString('s') }  else { $null }
        lastResult = $i.LastTaskResult
      } | ConvertTo-Json -Compress
    }
  `
  const { stdout } = await runPwsh(script)
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      hooked: boolean
      state?: string
      lastRun?: string | null
      nextRun?: string | null
      lastResult?: number | null
    }
    if (!parsed.hooked) return { hooked: false }
    return {
      hooked: true,
      state: parsed.state || undefined,
      lastRun: formatStamp(parsed.lastRun),
      nextRun: formatStamp(parsed.nextRun),
      lastResult: formatResult(parsed.lastResult)
    }
  } catch {
    // Fall back to a presence check if JSON parsing fails for any reason.
    return { hooked: await isHooked() }
  }
}

/** ISO-ish sortable timestamp (yyyy-MM-ddTHH:mm:ss) → friendlier display. */
function formatStamp(value?: string | null): string | undefined {
  if (!value) return undefined
  // Task Scheduler reports a pre-2000 sentinel (e.g. 1899/1999) for "never ran".
  const year = Number(value.slice(0, 4))
  if (Number.isFinite(year) && year < 2000) return undefined
  return value.replace('T', ' ')
}

function formatResult(code?: number | null): string | undefined {
  if (code === null || code === undefined) return undefined
  if (code === 0) return 'Success (0)'
  // 267011 = "task has not yet run"; surface the raw code otherwise.
  if (code === 267011) return 'Not yet run'
  return `0x${(code >>> 0).toString(16).toUpperCase()} (${code})`
}
