# winB v1.4 - host context and event timeline (SPEC)

Status: **implemented** as server `1.4.0` (branch `feat/v1.4-context-state`). Acceptance on a live
Windows host: `tests/verify_phase4.py` 18/18, `tests/smoke_local.sh` 35/35.
Base: v1.3 (`feat/v1.3-hardening-typed-ops`).

Sections marked *as built* record where the implementation diverged from the draft, including the
two defects found while deploying it.

## 1. Problem

The gateway can execute on the Windows host but is blind to the host's *state*. It discovers
problems only by (a) a call failing, or (b) the owner mentioning it. It cannot answer:

- is the host up, and since when?
- why did a job die - host reboot, network drop, or my own command?
- is the machine idle or in use right now?
- what is the host doing that competes with the job I am about to launch?
- what has the owner been using the machine for, so context is not requested from him again?

## 2. Goals

1. **On-demand host state** - one call returns everything relevant to "is this host healthy and free".
2. **Short-horizon timeline** - "what happened on this host in the last N hours" with a cursor so an
   agent can ask for *what is new* since its last look.
3. **App usage history** - which applications the user uses, and for how long, so the agent can pick
   launch windows and avoid interrupting work.
4. **Proactive notification** - a gateway-side watcher raises critical host events (reboot, network
   loss, bridge down, disk pressure) without polling from the agent.

## 3. Non-goals (hard boundaries)

- **Never** collect keystrokes, screenshots, clipboard, file contents, or message contents.
- **Never** parse Recent items, jump lists, or AutomaticDestinations (they leak document names).
- **No auto-injection** of host context into agent turns. The agent pulls when it senses a change.
- Not a fleet/telemetry system: no upload, no third party, no cloud. Data stays on the host and is
  served to an authenticated caller.

## 4. Data sources (all measured on a 16-core / 17 GB host, non-elevated)

| Source | Yields | Cost | Notes |
|---|---|---|---|
| `Get-Process` snapshot | running processes, working set | **24-31 ms** (373 procs) | cheapest useful signal |
| `.CPU` per process | CPU seconds | **1732 ms for every process**, ~100 ms for the top 25 | perf-counter lookup per process: only read for candidates |
| `Get-Process \| MainWindowTitle` | apps with a real window | ~10 ms | app-level, title included |
| `GetForegroundWindow` + `GetWindowText` (P/Invoke) | the window actually in front | 9 ms after a 56 ms one-time `Add-Type` | the basis of usage duration |
| UserAssist registry (`HKCU\...\Explorer\UserAssist`) | per-app run count + **last used timestamp** | 272 ms for 227 entries | retroactive: history predates the feature |
| `.NET NetworkInterface` | adapter state, speed, addresses | **24 ms** | `Get-NetAdapter` is 584 ms - not used |
| `quser` | login sessions, logon time, **idle minutes** | 20 ms | separates "idle host" from "user active" |
| `Get-CimInstance Win32_OperatingSystem` | boot time, uptime | 172 ms | |
| `Get-WinEvent` (System, Application, NetworkProfile/Operational, Winlogon/Operational, Dhcp-Client/Admin, UserPnp) | shutdown reason, reboots, app crashes, network transitions | 137-149 ms per query | event ids 6005/6006/6008/1074/1000/1002 |
| Windows Security log (4624/4634) | per-logon detail | **denied without elevation** | out of scope for v1.4 |
| Disk free (`statfs`) | capacity and free bytes | <5 ms | |

Full context assembly measured at **292-454 ms**. A single sampled line is **219 bytes**
(1440 lines/day = 308 KB/day, ~2.1 MB/week).

*As built*: reading `.CPU` for all processes dominated the tick (1.9 s of a 2.0 s tick), so the CPU
list is built from the 25 largest processes by working set and only those get a CPU reading. Cost
per tick in the persistent helper: **first tick ~740 ms (Add-Type compile), then 300-320 ms**;
the transient fallback path costs ~750 ms per call. Trade-off, stated plainly: a CPU-heavy process
with a tiny footprint can be missed by the leaderboard.

## 5. Tracking tiers

The owner decided: **tracking is enabled from the first run** - no phased rollout, no opt-in gate.
Tier 0+1+2 are therefore default-on. Tier 3 does not exist in this codebase by design.

| Tier | Content | Storage | Sensitive? |
|---|---|---|---|
| 0 | app inventory + last-used timestamps | computed on demand, not sampled | low |
| 1 | active app (executable name only) + duration, CPU/mem leaderboard, idle minutes | sparse switch events + per-minute rollup on disk | medium |
| 2 | **window titles** | live in `/state`; kept in a RAM ring (default 60 min); **not** written to disk unless `WINB_TITLES_PERSIST=1` | high - equivalent to browsing history |
| 3 | keystrokes, screenshots, file/message contents | never | unacceptable |

Rationale for the tier-2 storage split: the owner wants titles available, and they are - live and for
the recent window. Writing a long-lived title log to disk is a different risk class (it becomes a
browsing/document history file), so persistence is a separate, explicit switch.

## 6. Event model

One JSON object per line, appended to `history/state-YYYYMMDD.jsonl` (newline-delimited JSON).

```jsonc
{
  "t": "2026-11-01T12:17:50+07:00",   // ISO8601 with host offset
  "kind": "app.switch",                // dotted kind, see table
  "sev": "info",                        // info | warn | critical
  "data": { "app": "chrome.exe", "title": "..." },
  "src": "sampler"                      // sampler | eventlog | fs | net | bridge
}
```

| Kind | Fired when | Data fields |
|---|---|---|
| `power.boot` | boot detected (event 6005/6006, CIM boot time change) | `bootTime`, `uptimeSec`, `clean` |
| `power.shutdown` | 1074 (planned) / 6008 (unexpected) | `reason`, `actor` |
| `net.change` | adapter up/down, address change | `iface`, `state`, `address` |
| `session.change` | logon / logoff / idle transition | `user`, `state`, `idleMin` |
| `app.switch` | foreground app changed | `app`, `title` |
| `app.usage` | minute rollup | `app`, `sec` |
| `res.sample` | per-tick resource sample | `cpuTop[]`, `memUsedMb`, `procCount` |
| `disk.change` | free space crosses a threshold | `drive`, `freeGb`, `pct` |
| `app.crash` | application error event 1000/1002 | `app`, `module` |
| `bridge.reload` | `/reload` served, version/pid change | `version`, `pid` |
| `reach.fail` | gateway-side probe failed N times | `target`, `streak` |

Sampling is **sparse**: a line is written on change (app switch, network transition, boot) plus a
`res.sample` every 60 s.

*As built*: usage duration is stored, not re-derived. When a foreground segment closes (app change,
sampler stop, tracking switched off) the sampler writes an `app.usage` row with the elapsed seconds,
so `GET /apps` is a plain sum. The segment that is still open is added at query time from live
state, which is why an app can report minutes before its first closed segment exists.

## 7. Endpoints

| Method | Path | Query / body | Notes |
|---|---|---|---|
| GET | `/state` | `?detail=full` | one-shot host state: power, net, session, disk, resources, tracking status, top apps |
| GET | `/timeline` | `?hours=6&kinds=power,net,app&limit=` | events from disk + live ring, newest first |
| GET | `/events/since` | `?cursor=<opaque>` | cursor-based delta; returns `{cursor, events[]}` |
| GET | `/apps` | `?days=7` | tier-0/1 app usage rollup: per app, total minutes, last used |
| GET | `/history/purge` | `?days=0` | delete history beyond N days (token required) |
| GET | `/manifest` | - | adds `tracking: {apps, titles, titlesPersist, retentionDays, history}` |
| GET | `/health` | - | adds a one-line `state` summary (boot time, session, tracking on/off) |

`/state`, `/timeline`, `/events/since`, `/apps`, `/history/purge` are **private endpoints**: with
`WINB_PRIVATE_API=1` (default) they require the bearer token **even from loopback**.

## 8. Sampler

- Lives inside `server.js`, starts at boot, one tick every 60 s (`WINB_SAMPLE_SEC`).
- Runs its probes through a **persistent PowerShell helper child** (one process, ~70 MB, `Add-Type`
  compiled once) rather than spawning a shell per tick (~400 ms each). The server respawns the
  helper if it exits; after 3 consecutive helper failures it degrades to transient spawns, then to
  event-log-only, and says so in `/state.tracking.degraded`.
- Skips work when nothing changed: process snapshot diffing, not blind rewrites.
- `WINB_TRACK=off` is evaluated **per tick** - disabling takes effect within one interval, no restart.

## 9. Client surface

```
winb state [--full]            # host state as readable text (--json for raw)
winb timeline --hours 6        # what happened on the host
winb apps --days 7             # app usage rollup
winb context                   # delta since this gateway last asked + active jobs
winb history purge --days N    # retention control
winb privacy                   # print exactly what is collected, from /manifest
```

`winb context` keeps a cursor per gateway (default `~/.winb-cursor`, mode 600) and prints only what
is new, so an agent can call it cheaply at the start of a task that touches the host.

## 10. Proactive notification (gateway side)

Pull-based: the host cannot push when it is down, so a gateway watcher polls.

| Rule | Trigger | Severity |
|---|---|---|
| `host.reboot` | `power.boot` since last poll | warn |
| `host.unexpected` | `power.shutdown` with `clean: false` | critical |
| `net.down` | `net.change` to down, or `/health` unreachable x3 | critical |
| `bridge.restart` | version or pid changed since last poll | warn |
| `disk.low` | free % under threshold (`WINB_DISK_WARN_PCT`, default 10) | warn |
| `session.idle` | user idle > 30 min (launch-window hint) | info |
| `app.crash` | application error event | info |

Anti-noise: a rule fires at most once per cooldown (default 30 min) and only when a job is in flight
**or** severity is `critical`. Watcher cursor is byte-offset based (`/events/since`), so restarts do
not replay old events. Transport (cron entry vs systemd timer) is deliberately left to the operator -
the spec only fixes the poll shape.

## 11. Security and privacy

1. **Data classes differ.** Uptime/network is benign; app usage is medium; window titles are
   equivalent to browsing history. Storage and access rules are set per class, not globally.
2. **Token covers loopback for private endpoints** (`WINB_PRIVATE_API=1`, default on). Without it any
   local process could scrape session and usage data for free.
3. **Titles are not persisted by default** (RAM ring only, `WINB_TITLES_PERSIST=1` to opt in).
4. **History directory is ACL-restricted** to the account running the server; `history/` is in
   `.gitignore`; the purge endpoint exists so deletion is a one-liner.
   *As built*: the disk copy loses every `title` key recursively, empty strings included - the first
   implementation only dropped truthy titles, so a window with no caption still put `"title":""`
   into the timeline. `tests/verify_phase4.py` check 13 fails if any `title` reaches the disk while
   persistence is off.
5. **Kill switches**: `WINB_TRACK=off` (per-tick), `WINB_HISTORY=0` (stop writing, keep serving),
   `WINB_TITLES=off` (tier 1 only). All take effect without a restart.
6. **No telemetry, no upload, no third party.** Data is served only to callers holding the token.
7. **Transparency by construction**: `/manifest` reports the active tracking config, and
   `winb privacy` prints it, so what is collected is inspectable without reading code.
8. **Agent conduct**: app names and window titles must never be quoted into shared channels, group
   chats, or the public repo, and must never be written to agent long-term memory. Notifications
   summarise ("host rebooted, 3 jobs lost") without listing the owner's applications.
9. **Stated limits**: the sampler sees the interactive session the server runs in - other sessions,
   fast user switching, and RDP sessions are invisible (good for privacy, a known context gap).
   Elevated processes may refuse title reads. The Security log needs elevation and is out of scope.

## 11a. Launcher and deployment settings (*as built*)

The watchdog is the process that respawns node, so both launchers must see the same settings:

- `winb-tray.ps1` and `watchdog.ps1` dot-source **`server-env.ps1`** (next to `server.js`, optional,
  gitignored) before spawning node. A manual start and an automatic respawn then produce an
  identical process. Template: `winb-server/server-env.example.ps1`.
- The tray launches one watchdog (idempotent) and removes `watchdog.owner` on Exit; the watchdog
  stops when the owner PID is gone.
- **Never** restart the server by killing every `node.exe` on the machine, and never kill the tray
  and the watchdog together without immediately starting a replacement: both were observed in
  practice to take unrelated dev servers down with them, and the second leaves node unsupervised.
  Replace the process holding the port and let the watchdog respawn it.

## 12. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WINB_TRACK` | `on` | master tracker switch (`off` stops sampling within one tick) |
| `WINB_TITLES` | `on` | tier 2 live title capture |
| `WINB_TITLES_PERSIST` | `0` | write titles into the on-disk timeline |
| `WINB_TITLE_RING_MIN` | `60` | RAM ring length for titles |
| `WINB_SAMPLE_SEC` | `60` | sampler interval |
| `WINB_HISTORY` | `1` | write `history/*.jsonl` |
| `WINB_HISTORY_DAYS` | `7` | raw timeline retention |
| `WINB_APP_DAYS` | `90` | app-usage rollup retention |
| `WINB_HISTORY_MAX_MB` | `64` | history size cap (oldest files pruned first) |
| `WINB_PRIVATE_API` | `1` | require token for private endpoints even on loopback |
| `WINB_DISK_WARN_PCT` | `10` | disk warning threshold for the watcher |

## 13. Failure modes

| Symptom | Behaviour |
|---|---|
| PowerShell helper dies | respawn; 3 failures -> transient spawns -> event-log only, flagged in `/state.tracking.degraded` |
| Helper pipe is wedged | after 3 failed ticks the wedged child is killed so the next tick starts a fresh one (*as built*) |
| A tick never returns | the next interval takes over after a stall window instead of the sampler going quiet forever (*as built*) |
| Volume stalls, sync fs blocks the loop | observed on a real host: `appendFileSync` on a stalled volume blocks the event loop, so HTTP stops answering while the port stays open. Mitigation is outside the process: the watchdog's hang recovery below (*as built*) |
| PowerShell unavailable/policy-blocked | fall back to event logs + disk + `quser`; app tracking reports `unavailable` |
| No elevation | Security log absent (expected, documented); everything else works |
| History dir unwritable | log to `server.log`, keep serving from the live ring |
| Clock/timezone oddity | events carry the host offset; cursor comparisons are monotonic on byte offset, not wall clock |
| Host unreachable | nothing to read; the watcher reports `net.down` |
| Health fails while the port is still held | after 4 consecutive strikes the watchdog kills the node process holding the port and respawns it; a foreign process holding the port is reported, never killed (*as built*) |

## 14. Tests

Extend `tests/smoke_local.sh` (OS-agnostic surface) and add a phase-4 live suite:

Live suite `tests/verify_phase4.py` (18 checks) covers: private endpoints 401 without a token even
on loopback, manifest caps + tracking block, sampler health, the `/state` contract (host, power,
session, disks, network, resources, foreground app, live titles), helper path versus degraded path,
`/timeline` content and ordering, the `kinds` filter, titles absent from disk while persistence is
off, `/apps` rollup, `/events/since` baseline and no-replay, retention accounting, and latency.

`tests/smoke_local.sh` (35 checks, no Windows needed) covers the same endpoints on a POSIX host,
where the sampler degrades to node-level resource samples.

## 15. Rollout

1. Review this spec, adjust the flagged assumptions.
2. Implement behind the existing env pattern; no change to `/run`, `fs.*`, `proc.*`, sessions.
3. **v1.4 ships as its own branch and PR**, opened after v1.3 (PR #2) merges.
4. v1.3 clients keep working untouched; every new endpoint is additive.

## 16. Assumptions to confirm

- Tier 0+1+2 on from the first run; titles live + recent window only, not written to disk.
- Persistent helper child preferred over transient PowerShell spawns.
- Retention: raw timeline 7 days, app rollups 90 days.
- Watcher transport left to the operator (cron initially, systemd timer when the gateway runs one).
- No Security-log support until the server itself runs elevated.
