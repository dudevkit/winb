#!/usr/bin/env bash
# Assemble the office PC kit.
#
# The office kit is not a fork anymore: it ships the upstream server files unchanged
# (server.js, api.js, sampler.js, sampler-probe.ps1, package.json, package-lock.json)
# plus the office scaffolding in this folder, flattened into one directory so the
# installer can copy it to C:\winb-office as a unit.
#
# Everything office-specific is expressible as deployment settings in
# server-env.office.ps1 (bind host, version suffix, working dir, write roots), which is
# why updating this kit later is "cut a new kit", not "port a patch".
#
# Usage: office-pc/build-office-kit.sh [output-dir]      (default: <repo>/dist)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-$REPO/dist}"
STAGE="$OUT/winb-office-kit"
ZIP="$OUT/winb-office-kit.zip"

SERVER_FILES=(
  server.js
  api.js
  sampler.js
  sampler-probe.ps1
  package.json
  package-lock.json
)
OFFICE_FILES=(
  README-OFFICE.md
  setup-winb-office.ps1
  winb-office-tray.ps1
  winb-office-tunnel.ps1
  start-winb-office.vbs
  STATUS-WINB-OFFICE.cmd
  server-env.office.ps1
)

missing=0
for f in "${SERVER_FILES[@]}"; do
  [ -f "$REPO/winb-server/$f" ] || { echo "missing upstream file: winb-server/$f" >&2; missing=1; }
done
for f in "${OFFICE_FILES[@]}"; do
  [ -f "$HERE/$f" ] || { echo "missing office file: office-pc/$f" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1

rm -rf "$STAGE"
mkdir -p "$STAGE"
for f in "${SERVER_FILES[@]}"; do cp "$REPO/winb-server/$f" "$STAGE/$f"; done
for f in "${OFFICE_FILES[@]}"; do cp "$HERE/$f" "$STAGE/$f"; done

# A zip without a top-level folder explodes into the caller's cwd; keep the folder.
python3 - "$STAGE" "$ZIP" <<'PY'
import os, sys, zipfile
stage, zpath = sys.argv[1], sys.argv[2]
base = os.path.dirname(stage)
with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(stage):
        for name in sorted(files):
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, base))
print("zip:", zpath)
PY

# The version this kit will report, straight from the file the server reads.
grep -m1 "SERVER_VERSION = " "$REPO/winb-server/server.js" || true
ls -l "$ZIP"
