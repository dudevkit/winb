---
name: winb-execution
description: "Hybrid execution architecture for Ravi's Windows PC (SMB mount + winb CLI)."
version: 1.3.2
author: Hermes Agent
metadata:
  hermes:
    tags: [windows, execution, winb, hybrid, terminal]
---

# Winb Hybrid Execution Architecture

## Overview
This skill defines the standard operating procedure for developing, testing, and executing code on Ravi's Windows PC from the Linux gateway. It uses a hybrid approach: SMB/CIFS for fast file access and the custom `winb` CLI for remote execution.

## 1. File Access (The Storage Layer)
Always use the mounted SMB directory for reading, writing, and searching files.
- **Linux Path:** `/mnt/alice-workspace`
- **Windows Path:** `F:\AliceWorkspace`

Use native Hermes tools (`read_file`, `write_file`, `patch`, `search_files`) on the `/mnt/alice-workspace` path. Do NOT use `winb` for file manipulation unless it requires a specific Windows tool.

### CIFS is storage-only — not a Python runtime home
Do **not** create venvs, SQLite WAL DBs, or symlink-heavy installs directly under `/mnt/alice-workspace`. CIFS rejects venv `lib64` symlinks (`Operation not supported`) and SQLite `PRAGMA journal_mode=WAL` can fail with `database is locked` when the code/db path is on the mount — including when a local runtime only *symlinks* `app/` into SMB. Pattern: keep source on SMB for PC edit if desired; run **venv + SQLite data + real local copy of `app/`/`static/`** under `/mnt/usb-storage/workspace/<project>-runtime/`. After editing SMB source, re-copy/rsync into the local runtime before restart. See also `references/smb-mount-restore.md` and `cli-subscription-api-gateways` → `references/grok-cli-proxy.md`.

### SMB Mount Health Check
The intended SMB path can exist as a plain local directory after its CIFS mount drops. Before treating `/mnt/alice-workspace` as current Windows storage—or claiming a new Windows file is missing—verify it:

```bash
mountpoint -q /mnt/alice-workspace && findmnt -T /mnt/alice-workspace -o TARGET,SOURCE,FSTYPE,OPTIONS
```

- If it is a CIFS mount (`SOURCE=//192.168.1.100/AliceWorkspace`, `FSTYPE=cifs`), use native file tools directly; do not use WinB merely to inspect SMB files.
- If it is not mounted, stale local contents under `/mnt/alice-workspace` are **not** the current contents of `F:\AliceWorkspace`. State that the SMB mount is inactive. Also check `winb --health` and PC reachability separately — winb can be healthy while SMB is down.
- **Gateway-local apps when SMB is down:** if the work does not need Windows files or `winb` execution (e.g. light FastAPI URL-resolve services on the gateway), **do not block** the whole task on SMB remount — put source+venv under `/mnt/usb-storage/workspace/<project>/` and ship. Remount only when Ravi needs PC-side paths or Windows process control.
- A WinB listing of `F:\AliceWorkspace` (or `Get-SmbShare`) can confirm a Windows-side share/file but cannot refresh or repair the gateway mount.
- Do **not** attempt guest access or ask Ravi to paste Windows/SMB passwords into chat. Windows folder permission for `Everyone` does not by itself enable anonymous SMB login.
- If an artifact is urgently needed and remount is blocked, request a direct Telegram upload instead.

### SMB remount (approved route for this PC)
When Ravi asks to fix/remount SMB, restore via the known-good local config — do not invent new auth schemes.

**Known-good target (verified 2026-07-18):**
- Share: `//192.168.1.100/AliceWorkspace` → `/mnt/alice-workspace`
- Windows path: `F:\AliceWorkspace`
- Auth that works: `username=Ravi` + **blank password** (account already allows network logon without password)
- Options: `vers=3.0,uid=0,gid=0,iocharset=utf8,file_mode=0777,dir_mode=0777,nofail,_netdev`
- Credentials file: `/etc/cifs-credentials-alice-workspace` (mode `600`, contents `username=Ravi` + `password=`)
- fstab should contain a CIFS line using that credentials file so reboot remounts automatically

**Restore steps:**
1. Confirm PC/share alive: `ping -c1 192.168.1.100`, `winb --health`, and optionally `winb -p "Get-SmbShare"` (share name `AliceWorkspace`).
2. If `/mnt/alice-workspace` is a plain local dir with stale content (not a mountpoint), move it aside first:
   `mv /mnt/alice-workspace /mnt/alice-workspace.local-stale-$(date +%Y%m%d_%H%M%S) && mkdir -p /mnt/alice-workspace`
   Never mount over a non-empty local dir without relocating it — the mount would hide the stale tree and confuse later cleanup.
3. Ensure credentials file exists mode 600; create/update only with the known blank-password `Ravi` route unless Ravi explicitly changes Windows auth.
4. Mount:
   ```bash
   mount -t cifs //192.168.1.100/AliceWorkspace /mnt/alice-workspace \
     -o credentials=/etc/cifs-credentials-alice-workspace,uid=0,gid=0,iocharset=utf8,file_mode=0777,dir_mode=0777,vers=3.0,nofail,_netdev
   ```
5. Persist: add/replace the matching `/etc/fstab` CIFS line if missing.
6. Verify: `mountpoint -q /mnt/alice-workspace`, `findmnt` shows `cifs` to `//192.168.1.100/AliceWorkspace`, `ls` shows live Windows files, `df -h` reports the remote size.

**Auth probe order (only if known-good fails):** blank-password `Ravi` first → never guest (fails `Permission denied (13)` on this share) → do not thrash other local Windows users or ask for chat passwords. Report blocker after the known route fails.

Full recipe + pitfalls: `references/smb-mount-restore.md`.

## 2. Command Execution (The Execution Layer)
Use the `winb` CLI via the `terminal` tool to execute commands on the Windows PC.

### How Alice reaches the PC (auth map)
Do **not** assume password SSH is the only path. Verified routes for `192.168.1.100` / user `Ravi` — full notes in `references/pc-ssh-auth.md`:

| Layer | Auth | Notes |
|---|---|---|
| **SMB** → `/mnt/alice-workspace` | `Ravi` + **blank password** | Primary file access |
| **winb** `:5110` | HTTP bridge (tray) | Primary command execution; often **non-admin** |
| **SSH OpenSSH :22** | key `/root/.ssh/ravi-main-pc` | Works (`BatchMode=yes`); admin session |
| **SSH password** | works **after** password is set | Prefer set via key session (`Set-LocalUser`); blank account used to fail password SSH |

```bash
ssh -i /root/.ssh/ravi-main-pc -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 Ravi@192.168.1.100 "echo SSH_OK"
```

*Default execution for app work remains **winb**, not SSH.* Use SSH when the task needs OpenSSH (remote farm wizard, password set, elevated admin ops without UAC).

### Architecture & Internals
The server runs via a PowerShell tray app that supports Hot Module Replacement (HMR).
For development, server internals, and pitfalls (Express HMR router stack issues, PowerShell file locks, and zombie processes), read `references/winb-server-architecture.md`. For the latest hardening details from the 2026-07-02 build-out (HMR layout, verbose logging, logs/health flags, and tray hard-restart rules), read `references/session-2026-07-02-winb-hardening.md`. For inspecting Windows app DBs that may contain API keys/tokens without leaking secrets to chat, use `references/windows-secret-db-audit.md`. For EnowxAI backup/restore investigations, encrypted `.enowxbak` files, the legacy `imported 87` workflow, and recovering Ravi's own provider credentials via the local dashboard API, use `references/enowxai-account-backup-and-restore.md`. For CodeBuddy-CN account credential recovery from Ravi's running WSL EnowxAI service, including core-dump parsing, mapped credential export, active-key-only files, and cleanup, use `references/enowxai-codebuddy-cn-credential-recovery.md`. For adding Claude Code-style model tier mapping to Ravi's Windows 9router install, use the front-proxy pattern in `references/9router-model-mapping-proxy.md` rather than patching the minified Next standalone bundle. For inspecting the live Windows 9router install and its Grok CLI provider, OAuth token DB rows, upstream headers, and `winb` quoting pitfalls, use `references/9router-windows-grok-cli-investigation.md`.

### Path Translation
When specifying the working directory (`-w`), you MUST translate the Linux path to the corresponding Windows path.
- If editing file at: `/mnt/alice-workspace/my-app/index.js`
- The Windows workdir is: `-w "F:\AliceWorkspace\my-app"`

### `winb` Flags
- `-w, --workdir <dir>` : Set Windows working directory (absolute Windows path).
- `-b, --background` : Run in background (essential for dev servers/watchers).
- `-id, --process-id <id>` : Name the background process (pairs with `-b`).
- `-l, --list` : List background process records, including running/exited status, PID, and command.
- `--logs <id>` : Show captured stdout/stderr logs for a background process.
- `--tail <n>` : Limit `--logs` output to the last N lines (default 80, max 500).
- `--health` : Show winb-server status: version, HMR flag, PID, port, uptime, workdir, and process counts.
- `--open-url <url>` : Open an `http`/`https` URL in the Windows default browser (use after starting dev servers, e.g. localhost apps).
- `--port <port>` : Check whether a Windows TCP port is listening and show PID/process details.
- `-k, --kill <id>` : Kill a background process by ID.
- `-p, --powershell` : Use PowerShell instead of CMD.
- `-e, --env KEY=VALUE` : Add environment variable for the command; repeat for multiple variables. Keys must match `[A-Za-z_][A-Za-z0-9_]*`.
- `-t, --timeout <sec>` : Set timeout in seconds for foreground tasks.

### Examples

**Foreground Task (Install Dependencies)**
```bash
winb -w "F:\AliceWorkspace\my-app" "npm install"
```

**Background Task (Run Dev Server)**
```bash
winb -b -id app-dev -w "F:\AliceWorkspace\my-app" "npm run dev"
```

**Run With Environment Variables**
```bash
winb -e PORT=3001 -e NODE_ENV=development -w "F:\AliceWorkspace\my-app" "npm run dev"
```

**Health, List, Inspect Logs, and Kill Background Tasks**
```bash
winb --health
winb --open-url http://localhost:3000
winb --port 3000
winb -l
winb --logs app-dev --tail 50
winb -k app-dev
```

### Windows disk/storage investigations
Ravi is sensitive to PC slowdowns. For storage cleanup work:
- Start with lightweight checks (`Get-PSDrive C`, one-level directory sizes, Installed Apps/registry entries) before any recursive scan.
- Do **not** brute-force recurse all of `C:\Users\Ravi`, `AppData\Local`, or the whole C drive unless Ravi explicitly approves; these can enumerate hundreds of thousands of cache/node_modules files and feel stuck.
- If a scan may take >30s, explain the cost first and run a narrow target (specific folder or known cache) with a timeout.
- For software cleanup, prefer official uninstallers/Installed Apps over deleting `C:\Program Files` folders manually.
- If MSI uninstall returns `1603`, immediately check whether winb is elevated (`ADMIN=True/False`); non-admin winb cannot uninstall machine-wide MSI packages, so ask Ravi to run/elevate locally rather than retrying blindly.

### Installed Software on Windows PC
- **Camoufox**: Already installed at two paths (both v0.4.11, Camoufox v135.0.1-beta.24, verified 2026-07-06):
  1. `C:\Users\Ravi\AppData\Local\hermes\hermes-agent\venv\Scripts\camoufox.exe` (Hermes venv)
  2. `C:\Users\Ravi\miniconda3\Scripts\camoufox.exe` (Miniconda)
  - Do not suggest installing Camoufox — check with `Get-Command camoufox*` via winb first.

### autoclaw-autologin repo
Location: `F:\AliceWorkspace\autoclaw-autologin` (Linux: `/mnt/alice-workspace/autoclaw-autologin`)
Automated Google OAuth login for AutoClaw/Z.ai to get free GLM-5.2/GLM-5-Turbo access tokens. Uses CloakBrowser (C++ stealth Chromium, not Camoufox). See `references/autoclaw-autologin-flow.md` for full architecture and flow details.

### github-headless-register repo
Location: `F:\AliceWorkspace\github-headless-register` (Linux: `/mnt/alice-workspace/github-headless-register`)
CloakBrowser (fallback Camoufox) GitHub signup → CF OTP worker → profile/suspend check. Ravi runs on PC via `setup.bat` / `run_once.bat`. Alice writes files on SMB; venv created by Windows `setup.bat` is OK for this small tool. Speed knobs: `FAST_FILL`, `PAUSE_SCALE`, `SLOW_MO_MS` in `.env`. Class skill: `web-signup-http-reverse` → `references/github-headless-cloakbrowser.md`.

### Persistent CloakBrowser navigation
For Telegram-driven, persistent browser navigation on Ravi's PC, use `references/persistent-cloakbrowser-controller.md` for the controller shape and `references/persistent-cloakbrowser-control.md` for lifecycle, target-selection, and safe request-construction pitfalls. Return URL/title/DOM targets/text or requested HTML after each action; screenshots are not the default. Do not restart the controller while the user may be entering data or navigating an auth flow.

### Lightweight paper-trading bots
When Ravi asks to try automated crypto trading safely, use SMB for files and `winb` for a named background process. Start with public market data, virtual balance, explicit `PAPER ONLY` state, and verify both process logs and persisted state. See `references/lightweight-paper-trading-bot.md`.

### User-facing local dashboards
When Ravi asks for a WebUI to monitor a Windows-hosted automation, do not ship a minimal status page as the final dashboard. Build a usable monitoring surface from the first pass:
- Make the live operational state immediately legible: process state, last successful update/analysis, data freshness, current action, error state, and next scheduled run.
- Show the data that explains decisions (for trading: real market chart/candles, indicators, paper portfolio/P&L, open position, model decision/confidence/reason, and chronological analysis/trade journals).
- Every visible control must have a real backend endpoint and a visible state/result. Do not add decorative buttons, fake charts, placeholder metrics, or tabs that do nothing.
- Keep controls grouped by intent: primary operating actions on the dashboard; sensitive connection/configuration in Settings; destructive reset/stop actions require confirmation.
- Preserve explicit safety boundaries in the UI (for paper trading: no exchange credentials/order endpoints, `PAPER ONLY` status, virtual balance) without burying the important monitoring data.
- Test the running API endpoints and the primary interaction flow after deployment; restart the named winb process and verify its logs/port before reporting completion.

## 3. Server Infrastructure & Pitfalls
The `winb-server` runs on Node.js at `F:\AliceWorkspace\winb-server`. It autostarts via a VBScript and PowerShell script (`winb-tray.ps1`), residing in the Windows System Tray.
- **Log viewing:** Double-click the tray icon to open a realtime tail of `server.log`.
- **Restarting:** Use the tray menu "Restart Server (Hard)" to cleanly kill and restart the Node process.
- **Hot-Reloading (HMR):** The server supports true hot-reloading by splitting logic into `server.js` (holds process map) and `api.js` (holds endpoints). To update endpoints, edit `api.js` and call `curl http://192.168.1.100:5110/reload`.
- **Pitfall - Background Logging:** Never use PowerShell's `Start-Process -RedirectStandardOutput` for the Node server. It locks the log file exclusively, causing Node to crash on startup. Always launch via `cmd.exe /c node server.js >> server.log 2>&1`.
- **Pitfall - Ghost Node Processes:** When using PowerShell to kill a process started via `cmd.exe /c node`, `Stop-Process` only kills the `cmd.exe` wrapper. The child `node.exe` survives and hoards port 5110. The tray restart script mitigates this using `Stop-Process -Name "node" -Force`.
- **Pitfall - winb is usually non-admin.** Admin role check often `False`. Machine-wide MSI uninstall, `net user` / `Set-LocalUser` password changes, and SYSTEM scheduled tasks fail with **Access denied**. Do not thrash retries — ask Ravi to elevate once, or pick a path that needs no admin.
- **Pitfall - cannot set Windows password via non-admin winb.** `net user`, `Set-LocalUser`, and SYSTEM scheduled tasks denied. `Start-Process -Verb RunAs` hangs on **interactive UAC on the PC**. Never leave password-bearing scripts on SMB (`F:\AliceWorkspace`); delete immediately after attempt. See `references/pc-ssh-auth.md`.
- **Preferred password-set path:** when Ravi asks to create a Windows/SSH password and key SSH works, set it via **admin SSH key session** (`Set-LocalUser`), then verify password SSH with ASKPASS. Do not thrash non-admin winb first. Working pattern: send password base64 over the key session → `Set-LocalUser -Password` → ASKPASS password login probe → if Ravi asks to copy, return **only** the password string.
- **Pitfall - blank Windows password ≠ no remote access.** SMB blank-password still works; password SSH needs a real password (or use key). Prefer key `/root/.ssh/ravi-main-pc` for agent ops. `PasswordRequired=False` on `Get-LocalUser` may still show False after a password was set — always verify with a real password SSH login probe, not that flag alone.
- **Password copy preference:** when Ravi says “tulis ulang password”, return **only** that password string (dashboard vs SSH/Windows are different secrets).
- **User Preference (Logging):** Ravi prefers detailed, verbose logging in the `winb-server`. All actions (e.g., endpoint hits, active list checks) must be explicitly logged to `server.log`, rather than a minimal log that only tracks process lifecycle and reloads. Add HTTP request logger middleware to any API endpoints.
- **Windows user PATH pitfall:** Commands installed under the interactive Windows user (especially npm global shims) may not resolve in the `winb-server` process PATH even when the app exists. Diagnose with PowerShell `Get-Command <cmd>` and common user paths like `%APPDATA%\\npm\\<cmd>.cmd`; if found, run via the full shim path or update/restart the tray server PATH rather than reinstalling blindly. Current `api.js` run path explicitly prepends `%APPDATA%\\npm` into child command PATH so npm global shims like `opencode.cmd` resolve via plain `winb "opencode ..."`.
- **OpenCode via winb:** If `opencode` is not found but the app is installed, try `C:\\Users\\Ravi\\AppData\\Roaming\\npm\\opencode.cmd` first. Verify with `--version`, then smoke-test with `opencode run "Respond with exactly: OPENCODE_SMOKE_OK"` using a model/provider ID known to exist in Ravi's OpenCode config.
- **winb strips `$variables` in PowerShell one-liners.** Remote shell/quoting often drops `$p`, `$paths`, `foreach ($x in ...)` before PowerShell sees them → `Missing variable name after foreach` / empty tokens. Prefer: (1) write a `.ps1` locally → `scp` to `C:\Users\Ravi\AppData\Local\Temp\` → `ssh ... powershell -File ...`, or (2) tiny commands without `$vars`. Do **not** thrash long `winb -p` scripts full of `$`.
- **Machine PATH edits need admin.** Non-admin winb gets `Requested registry access is not allowed` on `[Environment]::SetEnvironmentVariable(..., 'Machine')`. Use **SSH key session** (`/root/.ssh/ravi-main-pc`, admin=True) for Machine PATH. User PATH can still be set without admin.
- **Ghost Python PATH (“python is not recognized” kumat):** Often installs still exist (Python311, miniconda, Launcher) but Machine PATH points at dead `C:\Python313\` and User PATH is empty/junk (e.g. TEDI-only). Diagnose + fix recipe: `references/windows-python-path-repair.md`. After registry PATH change, tell Ravi to **open a new terminal** — old CMD/PS keep stale env. Do not reinstall Python first if binaries still pass `Test-Path`.

### Windows Python PATH repair (class)
When Ravi reports `python` / `py` missing on the PC CMD while he still has local projects:
1. Probe existence vs PATH (not “reinstall Python” first): `where.exe python` **from the failing directory**, `Test-Path` on known installs, compare User vs Machine Path.
2. If `where` lists a **local bare `python` (0 bytes)** first → move/delete that junk before touching PATH again. WindowsApps 0-byte aliases can also shadow.
3. Remove dead entries (`C:\Python313`, TEDI junk) from User PATH; clean Machine PATH via **admin SSH** if needed.
4. Prepend working installs to User PATH (Python311 + Launcher ± miniconda); durable shim: `C:\Users\Ravi\Scripts\python.cmd` (folder already on Machine PATH).
5. If `py -0p` still marks missing 3.13 as default, write `%LOCALAPPDATA%\py.ini` with `[defaults]\npython=3.11`.
6. Verify with a **fresh** env (`Machine;User` join) and tell Ravi to relaunch terminal.

Full probe/fix script pattern: `references/windows-python-path-repair.md`.
