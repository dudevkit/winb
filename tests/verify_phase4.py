#!/usr/bin/env python3
"""Phase-4 acceptance tests: host context surface (/state, /timeline, /apps, sampler).

Requires a live server v1.4+ on the Windows host:

    export WINB_HOST=<host-ip>
    export WINB_TOKEN_FILE=~/.winb-token
    python3 tests/verify_phase4.py

Checks 1-18 cover: private-endpoint auth, the /state contract, sampler health, timeline
integrity, cursor semantics, retention accounting, and the promise that window titles do
not reach the disk when WINB_TITLES_PERSIST is off.

Non-destructive by default: the purge check keeps the retention window. Set
WINB_TEST_PURGE=1 to also run the full wipe (days=0) which empties the timeline.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


def _host():
    if os.environ.get("WINB_URL"):
        return os.environ["WINB_URL"]
    if os.environ.get("WINB_SERVER_URL"):
        return os.environ["WINB_SERVER_URL"]
    return "http://%s:%s" % (os.environ.get("WINB_HOST", "127.0.0.1"),
                             os.environ.get("WINB_PORT", "5110"))


def _token():
    for path in (os.environ.get("WINB_TOKEN_FILE"), os.path.expanduser("~/.winb-token"),
                 "/etc/winb-token"):
        if path and os.path.exists(path):
            with open(path) as fh:
                value = fh.read().strip()
            if value:
                return value
    return os.environ.get("WINB_TOKEN", "")


WINB = os.environ.get("WINB_CLI", "winb")
HOST = _host()
TOKEN = _token()
RESULTS = []


def winb(args, timeout=300):
    proc = subprocess.run([WINB] + args, capture_output=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def http(method, path, payload=None, timeout=60, auth=True):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(HOST + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if auth and TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def get_json(path, timeout=60, auth=True):
    status, body = http("GET", path, timeout=timeout, auth=auth)
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, {"_raw": body[:200]}


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name:44} {detail}")


if not TOKEN:
    print("no token found (WINB_TOKEN_FILE / ~/.winb-token): the private endpoints will 401")
print(f"host {HOST}\n")

# 1 - private endpoints refuse callers without the token, even from loopback
status_noauth, _ = http("GET", "/state", auth=False)
loopback = any(h in HOST for h in ("127.0.0.1", "localhost", "::1"))
check("1 /state refuses an unauthenticated caller", status_noauth == 401 if TOKEN else status_noauth in (200, 401),
      f"HTTP {status_noauth}{' (loopback: WINB_PRIVATE_API must be on)' if loopback else ''}")

# 2 - manifest advertises the surface and the tracking config
status, manifest = get_json("/manifest")
caps = set(manifest.get("capabilities") or [])
tracking = manifest.get("tracking") or {}
check("2 manifest caps + tracking block",
      status == 200 and {"state", "timeline", "apps", "history.purge"} <= caps and tracking,
      f"{len(caps)} caps, tracking keys={len(tracking)}")

# 3 - sampler is running on a windows host
check("3 sampler running", tracking.get("enabled") and tracking.get("sampling")
      and tracking.get("supported") and tracking.get("platform") == "win32",
      f"enabled={tracking.get('enabled')} sampling={tracking.get('sampling')} platform={tracking.get('platform')}")

# 4 - /state contract
status, state = get_json("/state")
host = state.get("host") or {}
power = state.get("power") or {}
check("4 /state host + power", status == 200 and "win32" in str(host.get("platform"))
      and host.get("cpus", 0) > 0 and power.get("uptimeSec", 0) > 0 and power.get("bootTime"),
      f"{host.get('name')} {host.get('cpus')}cpu base={str(power.get('bootTime'))[:19]}")

# 5 - session: user, idle seconds, derived state
session = state.get("session") or {}
check("5 /state session", "\\" in str(session.get("user")) and isinstance(session.get("idleSec"), int)
      and session.get("state") in ("active", "idle", "away"),
      f"{session.get('user')} state={session.get('state')} idle={session.get('idleSec')}s locked={session.get('locked')}")

# 6 - disks and adapters
disks = state.get("disk") or []
net = state.get("net") or []
check("6 /state disk + net", bool(disks) and all("freeGb" in d and "pct" in d for d in disks) and bool(net),
      f"{len(disks)} drive(s), {len(net)} adapter(s)")

# 7 - resources
res = state.get("res") or {}
check("7 /state resources", (res.get("procCount") or 0) > 30 and bool(res.get("cpuTop"))
      and (res.get("memUsedMb") or 0) > 0,
      f"{res.get('procCount')} procs, mem {res.get('memUsedMb')} MB, top={res.get('cpuTop')[:1]}")

# 8 - foreground app tracking
apps = state.get("apps") or {}
active = apps.get("active")
check("8 /state foreground app", bool(active) and str(active.get("app", "")).endswith(".exe")
      and isinstance(active.get("durSec"), int),
      f"{active.get('app') if active else None} for {active.get('durSec') if active else '?'}s")

# 9 - titles: live in /state, and the windows list carries them
if tracking.get("titles"):
    windows = apps.get("windows") or []
    check("9 titles live in /state", active is not None and "title" in active
          and bool(windows) and any(w.get("title") for w in windows),
          f"{len(windows)} window(s), fg title={str(active.get('title'))[:40]!r}" if active else "no foreground app")
else:
    check("9 titles off by config", tracking.get("titles") is False, "WINB_TITLES=off")

# 10 - helper process is the healthy path, not the fallback
check("10 probe helper healthy", tracking.get("lastSource") == "helper" and tracking.get("helper") == "running"
      and not tracking.get("degraded"),
      f"source={tracking.get('lastSource')} helper={tracking.get('helper')} degraded={bool(tracking.get('degraded'))}")

# 11 - timeline carries samples and app switches, newest first
status, timeline = get_json("/timeline?hours=2&limit=200")
events = timeline.get("events") or []
kinds = {e.get("kind") for e in events}
times = [e.get("t") for e in events]
check("11 /timeline content + ordering", status == 200 and "res.sample" in kinds and "app.switch" in kinds
      and times == sorted(times, reverse=True),
      f"{len(events)} events, kinds={sorted(kinds)[:6]}")

# 12 - kinds filter is honoured
status, filtered = get_json("/timeline?hours=2&kinds=res.sample&limit=20")
check("12 /timeline kinds filter", status == 200
      and all(e.get("kind") == "res.sample" for e in filtered.get("events") or []),
      f"{len(filtered.get('events') or [])} rows, all res.sample")

# 13 - titles must not reach the disk unless persistence is asked for
history_dir = tracking.get("historyDir") or ""
titles_persist = bool(tracking.get("titlesPersist"))
script = (
    "$d = '%s'; $f = Get-ChildItem (Join-Path $d 'state-*.jsonl') | Sort-Object Name | Select-Object -Last 1; "
    "if ($f) { $c = Get-Content $f.FullName; [pscustomobject]@{ file = $f.Name; lines = $c.Count; "
    "switches = @($c | Select-String -SimpleMatch 'app.switch').Count; "
    "withTitle = @($c | Select-String -SimpleMatch '\"title\"').Count } | ConvertTo-Json -Compress } else { '{}' }"
) % history_dir.replace("'", "''")
code, out, err = winb(["-p", script])
try:
    disk = json.loads(out.decode("utf-8", "replace").strip() or "{}")
except json.JSONDecodeError:
    disk = {}
disk_ok = bool(disk.get("file")) and disk.get("lines", 0) > 0
title_ok = (disk.get("withTitle", 0) > 0) if titles_persist else (disk.get("withTitle", 0) == 0)
check("13 titles on disk match WINB_TITLES_PERSIST", code == 0 and disk_ok and title_ok,
      f"{disk.get('file')} rows={disk.get('lines')} switches={disk.get('switches')} rowsWithTitle={disk.get('withTitle')} persist={titles_persist}")

# 14 - app usage rollup
status, rollup = get_json("/apps?days=1")
first = (rollup.get("apps") or [{}])[0]
check("14 /apps rollup", status == 200 and rollup.get("apps") and first.get("app")
      and isinstance(first.get("minutes"), (int, float)) and first.get("runs", 0) >= 1,
      f"{rollup.get('count')} app(s), top={first.get('app')} {first.get('minutes')}min/{first.get('runs')}runs")

# 15 - app duration comes from closed segments plus the open one
usage_ok = any((a.get("minutes") or 0) > 0 for a in rollup.get("apps") or [])
check("15 usage minutes accumulate", usage_ok,
      f"minutes>0 for {sum(1 for a in rollup.get('apps') or [] if (a.get('minutes') or 0) > 0)} app(s)")

# 16 - cursor: baseline is quiet, then advances without replaying
status, base = get_json("/events/since")
cursor = base.get("cursor") or ""
time.sleep(int(tracking.get("sampleSec") or 60) + 3)
status, delta = get_json("/events/since?cursor=" + cursor)
again_status, replay = get_json("/events/since?cursor=" + (delta.get("cursor") or ""))
check("16 /events/since baseline + no replay",
      status == 200 and base.get("count") == 0 and delta.get("count", 0) >= 1
      and replay.get("count") == 0 and delta.get("cursor") != cursor,
      f"baseline={base.get('count')} new={delta.get('count')} immediate-replay={replay.get('count')}")

# 17 - retention accounting (non destructive unless WINB_TEST_PURGE=1)
days = 0 if os.environ.get("WINB_TEST_PURGE") == "1" else 7
status, purge = get_json(f"/history/purge?days={days}")
has_shape = status == 200 and "removed" in purge and "kept" in purge and purge.get("keepDays") == days
if days == 0:
    time.sleep(int(tracking.get("sampleSec") or 60) + 3)
    status, after = get_json("/events/since")
    check("17 purge days=0 wipes + sampler continues", has_shape and status == 200
          and not after.get("events"), f"removed={purge.get('removedCount')} kept={purge.get('kept')}")
else:
    check("17 purge reports the window", has_shape and purge.get("removedCount") == 0,
          f"removed={purge.get('removedCount')} kept={purge.get('kept')} window={purge.get('keepDays')}d")

# 18 - latency of the on-demand calls (context is only worth it if it is cheap)
start = time.time()
get_json("/state")
state_ms = (time.time() - start) * 1000
start = time.time()
get_json("/timeline?hours=24&limit=200")
timeline_ms = (time.time() - start) * 1000
check("18 latency", state_ms < 1500 and timeline_ms < 4000, f"/state {state_ms:.0f} ms, /timeline {timeline_ms:.0f} ms")

failed = [r for r in RESULTS if not r[1]]
print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
if os.environ.get("WINB_TEST_PURGE") != "1":
    print("purge check ran with days=7 (kept the window); set WINB_TEST_PURGE=1 for the full wipe")
sys.exit(1 if failed else 0)
