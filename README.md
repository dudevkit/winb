# winB

Hybrid Windows remote execution bridge for Hermes Agent.

`winB` lets a Linux gateway drive a Windows PC over a local HTTP API (default port **5110**): run commands, PowerShell, background processes, kill jobs, transfer files, and health-check — without SSH on every call.

**v1.3** adds bearer-token auth for LAN callers, typed `fs.*` / `proc.*` endpoints, sticky sessions, a 64 mb body limit, and a rewritten single-process CLI (0.33 s per round trip versus 2.84 s in v1). See [docs/winb-v1.3.md](docs/winb-v1.3.md) for the full surface and [docs/AUDIT-2026-11-01.md](docs/AUDIT-2026-11-01.md) for the measurements behind it.

**v1.4** adds host context: a sampler inside the server keeps `GET /state` (power, session, disks, network, resources, foreground app) and an event timeline (`GET /timeline`, `GET /apps`) that says what happened on the host and who used it. See [docs/winb-v1.4-spec.md](docs/winb-v1.4-spec.md).

## Layout

```
winb-server/          # Node.js Express server (runs on Windows)
  server.js           # entrypoint: auth, body limit, log rotation, port from WINB_PORT
  api.js              # HTTP API surface (hot-reloadable via GET /reload)
  sampler.js          # host context sampler: /state, timeline, app-usage rollups
  sampler-probe.ps1   # probe helper driven by sampler.js (one long-lived process)
  winb-tray.ps1       # system-tray launcher + hard restart + watchdog owner
  watchdog.ps1        # polls /health every 15 s, respawns node, recovers a hung listener
  server-env.example.ps1  # template for server-env.ps1 (deployment settings, gitignored)
  start-winb.vbs      # silent tray bootstrap
  tail-log.ps1        # live log tail
  tunnel-only/        # same api.js, separate bootstrap + deploy guide for a host
                      # that is reachable only through a reverse tunnel
  INSTALL-SEKALI.bat / START-WINB.bat / CEK-STATUS.bat
cli/
  winb                # Linux CLI (single Python process, gateway side)
  winb-tunnel         # thin wrapper: loopback bridge / tunnel profile, no --admin
  legacy/winb-v1.sh   # the retired bash+jq client, kept for reference only
tests/
  smoke_local.sh      # 21 checks, boots the server locally (no Windows host needed)
  verify_client.py    # 17 client behaviour checks
  verify_phase2.py    # 13 server-hardening checks
  verify_phase3.py    # 12 typed-op / session checks
docs/
  winb-v1.3.md                        # v1.3 reference: endpoints, flags, HMR, recovery, pitfalls
  winb-execution.md                   # operating the bridge from a gateway (mount, paths, elevation, traps)
  windows-remote-execution-bridge.md  # the hybrid layout: SMB mount + HTTP execution, tray autostart
  AUDIT-2026-11-01.md                 # usage audit + acceptance list for the v1.3 work
  winb-v1.4-spec.md                   # v1.4 proposal: host state, event timeline, app usage (draft)
```

## Features

- HTTP remote shell on Windows (`POST /run`), cmd or PowerShell
- Typed filesystem ops: `fs.stat`, `fs.list`, `fs.read` (chunked), `fs.write`, `fs.mkdir`, `fs.move`, `fs.rm` — writes confined to `WINB_ALLOWED_ROOTS`
- Process list and tree-kill (`proc.list`, `proc.kill`)
- Sticky sessions: a named workdir + env set that any call can reuse
- Chunked upload/download with sha256 verification
- Background process registry + kill, with persisted job records
- Bearer-token auth (`Authorization: Bearer <token>`), loopback trusted, `/ping` and `/health` public
- Output cap with spill-to-file, log rotation, device manifest (`GET /manifest`)
- Tray app with View Logs / Hard Restart / Exit, plus a watchdog that also recovers a hung listener
- Host context: `GET /state` (power, session, disks, network, resources, foreground app), `GET /timeline`
  (event log: boots, shutdowns, network and disk transitions, app switches), `GET /apps` (per-app minutes)
- CLI: env-based host, sessions, `--out`, `--cmd-file`, `--stdin-file`, `--json`, optional SOCKS

## Quick start (Windows server)

**Easiest (non-technical):** copy `winb-server/` to the Desktop, then see
**[winb-server/README-INSTALL.md](winb-server/README-INSTALL.md)**
→ double-click `INSTALL-SEKALI.bat`.

**Manual:**

```powershell
cd path\to\winb-server
npm install
# option A: foreground
node server.js
# option B: tray (recommended)
wscript start-winb.vbs
# or START-WINB.bat
```

Server listens on `0.0.0.0:5110`.

### Enabling auth

Write the token next to the server (or pass it in the environment) and hand the same value to the CLI:

```powershell
# Windows side — one line, 32 bytes of entropy
[Convert]::ToHexString((1..32 | % { Get-Random -Max 256 })) | Set-Content .token -NoNewline
```

```bash
# gateway side
printf '%s' '<same value>' > ~/.winb-token && chmod 600 ~/.winb-token
```

With no `.token` file and no `WINB_TOKEN`, the server runs **open** (fail-open) so a lost token can never lock you out. `WINB_ALLOWED_ROOTS` defaults to the scratch directory and the system temp area — widen it deliberately.

## Quick start (Linux CLI)

```bash
export WINB_HOST=<host-ip>           # or WINB_URL=http://host:5110
export WINB_PORT=5110

# optional: userspace SOCKS proxy (opt-in only)
# export WINB_SOCKS=socks5h://127.0.0.1:1055

winb --health
winb "whoami"
winb -p "Get-Process | Select-Object -First 5"
winb --manifest                     # OS, cpu/mem, tool versions, drives, caps, limits
winb ls "C:\Temp" --pattern '\.log$'
winb put ./fix.py "C:\Temp\fix.py" && winb -p "python C:\Temp\fix.py"
```

Left unset, the CLI talks to `http://127.0.0.1:5110` — the tunnel/port-forward profile. Do **not** commit machine-specific IPs or auto-proxy defaults into `cli/winb`; keep those in a local shell profile or systemd env.

## Environment variables

| Variable | Side | Purpose |
|---|---|---|
| `WINB_PORT` | server | listen port (default 5110) |
| `WINB_BIND` | server | listen interface (default `0.0.0.0`; use `127.0.0.1` for a tunnel-only box) |
| `WINB_VERSION_SUFFIX` | server | label appended to the version in `/health`, e.g. `-office` (default empty) |
| `WINB_TOKEN`, `WINB_TOKEN_FILE` | server | bearer token (default `.token` next to `server.js`) |
| `WINB_DEFAULT_CWD` | server | working directory when a call passes none |
| `WINB_ALLOWED_ROOTS` | server | `;`-separated write roots |
| `WINB_BODY_LIMIT_MB` | server | JSON body limit (default 64) |
| `WINB_OUTPUT_CAP_MB`, `WINB_MAX_READ_MB` | server | response caps |
| `WINB_LOG_ROTATE_MB`, `WINB_LOG_KEEP` | server | `server.log` rotation |
| `WINB_URL`, `WINB_HOST`, `WINB_PORT` | client | server address |
| `WINB_TOKEN`, `WINB_TOKEN_FILE` | client | token (also `~/.winb-token`, `/etc/winb-token`) |
| `WINB_SOCKS` | client | transport proxy, e.g. `socks5h://127.0.0.1:1055` |
| `WINB_DEFAULT_CWD` | client | default remote directory for file verbs |
| `WINB_SSH_TARGET`, `WINB_SSH_KEY` | client | enable `--admin` (user@host + key) |
| `WINB_TRACK` | server | master switch for the sampler (default on) |
| `WINB_TITLES`, `WINB_TITLES_PERSIST` | server | window titles: live only (default) versus written to history |
| `WINB_SAMPLE_SEC` | server | sampler interval (default 60) |
| `WINB_HISTORY`, `WINB_HISTORY_DAYS`, `WINB_HISTORY_MAX_MB` | server | timeline file, retention, size cap |
| `WINB_APP_DAYS` | server | app-usage rollup retention (default 90) |
| `WINB_HISTORY_DIR` | server | where `history/*.jsonl` lives (default `<server folder>\history`) |
| `WINB_PRIVATE_API` | server | require the token for `/state` and friends even on loopback (default on) |
| `WINB_CURSOR_FILE` | client | cursor for `winb context` (default `~/.winb-cursor`) |

Deployment settings usually live in **`server-env.ps1`** next to `server.js` rather than in the
shell: `winb-tray.ps1` and `watchdog.ps1` dot-source it before spawning node, so a manual start and
an automatic respawn end up with the same configuration. Copy `server-env.example.ps1` and edit it;
the real file is gitignored.

## API sketch

| Method | Path | Body / query | Notes |
|--------|------|--------------|-------|
| POST | `/run` | `{cmdB64\|command, workdir?, powershell?, timeout?, env?, session?, background?, processId?}` | run a command (64 mb body) |
| POST | `/kill` | `{processId}` | tree-kill a background job |
| GET | `/list`, `/logs` | `?id=&tail=` | background jobs and their output |
| GET | `/ping`, `/health` | — | liveness + version (no token needed) |
| GET | `/manifest` | `?refresh=1` | device facts, capabilities, allowed roots |
| GET | `/reload` | — | re-require `api.js` (token required) |
| GET/POST/DELETE | `/fs/stat`, `/fs/list`, `/fs/read`, `/fs/write`, `/fs/mkdir`, `/fs/move`, `/fs/rm` | see [docs/winb-v1.3.md](docs/winb-v1.3.md) | typed file ops |
| GET/POST | `/proc/list`, `/proc/kill` | `?filter=&limit=` / `{pid\|name, tree}` | process ops |
| GET/POST/DELETE | `/session[/:id]` | `{workdir?, env?}` | sticky workdir + env |
| GET | `/state` | `?detail=full` | host context: power, session, disks, network, resources, apps, tracking |
| GET | `/timeline` | `?hours=6&kinds=power,net,app&limit=500` | event timeline (memory ring + `history/*.jsonl`) |
| GET | `/events/since` | `?cursor=<opaque>` | events after a cursor, so a caller can ask for "what is new" |
| GET | `/apps` | `?days=7` | per-app minutes, runs, last used |
| GET | `/history/purge` | `?days=0` | drop timeline history beyond N days (0 = everything) |

`/state`, `/timeline`, `/events/since`, `/apps` and `/history/purge` describe who uses the host, so
they require the bearer token **even from loopback** while `WINB_PRIVATE_API` is on (default).

Full request/response shapes: [docs/winb-v1.3.md](docs/winb-v1.3.md).

## Tests

Acceptance suites run **against a live server** (they exercise the real bridge, not mocks). Point them at it the same way the CLI is pointed:

```bash
export WINB_HOST=<host-ip>           # or WINB_URL=...
export WINB_TOKEN_FILE=~/.winb-token
python3 tests/verify_client.py      # 17 checks
python3 tests/verify_phase2.py      # 13 checks
python3 tests/verify_phase3.py      # 12 checks
python3 tests/verify_phase4.py      # 18 checks (needs server v1.4: host context surface)
```

Each suite prints `PASS`/`FAIL` per check and exits non-zero on failure. Run all three after touching `server.js`, `api.js` or `cli/winb`.

No Windows host at hand? `tests/smoke_local.sh` boots the server pair on a temp port against a temp root and drives the OS-agnostic surface (auth, `/health`, `/manifest`, `fs.*`, sessions, `/reload`) — 21 checks, no Windows required:

```bash
tests/smoke_local.sh                 # 35 checks, needs node + npm + curl
```

`verify_phase4.py` is non-destructive by default - the purge check keeps the retention window. Set
`WINB_TEST_PURGE=1` to also run the full wipe (`days=0`), which empties the timeline.

Exec paths (`cmd.exe`, PowerShell) are out of its scope by design.

## Security notes

- Bind is `0.0.0.0`; the token is the LAN boundary. Loopback is always trusted so local watchdogs keep working.
- Writes, moves and deletes are confined to `WINB_ALLOWED_ROOTS`; reads are not restricted.
- Never commit `.token`, `sessions.json`, `jobs.json`, `history/` or `server-env.ps1` (see `.gitignore`).
- Host context is the privacy-sensitive surface: window titles stay in memory unless
  `WINB_TITLES_PERSIST=1`, keystrokes/screenshots/clipboard/file contents are never collected, and
  `history/` is ACL-restricted to the account running the server.
- Hosts that cannot be reached inbound: use the reverse-tunnel profile (`cli/winb-tunnel` + `winb-server/tunnel-only/`). The loopback endpoint is then the boundary, and the token covers the case where the port becomes reachable another way.

## Related Hermes skills

- `windows-remote-execution-bridge`
- `winb-execution` (user workflow)

## License

Private / internal tooling unless stated otherwise.
