import './app.css'
// Only Web Awesome's theme tokens (the --wa-* variables the components consume).
// We intentionally skip webawesome.css — its bundled native.css restyles raw
// <h1>/<p> in a cascade layer that would override our Tailwind utilities.
import '@awesome.me/webawesome/dist/styles/themes/default.css'
// Only the components we use (keeps the bundle lean).
import '@awesome.me/webawesome/dist/components/badge/badge.js'
import '@awesome.me/webawesome/dist/components/button/button.js'
import '@awesome.me/webawesome/dist/components/callout/callout.js'
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js'
import '@awesome.me/webawesome/dist/components/spinner/spinner.js'
import '@awesome.me/webawesome/dist/components/switch/switch.js'

import type {
  CheckProgress,
  CheckSummary,
  RunEvent,
  TaskInfo,
  UpdateItem,
  UpdaterApi
} from '../../preload/index.d'

const api: UpdaterApi = window.api

// --- tiny DOM helpers -------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | string,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return el
}

function itemKey(i: UpdateItem): string {
  return i.distro ? `${i.source}:${i.distro}:${i.id}` : `${i.source}:${i.id}`
}

function groupKey(i: UpdateItem): string {
  if (i.source === 'apt' && i.distro) return `apt:${i.distro}`
  return i.source
}

function groupLabel(i: UpdateItem): string {
  if (i.source === 'apt') return `WSL · ${i.distro}`
  if (i.source === 'hp') return 'HP · drivers & firmware'
  if (i.source === 'wu') return 'Windows Update'
  if (i.source === 'sdi') return 'Drivers (SDI)'
  return 'Windows · winget'
}

// Same mappings, keyed by group key (for pending placeholders, where there is no
// item yet). Keep in sync with groupKey/groupLabel above.
function keyLabel(key: string): string {
  if (key.startsWith('apt:')) return `WSL · ${key.slice(4)}`
  if (key === 'hp') return 'HP · drivers & firmware'
  if (key === 'wu') return 'Windows Update'
  if (key === 'sdi') return 'Drivers (SDI)'
  return 'Windows · winget'
}

function keySourceKind(key: string): string {
  if (key.startsWith('apt')) return 'apt'
  if (key === 'hp') return 'hp'
  if (key === 'wu') return 'wu'
  if (key === 'sdi') return 'sdi'
  return 'winget'
}

function resultGroupKey(r: { source: string; distro?: string }): string {
  return r.source === 'apt' && r.distro ? `apt:${r.distro}` : r.source
}

// --- state ------------------------------------------------------------------

let items: UpdateItem[] = []
const checked = new Set<string>()
// Group keys the user has collapsed (header click toggles the body).
const collapsed = new Set<string>()
// Per-item checkbox elements, so select-all can mutate them in place (no rebuild).
const itemCheckboxes = new Map<string, WaCheckable>()
// Group keys still being scanned (shown as "scanning…" placeholders), and whether
// a streaming scan is currently in flight.
let pendingKeys: string[] = []
let streaming = false
// Group keys that were checked but have no updates (shown as muted "up to date"
// rows so every source stays visible alongside ones that do have updates).
let emptyKeys: string[] = []

const el = {
  rescan: $<HTMLElement>('rescan'),
  updateReady: $<HTMLElement>('update-ready'),
  loading: $<HTMLDivElement>('loading'),
  listWrap: $<HTMLDivElement>('list-wrap'),
  empty: $<HTMLDivElement>('empty'),
  groups: $<HTMLDivElement>('groups'),
  errors: $<HTMLDivElement>('errors'),
  summary: $<HTMLSpanElement>('summary'),
  checkAll: $<HTMLElement>('check-all'),
  run: $<HTMLElement>('run'),
  back: $<HTMLElement>('back'),
  footerMsg: $<HTMLDivElement>('footer-msg'),
  progress: $<HTMLDivElement>('progress'),
  content: $<HTMLDivElement>('content'),
  schedSwitch: $<HTMLElement>('sched-switch'),
  schedStatus: $<HTMLDivElement>('sched-status'),
  schedDetail: $<HTMLDivElement>('sched-detail'),
  subtitle: $<HTMLDivElement>('subtitle')
}

// WA components expose `checked`/`indeterminate`/`disabled` as properties.
type WaCheckable = HTMLElement & { checked: boolean; indeterminate: boolean; disabled: boolean }
type WaDisablable = HTMLElement & { disabled: boolean }

// --- updates list -----------------------------------------------------------

function selectedItems(): UpdateItem[] {
  return items.filter((i) => checked.has(itemKey(i)))
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c
  )
}

function renderList(): void {
  el.groups.innerHTML = ''
  itemCheckboxes.clear()

  // Only "all clear" once nothing is left to scan; otherwise we show placeholders.
  if (items.length === 0 && pendingKeys.length === 0) {
    el.loading.classList.add('hidden')
    el.listWrap.classList.add('hidden')
    el.empty.classList.remove('hidden')
    el.empty.classList.add('flex')
    el.summary.textContent = 'No updates'
    updateRunButton()
    return
  }

  el.loading.classList.add('hidden')
  el.empty.classList.add('hidden')
  el.empty.classList.remove('flex')
  el.listWrap.classList.remove('hidden')

  // Group by source/distro.
  const groups = new Map<string, UpdateItem[]>()
  for (const i of items) {
    const k = groupKey(i)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)?.push(i)
  }

  for (const [gk, gitems] of groups) {
    const sourceKind = keySourceKind(gk)
    const card = h('div', { class: 'glass overflow-hidden rounded-2xl rise' })

    const isCollapsed = collapsed.has(gk)
    const chevron = h(
      'span',
      {
        class: `select-none text-white/40 text-[10px] transition-transform ${
          isCollapsed ? '' : 'rotate-90'
        }`
      },
      ['▶']
    )
    const list = h('div', { class: 'divide-y divide-white/5 px-3' })
    const listWrap = h('div', { class: `collapsible ${isCollapsed ? 'collapsed' : ''}` }, [list])

    const header = h(
      'div',
      {
        class:
          'flex cursor-pointer select-none items-center gap-2.5 border-b border-white/5 px-3 py-2'
      },
      [
        chevron,
        h('span', { class: `src-dot ${sourceKind}` }),
        h('span', { class: 'text-[13px] font-semibold' }, [groupLabel(gitems[0])]),
        h('wa-badge', { variant: 'neutral', class: 'ml-auto' }, [String(gitems.length)])
      ]
    )
    header.addEventListener('click', () => {
      const nowCollapsed = !collapsed.has(gk)
      if (nowCollapsed) collapsed.add(gk)
      else collapsed.delete(gk)
      // Mutate in place — no rebuild, so no flicker of the WA components.
      listWrap.classList.toggle('collapsed', nowCollapsed)
      chevron.classList.toggle('rotate-90', !nowCollapsed)
    })
    card.append(header)

    for (const item of gitems) {
      const k = itemKey(item)
      const cb = h('wa-checkbox', {}) as WaCheckable
      cb.checked = checked.has(k)
      cb.addEventListener('change', () => {
        if (cb.checked) checked.add(k)
        else checked.delete(k)
        syncCheckAll()
        updateRunButton()
      })
      itemCheckboxes.set(k, cb)

      const info = h('div', { class: 'min-w-0 flex-1 leading-tight' }, [
        h('div', { class: 'truncate text-[13px] font-medium' }, [item.name]),
        h('div', { class: 'truncate text-[11px] text-white/40' }, [item.id])
      ])

      const versions = h('div', { class: 'shrink-0 text-right text-xs tabular-nums' })
      versions.innerHTML = `<span class="text-white/45">${escapeHtml(item.current || '—')}</span><span class="mx-1.5 text-white/30">→</span><span class="font-semibold text-emerald-300/90">${escapeHtml(item.available)}</span>`

      const row = h('label', { class: 'flex cursor-pointer items-center gap-3 py-1.5' }, [
        cb,
        info,
        versions
      ])
      list.append(row)
    }
    card.append(listWrap)
    el.groups.append(card)
  }

  // Placeholders for sources still scanning (e.g. HP/HPIA takes ~1 min).
  for (const key of pendingKeys) {
    el.groups.append(renderPendingCard(key))
  }

  // Checked-but-no-updates sources, so each stays visible (skip any that also have
  // items, which shouldn't happen, and any still pending).
  for (const key of emptyKeys) {
    if (pendingKeys.includes(key)) continue
    el.groups.append(renderUpToDateRow(key))
  }

  syncCheckAll()
  updateRunButton()
}

/** A "scanning…" placeholder card for a source whose result hasn't arrived yet. */
function renderPendingCard(key: string): HTMLElement {
  return h('div', { class: 'glass overflow-hidden rounded-2xl rise opacity-70' }, [
    h('div', { class: 'flex items-center gap-2.5 px-3 py-2' }, [
      h('span', { class: `src-dot ${keySourceKind(key)}` }),
      h('span', { class: 'text-[13px] font-semibold' }, [keyLabel(key)]),
      h('wa-spinner', { class: 'ml-auto', style: 'font-size: 0.9rem' }),
      h('span', { class: 'text-[11px] text-white/40' }, ['scanning…'])
    ])
  ])
}

/** A muted row for a source that was checked and has no updates. */
function renderUpToDateRow(key: string): HTMLElement {
  return h('div', { class: 'glass overflow-hidden rounded-2xl rise opacity-55' }, [
    h('div', { class: 'flex items-center gap-2.5 px-3 py-2' }, [
      h('span', { class: `src-dot ${keySourceKind(key)}` }),
      h('span', { class: 'text-[13px] font-medium' }, [keyLabel(key)]),
      h('span', { class: 'ml-auto text-[11px] text-emerald-300/80' }, ['up to date ✓'])
    ])
  ])
}

function syncCheckAll(): void {
  const total = items.length
  const sel = selectedItems().length
  const master = el.checkAll as WaCheckable
  master.checked = sel === total && total > 0
  master.indeterminate = sel > 0 && sel < total
  el.summary.textContent = `${sel} of ${total} update${total === 1 ? '' : 's'} selected`
}

function updateRunButton(): void {
  const n = selectedItems().length
  ;(el.run as WaDisablable).disabled = n === 0
  el.run.textContent = n > 0 ? `Run ${n} update${n === 1 ? '' : 's'}` : 'Run selected'
}

function renderErrors(summary: CheckSummary | null): void {
  el.errors.innerHTML = ''
  if (!summary || summary.errors.length === 0) return
  for (const e of summary.errors) {
    const where = e.distro ? `${e.source} (${e.distro})` : e.source
    const callout = h('wa-callout', { variant: 'warning', class: 'block rounded-xl text-sm' }, [
      h('strong', {}, [`${where}: `]),
      e.error
    ])
    el.errors.append(callout)
  }
}

function updateSubtitle(): void {
  const count = (s: string): number => items.filter((i) => i.source === s).length
  const parts = [`${count('winget')} winget`, `${count('wu')} Windows`]
  const hc = count('hp')
  if (hc > 0) parts.push(`${hc} HP`)
  const sc = count('sdi')
  if (sc > 0) parts.push(`${sc} SDI`)
  parts.push(`${count('apt')} apt`)
  el.subtitle.textContent = parts.join(' · ')
}

/** Merges streamed scan results so fast sources (winget, apt) render before HP. */
function handleCheckProgress(msg: CheckProgress): void {
  if (!streaming) return // ignore stray events outside an active scan
  if (msg.phase === 'start') {
    pendingKeys = [...msg.keys]
    items = []
    emptyKeys = []
    checked.clear()
    el.errors.innerHTML = ''
    el.loading.classList.add('hidden')
    el.empty.classList.add('hidden')
    el.listWrap.classList.remove('hidden')
    updateSubtitle()
    renderList()
    return
  }
  const r = msg.result
  const key = resultGroupKey(r)
  pendingKeys = pendingKeys.filter((k) => k !== key)
  for (const it of r.items) {
    items.push(it)
    checked.add(itemKey(it))
  }
  // Checked, no updates, no error → show it as "up to date" rather than vanish.
  if (r.items.length === 0 && !r.error && !emptyKeys.includes(key)) emptyKeys.push(key)
  updateSubtitle()
  renderList()
}

function applySummary(summary: CheckSummary | null): void {
  items = summary?.items ?? []
  pendingKeys = [] // scan complete — no more placeholders
  // Sources that were checked but found nothing (and didn't error) → "up to date".
  emptyKeys = (summary?.results ?? [])
    .filter((r) => r.items.length === 0 && !r.error)
    .map((r) => (r.source === 'apt' && r.distro ? `apt:${r.distro}` : r.source))
  checked.clear()
  for (const i of items) checked.add(itemKey(i)) // all checked by default

  updateSubtitle()
  renderErrors(summary)
  renderList()
}

async function rescan(): Promise<void> {
  ;(el.rescan as WaDisablable).disabled = true
  el.footerMsg.textContent = ''
  // Stream partial results in via handleCheckProgress while we await the summary.
  streaming = true
  pendingKeys = []
  emptyKeys = []
  items = []
  el.listWrap.classList.add('hidden')
  el.empty.classList.add('hidden')
  el.loading.classList.remove('hidden')
  try {
    applySummary(await api.check())
  } catch (e) {
    el.loading.classList.add('hidden')
    el.errors.innerHTML = ''
    el.errors.append(
      h('wa-callout', { variant: 'danger', class: 'block rounded-xl text-sm' }, [
        `Scan failed: ${(e as Error).message}`
      ])
    )
  } finally {
    streaming = false
    ;(el.rescan as WaDisablable).disabled = false
  }
}

// --- scheduler --------------------------------------------------------------

let schedBusy = false

function renderScheduler(info: TaskInfo): void {
  const sw = el.schedSwitch as WaCheckable
  sw.disabled = false
  sw.checked = info.hooked

  if (info.hooked) {
    el.schedStatus.textContent = 'Registered — runs every week.'
    const parts: string[] = []
    if (info.nextRun) parts.push(`Next ${info.nextRun}`)
    if (info.lastRun) parts.push(`Last ${info.lastRun}`)
    if (info.lastResult) parts.push(info.lastResult)
    el.schedDetail.textContent = parts.join('   ·   ')
  } else {
    el.schedStatus.textContent = 'Not registered. Toggle to run a weekly background check.'
    el.schedDetail.textContent = ''
  }
}

async function loadScheduler(): Promise<void> {
  try {
    renderScheduler(await api.schedulerInfo())
  } catch (e) {
    el.schedStatus.textContent = `Scheduler unavailable: ${(e as Error).message}`
    ;(el.schedSwitch as WaDisablable).disabled = true
  }
}

async function onSchedToggle(): Promise<void> {
  if (schedBusy) return
  schedBusy = true
  const sw = el.schedSwitch as WaCheckable
  const want = sw.checked
  sw.disabled = true
  el.schedStatus.textContent = want ? 'Registering…' : 'Removing…'
  try {
    const info = want ? await api.schedulerHook() : await api.schedulerUnhook()
    renderScheduler(info)
  } catch (e) {
    el.schedStatus.textContent = `Failed: ${(e as Error).message}`
    sw.checked = !want // revert
    sw.disabled = false
  } finally {
    schedBusy = false
  }
}

// --- run + progress ---------------------------------------------------------

interface Panel {
  root: HTMLElement
  icon: HTMLElement
  log: HTMLElement
}
const panels = new Map<string, Panel>()

function setView(running: boolean): void {
  el.content.classList.toggle('hidden', running)
  el.errors.classList.toggle('hidden', running)
  el.progress.classList.toggle('hidden', !running)
  el.back.classList.toggle('hidden', !running)
  ;(el.rescan as WaDisablable).disabled = running
}

function ensurePanel(group: string, label: string, count: number): Panel {
  const existing = panels.get(group)
  if (existing) return existing

  const icon = h('wa-spinner', { style: 'font-size: 1.05rem' })
  const logBox = h('pre', {
    class:
      'log mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/35 p-2.5 text-white/70'
  })
  const root = h('div', { class: 'glass rounded-2xl px-3 py-2.5 rise' }, [
    h('div', { class: 'flex items-center gap-2.5' }, [
      icon,
      h('span', { class: 'text-[13px] font-semibold' }, [label]),
      h('wa-badge', { variant: 'neutral', class: 'ml-auto' }, [`${count} pkg`])
    ]),
    logBox
  ])
  el.progress.append(root)
  const panel: Panel = { root, icon, log: logBox }
  panels.set(group, panel)
  return panel
}

function appendLog(panel: Panel, text: string): void {
  panel.log.append(`${text}\n`)
  panel.log.scrollTop = panel.log.scrollHeight
}

function swapIcon(panel: Panel, ok: boolean): void {
  const mark = h('span', {
    class: `grid h-[1.05rem] w-[1.05rem] place-items-center rounded-full text-[11px] font-bold ${
      ok ? 'bg-emerald-500/25 text-emerald-300' : 'bg-red-500/25 text-red-300'
    }`
  })
  mark.textContent = ok ? '✓' : '✗'
  panel.icon.replaceWith(mark)
  panel.icon = mark
}

function handleProgress(evt: RunEvent): void {
  switch (evt.kind) {
    case 'group-start':
      ensurePanel(evt.group, evt.label, evt.count)
      break
    case 'log': {
      const p = panels.get(evt.group)
      if (p) appendLog(p, evt.text)
      break
    }
    case 'group-done': {
      const p = panels.get(evt.group)
      if (p) swapIcon(p, evt.ok)
      break
    }
    case 'error':
      el.footerMsg.textContent = evt.message
      break
    case 'done': {
      ;(el.run as WaDisablable).disabled = false
      el.run.textContent = 'Run selected'
      const summary = h(
        'wa-callout',
        {
          variant: evt.ok ? 'success' : 'warning',
          class: 'block rounded-xl text-sm rise'
        },
        [
          evt.ok
            ? 'All selected updates finished.'
            : 'Finished with some failures — see logs above.'
        ]
      )
      el.progress.append(summary)
      el.footerMsg.textContent = evt.ok ? 'Done.' : 'Done with errors.'
      break
    }
  }
}

async function run(): Promise<void> {
  const sel = selectedItems()
  if (sel.length === 0) return

  panels.clear()
  el.progress.innerHTML = ''
  el.progress.append(
    h('div', { class: 'px-1 text-xs text-white/45' }, [
      'Windows updates (winget, Windows Update, HP) prompt once for administrator access for the whole run. WSL packages install without a prompt.'
    ])
  )
  setView(true)
  ;(el.run as WaDisablable).disabled = true
  el.run.textContent = 'Running…'
  el.footerMsg.textContent = 'Running updates…'

  try {
    await api.run(sel)
  } catch (e) {
    el.footerMsg.textContent = `Run failed: ${(e as Error).message}`
    ;(el.run as WaDisablable).disabled = false
    el.run.textContent = 'Run selected'
  }
}

// --- wire up ----------------------------------------------------------------

el.rescan.addEventListener('click', rescan)
el.run.addEventListener('click', run)
el.back.addEventListener('click', () => setView(false))
el.schedSwitch.addEventListener('change', onSchedToggle)
el.checkAll.addEventListener('change', () => {
  const master = el.checkAll as WaCheckable
  if (master.checked) for (const i of items) checked.add(itemKey(i))
  else checked.clear()
  // Mutate existing checkboxes in place — no rebuild, so no flicker.
  for (const [k, cb] of itemCheckboxes) cb.checked = checked.has(k)
  syncCheckAll()
  updateRunButton()
})

api.onCheckProgress(handleCheckProgress)
api.onProgress(handleProgress)
api.onUpdateReady(() => {
  el.updateReady.classList.remove('hidden')
})
el.updateReady.addEventListener('click', () => {
  void api.quitAndInstall()
})

async function init(): Promise<void> {
  await loadScheduler()
  const cached = await api.getCached()
  if (cached) applySummary(cached)
  else await rescan()
}

void init()
