#!/usr/bin/env python3
"""Phase-2 acceptance tests for the winb bridge.

Each test maps to one item in the audit's acceptance list
(docs/AUDIT-2026-11-01.md, section 3). Run it after any
change to api.js / server.js / the client.

Usage: python3 verify_phase2.py
"""

import hashlib
import json
import os
import statistics
import subprocess
import sys
import time
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


def _scratch():
    """Directory used for round-trip artifacts: WINB_TEST_DIR, else whatever the
    server reports as its default working directory, else the temp area."""
    for key in ("WINB_TEST_DIR", "WINB_DEFAULT_CWD"):
        if os.environ.get(key):
            return os.environ[key]
    try:
        req = urllib.request.Request(_host() + "/manifest", method="GET")
        if _token():
            req.add_header("Authorization", "Bearer " + _token())
        with urllib.request.urlopen(req, timeout=15) as resp:
            cwd = json.loads(resp.read().decode("utf-8", "replace")).get("defaultCwd")
        if cwd:
            return cwd
    except Exception:
        pass
    return os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or r"C:\Windows\Temp",
                        "winb-tests")


WINB = os.environ.get("WINB_CLI", "winb")
HOST = _host()
TOKEN = _token()
SCRATCH = _scratch()
RESULTS = []


def winb(args, timeout=180):
    proc = subprocess.run([WINB] + args, capture_output=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def http(method, path, payload=None, token=True, timeout=20):
    url = HOST + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token and TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name:38} {detail}")


def server_pid():
    _, body = http("GET", "/health", token=False)
    return json.loads(body)["pid"]


# 1 - latency
samples = []
for _ in range(5):
    start = time.time()
    winb(["echo hi"])
    samples.append(time.time() - start)
median = round(statistics.median(samples), 3)
check("1 latency < 0.5 s", median < 0.5, f"median {median}s")

# 2 - UTF-8 through PowerShell
code, out, _ = winb(["-p", "[Console]::Out.Write([char]0x2713)"])
check("2 utf-8 via powershell", out == b"\xe2\x9c\x93", out.hex() or "empty")

# 3 - 300 KB upload with sha verification
src = "/tmp/phase2-src.bin"
with open(src, "wb") as fh:
    fh.write(os.urandom(300000))
remote = os.path.join(SCRATCH, "phase2-roundtrip.bin")
code, out, err = winb(["put", src, remote], timeout=300)
check("3 put 300KB sha256 verified", code == 0 and b"verified" in out, out.decode().strip()[:60])

# 4 - timeout kills the tree and answers
start = time.time()
code, out, err = winb(["-t", "5", "python -m http.server 8895"], timeout=120)
elapsed = round(time.time() - start, 1)
time.sleep(2)
_, pc, _ = winb(["--port", "8895"])
check("4 timeout bounded + tree killed", elapsed < 15 and b"not listening" in pc,
      f"{elapsed}s, port {'free' if b'not listening' in pc else 'STILL OPEN'}")

# 5 - multi-line cmd runs every line
code, out, _ = winb(["echo alpha\necho beta"])
check("5 multi-line cmd", b"alpha" in out and b"beta" in out, out.decode().strip().replace("\r\n", "|")[:40])

# 6 - auth
s_run, _ = http("POST", "/run", {"command": "echo hi"}, token=False)
s_hlt, _ = http("GET", "/health", token=False)
s_rld, _ = http("GET", "/reload", token=False)
s_tok, _ = http("GET", "/list", token=True)
check("6 auth enforced", (s_run, s_rld, s_tok) == (401, 401, 200) and s_hlt == 200,
      f"run={s_run} reload={s_rld} health={s_hlt} list(token)={s_tok}")

# 7 - --out writes the full stream
big = "/tmp/phase2-big.log"
if os.path.exists(big):
    os.remove(big)
code, out, _ = winb(["--out", big, "-p", "[Console]::Out.Write(('q'*250000))"])
size = os.path.getsize(big) if os.path.exists(big) else -1
check("7 --out byte exact", size == 250000, f"{size} bytes")

# 8 - a bad workdir must not kill the server
pid_before = server_pid()
code, out, err = winb(["-w", "F:\\phase2-nonexistent-dir", "echo hi"])
pid_after = server_pid()
check("8 bad workdir: clean 400, no crash", code == 1 and pid_before == pid_after,
      f"pid {pid_before} -> {pid_after}, msg={err.decode().strip().splitlines()[0][:48]}")

# 9 - NUL bytes survive
code, out, _ = winb(["-p", "[Console]::Out.Write('A'+[char]0+'B')"])
check("9 NUL preserved", b"A\x00B" in out, out.hex()[:24])

# 10 - 200 KB stdin no longer hangs
with open("/tmp/phase2-stdin.txt", "w") as fh:
    fh.write("\n".join(f"line-{i}-winb" for i in range(8000)))
start = time.time()
code, out, _ = winb(["--stdin-file", "/tmp/phase2-stdin.txt", "find /c \"winb\""], timeout=120)
elapsed = round(time.time() - start, 1)
check("10 200KB stdin, no hang", code == 0 and elapsed < 30, f"{elapsed}s, count={out.decode().strip()}")

# 11 - manifest
status, body = http("GET", "/manifest")
m = json.loads(body) if status == 200 else {}
ok = status == 200 and m.get("host") and m.get("tools", {}).get("python") and m.get("drives") and m.get("limits")
check("11 manifest complete", bool(ok),
      f"host={m.get('host')} python={m.get('tools', {}).get('python')} drives={len(m.get('drives') or [])}")

# 12 - background records survive a hot reload
winb(["-b", "-id", "phase2-persist", "ping -n 3 127.0.0.1 > nul"])
time.sleep(5)
http("GET", "/reload")
_, out, _ = winb(["-l"])
check("12 jobs survive reload", b"phase2-persist" in out, out.decode().splitlines()[:2])

# 13 - truncation is reported, not silent
code, out, _ = winb(["--json", "-p", "[Console]::Out.Write(('z'*3000000))"])
envelope = json.loads(out) if out.strip() else {}
check("13 output cap + spill path", envelope.get("truncated") is True
      and envelope.get("stdoutBytes") == 3000000 and envelope.get("stdoutSpill"),
      f"{envelope.get('stdoutBytes')} bytes, spill={bool(envelope.get('stdoutSpill'))}")

# cleanup
winb(['del /q "%s" 2>nul' % os.path.join(SCRATCH, "phase2-roundtrip.bin")]) if False else None
for path in (src, big, "/tmp/phase2-stdin.txt"):
    try:
        os.remove(path)
    except OSError:
        pass

failed = [r for r in RESULTS if not r[1]]
print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
sys.exit(1 if failed else 0)
