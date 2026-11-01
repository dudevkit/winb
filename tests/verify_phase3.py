#!/usr/bin/env python3
"""Phase-3/4 acceptance tests: typed operations (fs/proc), sessions, transfer.

Run after any change to api.js / server.js / the client:
    python3 tests/verify_phase3.py   (WINB_HOST/WINB_PORT/WINB_URL + token as above)
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
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
RESULTS = []
SCRATCH = _scratch()


def winb(args, timeout=300):
    proc = subprocess.run([WINB] + args, capture_output=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def http(method, path, payload=None, timeout=60, raw_path=False):
    url = path if raw_path else HOST + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name:40} {detail}")


# 1 - manifest advertises the typed surface
status, body = http("GET", "/manifest")
manifest = json.loads(body) if status == 200 else {}
caps = manifest.get("capabilities") or []
check("1 manifest capabilities", status == 200 and {"fs.read", "fs.write", "proc.list", "sessions"} <= set(caps)
      and manifest.get("allowedWriteRoots"), f"{len(caps)} caps, roots={manifest.get('allowedWriteRoots')}")

# 2/3 - stat + list against a file we control
payload = os.urandom(65536)
local = "/tmp/phase3-a.bin"
with open(local, "wb") as fh:
    fh.write(payload)
code, out, err = winb(["put", local, SCRATCH + "\\phase3-a.bin"])
digest = hashlib.sha256(payload).hexdigest()
status, body = http("GET", f"/fs/stat?path={SCRATCH}\\phase3-a.bin&sha256=1".replace("\\", "%5C"))
stat = json.loads(body)
check("2 fs.stat + sha256", stat.get("exists") and stat.get("size") == 65536 and stat.get("sha256") == digest,
      f"size={stat.get('size')} sha_ok={stat.get('sha256') == digest}")

status, body = http("GET", "/fs/list?path=" + SCRATCH.replace("\\", "%5C") + "&pattern=" + "phase3")
listing = json.loads(body)
check("3 fs.list pattern", status == 200 and any(e["name"] == "phase3-a.bin" for e in listing.get("entries", [])),
      f"{listing.get('count')} entries")

# 4 - typed write + read round trip
blob = os.urandom(40000)
status, body = http("POST", "/fs/write", {"path": SCRATCH + "\\phase3-b.bin",
                                          "dataB64": __import__("base64").b64encode(blob).decode(),
                                          "sha256": True})
written = json.loads(body)
status, body = http("GET", f"/fs/read?path={SCRATCH}\\phase3-b.bin".replace("\\", "%5C") + "&encoding=base64")
read_back = __import__("base64").b64decode(json.loads(body)["content"])
check("4 fs.write/read round trip", read_back == blob and written.get("sha256") == hashlib.sha256(blob).hexdigest(),
      f"{written.get('bytes')} bytes")

# 5 - write outside the allowed roots is refused
status, _ = http("POST", "/fs/write", {"path": "C:\\Windows\\Temp\\phase3-nope.txt", "text": "x"})
check("5 write outside roots refused", status == 403, f"HTTP {status}")

# 6 - destructive guards
status_root, _ = http("POST", "/fs/rm", {"path": "F:\\", "recursive": True})
status_dir, _ = http("POST", "/fs/rm", {"path": SCRATCH})
status_file, _ = http("POST", "/fs/rm", {"path": SCRATCH + "\\phase3-b.bin"})
check("6 rm guards", (status_root, status_dir, status_file) == (400, 400, 200),
      f"root={status_root} dir={status_dir} file={status_file}")

# 7 - mkdir + move
http("POST", "/fs/mkdir", {"path": SCRATCH + "\\phase3-dir"})
status, _ = http("POST", "/fs/move", {"from": SCRATCH + "\\phase3-a.bin",
                                      "to": SCRATCH + "\\phase3-dir\\phase3-a.bin"})
status2, body = http("GET", f"/fs/stat?path={SCRATCH}\\phase3-dir\\phase3-a.bin".replace("\\", "%5C"))
check("7 mkdir + move", status == 200 and json.loads(body).get("exists"), f"move HTTP {status}")

# 8 - process list
status, body = http("GET", "/proc/list?filter=node&limit=5")
procs = json.loads(body)
check("8 proc.list", status == 200 and procs.get("count", 0) > 0 and all("pid" in p for p in procs["processes"]),
      f"{procs.get('count')} node processes")

# 9 - typed transfer of 2 MB, byte identical
big = os.urandom(2_000_000)
src, dst = "/tmp/phase3-big.bin", "/tmp/phase3-big.back"
with open(src, "wb") as fh:
    fh.write(big)
code_put, out_put, _ = winb(["put", src, SCRATCH + "\\phase3-big.bin"])
code_get, out_get, _ = winb(["get", SCRATCH + "\\phase3-big.bin", dst])
same = os.path.exists(dst) and open(dst, "rb").read() == big
check("9 typed transfer 2MB", code_put == 0 and code_get == 0 and same
      and b"typed fs" in out_put, f"{'identical' if same else 'MISMATCH'}")

# 10 - chunked read out of a file
read_out = "/tmp/phase3-read.bin"
code, _, _ = winb(["read", SCRATCH + "\\phase3-big.bin", "--out", read_out])
sames = os.path.exists(read_out) and open(read_out, "rb").read() == big
check("10 winb read --out", code == 0 and sames, f"{'identical' if sames else 'MISMATCH'}")

# 11 - sessions
http("POST", "/session", {"id": "phase3", "workdir": SCRATCH, "env": {"PHASE3": "on"}})
code, out, _ = winb(["-s", "phase3", "echo sess=%PHASE3%"])
code2, out2, _ = winb(["-s", "phase3", "-w", SCRATCH, "cd"])
status_unknown, _ = http("POST", "/run", {"cmdB64": "Y2Q=", "session": "phase3-missing"})
http("DELETE", "/session/phase3")
check("11 sessions", b"sess=on" in out and (SCRATCH.encode()) in out2 and status_unknown == 400,
      f"env={'ok' if b'sess=on' in out else 'no'} override={'ok' if SCRATCH.encode() in out2 else 'no'} unknown={status_unknown}")

# 12 - raw api passthrough
code, out, _ = winb(["api", "GET", "/fs/stat?path=" + SCRATCH.replace("\\", "%5C")])
check("12 api passthrough", code == 0 and b'"exists": true' in out.replace(b'"exists":true', b'"exists": true'),
      out.decode()[:60].replace("\n", " "))

# cleanup
winb(["rm", SCRATCH + "\\phase3-big.bin"], timeout=120)
winb(["rm", SCRATCH + "\\phase3-dir\\phase3-a.bin"], timeout=120)
winb(["rm", SCRATCH + "\\phase3-dir", "--recursive"], timeout=120)
for path in (local, src, dst, read_out):
    try:
        os.remove(path)
    except OSError:
        pass

failed = [r for r in RESULTS if not r[1]]
print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
sys.exit(1 if failed else 0)
