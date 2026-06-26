import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Downloads the bundled vendor driver tools into resources/ so electron-builder can
// ship them via `extraResources`. resources/ is gitignored — these pinned definitions
// are the single source of truth for what gets packaged. Runs automatically before
// `npm run build` (the `prebuild` hook); also runnable on its own: `npm run fetch:resources`.
//
// Idempotent: a tool whose marker file already exists is skipped. Pass --force to
// re-download. Windows-only — HPIA ships as a self-extracting .exe and SDIO is unzipped
// with Expand-Archive, so on other platforms this no-ops (packaging is `--win` anyway).
//
// To upgrade a tool, bump its url + version marker (and SDIO's sha256) below.

const execFileP = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RES = join(ROOT, 'resources')
const FORCE = process.argv.includes('--force')

const HPIA = {
  label: 'HP Image Assistant 5.3.6',
  url: 'https://hpia.hpcloud.hp.com/downloads/hpia/hp-hpia-5.3.6.exe',
  dir: join(RES, 'hpia'),
  // The launcher exe; present iff the SoftPaq extracted its full payload.
  marker: 'HPImageAssistant.exe'
}

const SDIO = {
  label: 'Snappy Driver Installer Origin R830',
  url: 'https://www.glenn.delahoy.com/downloads/sdio/SDIO_1.18.0.830.zip',
  sha256: '7bb0cecaca9d69493a730763c980471a8eadd0c5bf9bf5b20df2d090e3692819',
  dir: join(RES, 'sdio'),
  // updates/sdi.ts matches /^SDIO_x64_R\d+\.exe$/i — keep this in sync with the version.
  marker: 'SDIO_x64_R830.exe'
}

if (process.platform !== 'win32') {
  console.warn(`fetch-resources: vendor tools are Windows-only — skipping on ${process.platform}`)
  process.exit(0)
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

/** Directory under `root` that directly contains `marker` — root itself or one level down. */
async function findMarkerDir(root, marker) {
  if (await exists(join(root, marker))) return root
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && (await exists(join(root, entry.name, marker)))) {
      return join(root, entry.name)
    }
  }
  return null
}

/** Polls for `marker` — the HP self-extractor can return before its payload is flushed. */
async function waitForMarkerDir(root, marker, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await findMarkerDir(root, marker)
    if (found) return found
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`timed out waiting for ${marker} (extraction failed?)`)
}

/** Replaces `tool.dir` with the freshly extracted tree rooted at `src`. */
async function install(tool, src) {
  await rm(tool.dir, { recursive: true, force: true })
  await cp(src, tool.dir, { recursive: true })
}

async function fetchHpia() {
  if (!FORCE && (await exists(join(HPIA.dir, HPIA.marker)))) {
    console.log(`✓ ${HPIA.label} already present`)
    return
  }
  console.log(`↓ ${HPIA.label}…`)
  const tmp = await mkdtemp(join(tmpdir(), 'wuc-hpia-'))
  try {
    const exe = join(tmp, 'hp-hpia.exe')
    await download(HPIA.url, exe)
    const out = join(tmp, 'out')
    await mkdir(out, { recursive: true })
    // HP SoftPaq self-extractor: /s silent, /e extract, /f <folder>. Its exit code is
    // unreliable, so ignore it and verify by polling for the launcher instead.
    await execFileP(exe, ['/s', '/e', '/f', out]).catch(() => {})
    await install(HPIA, await waitForMarkerDir(out, HPIA.marker))
    console.log(`✓ ${HPIA.label} → resources/hpia`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function fetchSdio() {
  if (!FORCE && (await exists(join(SDIO.dir, SDIO.marker)))) {
    console.log(`✓ ${SDIO.label} already present`)
    return
  }
  console.log(`↓ ${SDIO.label}…`)
  const tmp = await mkdtemp(join(tmpdir(), 'wuc-sdio-'))
  try {
    const zip = join(tmp, 'sdio.zip')
    await download(SDIO.url, zip)
    const got = await sha256(zip)
    if (got !== SDIO.sha256)
      throw new Error(`SDIO checksum mismatch:\n  want ${SDIO.sha256}\n  got  ${got}`)
    const out = join(tmp, 'out')
    await execFileP('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`
    ])
    const src = await findMarkerDir(out, SDIO.marker)
    if (!src) throw new Error(`zip did not contain ${SDIO.marker}`)
    await install(SDIO, src)
    // The app only ever launches the 64-bit build (updates/sdi.ts) — drop the x86 exe.
    for (const f of await readdir(SDIO.dir)) {
      if (/^SDIO_R\d+\.exe$/i.test(f)) await rm(join(SDIO.dir, f))
    }
    console.log(`✓ ${SDIO.label} → resources/sdio`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

await mkdir(RES, { recursive: true })
await fetchHpia()
await fetchSdio()
console.log('resources ready.')
