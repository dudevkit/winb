#!/usr/bin/env python3
"""Client behaviour suite for winb v2 (replaces the v1-vs-v2 migration matrix).

The old matrix compared v1 (`/usr/local/bin/winb.v1.sh`) against v2. That comparison is
retired: v1 cannot send the bearer token the v1.3 server now requires, so every call
except loopback returns 401. Rolling the client back therefore also requires disabling
server auth (delete the PC's `.token`), which is the documented recovery hatch.

This suite asserts the documented v2 behaviour directly.

Usage: python3 verify_client.py   (WINB_HOST/WINB_PORT/WINB_URL, token as above)
"""

import hashlib
import json
import os
import statistics
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


def winb(args, timeout=300):
    proc = subprocess.run([WINB] + args, capture_output=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def http(method, path, payload=None, token=True):
    req = urllib.request.Request(HOST + path, method=method,
                                 data=json.dumps(payload).encode() if payload is not None else None)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name:36} {detail}")


def server_pid():
    return json.loads(http("GET", "/health", token=False)[1])["pid"]


# --- execution basics
code, out, _ = winb(["echo hi"])
check("stdout preserved byte exact", (code, out) == (0, b"hi\r\n"), repr(out))

code, out, _ = winb(["-p", "Write-Output ps-ok"])
check("powershell path", (code, out) == (0, b"ps-ok\r\n"), repr(out))

code, _, _ = winb(["-p", "exit 7"])
code2, _, _ = winb(["cmd /c exit 3"])
check("exit codes propagate", (code, code2) == (7, 3), f"{code}, {code2}")

code, out, err = winb(["-p", "[Console]::Error.Write('ERRONLY')"])
check("stderr stays separate", code == 0 and out == b"" and b"ERRONLY" in err, f"stdout={out!r}")

code, out, _ = winb(["-p", "[Console]::Out.Write(('x'*200000))"])
check("200 KB stdout intact", code == 0 and len(out) == 200000, f"{len(out)} bytes")

code, out, _ = winb(["-p", "[Console]::Out.Write([char]0x2713)"])
check("utf-8 via powershell", out == b"\xe2\x9c\x93", out.hex())

code, out, _ = winb(["-p", "[Console]::Out.Write('A'+[char]0+'B')"])
check("NUL preserved", b"A\x00B" in out, out.hex()[:24])

code, out, _ = winb(["echo alpha\necho beta"])
check("multi-line cmd", b"alpha" in out and b"beta" in out, out.decode().strip().replace("\r\n", "|"))

code, out, _ = winb(["--json", "echo hi"])
envelope = json.loads(out) if out.strip() else {}
check("--json envelope", {"status", "exitCode", "stdout", "stderr"} <= set(envelope), list(envelope)[:5])

# --- latency
samples = []
for _ in range(5):
    start = time.time()
    winb(["echo hi"])
    samples.append(time.time() - start)
median = round(statistics.median(samples), 3)
check("latency < 0.5 s", median < 0.5, f"median {median}s")

# --- files
out_path = "/tmp/client-suite-out.log"
if os.path.exists(out_path):
    os.remove(out_path)
code, out, _ = winb(["--out", out_path, "-p", "[Console]::Out.Write(('y'*50000))"])
check("--out byte exact", os.path.getsize(out_path) == 50000, f"{os.path.getsize(out_path)} bytes")

script = "/tmp/client-suite-cmd.txt"
with open(script, "w", encoding="utf-8") as fh:
    fh.write("Write-Output 'from-cmd-file'\n")
code, out, _ = winb(["--cmd-file", script, "-p"])
check("--cmd-file", b"from-cmd-file" in out, out.decode().strip()[:24])

payload = os.urandom(200000)
src, dst = "/tmp/client-suite-src.bin", "/tmp/client-suite-dst.bin"
with open(src, "wb") as fh:
    fh.write(payload)
remote = os.path.join(SCRATCH, "client-suite.bin")
up = winb(["put", src, remote])
down = winb(["get", remote, dst])
same = os.path.exists(dst) and open(dst, "rb").read() == payload
check("put/get 200KB verified", up[0] == 0 and down[0] == 0 and same and b"verified" in up[1],
      f"{'identical' if same else 'MISMATCH'}")

big = "/tmp/client-suite-stdin.txt"
with open(big, "w") as fh:
    fh.write("\n".join(f"line-{i}-winb" for i in range(8000)))
start = time.time()
code, out, _ = winb(["--stdin-file", big, "find /c \"winb\""], timeout=120)
check("90 KB stdin works", code == 0 and time.time() - start < 30,
      f"{round(time.time() - start, 1)}s count={out.decode().strip()}")

# --- failure paths
pid_before = server_pid()
code, _, err = winb(["-w", "F:\\client-suite-missing", "echo hi"])
pid_after = server_pid()
check("bad workdir: no crash", code == 1 and pid_before == pid_after,
      f"pid {pid_before} -> {pid_after}")

start = time.time()
code, _, _ = winb(["-t", "5", "python -m http.server 8894"], timeout=120)
elapsed = round(time.time() - start, 1)
time.sleep(2)
_, pc, _ = winb(["--port", "8894"])
check("timeout bounded + tree killed", code == 124 and elapsed < 15 and b"not listening" in pc,
      f"{elapsed}s code={code}")

status, _ = http("POST", "/run", {"command": "echo hi"}, token=False)
status_health, _ = http("GET", "/health", token=False)
check("auth: 401 without token", status == 401 and status_health == 200, f"run={status} health={status_health}")

# cleanup
winb(["rm", remote], timeout=120)
for path in (out_path, script, src, dst, big):
    try:
        os.remove(path)
    except OSError:
        pass

failed = [r for r in RESULTS if not r[1]]
print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
sys.exit(1 if failed else 0)
