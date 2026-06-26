import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { CheckResult, UpdateItem } from './types'

// HP Image Assistant: HP's official, scriptable equivalent of the HP Support
// Assistant "Updates" tile. HPSA itself is a sandboxed UWP app with no CLI, and
// the update list it caches on disk is encrypted — so HPIA is the only supported
// way to enumerate the same driver/firmware/BIOS SoftPaqs. HPIA queries the same
// SoftPaq catalog (keyed off the machine's product id), produces a structured
// XML report (locale-independent — only its <Comments> are translated, which we
// ignore), and runs the Analyze pass without elevation.
//
// HPIA is bundled in resources/hpia (a full .NET app — the exe needs its sibling
// DLLs) and shipped via electron-builder `extraResources`, so it lands outside
// the asar where it can actually be executed.

/** HP SoftPaq id, e.g. `sp153464`. */
const SOFTPAQ_ID = /^sp\d+$/i

interface ExecOut {
  error: (Error & { code?: string | number | null }) | null
  stdout: string
  stderr: string
}

function exec(file: string, args: string[], timeout = 180_000): Promise<ExecOut> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    )
  })
}

// --- HP machine gate --------------------------------------------------------

let hpMachine: boolean | undefined

/**
 * True only on genuine HP hardware. The system manufacturer is a brand string
 * ("HP" / "Hewlett-Packard") that Windows does not localize, so matching it is
 * locale-safe. Cached for the process lifetime.
 */
export async function isHpMachine(): Promise<boolean> {
  if (hpMachine !== undefined) return hpMachine
  const { error, stdout } = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_ComputerSystem).Manufacturer'
    ],
    20_000
  )
  const mfr = (error ? '' : stdout).trim().toLowerCase()
  hpMachine = mfr === 'hp' || mfr.startsWith('hewlett')
  return hpMachine
}

// --- HPIA location ----------------------------------------------------------

/**
 * Path to the bundled HPImageAssistant.exe. In a packaged build it sits under
 * `process.resourcesPath/hpia` (shipped via electron-builder `extraResources`);
 * in dev it resolves to the project's `resources/hpia`. Throws if missing.
 */
function hpiaPath(): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'hpia')
    : join(app.getAppPath(), 'resources', 'hpia')
  const exe = join(base, 'HPImageAssistant.exe')
  if (!existsSync(exe)) {
    throw new Error(`HP Image Assistant not found at ${exe}`)
  }
  return exe
}

// --- Analyze + parse --------------------------------------------------------

/** How long to wait for the detached HPIA worker to write its report. */
const ANALYZE_TIMEOUT_MS = 240_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs HPIA's read-only Analyze pass and returns the recommended SoftPaqs.
 *
 * HPImageAssistant.exe is only a launcher: it spawns detached worker processes
 * (IPC) and exits within ~2s with a meaningless exit code, while the worker
 * downloads HP's catalog and writes the report up to ~60s later. So we must NOT
 * treat the launched process exiting as completion — we poll the report folder
 * until the XML is present AND fully written (closing `</HPIA>`), or we time out.
 */
export async function checkHp(): Promise<CheckResult> {
  if (!(await isHpMachine())) return { source: 'hp', items: [] }

  let hpia: string
  try {
    hpia = hpiaPath()
  } catch (e) {
    return { source: 'hp', items: [], error: (e as Error).message }
  }

  const report = mkdtempSync(join(tmpdir(), 'wuc-hpia-report-'))
  const downloads = mkdtempSync(join(tmpdir(), 'wuc-hpia-dl-'))

  // Launch and detach — the worker outlives this process handle, so polling the
  // report file (below) is the real completion signal.
  const child = spawn(
    hpia,
    [
      '/Operation:Analyze',
      '/Category:All',
      '/Selection:All',
      '/Action:List',
      '/Silent',
      `/ReportFolder:${report}`,
      `/SoftpaqDownloadFolder:${downloads}`
    ],
    { windowsHide: true, detached: true, stdio: 'ignore' }
  )
  let launchError: string | undefined
  child.on('error', (e) => {
    launchError = e.message
  })
  child.unref()

  const deadline = Date.now() + ANALYZE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(1500)
    if (launchError) {
      return {
        source: 'hp',
        items: [],
        error: `Could not launch HP Image Assistant: ${launchError}`
      }
    }
    const xml = findReportXml(report)
    if (!xml) continue
    const content = readFileSync(xml, 'utf8')
    // The worker writes the file incrementally; wait for the closing tag.
    if (!content.includes('</HPIA>')) continue
    try {
      return { source: 'hp', items: parseHpiaReport(content) }
    } catch (e) {
      return {
        source: 'hp',
        items: [],
        error: `Failed to parse HPIA report: ${(e as Error).message}`
      }
    }
  }

  return {
    source: 'hp',
    items: [],
    error: 'HP Image Assistant produced no report in time (no network access to HP catalog?)'
  }
}

/** HPIA names the report `<ProductName>.xml`; there is exactly one per run. */
function findReportXml(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const name = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.xml'))
  return name ? join(dir, name) : undefined
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? unescapeXml(m[1].trim()) : ''
}

/**
 * Extracts the recommended SoftPaqs from an HPIA Analyze report. Each
 * `<Recommendation>` (under `<Drivers>`/`<Software>`/`<Firmware>`) carries the
 * installed `<TargetVersion>`, the available `<ReferenceVersion>`, and a
 * `<Solution><Softpaq>` with the SoftPaq id, name, and download url. All of
 * these are locale-stable; we never read the translated `<Comments>`.
 */
export function parseHpiaReport(xml: string): UpdateItem[] {
  const items: UpdateItem[] = []
  for (const m of xml.matchAll(/<Recommendation>([\s\S]*?)<\/Recommendation>/gi)) {
    const block = m[1]
    const id = tag(block, 'Id').toLowerCase()
    if (!SOFTPAQ_ID.test(id)) continue

    const component = tag(block, 'TargetComponent')
    const softpaqName = tag(block, 'Name')
    const current = tag(block, 'TargetVersion')
    const available = tag(block, 'ReferenceVersion') || tag(block, 'Version')
    const url = tag(block, 'Url')
    if (!available) continue

    items.push({
      source: 'hp',
      id,
      name: component || softpaqName || id,
      current: current || '—',
      available,
      url: url || undefined
    })
  }
  return items
}
