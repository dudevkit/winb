---
name: windows-remote-execution-bridge
description: "Hybrid execution architecture for Hermes: SMB/CIFS storage mount + custom `winb` HTTP shell wrapper for Windows PC remote control."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux, windows]
metadata:
  hermes:
    tags: [bridge, windows, execution, proxy, networking, workspace]
---

# Windows Remote Execution Bridge (`winb`)

## Overview

When running Hermes on a Linux gateway (like an OrangePi or Raspberry Pi) but needing to execute commands, build apps, or start dev servers on a target Windows PC, SSH is often unreliable or cumbersome for background process control. 

This skill documents the **Hybrid Execution Architecture**:
1. **Storage Layer:** The Windows workspace is shared via network (SMB) and mounted on the Linux gateway. Hermes edits files directly on the Linux side with native speed.
2. **Execution Layer:** A lightweight Node.js server (`winb-server`) runs on Windows, and a bash wrapper (`winb`) on Linux sends execution commands via HTTP. 

This allows seamless, context-aware command execution (foreground and background) without the overhead of heavy agent bridges.

## 1. Storage Mount (SMB/CIFS)

**On Windows:**
- Share the target folder (e.g., `F:\AliceWorkspace`) via Folder Properties -> Sharing -> Advanced Sharing.
- Ensure the Windows user has a password (Windows by default rejects network access for blank passwords). If using a blank password, the Local Security Policy (`secpol.msc`) must be changed to disable "Accounts: Limit local account use of blank passwords to console logon only".

**On Linux (Hermes Gateway):**
Prefer a credentials file (mode `600`) + fstab/`nofail,_netdev` over embedding passwords on the command line:

```bash
# credentials file example
# username=...
# password=...
mount -t cifs //192.168.1.100/AliceWorkspace /mnt/alice-workspace \
  -o credentials=/etc/cifs-credentials-alice-workspace,uid=0,gid=0,iocharset=utf8,file_mode=0777,dir_mode=0777,vers=3.0,nofail,_netdev
```

Inline form (one-shot only):

```bash
sudo mount -t cifs //192.168.1.100/AliceWorkspace /mnt/alice-workspace -o username=YourUser,password=YourPassword,uid=1000,gid=1000,dir_mode=0777,file_mode=0777
```
*(If no password is required after secpol.msc change, use `password=""`)*

**Health check before trusting the path:**

```bash
mountpoint -q /mnt/alice-workspace && findmnt -T /mnt/alice-workspace -o TARGET,SOURCE,FSTYPE,OPTIONS
```

If the path exists but is **not** a CIFS mount, it may be a plain local directory with stale contents left after a previous mount drop. Move that tree aside before remounting. Execution-bridge health (`winb --health`) is independent of the storage mount — both layers must be checked.

For Ravi's live gateway restore recipe (known-good auth, fstab line, stale-dir relocate), see the companion skill `winb-execution` → `references/smb-mount-restore.md`.

## 2. `winb-server` (Windows Node.js Server)

A small Express server runs on the Windows PC to listen for commands and execute them via `child_process.spawn`.

**Location on Windows:** `F:\AliceWorkspace\winb-server\server.js` (or similar).
**Default Port:** 5110

**Features:**
- Executes commands via `cmd.exe` or `powershell.exe`.
- Tracks background processes by ID (allows killing them later).
- Returns stdout/stderr for foreground tasks.
- Supports working directory (`cwd`) overrides.

**Startup Script (VBS + PowerShell Tray):**
The server is started silently at boot using a `.vbs` script that calls a `.ps1` script to create a System Tray icon (for viewing logs and exiting) while keeping the Node.js process completely hidden.

## 3. `winb` CLI Wrapper (Linux Gateway)

A bash script installed at `/usr/local/bin/winb` on the Linux gateway.

**Usage:**
```bash
winb [OPTIONS] "command"
```

**Options:**
- `-w, --workdir <dir>`: Working directory on the Windows PC (e.g. "F:\AliceWorkspace"). If omitted, uses the winb-server directory.
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
winb -w "F:\AliceWorkspace\MyApp" "npm install"

# Start dev server in background
winb -w "F:\AliceWorkspace\MyApp" -b -id devserver "npm run dev"

# Stop dev server
winb -k devserver
```

## Workflow and Pitfalls

### Coding/App Building Workflow
1. Use standard Hermes tools (`write_file`, `patch`, `read_file`) directly on the mounted directory (e.g., `/mnt/alice-workspace/MyApp`).
2. Use `winb` for execution only (e.g., `winb -w "F:\AliceWorkspace\MyApp" "npm test"`).
3. Do NOT use `terminal` to run `npm` or `python` inside `/mnt/alice-workspace` on the Linux side unless the target runtime environment (Node/Python versions, native modules) exactly matches or doesn't matter. The execution *must* happen on Windows if the goal is a Windows app.

### Pitfalls
- **CWD mismatch:** The Linux mount path (`/mnt/alice-workspace`) and the Windows path (`F:\\AliceWorkspace`) are different. When passing `-w` to `winb`, **always use the Windows path format**.
- **Hanging terminals:** Never run long-living commands (like dev servers) in foreground via `winb`. Always use `-b` and assign an `-id`, or the Linux terminal tool will time out and hang.
- **Process Trees:** The `/kill` endpoint in `winb-server` must use `taskkill /pid <PID> /f /t` to properly kill process trees on Windows, otherwise child processes (like node workers) will orphan and block ports.
- **Blank-password Windows accounts:** CIFS mounts usually fail with `Permission denied (13)` when the Windows account has no password. Either set a real Windows password, or on Windows run `secpol.msc` and disable `Accounts: Limit local account use of blank passwords to console logon only`, then mount with `password=""`.
- **Stale local mountpoint:** After a CIFS drop, `/mnt/alice-workspace` can remain as a normal local directory with old files. Always verify with `mountpoint`/`findmnt` (`FSTYPE=cifs`) before treating contents as live Windows storage; relocate the local tree before remounting.
- **Guest SMB:** Do not assume `guest` or `Everyone` share permission enables CIFS login; probe known user auth, never ask the user to paste Windows passwords into chat.
- **PowerShell log redirection locks:** For tray/autostart wrappers, do not launch Node/Python with `Start-Process ... -RedirectStandardOutput $logFile`; PowerShell can lock the log exclusively and make Node crash with `EPERM`. Prefer `System.Diagnostics.ProcessStartInfo` invoking `cmd.exe /c node server.js >> server.log 2>&1` so appends are handled without exclusive locking.
- **Realtime log viewing:** A tray-menu "Tail log" action can use `Get-Content -Path server.log -Wait -Tail 20`.

## Windows Tray / Autostart Pattern

For unattended use, wrap `winb-server` in a VBS + PowerShell tray launcher: VBS starts the PowerShell script hidden at login; the PowerShell script owns a `System.Windows.Forms.NotifyIcon` with actions like "Tail log", "Restart server", and "Exit". Keep the actual Node/Python server detached and hidden, and use `cmd.exe` append redirection for logs rather than PowerShell redirect parameters.
