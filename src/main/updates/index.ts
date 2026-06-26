import { checkAllApt, listDistros } from './apt'
import { checkHp, isHpMachine } from './hp'
import { checkSdi } from './sdi'
import type { CheckResult, UpdateItem } from './types'
import { checkWinget } from './winget'
import { checkWindowsUpdate } from './wu'

export type { CheckProgress, CheckResult, Source, UpdateItem } from './types'
export { itemKey } from './types'
export { listDistros }

export interface CheckSummary {
  items: UpdateItem[]
  results: CheckResult[]
  errors: { source: string; distro?: string; error: string }[]
}

/** Group key for a result, matching the renderer's grouping (apt is per-distro). */
export function resultKey(r: CheckResult): string {
  return r.source === 'apt' && r.distro ? `apt:${r.distro}` : r.source
}

export interface CheckHandlers {
  /** Group keys about to be scanned, so the UI can show pending placeholders. */
  onStart?: (keys: string[]) => void
  /** Fired as each source completes, so fast sources render before slow ones. */
  onResult?: (result: CheckResult) => void
}

/**
 * Runs winget + HP (HP machines only) + every WSL distro's apt check concurrently.
 * When `handlers` are given, results are streamed as they complete (HP/HPIA is far
 * slower than winget/apt), letting the UI render the fast sources immediately.
 */
export async function checkAll(handlers?: CheckHandlers): Promise<CheckSummary> {
  const results: CheckResult[] = []
  const collect = (r: CheckResult): void => {
    results.push(r)
    handlers?.onResult?.(r)
  }

  // HP updates apply only to genuine HP hardware. On any other machine the source
  // isn't applicable, so skip it entirely — otherwise checkHp() returns an empty
  // result the UI renders as a spurious "HP · drivers & firmware — up to date"
  // row on non-HP PCs. isHpMachine() is cached and reused by checkHp below.
  const hp = await isHpMachine()

  if (handlers?.onStart) {
    // Enumerate the slow/optional sources up front so the UI knows what to wait
    // for. listDistros is cheap.
    const distros = await listDistros()
    handlers.onStart([
      'winget',
      'wu',
      ...(hp ? ['hp'] : []),
      'sdi',
      ...distros.map((d) => `apt:${d}`)
    ])
  }

  await Promise.all([
    checkWinget().then(collect),
    checkWindowsUpdate().then(collect),
    ...(hp ? [checkHp().then(collect)] : []),
    checkSdi().then(collect),
    checkAllApt().then((rs) => {
      for (const r of rs) collect(r)
    })
  ])

  const items = results.flatMap((r) => r.items)
  const errors = results
    .filter((r): r is CheckResult & { error: string } => Boolean(r.error))
    .map((r) => ({ source: r.source, distro: r.distro, error: r.error }))
  return { items, results, errors }
}
