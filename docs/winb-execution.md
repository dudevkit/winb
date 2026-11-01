# Operating winb from a gateway

Patterns for driving a Windows host from a Linux gateway: when to use the file mount and
when to use the bridge, how paths translate, what needs elevation, and the traps that cost
real time. Command and endpoint reference: [winb-v1.3.md](winb-v1.3.md). First-time setup:
[windows-remote-execution-bridge.md](windows-remote-execution-bridge.md).

## 1. Two layers: storage and execution

| Layer | Mechanism | Use it for |
|---|---|---|
| Storage | SMB/CIFS share mounted at a local path | reading, writing, searching files with native tools |
| Execution | `winb` CLI over HTTP (port 5110) | running commands, servers, installers on the host |

Rules that keep this clean:

- Edit files on the mount; execute through the bridge. Do not run the project's toolchain on
  the gateway just because its files are visible there — the runtime that matters is the
  host's (Node/Python versions, native modules, Windows APIs).
- **CIFS is storage-only, not a runtime home.** venvs fail there (`lib64` symlinks →
  `Operation not supported`) and SQLite `PRAGMA journal_mode=WAL` can return
  `database is locked`. Keep the venv, the database and any symlink-heavy tree on a local
  filesystem and copy/rsync after edits.
- When the task genuinely needs no Windows files and no Windows execution, do not block it on
  the mount: run it locally on the gateway and say which layer you used.

## 2. Verify the mount before trusting the path

A mountpoint can survive a dropped CIFS session as a plain local directory holding stale
files. Check before reading or writing:

```bash
mountpoint -q /mnt/win-share && findmnt -T /mnt/win-share -o TARGET,SOURCE,FSTYPE,OPTIONS
```

- `FSTYPE=cifs` → the content is live; use native file tools directly.
- Not a mountpoint → the local tree is **not** the host's content. Say so instead of
  concluding a file is missing. Also check the bridge separately: `winb --health` can pass
  while SMB is down, and vice versa.
- Remounting: move a stale tree aside first (`mv ... ...-stale-$(date +%s)`), never mount
  over a non-empty directory — the mount hides it and the mess surfaces later.
- Credentials belong in a mode-600 file referenced from `fstab` (`credentials=...`,
  `nofail,_netdev`), not on the command line and never pasted into chat.
- Blank-password Windows accounts reject network logon by default. Either the account has a
  real password, or the host has "Limit local account use of blank passwords to console
  logon only" disabled in `secpol.msc`. Guest access is a separate share permission and does
  not make anonymous CIFS work.

## 3. Path translation

The same file has two names. `-w` and every path inside a remote command need the Windows
form:

| Gateway | Host |
|---|---|
| `/mnt/win-share/my-app` | `F:\my-app` (or wherever the share maps) |
| `/mnt/win-share` | `F:\` |

```bash
# editing /mnt/win-share/my-app/index.js  →  run it with:
winb -w "F:\my-app" "node index.js"
```

## 4. Which transport for which job

| Route | Auth | Good for |
|---|---|---|
| SMB mount | share credentials | file access |
| `winb` (HTTP 5110) | bearer token for non-loopback callers | day-to-day command execution, usually **non-elevated** |
| OpenSSH | key (`BatchMode=yes`) | admin work, scripted long commands |
| OpenSSH | password | only once a real password is set on the account |

Client-side configuration is env based (`WINB_URL`, `WINB_HOST`, `WINB_PORT`, `WINB_TOKEN*`,
see the README). A host that offers no inbound route is driven through a reverse tunnel —
see [`winb-server/tunnel-only/README.md`](../winb-server/tunnel-only/README.md).

**Elevation is the usual reason a command fails.** A non-elevated bridge process cannot:

- install or uninstall machine-wide MSI packages (`1603` from `msiexec`),
- write machine-level environment variables (`Requested registry access is not allowed`),
- run `net user` / `Set-LocalUser` / create SYSTEM scheduled tasks (`Access denied`).

When one of those is needed, use an admin transport once rather than retrying the bridge, and
do not rely on `Start-Process -Verb RunAs` — it blocks on interactive UAC on the host.

## 5. Long-running work

Start servers, watchers and installers detached and named, then inspect them:

```bash
winb -b -id app-dev -w "F:\my-app" "npm run dev"
winb --port 3000            # is it listening, and which process owns the port
winb --logs app-dev --tail 50
winb -k app-dev             # kills the whole process tree
```

Never run a server in the foreground: the gateway call blocks until it exits. Give anything
server-like a timeout (`-t`) so a hung child cannot hold the request open.

## 6. Server-side pitfalls worth knowing

- **Log redirection locks.** Launching the server with PowerShell's
  `Start-Process -RedirectStandardOutput` can hold the log file exclusively and make Node
  crash on startup or fail log rotation. Append through `cmd.exe /c node server.js >> server.log 2>&1`
  instead. Rotation therefore only happens in the window where the launcher restarts the
  process.
- **Ghost processes.** `Stop-Process` on a `cmd.exe /c node ...` wrapper kills the wrapper
  only; the child `node.exe` survives and keeps the port. Kill the tree (`taskkill /pid <pid>
  /f /t`) or match the node processes in the restart path.
- **Hot reload scope.** Only the route module (`api.js`) reloads via `GET /reload`; the
  bootstrap (`server.js`) needs a real restart. The reload handler runs `cleanupApi()` before
  `require()` — a file that throws removes every route, including `/health`. Validate with
  `node --check` and keep a backup before reloading. Details in
  [winb-v1.3.md](winb-v1.3.md#server-edits-hmr-and-recovery).
- **PATH is not the interactive user's PATH.** Commands installed as user-level global shims
  (for example npm's `%APPDATA%\npm`) can be invisible to the server process even though the
  app is installed. The API prepends `%APPDATA%\npm`; if something still does not resolve,
  call it by full path or fix the service PATH — do not reinstall blindly.
- **Quoting layers eat `$` and `%`.** A PowerShell one-liner passed through JSON and the
  shell can arrive with variables stripped (`Missing variable name after foreach`). Prefer
  `--cmd-file`, a staged `.ps1`, or pass values as env vars (`-e KEY=VALUE`) rather than
  interpolating them into the command string.
- **Request logging is deliberate.** Every hit, including listings, is written to
  `server.log`; that is what makes a remote bridge debuggable. Expect a growing log and rely
  on rotation.

## 7. Boundaries

- Never leave credentials on the share; delete any temporary script that carried a secret as
  soon as it has run.
- Prefer a loopback/tunnel boundary plus the token over exposing the port.
- Back up a file on the host before overwriting it, and re-run the acceptance suites after a
  change — see the Tests section of the [README](../README.md).
