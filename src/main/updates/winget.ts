import { execFile } from 'node:child_process'
import type { CheckResult, UpdateItem } from './types'

const WINGET_ARGS = [
  'upgrade',
  '--include-unknown',
  '--disable-interactivity',
  '--accept-source-agreements'
]

/**
 * winget has no machine-readable output for `upgrade`
 * (https://github.com/microsoft/winget-cli/issues/2603), so we parse the
 * fixed-width text table. Columns are aligned by character position, which is
 * more robust than splitting on whitespace (package names contain spaces).
 */
export function checkWinget(): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile(
      'winget',
      WINGET_ARGS,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // winget exits non-zero in some no-update / source states; rely on parse
        // output rather than the exit code, but surface a hard failure if we got
        // nothing usable back.
        const raw = stdout || ''
        if (!raw.trim()) {
          resolve({
            source: 'winget',
            items: [],
            error: error ? describeError(error, stderr) : undefined
          })
          return
        }
        try {
          resolve({ source: 'winget', items: parseWingetTable(raw) })
        } catch (e) {
          resolve({
            source: 'winget',
            items: [],
            error: `Failed to parse winget output: ${(e as Error).message}`
          })
        }
      }
    )
  })
}

function describeError(error: Error & { code?: string | number | null }, stderr: string): string {
  if (error.code === 'ENOENT') return 'winget not found on PATH'
  return stderr.trim() || error.message
}

/** Strip ANSI escape sequences and the spinner/progress carriage-return noise. */
function clean(raw: string): string[] {
  // Carriage returns redraw the spinner; keep the final non-empty segment of
  // each line. Taking the last segment naively would yield '' on CRLF input
  // (the trailing '\r' leaves an empty segment after the split).
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => {
      const segments = line.split('\r')
      const last = segments[segments.length - 1]
      if (last === '' && segments.length > 1) return segments[segments.length - 2]
      return last
    })
}

export function parseWingetTable(raw: string): UpdateItem[] {
  const lines = clean(raw)

  // winget localizes the column labels (e.g. "Nom / ID / Version / Disponible /
  // Source" in French), so we must NOT match on header text. Instead anchor on
  // the all-dashes separator line that always sits directly under the header,
  // and derive column start offsets from the header's whitespace layout. The
  // column ORDER is stable across locales: Name, Id, Version, Available, Source.
  const sepIdx = lines.findIndex((l) => isSeparator(l))
  if (sepIdx < 1) return []

  const header = lines[sepIdx - 1]
  const starts = columnStarts(header)
  if (starts.length < 4) return [] // need at least name/id/version/available
  const [cName, cId, cVersion, cAvailable] = starts
  const cSource = starts[4] // may be undefined

  const items: UpdateItem[] = []
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) break // blank line ends the table
    if (isSeparator(line)) continue
    // Trailing summary line, e.g. "12 upgrades available" / "12 mises à niveau".
    // It does not align to the columns, so detect it by lack of a usable id.
    if (line.length < cId) continue

    const name = line.slice(cName, cId).trim()
    const id = line.slice(cId, cVersion).trim()
    const current = line.slice(cVersion, cAvailable).trim()
    const available = line.slice(cAvailable, cSource ?? undefined).trim()

    // A real row has an id token with no internal spaces and a version-ish
    // available column. This filters footer/summary lines that survive.
    if (!id || /\s/.test(id) || !available) continue
    items.push({ source: 'winget', id, name: name || id, current, available })
  }
  return items
}

/** A separator line is all dashes (with optional surrounding space). */
function isSeparator(line: string): boolean {
  const t = line.trim()
  return t.length >= 5 && /^-+$/.test(t)
}

/**
 * Column start offsets, derived from runs of 2+ spaces in the header. winget
 * pads each column to its content width, so these offsets line up with the data
 * rows regardless of the (localized) label text.
 */
function columnStarts(header: string): number[] {
  const starts = header.length > 0 && header[0] !== ' ' ? [0] : []
  const re = / {2,}(?=\S)/g
  for (const m of header.matchAll(re)) {
    starts.push(m.index + m[0].length)
  }
  return starts
}
