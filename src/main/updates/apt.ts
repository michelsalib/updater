import { execFile } from 'node:child_process'
import type { CheckResult, UpdateItem } from './types'

interface ExecResult {
  error: (Error & { code?: string | number | null }) | null
  stdout: string
  stderr: string
}

function runWsl(args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      args,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    )
  })
}

/**
 * wsl.exe writes its own listings (e.g. `-l`) as UTF-16LE. execFile decodes as
 * UTF-8, which interleaves NUL chars between the ASCII bytes. Distro names and
 * apt package data are ASCII, so dropping the NULs recovers the text.
 */
function decodeWsl(stdout: string): string {
  if (stdout.indexOf('\x00') !== -1) {
    return stdout.replace(/\x00/g, '')
  }
  return stdout
}

/**
 * Enumerate installed WSL distributions. `-l -q` lists names only. Returns an
 * empty list (no error) when WSL is absent or has no distros.
 */
export async function listDistros(): Promise<string[]> {
  const { error, stdout } = await runWsl(['-l', '-q'])
  if (error) return []
  return decodeWsl(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * Lists upgradable packages from a single WSL distro, refreshing the index first
 * so the check is current. We run as `-u root` (no sudo password — the Windows
 * user owns the distro) to allow `apt-get update`; we use `;` not `&&` so a failed
 * refresh (e.g. offline) still lists from cached state. apt-get output is sent to
 * /dev/null so stdout is just the upgradable list (which `2>/dev/null` keeps clean
 * of apt's "do not use in scripts" warning).
 */
export async function checkApt(distro: string): Promise<CheckResult> {
  const { error, stdout, stderr } = await runWsl([
    '-d',
    distro,
    '-u',
    'root',
    '--',
    'bash',
    '-lc',
    'apt-get update >/dev/null 2>&1; apt list --upgradable 2>/dev/null'
  ])

  if (error && !stdout) {
    return { source: 'apt', distro, items: [], error: describeError(error, stderr) }
  }
  try {
    return { source: 'apt', distro, items: parseAptList(decodeWsl(stdout), distro) }
  } catch (e) {
    return {
      source: 'apt',
      distro,
      items: [],
      error: `Failed to parse apt output: ${(e as Error).message}`
    }
  }
}

/** Checks every installed distro concurrently and returns one result per distro. */
export async function checkAllApt(): Promise<CheckResult[]> {
  const distros = await listDistros()
  if (distros.length === 0) return []
  return Promise.all(distros.map((d) => checkApt(d)))
}

function describeError(error: Error & { code?: string | number | null }, stderr: string): string {
  if (error.code === 'ENOENT') return 'wsl.exe not found — is WSL installed?'
  const msg = (stderr || error.message).trim()
  if (/no installed distributions|no such distribution/i.test(msg)) {
    return 'No WSL distribution available'
  }
  return msg || error.message
}

export function parseAptList(stdout: string, distro?: string): UpdateItem[] {
  const items: UpdateItem[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('Listing')) continue
    // Format: pkg/repo,repo new-version arch [upgradable from: old-version]
    const m = line.match(/^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/)
    if (!m) continue
    const [, name, available, current] = m
    items.push({
      source: 'apt',
      id: name,
      name,
      current: current.trim(),
      available,
      distro
    })
  }
  return items
}
