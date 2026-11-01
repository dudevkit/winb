# Windows remote execution bridge: the hybrid pattern

## Overview

Running an agent on a small Linux box while the real work has to happen on a Windows machine is
awkward over SSH: background processes are hard to track, quoting differs, and every call pays a
connection setup. The hybrid layout splits the problem in two:

1. **Storage layer** — the Windows workspace is shared over SMB and mounted on the gateway, so
   files are edited locally at native speed.
2. **Execution layer** — a small Node.js server (`winb-server`) runs on Windows and the `winb`
   CLI on the gateway sends commands over HTTP, foreground or background.

SSH still has its place (elevated or scripted work), but it is not the default path.

## 1. Storage Mount (SMB/CIFS)

**On Windows:**
- Share the target folder (e.g. `F:\shared`) via Folder Properties -> Sharing -> Advanced Sharing.
- Ensure the Windows user has a password (Windows by default rejects network access for blank passwords). If using a blank password, the Local Security Policy (`secpol.msc`) must be changed to disable "Accounts: Limit local account use of blank passwords to console logon only".

**On Linux (Hermes Gateway):**
Prefer a credentials file (mode `600`) + fstab/`nofail,_netdev` over embedding passwords on the command line:

```bash
# credentials file example
# username=...
# password=...
mount -t cifs //<host-or-ip>/<share> /mnt/win-share \
  -o credentials=/etc/cifs-credentials-win-share,uid=0,gid=0,iocharset=utf8,file_mode=0777,dir_mode=0777,vers=3.0,nofail,_netdev
```

Inline form (one-shot only):

```bash
sudo mount -t cifs //<host-or-ip>/<share> /mnt/win-share -o username=<user>,password=<password>,uid=1000,gid=1000,dir_mode=0777,file_mode=0777
```
*(If no password is required after secpol.msc change, use `password=""`)*

**Health check before trusting the path:**

```bash
mountpoint -q /mnt/win-share && findmnt -T /mnt/win-share -o TARGET,SOURCE,FSTYPE,OPTIONS
```

If the path exists but is **not** a CIFS mount, it may be a plain local directory with stale contents left after a previous mount drop. Move that tree aside before remounting. Execution-bridge health (`winb --health`) is independent of the storage mount — both layers must be checked.

A worked restore recipe (credentials file, `fstab` line, relocating a stale tree) is in
[winb-execution.md](winb-execution.md#2-verify-the-mount-before-trusting-the-path).

## 2. `winb-server` (Windows Node.js Server)

A small Express server runs on the Windows PC to listen for commands and execute them via `child_process.spawn`.

**Location on Windows:** wherever you deploy it, e.g. `C:\winb-server\server.js`.
**Default port:** 5110 (`WINB_PORT` to change it).

**Features:**
- Executes commands via `cmd.exe` or `powershell.exe`.
- Tracks background processes by ID (allows killing them later).
- Returns stdout/stderr for foreground tasks.
- Supports working directory (`cwd`) overrides.

**Startup Script (VBS + PowerShell Tray):**
The server is started silently at boot using a `.vbs` script that calls a `.ps1` script to create a System Tray icon (for viewing logs and exiting) while keeping the Node.js process completely hidden.

## 3. `winb` CLI Wrapper (Linux Gateway)

A Python 3 script installed as `winb` on the gateway (`cli/winb` in this repo; the retired
bash version is at `cli/legacy/winb-v1.sh`).

**Usage:**
```bash
winb [OPTIONS] "command"
```

**Options:**
- `-w, --workdir <dir>`: Working directory on the Windows host (e.g. `C:\projects\my-app`). If omitted, the server uses its default working directory (`WINB_DEFAULT_CWD`, else a `winb-scratch` folder under the system temp area). Pass `-w` for anything that must not land in the scratch dir.
- `-b, --background`: Run command in background (returns immediately). Crucial for dev servers (`npm start`, `python app.py`).
- `-id, --process-id <id>`: Custom process ID for background task (optional, pairs with -b).
- `-k, --kill <id>`: Kill a background process by ID.
- `-p, --powershell`: Run using PowerShell instead of cmd.
- `-t, --timeout <sec>`: Timeout in seconds (for foreground tasks).

**Examples:**
```bash
# Foreground execution
winb "echo Hello World"

# Execute in specific directory
winb -w "C:\projects\my-app" "npm install"

# Start dev server in background
winb -w "C:\projects\my-app" -b -id devserver "npm run dev"

# Stop dev server
winb -k devserver
```

## Workflow and Pitfalls

### Coding/App Building Workflow
1. Edit with the normal file tools on the mounted directory (e.g. `/mnt/win-share/my-app`).
2. Execute through the bridge only (e.g. `winb -w "C:\projects\my-app" "npm test"`).
3. Do not run `npm`/`python` from the mount on the gateway: the runtime that matters is the
   host's. Keep build output and venvs where the host can run them.

### Pitfalls
- **CWD mismatch:** the mount path (`/mnt/win-share`) and the host path (`C:\projects`) are not interchangeable. `-w` always takes the host form.
- **Hanging terminals:** Never run long-living commands (like dev servers) in foreground via `winb`. Always use `-b` and assign an `-id`, or the Linux terminal tool will time out and hang.
- **Process Trees:** The `/kill` endpoint in `winb-server` must use `taskkill /pid <PID> /f /t` to properly kill process trees on Windows, otherwise child processes (like node workers) will orphan and block ports.
- **Blank-password Windows accounts:** CIFS mounts usually fail with `Permission denied (13)` when the Windows account has no password. Either set a real Windows password, or on Windows run `secpol.msc` and disable `Accounts: Limit local account use of blank passwords to console logon only`, then mount with `password=""`.
- **Stale local mountpoint:** after a CIFS drop, the mount path can remain as a normal local directory with old files. Always verify with `mountpoint`/`findmnt` (`FSTYPE=cifs`) before treating contents as live Windows storage; relocate the local tree before remounting.
- **Guest SMB:** Do not assume `guest` or `Everyone` share permission enables CIFS login; probe known user auth, never ask the user to paste Windows passwords into chat.
- **PowerShell log redirection locks:** For tray/autostart wrappers, do not launch Node/Python with `Start-Process ... -RedirectStandardOutput $logFile`; PowerShell can lock the log exclusively and make Node crash with `EPERM`. Prefer `System.Diagnostics.ProcessStartInfo` invoking `cmd.exe /c node server.js >> server.log 2>&1` so appends are handled without exclusive locking.
- **Realtime log viewing:** a tray-menu "Tail log" action can use `Get-Content -Path server.log -Wait -Tail 20`.
- **Auth:** once a token exists, non-loopback callers need `Authorization: Bearer <token>`. Keep
  `/ping` and `/health` public so monitoring does not need a secret; loopback stays trusted.

## Windows Tray / Autostart Pattern

For unattended use, wrap `winb-server` in a VBS + PowerShell tray launcher: VBS starts the PowerShell script hidden at login; the PowerShell script owns a `System.Windows.Forms.NotifyIcon` with actions like "Tail log", "Restart server", and "Exit". Keep the actual Node/Python server detached and hidden, and use `cmd.exe` append redirection for logs rather than PowerShell redirect parameters.
