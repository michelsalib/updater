import { execFile } from 'node:child_process'
import type { CheckResult, UpdateItem } from './types'

// Windows Update has no stable, machine-readable CLI (UsoClient/wuauclt are
// undocumented and their text is localized). The Windows Update Agent COM API
// is the supported programmatic interface: it returns objects (UpdateID GUID,
// Title, KB), so it's locale-independent — fitting the codebase rule. Searching
// is read-only and needs no elevation; only installing (see run.ts) does.
const SEARCH_PS = `
$ErrorActionPreference = 'Stop'
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $r = $searcher.Search("IsInstalled=0 and IsHidden=0")
  $out = @()
  foreach ($u in $r.Updates) {
    $kb = ($u.KBArticleIDs | Select-Object -First 1)
    $out += [pscustomobject]@{ id = $u.Identity.UpdateID; title = $u.Title; kb = "$kb" }
  }
  if ($out.Count -eq 0) { '[]' } else { ConvertTo-Json -Compress -Depth 3 @($out) }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`

interface WuRow {
  id: string
  title: string
  kb: string
}

/**
 * Lists pending Windows Updates via the Windows Update Agent COM API. The search
 * can take tens of seconds (it contacts Windows Update) and may be restricted by
 * policy/WSUS on managed machines — that surfaces as a non-fatal error.
 */
export function checkWindowsUpdate(): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SEARCH_PS],
      { windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout.trim()) {
          resolve({ source: 'wu', items: [], error: describeError(stderr, error) })
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim() || '[]')
          // ConvertTo-Json unwraps a single-element array into an object.
          const rows: WuRow[] = Array.isArray(parsed) ? parsed : [parsed]
          const items: UpdateItem[] = rows
            .filter((r) => r?.id)
            .map((r) => ({
              source: 'wu' as const,
              id: String(r.id),
              name: r.title || String(r.id),
              current: '—',
              available: r.kb ? `KB${r.kb}` : 'update'
            }))
          resolve({ source: 'wu', items })
        } catch (e) {
          resolve({
            source: 'wu',
            items: [],
            error: `Failed to parse Windows Update results: ${(e as Error).message}`
          })
        }
      }
    )
  })
}

function describeError(stderr: string, error: Error): string {
  const msg = (stderr || error.message || '').trim()
  if (/0x80072EE[27]|no connection|network|0x8024401C/i.test(msg)) {
    return 'Windows Update: could not reach the update service'
  }
  return msg || 'Windows Update search failed'
}
