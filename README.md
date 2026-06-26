<div align="center">

<img src="build/icon.svg" alt="Weekly Update Checker" width="128" height="128" />

# Weekly Update Checker

**One quiet weekly nudge when your Windows machine has updates waiting — then one click to install them all.**

Checks **winget**, **WSL apt**, **HP drivers**, **Windows Update**, and **third-party drivers** in a single pass, notifies you only when something's actually out of date, and runs the upgrades for you with live streaming progress.

<br />

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38BDF8?logo=tailwindcss&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-22d3ee)

</div>

---

## ✨ What it does

You shouldn't have to remember to run `winget upgrade`, `apt list --upgradable`, check HP's driver page, and open Windows Update every week. This app does all of that **once a week, in the background**, and gets out of your way unless there's something to do.

- 🔔 **Notify only when it matters.** A weekly headless scan runs via Task Scheduler. If updates exist, you get a native Windows notification — click it to open the UI. If everything's current, it exits silently. No tray clutter, no nagging.
- ☑️ **Pick and choose.** Open the UI to see every pending update grouped by source, tick the ones you want, and run the batch.
- 📡 **Watch it happen.** Installs stream their output line-by-line into a live log, so you see exactly what's running.
- 🌍 **Works on any Windows display language.** Output is parsed by *structure*, never by matching English words — so it behaves identically on a French, German, or Japanese install.
- 🔌 **Fully offline.** No network calls beyond the package managers themselves; the renderer's CSP is locked to `'self'`.
- 🔄 **Self-updating.** Ships new versions to itself via electron-updater + GitHub Releases.

## 📦 Update sources

A single **Check for updates** fans out across five sources concurrently and merges the results. Fast sources render immediately while slower ones (HP/drivers can take ~a minute) stream in behind them.

| Source | What it covers | How it's checked |
| --- | --- | --- |
| 🪟 **winget** | Windows desktop apps | Parses the `winget upgrade` text table by column **offsets** |
| 🐧 **WSL apt** | Packages in every WSL distro | `apt list --upgradable` per distro (read-only, no `apt update`) |
| 💻 **HP drivers** | OEM driver & firmware updates | HP Image Assistant (HPIA) XML report — *HP machines only* |
| 🛡️ **Windows Update** | OS & security updates | Windows Update COM API |
| 🔧 **Drivers (SDI)** | Generic third-party drivers | Snappy Driver Installer Origin (bundled), matched against installed hardware |

## 🚀 How it works

### Two launch modes

The mode is detected from `process.argv` ([src/main/index.ts](src/main/index.ts)):

- **`--check`** — the headless weekly scan launched by Task Scheduler. Scans, fires a notification if anything's pending, and exits silently when clean. A 60 s safety-net timeout keeps it from lingering in a non-interactive session.
- **(default)** — opens the `BrowserWindow` UI for picking and running updates.

### One UAC prompt, one batch

Privilege models differ per source, so the runner ([src/main/updates/run.ts](src/main/updates/run.ts)) handles each correctly:

- **winget / Windows Update / drivers** need Windows elevation. The app elevates **once** for the whole batch — a single UAC prompt covers everything. Since the elevated worker can't share stdout across the elevation boundary, it writes a transcript log that the parent **tails** and forwards line-by-line.
- **apt** runs inside WSL as `-u root` (no sudo password needed — you own the distro), streaming output directly. `apt-get update` runs first so a stale index can't block the install.

Package ids are validated against strict regexes before they're ever interpolated into a command — no shell or script injection.

### Locale independence

This is a hard rule, not a nice-to-have. The app runs on machines with non-English Windows display languages, so it **never** parses CLI output by matching English labels:

- **winget** has [no machine-readable output](https://github.com/microsoft/winget-cli/issues/2603), so its fixed-width table is parsed by anchoring on the all-dashes separator and deriving column offsets from the header layout. Column *order* is stable across locales; the *labels* are not.
- **Task Scheduler** is driven through PowerShell `ScheduledTasks` cmdlets (stable JSON property names) rather than `schtasks.exe`, whose field labels are translated.

### The weekly trigger

A weekly Task Scheduler task launches the app with `--check`. It's registered for the **current user's interactive context** — no `-WakeToRun`, no SYSTEM principal — which lets Windows register it **without elevation (no UAC)**. `-StartWhenAvailable` catches runs missed while you were logged off. Toggle it from the UI; unregistering is idempotent.

## 🏗️ Architecture

Three processes, talking only through a typed IPC bridge:

```
┌─────────────┐     IPC      ┌─────────────┐  window.api  ┌──────────────┐
│    main     │ ◀──────────▶ │   preload   │ ◀──────────▶ │   renderer   │
│ lifecycle,  │  ipcMain /   │ contextBridge│              │ framework-   │
│ scanning,   │  ipcRenderer │ exposes every│              │ free TS + Web│
│ running,    │              │ channel as   │              │ Awesome +    │
│ scheduler   │              │ window.api.* │              │ Tailwind v4  │
└─────────────┘              └─────────────┘              └──────────────┘
```

- **main** ([src/main/](src/main/)) — process lifecycle, mode dispatch, the update checkers/runner, scheduler, notifications, and auto-updater wiring.
- **preload** ([src/preload/index.ts](src/preload/index.ts)) — exposes each IPC channel as `window.api.<method>`, fully typed.
- **renderer** ([src/renderer/](src/renderer/)) — framework-free TypeScript with [Web Awesome](https://webawesome.com) web components and Tailwind v4. No React, no router, no store.

Shared types live in a deliberately **node-free** [src/main/updates/types.ts](src/main/updates/types.ts) so the renderer can import them without pulling in `node:` modules.

## 🛠️ Getting started

> **Prerequisites:** Windows 10/11, Node.js ≥ 20. WSL is optional (apt checks are skipped if absent).

```bash
npm install
npm run dev          # electron-vite dev server with HMR for all three processes
```

### Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot-reload (main / preload / renderer) |
| `npm run typecheck` | `tsc --noEmit` for both the node and web TS projects |
| `npm run check` | Biome lint + format (`--write`) |
| `npm run build` | Typecheck, then `electron-vite build` |
| `npm run build:win` | Build, then package an NSIS installer with electron-builder |
| `npm run build:icons` | Regenerate PNG/ICO icons from [build/icon.svg](build/icon.svg) |

> `build` aborts on any typecheck error. There are no tests.

### Code style

Formatting and linting are handled by **[Biome](https://biomejs.dev)** (not ESLint/Prettier): single quotes, no semicolons, no trailing commas, 100-column width, 2-space indent. See [biome.json](biome.json).

## 📦 Packaging & auto-update

Packaged as a per-user **NSIS installer** via electron-builder ([electron-builder.yml](electron-builder.yml)). Once installed, the app updates itself: electron-updater pulls releases from GitHub, and on `update-downloaded` the UI surfaces a **Restart to update** button that triggers `quitAndInstall()`.

## 🧰 Tech stack

<div align="center">

**Electron** · **TypeScript** · **electron-vite** · **Tailwind CSS v4** · **Web Awesome** · **Biome** · **electron-builder** · **electron-updater**

</div>

## 📄 License

[MIT](LICENSE) © m.salib
