# winb v1.3: client, server, typed ops, sessions (2026-11-01)

Written against winb-server **1.3.0** and CLI **2.0.0**. Measurements and reproduction commands:
[AUDIT-2026-11-01.md](AUDIT-2026-11-01.md). Acceptance suites: `tests/verify_client.py` (17 checks),
`tests/verify_phase2.py` (13), `tests/verify_phase3.py` (12). Run all three after any change.

## 1. Layout

| Piece | Where |
|---|---|
| Client v2 (source of truth) | `cli/winb` (Python, no runtime deps beyond curl) |
| Client v1 (retired) | `cli/legacy/winb-v1.sh` - see the rollback caveat in section 5 |
| Server routes | `winb-server\api.js` (hot-reloadable) |
| Server bootstrap | `winb-server\server.js` (auth, 64 mb body limit, version) |
| Token | host `winb-server/.token`, gateway `~/.winb-token` |
| Tunnel-only host | `cli/winb-tunnel` (wrapper) + `winb-server/tunnel-only/` (bootstrap + deploy guide) |
| Watchdog | `watchdog.ps1`, owned by `winb-tray.ps1`, polls `/health` every 15 s |

`winb "echo hi"` costs **0.33 s** end to end (v1 was 2.84 s; the server answers in 131 ms).

## 2. Client command surface (v2)

All v1 flags still work. Additions:

| Flag / subcommand | Purpose |
|---|---|
| `--json` | raw envelope: `status`, `exitCode`, `stdout`, `stderr`, `stdoutBytes`, `truncated`, `stdoutSpill` |
| `--out <path>` | save stdout locally, print a byte summary |
| `--cmd-file <path>` | command from a file - no shell quoting anywhere |
| `-s, --session <id>` | apply a sticky workdir/env to this call (explicit `-w`/`-e` still win) |
| `--client-timeout <sec>` | local give-up (default: server timeout + 15, else 1800) |
| `--manifest` | one call for device facts: host, OS, cpu/mem, tool versions, drives, capabilities, allowed write roots, limits |
| `put` / `get` | chunked transfer, sha256 verified, uses the typed endpoints with a python fallback for pre-1.3 servers |
| `ls [path] [--pattern RE]` | directory listing |
| `stat <path>` | exists/type/size/mtime/sha256 |
| `read <path> [--out FILE]` | chunked stream out |
| `rm <path> [--recursive]` | delete, guarded (refuses roots, refuses dirs without `--recursive`) |
| `ps [filter] [--limit N]` | process list with memory |
| `session set\|show\|rm\|list` | manage sticky sessions |
| `api <METHOD> <path> [json]` | raw typed request |
| `doctor` | latency + device + auth + manifest report |

Behaviour differences from v1 worth remembering: remote bytes are preserved exactly (v1 stripped
trailing newlines via bash command substitution), `[no output]` is printed for an empty `exit 0`, and
POSTs are never replayed while connection-level failures are retried (7 s apart, which also rides out
a watchdog respawn).

## 3. Server surface (v1.3.0)

Endpoints beyond `/run`, `/kill`, `/list`, `/logs`, `/ping`, `/health`, `/port/:port`, `/open-url`:

| Endpoint | Notes |
|---|---|
| `GET /manifest` | cached 10 min device probe (`?refresh=1` forces) |
| `GET /fs/stat` | `?path=&sha256=1` |
| `GET /fs/list` | `?path=&pattern=REGEX&limit=` |
| `GET /fs/read` | `?path=&offset=&length=&encoding=utf8\|base64`, 8 MB per call |
| `POST /fs/write` | `{path, text\|dataB64, append, mkdirs, sha256}` |
| `POST /fs/mkdir`, `POST /fs/move`, `POST /fs/rm` | `rm` refuses drive roots and directories unless `recursive:true` |
| `GET /proc/list` | `?filter=&limit=` |
| `POST /proc/kill` | `{pid\|name, tree}` |
| `GET/POST/DELETE /session[/:id]` | sticky cwd + env, persisted to `sessions.json` |

Write/move/delete are confined to `ALLOWED_ROOTS` - by default the scratch directory and the system
temp area, widen it with `WINB_ALLOWED_ROOTS` (semicolon separated). Reads are not restricted.
Destructive calls return 403 outside those roots; do not widen the list casually.

Fixes carried by v1.3, each verified by a test: token auth for LAN callers (loopback trusted, missing
`.token` = fail-open recovery hatch), forced UTF-8 in both shells, timeout kills the process tree and
always answers, multi-line cmd staged into a temp `.cmd`, stdin piped through `child.stdin` and closed
(a reader can no longer hang), bad workdir returns 400 instead of killing the server, 2 MB output cap
with a spill path in `%TEMP%`, `<scratch dir>` as the default cwd, 64 mb body limit,
job records persisted, `server.log` rotated, `routes.js` deleted (dead code - its routes were
duplicated in `api.js`).

## 4. Tunnel-only profile (host reachable only through a reverse tunnel)

For a machine with no inbound route - no port forward, no VPN, often a network you do not
administer. The host dials out to a relay you control; the gateway drives it through that tunnel
and talks to a loopback forwarder.

`cli/winb-tunnel` is the gateway-side wrapper: it exports `WINB_SERVER_URL=http://127.0.0.1:5110`,
keeps a `/ping` preflight so an offline host fails loudly (the hint names the forwarder unit from
`WINB_BRIDGE_UNIT`), refuses `--admin` because a reverse tunnel offers no inbound shell, and then
execs the shared v2 client. Every v1 flag is preserved.

`winb-server/tunnel-only/` holds the matching bootstrap (version `1.3.0-tunnel`) - same `api.js`,
env driven like `server.js`, with its own `/health` identity - plus `README.md` covering the
topology, the deploy steps and rollback. A remote server that predates v1.3 still works: the client
falls back to its exec/put/get path for transfers and reports "this server does not expose X - it
predates v1.3" for the typed verbs. The loopback endpoint is the boundary; the token protects the
case where the port becomes reachable another way.

## 5. Server edits, HMR and recovery

`GET /reload` re-requires `api.js` and re-registers routes. Auth lives in `server.js` before that
route, so `/reload` needs the token too:

```bash
winb "node --check <install-dir>\\api.js"                          # syntax first, always
winb "copy /y <install-dir>\\api.js <install-dir>\\api.js.bak"     # backup before reload
winb "copy /y <install-dir>\\api.js <install-dir>\\api.new"          # stage the new file
winb "move /y <install-dir>\\api.new <install-dir>\\api.js"
curl -s -H "Authorization: Bearer $(cat ~/.winb-token)" http://WINB_HOST:5110/reload
winb --health && winb "echo hi"
```

**Trap:** the reload handler calls `cleanupApi()` *before* `require('./api.js')`, so a file that throws
removes every route including `/health`, and the watchdog refuses to restart while port 5110 is
listening. Recovery: restore `api.js.bak`, then `winb --admin "taskkill /pid <serverPid> /f"` - the
watchdog respawns node within 15 s. `server.js` changes (body limit, bind, version) always need that
kill-and-respawn path, and log rotation only works inside that window (the launcher's `>> server.log`
redirect holds the handle open, so an in-process rename fails with EBUSY on Windows).

**Client rollback caveat:** after auth is enabled, `cli/legacy/winb-v1.sh` cannot call the server (it has
no token support, so every non-loopback request returns 401). To roll the client back you must first
disable server auth by deleting the host's `.token` (fail-open), or restore `server.js.bak` and
respawn.

## 6. Pitfalls

* Always back up a file before overwriting it, and check the new file's flag surface first. A 304-line
  bash wrapper was lost to a blind overwrite during this work; it had to be reconstructed from the
  older client just to restore the rollback path.
* `--admin` runs over SSH with PowerShell: chain with `;`, never `&&` or `&` (the latter raises
  `AmpersandNotAllowed`). Its default workdir is `<scratch dir>`, same as HTTP.
* `winb -e ""` is rejected - omit `-e` instead of passing an empty value.
* `--stdin-file` with `-p` pipes the content in, so the command must consume a pipeline
  (`ForEach-Object { ... }`), not call `[Console]::In.ReadToEnd()`.
* Windows paths in a python one-liner must travel as env vars (`-e WINB_PATH=...`), never interpolated
  into the `-c` string. `put`/`get` and the typed endpoints already do this.
* f-strings cannot contain a backslash inside the expression part - a real syntax error this cost once
  (`{_q(target or 'F:\\...')}`). Keep default paths in module constants.
* A command started with `timeout=0` that detaches a grandchild can still outlive the request; the
  client bounds it at `--client-timeout`. Pass `-t` for anything server-like.
* Host-firewall scoping of port 5110 to the gateway IP is often **not** available: the inbound
  allowance typically comes from per-program `Node.js JavaScript Runtime` allow rules
  (Private+Public, any remote), and editing those breaks every other node service on that machine.
  The token is the boundary; binding to 127.0.0.1 plus a reverse tunnel (the `cli/winb-tunnel` profile)
  is the alternative when the host is not on your own network.
