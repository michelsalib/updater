import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { CheckResult, UpdateItem } from './types'

// SDI = Snappy Driver Installer Origin (SDIO), bundled in resources/sdio the same
// way as HPIA. Checking drivers means refreshing SDIO's index and matching it
// against installed hardware — so the download/refresh happens AS PART OF the
// check (one "Check for updates" action). SDIO is run headless with -lang:en so
// its log is English (locale-safe). It finds its scripts/tools next to the exe
// but writes data relative to cwd, so we run it with cwd = a writable userData dir.
//
// NOTE: SDIO's driver data is largely BitTorrent-distributed; a plain HTTP
// `get indexes` may populate nothing matchable, in which case `select` reports
// 0 and this returns no items (clean). The per-driver row format is therefore
// validated only for the empty case so far — see update-sources-architecture memory.

const SCRIPT = `verbose 384
logging on
enableinstall off
init
get indexes
select missing better
writedevicelist devicelist.txt
end
`

/** Bundled SDIO exe path (resources/sdio), mirroring hp.ts's hpiaPath(). */
function sdioExe(): string | null {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'sdio')
    : join(app.getAppPath(), 'resources', 'sdio')
  if (!existsSync(base)) return null
  const name = readdirSync(base).find((f) => /^SDIO_x64_R\d+\.exe$/i.test(f))
  return name ? join(base, name) : null
}

/**
 * Refreshes SDIO's driver index and lists available driver updates. The refresh
 * download is part of the check. Returns no items (no error) when SDIO finds
 * nothing to update.
 */
export async function checkSdi(): Promise<CheckResult> {
  const exe = sdioExe()
  if (!exe) return { source: 'sdi', items: [], error: 'SDIO not found in resources' }

  const dataDir = join(app.getPath('userData'), 'sdio')
  mkdirSync(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'check.txt'), SCRIPT, 'utf8')

  const { code, out } = await run(exe, ['-nogui', '-lang:en', '-script:check.txt'], dataDir)

  // SDIO prints "<N> drivers selected"; <N> == 0 on an up-to-date (or unpopulated
  // index) machine. When >0 we parse the selected entries from its output.
  const selected = Number(/(\d+)\s+drivers?\s+selected/i.exec(out)?.[1] ?? '0')
  if (selected === 0) {
    // Distinguish "all current" from "SDIO couldn't run".
    if (!/Indexes downloaded successfully/i.test(out) && code !== 0) {
      return { source: 'sdi', items: [], error: 'SDIO index refresh failed' }
    }
    return { source: 'sdi', items: [] }
  }

  const items = parseSelectedDrivers(out)
  if (items.length === 0) {
    // We know N>0 but couldn't enumerate them — surface the count rather than
    // silently dropping it (format still to be confirmed on a machine with gaps).
    return {
      source: 'sdi',
      items: [],
      error: `${selected} driver update(s) found via SDI (per-driver listing not yet available).`
    }
  }
  return { source: 'sdi', items }
}

/**
 * Parses selected-driver entries from SDIO's verbose log. SDIO writes one line
 * per selected driver after the "<N> drivers selected" summary; the device's
 * hardware id and the offered driverpack version are the stable, locale-safe
 * fields. Kept tolerant — refine against real output once a machine has gaps.
 */
function parseSelectedDrivers(log: string): UpdateItem[] {
  const items: UpdateItem[] = []
  const seen = new Set<string>()
  for (const line of log.split(/\r?\n/)) {
    // Heuristic: lines naming a driverpack (...\<name>.7z) with a version token.
    const m = /([A-Za-z0-9 .,_+()-]+?)\s+([0-9]+(?:\.[0-9]+){1,3})\b.*\.7z/i.exec(line)
    if (!m) continue
    const name = m[1].trim()
    const available = m[2]
    const id = `${name}@${available}`.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    items.push({ source: 'sdi', id, name, current: '—', available })
  }
  return items
}

interface SdioRun {
  code: number | null
  out: string
}

function run(file: string, args: string[], cwd: string): Promise<SdioRun> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        cwd,
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
        // SDIO's manifest is `highestAvailable`, so on an admin account
        // CreateProcess (Node spawn) fails with EACCES demanding elevation. Force
        // run-as-invoker so it runs unelevated with no UAC — refreshing the index
        // needs no admin (installing drivers, later, will go via the elevated batch).
        env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' }
      },
      (error, stdout) => {
        const out = stdout || ''
        if (!error) return resolve({ code: 0, out })
        const code = (error as { code?: number }).code
        resolve({ code: typeof code === 'number' ? code : null, out })
      }
    )
  })
}
