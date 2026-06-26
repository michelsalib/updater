# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Windows-only Electron app that checks for **winget** and **WSL apt** updates on a weekly Task Scheduler trigger, notifies when updates exist, and offers a UI to select and run them with live progress streaming.

## Commands

```bash
npm run dev              # electron-vite dev (HMR for main/preload/renderer)
npm run typecheck        # tsc --noEmit for both projects (node + web)
npm run check            # biome check --write (lint + format)
npm run build:icons      # regenerate build/icon.{png,ico} + resources/icon.png from build/icon.svg
npm run fetch:resources  # download HPIA + SDIO vendor tools into resources/ (idempotent; --force to re-fetch)
npm run build            # prebuild (fetch:resources) → typecheck → electron-vite build
npm run build:win        # build → electron-builder --win (NSIS installer)
```

No tests. `build` aborts on typecheck failure. Biome (not ESLint/Prettier) — single quotes, no semicolons, no trailing commas, 100-col, 2-space; see [biome.json](biome.json). TS root is references-only; edit [tsconfig.node.json](tsconfig.node.json) (main + preload) or [tsconfig.web.json](tsconfig.web.json) (renderer).

## Two launch modes

Detected from `process.argv` in [src/main/index.ts](src/main/index.ts):

- **`--check`** — headless background scan launched by Task Scheduler. Scans, shows a native `Notification` if updates exist (click → opens the UI), exits silently when clean. A 60s safety-net timeout prevents lingering in a non-interactive session.
- **(default)** — opens the `BrowserWindow` UI.

## Architecture

Three processes communicating only via the IPC bridge in [src/preload/index.ts](src/preload/index.ts):

- **main** ([src/main/index.ts](src/main/index.ts)) — lifecycle, mode dispatch, notifications, auto-updater wiring.
- **preload** — exposes every IPC channel as `window.api.<method>` (typed by [src/preload/index.d.ts](src/preload/index.d.ts)).
- **renderer** ([src/renderer/](src/renderer/)) — framework-free TS + Web Awesome web components + Tailwind v4. No React/router/store.

### IPC

Channel-name constants are **duplicated** in [src/main/ipc.ts](src/main/ipc.ts) and [src/preload/index.ts](src/preload/index.ts) — keep the two `IPC` objects in sync when adding a channel. `ipc.ts` keeps the last scan in a module-level `cached` so a window opened from a notification renders without re-scanning.

### Shared types

[src/main/updates/types.ts](src/main/updates/types.ts) is **node-free** (no `node:` imports) so the renderer can consume it. `tsconfig.web.json` explicitly includes it plus `src/preload/index.d.ts`; the renderer imports types from `../../preload/index.d`. Keep `types.ts` free of runtime/node dependencies or the renderer build breaks.

## Locale independence (critical)

This runs on machines with non-English Windows display languages (e.g. French). **Never parse CLI output by matching English labels.** Parse by structure instead:

- **winget** ([src/main/updates/winget.ts](src/main/updates/winget.ts)) — `winget upgrade` has no machine-readable output ([issue #2603](https://github.com/microsoft/winget-cli/issues/2603)). Parse the fixed-width text table by anchoring on the all-dashes separator line and deriving column **offsets** from the header's whitespace layout. Column order (Name, Id, Version, Available, Source) is stable across locales; the labels are not. ANSI escapes + carriage-return spinner redraws are stripped first.
- **scheduler** ([src/main/scheduler.ts](src/main/scheduler.ts)) — uses the PowerShell `ScheduledTasks` cmdlets (stable property names, emit JSON, parse) rather than `schtasks.exe` text output, whose field labels are translated.

## Update checkers

`checkAll()` ([src/main/updates/index.ts](src/main/updates/index.ts)) runs winget + every WSL distro's apt check concurrently and merges into a `CheckSummary` (items + per-source results + non-fatal errors).

- **apt** ([src/main/updates/apt.ts](src/main/updates/apt.ts)) — `wsl -l -q` enumerates distros; each runs `apt list --upgradable` (read-only cached state — **no `apt update`**, that needs root; tradeoff is freshness). `wsl.exe` writes some listings as UTF-16LE which `execFile` decodes as UTF-8 with interleaved NULs — `decodeWsl()` strips them.

## Running updates ([src/main/updates/run.ts](src/main/updates/run.ts))

Privilege models differ:

- **winget** = Windows UAC. Elevate **once** for the whole batch: an unelevated launcher calls `Start-Process -Verb RunAs -Wait`, one UAC prompt blocks until the elevated worker exits. The worker can't share stdout across the elevation boundary, so it writes a transcript log we **tail** (`tailLog`, 400ms poll) and forward line-by-line. Declined UAC is detected from the launcher's stderr.
- **apt** = run inside WSL as **`-u root`** (no sudo password — the Windows user owns the distro), streaming stdout/stderr directly. `apt-get update` runs first so a stale index doesn't block the install.

Package ids are validated against `WINGET_ID` / `APT_NAME` regexes before interpolation to prevent shell/script injection. Progress is emitted as `RunEvent`s (`group-start`/`log`/`group-done`/`done`/`error`) and forwarded over the `updates:progress` channel.

## Scheduler ([src/main/scheduler.ts](src/main/scheduler.ts))

`hook()` registers a weekly task launching the app with `--check` via `Register-ScheduledTask`. **No `-WakeToRun` and no SYSTEM principal** → the task runs only in the current user's interactive context, which Windows lets us register **without elevation (no UAC)**. `-StartWhenAvailable` catches runs missed while logged off. `unhook()` is idempotent. Task name: `WeeklyUpdateCheck`.

## UI (Web Awesome + Tailwind v4)

[src/renderer/ui/main.ts](src/renderer/ui/main.ts) renders the list, checkboxes, scheduler switch, and live run log; [app.css](src/renderer/ui/app.css) is `@import "tailwindcss"` + small overrides.

- Import **only** `@awesome.me/webawesome/dist/styles/themes/default.css` (the `--wa-*` tokens) — **NOT** `webawesome.css`. The latter bundles `native.css`, which restyles raw `<h1>/<p>` in a cascade layer that overrides Tailwind utilities.
- WA component scripts are imported individually from `dist/components/<name>/<name>.js` to keep the bundle lean. WA components are web components (Shadow DOM): Tailwind classes style light-DOM layout; theme tokens / `::part()` style internals.
- `<html class="wa-dark wa-theme-default">` enables the dark theme.
- `<wa-icon>` is avoided (needs a network/asset base path) — emoji/Unicode used instead, so the app stays fully **offline**. The renderer CSP in [index.html](src/renderer/index.html) is locked to `'self'`.

## Bundled vendor tools (`resources/`)

`resources/` is **git-ignored** — it holds large third-party binaries that are fetched, not committed: HP Image Assistant (`resources/hpia/`) and Snappy Driver Installer Origin (`resources/sdio/`), plus the generated `icon.png`. [scripts/fetch-resources.mjs](scripts/fetch-resources.mjs) downloads + extracts the two tools (pinned versions/URLs at the top of the file) into `resources/`; it's wired as the `prebuild` npm hook, so `npm run build` (and thus `build:win`) self-populate. Idempotent (skips a tool whose marker file exists; `--force` re-downloads), Windows-only, no new npm deps (HPIA self-extracts via its `.exe`; SDIO unzips via `Expand-Archive`). electron-builder then ships `hpia`/`sdio` as `extraResources` (outside the asar, so the exes stay runnable). To upgrade a tool, bump its entry in the script. Run `npm run fetch:resources` once after a fresh clone to populate them for `dev`.

## Auto-update & packaging

electron-updater (GitHub provider, [dev-app-update.yml](dev-app-update.yml)) + electron-log. On `update-downloaded` the main process signals the renderer (`updater:ready`), which shows a "Restart to update" button → `quitAndInstall()`. Packaged via electron-builder NSIS ([electron-builder.yml](electron-builder.yml)); `appId` `fr.matchem.weeklyupdatechecker` (also set as the AppUserModelId so notifications attribute correctly).

## Icons

[build/icon.svg](build/icon.svg) is the source of truth. `npm run build:icons` ([scripts/build-icons.mjs](scripts/build-icons.mjs)) rasterizes it via `sharp` (density 384) and emits `build/icon.png`, `resources/icon.png`, and a multi-size `build/icon.ico` (via `icon-gen`). The window icon is imported with `?asset` ([src/main/env.d.ts](src/main/env.d.ts) references `electron-vite/node` for that type); electron-builder auto-picks `build/icon.ico` for the installer/exe. Re-run `build:icons` after editing the SVG.
