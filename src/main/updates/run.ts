import { execFile, spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent, Source, UpdateItem } from './types'

export type { RunEvent } from './types'
export type Emit = (event: RunEvent) => void

// winget package ids: letters, digits, '.', '-', '+', '_'. apt names similar plus ':'.
// Validate to prevent shell/script injection of attacker-controlled ids.
const WINGET_ID = /^[A-Za-z0-9._+-]+$/
const APT_NAME = /^[A-Za-z0-9.+:_-]+$/
// HP SoftPaq id, e.g. `sp153464`. Used verbatim in the elevated script.
const SOFTPAQ_ID = /^sp\d+$/i
// Windows Update id is a GUID (the update's UpdateIdentity.UpdateID).
const WU_ID = /^[0-9a-f-]{36}$/i

function groupId(source: Source, distro?: string): string {
  if (source === 'apt' && distro) return `apt:${distro}`
  return source
}

/** Single quote escaping for a PowerShell single-quoted string literal. */
function psQuote(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Runs the selected updates and streams progress through `emit`.
 *
 * Everything that needs Windows elevation (winget, HP SoftPaqs, Windows Update)
 * runs in ONE elevated batch — a single UAC prompt for the whole run — by
 * concatenating per-source PowerShell fragments into one elevated worker. apt
 * runs separately inside WSL as root (no prompt — the Windows user owns the distro).
 */
export async function runUpdates(items: UpdateItem[], emit: Emit): Promise<void> {
  const aptByDistro = new Map<string, UpdateItem[]>()
  for (const i of items) {
    if (i.source !== 'apt') continue
    const d = i.distro ?? ''
    if (!d) continue
    if (!aptByDistro.has(d)) aptByDistro.set(d, [])
    aptByDistro.get(d)?.push(i)
  }

  // Build the elevated jobs (order = display order). Each contributes one group.
  const jobs: ElevatedJob[] = []
  const winget = buildWingetJob(items.filter((i) => i.source === 'winget'))
  if (winget) jobs.push(winget)
  const hp = buildHpJob(items.filter((i) => i.source === 'hp'))
  if (hp) jobs.push(hp)
  const wu = buildWindowsUpdateJob(items.filter((i) => i.source === 'wu'))
  if (wu) jobs.push(wu)

  let allOk = true
  try {
    if (jobs.length > 0) allOk = (await runElevatedBatch(jobs, emit)) && allOk
    for (const [distro, pkgs] of aptByDistro) {
      allOk = (await runApt(distro, pkgs, emit)) && allOk
    }
    emit({ kind: 'done', ok: allOk })
  } catch (e) {
    emit({ kind: 'error', message: (e as Error).message })
    emit({ kind: 'done', ok: false })
  }
}

// ---- elevated batch (one UAC for winget + HP + Windows Update) --------------

/** One elevated source's contribution: a display group plus a PS fragment. */
interface ElevatedJob {
  group: string
  label: string
  count: number
  /**
   * PowerShell that installs this source's items. It runs with a fresh `$gfail`
   * counter (0) in scope; increment it for every item that fails. Lines it writes
   * are streamed to this group's panel.
   */
  body: string
}

/**
 * Runs all elevated jobs under a SINGLE UAC prompt. The unelevated launcher calls
 * `Start-Process -Verb RunAs -Wait`, so one prompt blocks until the elevated
 * worker finishes every job. The worker can't share stdout across the elevation
 * boundary, so it writes a transcript we tail; `@@WUC-START/END@@` markers around
 * each job let us route lines to the right panel and learn each job's pass/fail.
 */
async function runElevatedBatch(jobs: ElevatedJob[], emit: Emit): Promise<boolean> {
  // Announce all panels up front so they render immediately.
  for (const j of jobs) {
    emit({ kind: 'group-start', group: j.group, label: j.label, count: j.count })
  }

  const dir = mkdtempSync(join(tmpdir(), 'wuc-elevated-'))
  const logFile = join(dir, 'run.log')
  const scriptFile = join(dir, 'run.ps1')

  const sections = jobs
    .map(
      (j) => `
"@@WUC-START ${j.group}@@"
$gfail = 0
${j.body}
"@@WUC-END ${j.group} $gfail@@"
if ($gfail -gt 0) { $batchFail++ }`
    )
    .join('\n')

  const script = `
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$batchFail = 0
Start-Transcript -Path '${psQuote(logFile)}' -Force | Out-Null
${sections}
Stop-Transcript | Out-Null
exit $batchFail
`
  await writeFile(scriptFile, script, 'utf8')

  // Route tailed lines to the current group; learn each group's result from its
  // END marker. Markers are matched as substrings so transcript framing is moot.
  const results = new Map<string, boolean>()
  let current: string | null = null
  const route = (line: string): void => {
    const start = line.match(/@@WUC-START (\S+)@@/)
    if (start) {
      current = start[1]
      return
    }
    const end = line.match(/@@WUC-END (\S+) (\d+)@@/)
    if (end) {
      const ok = Number(end[2]) === 0
      results.set(end[1], ok)
      emit({ kind: 'group-done', group: end[1], ok, code: ok ? 0 : 1 })
      current = null
      return
    }
    if (current) emit({ kind: 'log', group: current, text: line })
  }

  const tailer = tailLog(logFile, route)
  try {
    await launchElevated(scriptFile)
    await tailer.flush()
  } catch (e) {
    // Most commonly: the user declined the single UAC prompt — nothing ran.
    const msg = `Elevation cancelled or failed: ${(e as Error).message}`
    for (const j of jobs) {
      if (!results.has(j.group)) {
        emit({ kind: 'log', group: j.group, text: msg })
        emit({ kind: 'group-done', group: j.group, ok: false, code: null })
        results.set(j.group, false)
      }
    }
    return false
  } finally {
    tailer.stop()
  }

  // Any job whose END marker never arrived (worker crashed mid-batch) failed.
  for (const j of jobs) {
    if (!results.has(j.group)) {
      emit({ kind: 'group-done', group: j.group, ok: false, code: null })
      results.set(j.group, false)
    }
  }
  return [...results.values()].every(Boolean)
}

// ---- winget -----------------------------------------------------------------

function buildWingetJob(items: UpdateItem[]): ElevatedJob | null {
  const ids = items.map((i) => i.id).filter((id) => WINGET_ID.test(id))
  if (ids.length === 0) return null
  const body = ids
    .map(
      (id) => `
"=== ${id} ==="
winget upgrade --id "${id}" --exact --silent --accept-package-agreements --accept-source-agreements --include-unknown --disable-interactivity
if ($LASTEXITCODE -ne 0) { $gfail++; "winget exited $LASTEXITCODE for ${id}" }`
    )
    .join('\n')
  return { group: 'winget', label: 'Windows · winget', count: ids.length, body }
}

// ---- HP SoftPaqs ------------------------------------------------------------

/**
 * Normalizes and validates a SoftPaq download url. The HPIA report gives a
 * scheme-less host path (e.g. `ftp.hp.com/pub/softpaq/.../sp153464.exe`); we
 * prepend https and require an hp.com host plus a `spNNNN.exe` filename so an
 * attacker-controlled report can't point the elevated installer elsewhere. Falls
 * back to deriving the canonical path from the SoftPaq id when no url is present.
 */
function softpaqUrl(item: UpdateItem): string | null {
  let raw = (item.url ?? '').trim()
  if (!raw) {
    const n = Number(item.id.replace(/^sp/i, ''))
    if (!Number.isInteger(n)) return null
    const lower = Math.floor((n - 1) / 500) * 500 + 1
    const upper = Math.ceil(n / 500) * 500
    raw = `ftp.hp.com/pub/softpaq/sp${lower}-${upper}/${item.id.toLowerCase()}.exe`
  }
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    if (host !== 'hp.com' && !host.endsWith('.hp.com')) return null
    if (!/\/sp\d+\.exe$/i.test(u.pathname)) return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * The elevated worker downloads each SoftPaq from hp.com and runs its silent
 * installer; SoftPaq exit codes 0/3010/1641 are success (3010/1641 = a reboot is
 * pending), anything else is a failure.
 */
function buildHpJob(items: UpdateItem[]): ElevatedJob | null {
  const targets = items
    .filter((i) => SOFTPAQ_ID.test(i.id))
    .map((i) => ({ id: i.id.toLowerCase(), url: softpaqUrl(i) }))
    .filter((t): t is { id: string; url: string } => t.url !== null)
  if (targets.length === 0) return null

  const body = targets
    .map(
      ({ id, url }) => `
"=== ${id} ==="
$f = Join-Path $env:TEMP '${id}.exe'
try {
  Invoke-WebRequest -Uri '${url}' -OutFile $f -UseBasicParsing -ErrorAction Stop
  $p = Start-Process -FilePath $f -ArgumentList '/s' -Wait -PassThru
  $code = $p.ExitCode
  if ($code -ne 0 -and $code -ne 3010 -and $code -ne 1641) { $gfail++; "${id} installer exited $code" }
} catch {
  $gfail++
  "${id} failed: $($_.Exception.Message)"
}`
    )
    .join('\n')
  return { group: 'hp', label: 'HP · drivers & firmware', count: targets.length, body }
}

// ---- Windows Update ---------------------------------------------------------

/**
 * Installs the selected Windows Updates via the Windows Update Agent COM API —
 * the same locale-independent interface the checker uses. We search by each
 * update's GUID, download, and install; the API reports per-update result codes
 * (2 = succeeded) and whether a reboot is required.
 */
function buildWindowsUpdateJob(items: UpdateItem[]): ElevatedJob | null {
  const ids = items.map((i) => i.id.toLowerCase()).filter((id) => WU_ID.test(id))
  if (ids.length === 0) return null

  const idList = ids.map((id) => `'${id}'`).join(',')
  const body = `
$wanted = @(${idList})
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0")
$toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $result.Updates) {
  if ($wanted -contains $u.Identity.UpdateID.ToLower()) {
    if ($u.EulaAccepted -eq $false) { $u.AcceptEula() }
    [void]$toInstall.Add($u)
    "queued: $($u.Title)"
  }
}
if ($toInstall.Count -eq 0) { "No matching updates still pending." }
else {
  $dl = $session.CreateUpdateDownloader(); $dl.Updates = $toInstall
  "Downloading $($toInstall.Count) update(s)..."
  $dr = $dl.Download()
  $inst = $session.CreateUpdateInstaller(); $inst.Updates = $toInstall
  "Installing..."
  $ir = $inst.Install()
  for ($i = 0; $i -lt $toInstall.Count; $i++) {
    $rc = $ir.GetUpdateResult($i).ResultCode  # 2 = succeeded, 3 = succeeded w/ errors
    $t = $toInstall.Item($i).Title
    if ($rc -eq 2) { "ok: $t" } else { $gfail++; "failed ($rc): $t" }
  }
  if ($ir.RebootRequired) { "A reboot is required to finish." }
}`
  return { group: 'wu', label: 'Windows Update', count: ids.length, body }
}

// ---- elevation + log tailing ------------------------------------------------

/**
 * Launches an elevated PowerShell that runs `scriptFile` and waits for it.
 * Resolves with the worker's exit code; rejects if elevation is declined.
 */
function launchElevated(scriptFile: string): Promise<number> {
  const inner =
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -PassThru -Wait ` +
    `-ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${psQuote(scriptFile)}'); ` +
    `exit $p.ExitCode`
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inner],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          const code = (error as { code?: number }).code
          // Declined UAC surfaces as a thrown exception in the launcher.
          if (/canceled by the user|operation was canceled|RunAs/i.test(stderr)) {
            reject(new Error('Elevation was declined.'))
          } else if (typeof code === 'number') {
            resolve(code) // worker ran but reported a non-zero exit
          } else {
            reject(new Error(stderr.trim() || error.message))
          }
        } else {
          resolve(0)
        }
      }
    )
  })
}

/** Polls a (growing) log file and forwards new complete lines. */
function tailLog(
  file: string,
  onLine: (line: string) => void
): { stop: () => void; flush: () => Promise<void> } {
  let offset = 0
  let buffer = ''
  let stopped = false

  const readNew = (): Promise<void> =>
    new Promise((resolve) => {
      if (!existsSync(file)) return resolve()
      const stream = createReadStream(file, { start: offset, encoding: 'utf8' })
      stream.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        offset += Buffer.byteLength(text, 'utf8')
        buffer += text
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (t) onLine(t)
        }
      })
      stream.on('end', resolve)
      stream.on('error', () => resolve())
    })

  const timer = setInterval(() => {
    if (!stopped) void readNew()
  }, 400)

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    flush: async () => {
      await readNew()
      if (buffer.trim()) onLine(buffer.trim())
      buffer = ''
    }
  }
}

// ---- apt (WSL as root, direct streaming) -----------------------------------

/**
 * Upgrades the selected packages inside a WSL distro. Running as `-u root`
 * avoids any sudo password prompt: the Windows user already controls the distro.
 * We `apt-get update` first so the install isn't blocked by a stale index.
 */
function runApt(distro: string, items: UpdateItem[], emit: Emit): Promise<boolean> {
  const group = groupId('apt', distro)
  const pkgs = items.map((i) => i.id).filter((id) => APT_NAME.test(id))
  if (pkgs.length === 0) {
    emit({ kind: 'group-done', group, ok: true, code: 0 })
    return Promise.resolve(true)
  }

  emit({ kind: 'group-start', group, label: `WSL · ${distro}`, count: pkgs.length })

  const cmd =
    `export DEBIAN_FRONTEND=noninteractive; ` +
    `apt-get update && apt-get install --only-upgrade -y ${pkgs.join(' ')}`

  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--', 'bash', '-lc', cmd], {
      windowsHide: true
    })

    const forward = (chunk: Buffer): void => {
      // WSL command output is UTF-8; strip any stray NULs defensively.
      const text = chunk.toString('utf8').replace(/\x00/g, '')
      for (const line of text.split(/\r?\n/)) {
        const t = line.trimEnd()
        if (t) emit({ kind: 'log', group, text: t })
      }
    }

    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', (err) => {
      emit({ kind: 'log', group, text: `Failed to start: ${err.message}` })
      emit({ kind: 'group-done', group, ok: false, code: null })
      resolve(false)
    })
    child.on('close', (code) => {
      const ok = code === 0
      emit({ kind: 'group-done', group, ok, code })
      resolve(ok)
    })
  })
}
