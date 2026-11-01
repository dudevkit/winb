#!/usr/bin/env bash
# Local smoke test for the server pair, without a Windows host.
#
# Boots api.js/server.js on a temporary port against a temporary root and drives
# the OS-agnostic surface: auth, /health, /manifest, fs.*, sessions, /reload.
# Exec testing needs cmd.exe/PowerShell, so it is deliberately out of scope.
#
# It exists because the ported code has host-dependent paths: the allowed-root
# comparison, the scratch default and the codepage prefix. Run it after touching
# api.js or server.js - it catches those classes without a Windows machine.
#
# Usage: tests/smoke_local.sh            (needs node + npm + curl + python3)

set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${WINB_TEST_PORT:-5199}"
ROOT="$(mktemp -d)"
SRV="$ROOT/srv"
DATA="$ROOT/data"
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SERVER_PID=""
PASS=0
FAIL=0

cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    rm -rf "$ROOT"
}
trap cleanup EXIT

check() { # check <name> <expected-substring> <actual>
    if [[ "$3" == *"$2"* ]]; then
        echo "  [PASS] $1"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] $1"
        echo "         expected to contain: $2"
        echo "         got:                 ${3:0:200}"
        FAIL=$((FAIL + 1))
    fi
}

api() { # api <METHOD> <path> [json] [auth:yes|no]
    local method="$1" path="$2" body="${3:-}" auth="${4:-yes}"
    local args=(-s -X "$method" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN")
    [[ "$auth" == "no" ]] && args=(-s -X "$method" -H 'Content-Type: application/json')
    [[ -n "$body" ]] && args+=(--data-binary "$body")
    curl "${args[@]}" "http://127.0.0.1:$PORT$path"
}

status_of() { # status_of <url> [auth-header-value]
    curl -s -o /dev/null -w '%{http_code}' ${2:+-H "Authorization: Bearer $2"} "$1"
}

echo "== preparing ($ROOT)"
mkdir -p "$SRV" "$DATA/scratch"
cp "$HERE/winb-server/api.js" "$HERE/winb-server/server.js" "$HERE/winb-server/package.json" "$SRV/"
( cd "$SRV" && npm install --silent --no-audit --no-fund >/dev/null 2>&1 ) || {
    echo "npm install failed - is npm on PATH?"; exit 2; }

WINB_PORT="$PORT" WINB_TOKEN="$TOKEN" WINB_DEFAULT_CWD="$DATA/scratch" \
    WINB_ALLOWED_ROOTS="$DATA" node "$SRV/server.js" >"$ROOT/run.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
    sleep 0.5
done

echo "== checks"
check "1  /health is public"            '"status":"ok"'      "$(api GET /health '' no)"
check "2  version reported"             '"version":"1.3.0"'  "$(api GET /health '' no)"
check "3  token accepted"                '"defaultCwd"'      "$(api GET /manifest)"
check "4  /manifest lists caps"          '"fs.write"'        "$(api GET /manifest)"
check "5  allowed roots from env"        "$DATA"             "$(api GET /manifest)"

# Non-loopback callers must present the token. Skipped when the host has no
# routable address (containers, offline CI).
LANIP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -n "$LANIP" ]]; then
    check "6  no token from LAN -> 401" "401" "$(status_of "http://$LANIP:$PORT/manifest")"
    check "7  bad token from LAN -> 401" "401" "$(status_of "http://$LANIP:$PORT/manifest" wrong)"
else
    echo "  [SKIP] 6-7 no non-loopback address on this host"
fi

F="$DATA/hello.txt"
check "8  fs.write inside a root"       '"bytes"'           "$(api POST /fs/write "{\"path\":\"$F\",\"text\":\"round trip\",\"mkdirs\":true,\"sha256\":true}")"
check "9  fs.stat + sha256"             '"exists":true'     "$(api GET "/fs/stat?path=$F&sha256=1")"
check "10 fs.read returns content"      'round trip'        "$(api GET "/fs/read?path=$F")"
check "11 fs.list finds the file"       'hello.txt'         "$(api GET "/fs/list?path=$DATA")"
check "12 write outside roots refused"  'outside the allowed write roots' "$(api POST /fs/write "{\"path\":\"$ROOT/escape.txt\",\"text\":\"nope\"}")"
check "13 mkdir"                        '"created"'         "$(api POST /fs/mkdir "{\"path\":\"$DATA/sub\"}")"
check "14 move"                         '"moved"'           "$(api POST /fs/move "{\"from\":\"$F\",\"to\":\"$DATA/sub/hello.txt\"}")"
check "15 rm dir needs recursive"       'recursive'         "$(api POST /fs/rm "{\"path\":\"$DATA/sub\"}")"
check "16 rm recursive works"           '"deleted"'         "$(api POST /fs/rm "{\"path\":\"$DATA/sub\",\"recursive\":true}")"
# The message differs by platform: a Windows drive root is "too close to a
# root", anything outside an allowed root is refused earlier. Both are refusals.
check "17 rm of a root is refused"      'error'             "$(api POST /fs/rm "{\"path\":\"/\",\"recursive\":true}")"
check "18 session round trip"           'smoke'             "$(api POST /session '{"id":"smoke","workdir":"'"$DATA"'"}' ; api GET /session)"
check "19 session delete"               'deleted'           "$(api DELETE /session/smoke)"
check "20 /reload keeps the API alive"  '"status":"reloaded"' "$(api GET /reload)"
check "21 /health after reload"         '"status":"ok"'      "$(api GET /health '' no)"

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
