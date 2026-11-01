# Deployment settings for winb-server.
#
# Copy to server-env.ps1 (same folder as server.js) and edit. winb-tray.ps1 and watchdog.ps1
# dot-source that file before spawning node, so a manual start and an automatic respawn carry
# identical settings. Everything here is optional: anything unset falls back to the defaults
# documented in README.md.
#
# The file is PowerShell, so values must be quoted strings. server-env.ps1 itself is
# gitignored - deployment settings are not repository content.

# --- transport -------------------------------------------------------------------------
# Listen port (default 5110)
# $env:WINB_PORT = '5110'

# Bearer token for non-loopback callers. Prefer the .token file next to server.js; set this
# only when a service wrapper has to supply the token from the environment.
# Describe the value, never commit it: a 64 character hex string.
# $env:WINB_TOKEN = '<YOUR_TOKEN>'

# --- paths -----------------------------------------------------------------------------
# Working directory for calls that do not pass one (default: <tmp>\winb-scratch)
# $env:WINB_DEFAULT_CWD = '<SCRATCH_DIRECTORY>'

# Semicolon separated write allow-list. Reads are never restricted.
# $env:WINB_ALLOWED_ROOTS = '<ROOT_1>;<ROOT_2>'

# Where the event timeline is written (default: <server folder>\history)
# $env:WINB_HISTORY_DIR = '<HISTORY_DIRECTORY>'

# $env:WINB_BODY_LIMIT_MB = '64'
# $env:WINB_OUTPUT_CAP_MB = '2'
# $env:WINB_MAX_READ_MB = '8'

# --- host context sampler (v1.4) --------------------------------------------------------
# Tracking is on by default. Window titles live in a RAM ring only; they reach
# history/*.jsonl solely when WINB_TITLES_PERSIST=1.
# $env:WINB_TRACK = 'on'
# $env:WINB_TITLES = 'on'
# $env:WINB_TITLES_PERSIST = '0'
# $env:WINB_TITLE_RING_MIN = '60'
# $env:WINB_SAMPLE_SEC = '60'
# $env:WINB_HISTORY = '1'
# $env:WINB_HISTORY_DAYS = '7'
# $env:WINB_APP_DAYS = '90'
# $env:WINB_HISTORY_MAX_MB = '64'
# $env:WINB_PRIVATE_API = '1'
# $env:WINB_DISK_WARN_PCT = '10'
