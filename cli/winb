#!/bin/bash

# Target winb-server on Windows. Override with env (portable defaults — no host-specific IPs):
#   WINB_HOST / WINB_PORT  or full  WINB_URL
# Optional proxy (only if YOU set it — e.g. userspace Tailscale SOCKS on a gateway):
#   WINB_SOCKS=socks5h://127.0.0.1:1055
#   or ALL_PROXY / HTTP_PROXY / http_proxy
# WINB_NOPROXY=1 forces direct (clears using WINB_SOCKS only; does not unset caller proxies)
WINB_HOST="${WINB_HOST:-192.168.1.100}"
WINB_PORT="${WINB_PORT:-5110}"
SERVER_URL="${WINB_URL:-http://${WINB_HOST}:${WINB_PORT}}"
if [[ -n "${WINB_SOCKS:-}" && -z "${WINB_NOPROXY:-}" ]]; then
  # Opt-in only: do not invent a default SOCKS for every clone
  if [[ -z "${ALL_PROXY:-}${HTTP_PROXY:-}${http_proxy:-}" ]]; then
    export ALL_PROXY="${WINB_SOCKS}"
  fi
fi

show_help() {
    echo "Usage: winb [OPTIONS] \"command\""
    echo "Executes a command on the remote Windows PC via winb-server."
    echo "Server: $SERVER_URL  (set WINB_HOST/WINB_PORT or WINB_URL)"
    echo ""
    echo "Env:"
    echo "  WINB_HOST   Windows host (default: 192.168.1.100)"
    echo "  WINB_PORT   Port (default: 5110)"
    echo "  WINB_URL    Full base URL (overrides host/port)"
    echo "  WINB_SOCKS  Optional SOCKS/HTTP proxy URL for curl (opt-in only)"
    echo "  WINB_NOPROXY=1  Do not apply WINB_SOCKS"
    echo ""
    echo "Options:"
    echo "  -h, --help               Show this help message"
    echo "  -w, --workdir <dir>      Working directory on the Windows PC (e.g. F:/AliceWorkspace)"
    echo "  -b, --background         Run command in background (returns immediately)"
    echo "  -id, --process-id <id>   Custom process ID for background task (optional, pairs with -b)"
    echo "  -l, --list               List active/background process records"
    echo "  --logs <id>              Show captured logs for a background process"
    echo "  --tail <n>               Number of log lines to show with --logs (default 80, max 500)"
    echo "  --health                 Show winb-server health/status"
    echo "  --open-url <url>         Open a URL in the Windows default browser"
    echo "  --port <port>            Check whether a Windows TCP port is in use"
    echo "  -k, --kill <id>          Kill a background process by ID"
    echo "  -p, --powershell         Run using PowerShell instead of cmd"
    echo "  -e, --env KEY=VALUE      Add environment variable for command (repeatable)"
    echo "  -t, --timeout <sec>      Timeout in seconds (for foreground tasks)"
    echo ""
    echo "Examples:"
    echo "  export WINB_HOST=192.168.1.100 WINB_PORT=5110"
    echo "  winb --health"
    echo "  winb -w 'F:/AliceWorkspace/my-app' 'npm run dev'"
    echo "  winb -b -id server1 'python app.py'"
    echo "  winb -l"
    echo "  winb --open-url http://localhost:3000"
    echo "  winb --port 3000"
    echo "  winb --logs server1 --tail 50"
    echo "  winb -e PORT=3001 -e NODE_ENV=development 'npm run dev'"
    echo "  winb -k server1"
    echo "  winb -p \"Get-Process | Where-Object Name -eq 'node'\""
    echo "  winb -t 10 'ping 8.8.8.8'"
    echo "  # Userspace Tailscale gateway (opt-in):"
    echo "  export WINB_HOST=100.x.x.x WINB_SOCKS=socks5h://127.0.0.1:1055"
}

COMMAND=""
WORKDIR=""
BACKGROUND="false"
PROCESS_ID=""
LIST="false"
LOGS_ID=""
TAIL=80
HEALTH="false"
OPEN_URL=""
PORT_CHECK=""
KILL_ID=""
POWERSHELL="false"
ENV_ARGS=()
TIMEOUT=0

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -w|--workdir)
            WORKDIR="$2"
            shift 2
            ;;
        -b|--background)
            BACKGROUND="true"
            shift 1
            ;;
        -id|--process-id)
            PROCESS_ID="$2"
            shift 2
            ;;
        -l|--list)
            LIST="true"
            shift 1
            ;;
        --logs)
            LOGS_ID="$2"
            shift 2
            ;;
        --tail)
            TAIL="$2"
            shift 2
            ;;
        --health)
            HEALTH="true"
            shift 1
            ;;
        --open-url)
            OPEN_URL="$2"
            shift 2
            ;;
        --port)
            PORT_CHECK="$2"
            shift 2
            ;;
        -k|--kill)
            KILL_ID="$2"
            shift 2
            ;;
        -p|--powershell)
            POWERSHELL="true"
            shift 1
            ;;
        -e|--env)
            ENV_ARGS+=("$2")
            shift 2
            ;;
        -t|--timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        *)
            if [[ -z "$COMMAND" ]]; then
                COMMAND="$1"
            else
                COMMAND="$COMMAND $1"
            fi
            shift 1
            ;;
    esac
done

# Handle KILL action
if [[ -n "$KILL_ID" ]]; then
    PAYLOAD=$(jq -n --arg pid "$KILL_ID" '{processId: $pid}')
    curl -s --connect-timeout 5 --max-time 30 -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$SERVER_URL/kill"
    echo ""
    exit 0
fi

# Handle OPEN URL action
if [[ -n "$OPEN_URL" ]]; then
    PAYLOAD=$(jq -n --arg url "$OPEN_URL" '{url: $url}')
    RESPONSE=$(curl -s --connect-timeout 5 --max-time 30 -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$SERVER_URL/open-url")
    if [[ $? -ne 0 ]]; then
        echo "Error: Could not connect to winb-server at $SERVER_URL" >&2
        exit 1
    fi
    ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
    if [[ -n "$ERROR" ]]; then
        echo "Error: $ERROR" >&2
        exit 1
    fi
    echo "$RESPONSE" | jq -r '"Opened URL: \(.url) (status: \(.status))"'
    exit 0
fi

# Handle PORT CHECK action
if [[ -n "$PORT_CHECK" ]]; then
    RESPONSE=$(curl -s --connect-timeout 5 --max-time 30 "$SERVER_URL/port/$PORT_CHECK")
    if [[ $? -ne 0 ]]; then
        echo "Error: Could not connect to winb-server at $SERVER_URL" >&2
        exit 1
    fi
    ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
    if [[ -n "$ERROR" ]]; then
        echo "Error: $ERROR" >&2
        exit 1
    fi
    echo "$RESPONSE" | jq -r '
        "Port \(.port): " + (if .listening then "LISTENING" else "not listening" end),
        (if (.connections | length) == 0 then "No TCP connections found."
         else (.connections[] | "  - \(.state) PID \(.pid) " + ((.processName // "unknown") | tostring) + " @ \(.localAddress):\(.localPort)") end)
    '
    exit 0
fi

# Handle LIST action
if [[ "$LIST" == "true" ]]; then
    RESPONSE=$(curl -s --connect-timeout 5 --max-time 30 "$SERVER_URL/list")
    if [[ $? -ne 0 ]]; then
        echo "Error: Could not connect to winb-server at $SERVER_URL" >&2
        exit 1
    fi
    echo "$RESPONSE" | jq -r 'if (.processes | length) == 0 then "No background process records." else "Background Process Records:\n" + (.processes[] | "  - \(.processId) (PID: \(.pid), \(.status)) :: \(.command)") end'
    exit 0
fi

# Handle HEALTH action
if [[ "$HEALTH" == "true" ]]; then
    RESPONSE=$(curl -s --connect-timeout 5 --max-time 30 "$SERVER_URL/health")
    if [[ $? -ne 0 ]]; then
        echo "Error: Could not connect to winb-server at $SERVER_URL" >&2
        exit 1
    fi
    echo "$RESPONSE" | jq -r '
        "Winb Server: \(.status | ascii_upcase)",
        "Version: \(.version)",
        "HMR: \(.hmr)",
        "PID: \(.pid)",
        "Port: \(.port)",
        "Platform: \(.platform)",
        "Workdir: \(.workdir)",
        "Started: \(.startedAt)",
        "Now: \(.now)",
        "Uptime: \(.uptimeSeconds)s",
        "Processes: \(.processes.records) records, \(.processes.running) running, \(.processes.exited) exited"
    '
    exit 0
fi

# Handle LOGS action
if [[ -n "$LOGS_ID" ]]; then
    RESPONSE=$(curl -s --connect-timeout 5 --max-time 30 "$SERVER_URL/logs/$LOGS_ID?tail=$TAIL")
    if [[ $? -ne 0 ]]; then
        echo "Error: Could not connect to winb-server at $SERVER_URL" >&2
        exit 1
    fi
    ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
    if [[ -n "$ERROR" ]]; then
        echo "Error: $ERROR" >&2
        exit 1
    fi
    echo "$RESPONSE" | jq -r '
        "Process: \(.processId) (PID: \(.pid), \(.status))",
        "Command: \(.command)",
        "Workdir: \(.workdir)",
        "--- STDOUT ---",
        (if (.stdout | length) == 0 then "(empty)" else .stdout[] end),
        "--- STDERR ---",
        (if (.stderr | length) == 0 then "(empty)" else .stderr[] end)
    '
    exit 0
fi

# Require command for normal execution
if [[ -z "$COMMAND" ]]; then
    echo "Error: Command is required."
    echo ""
    show_help
    exit 1
fi

# Build environment JSON safely from repeatable -e/--env KEY=VALUE flags
ENV_JSON='{}'
for item in "${ENV_ARGS[@]}"; do
    if [[ "$item" != *=* ]]; then
        echo "Error: env must use KEY=VALUE format: $item" >&2
        exit 1
    fi
    key="${item%%=*}"
    value="${item#*=}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        echo "Error: invalid env key: $key" >&2
        exit 1
    fi
    ENV_JSON=$(echo "$ENV_JSON" | jq --arg k "$key" --arg v "$value" '. + {($k): $v}')
done

# Construct JSON payload safely using jq to avoid string escaping issues
PAYLOAD=$(jq -n \
    --arg cmd "$COMMAND" \
    --arg cwd "$WORKDIR" \
    --argjson bg "$BACKGROUND" \
    --arg pid "$PROCESS_ID" \
    --argjson ps "$POWERSHELL" \
    --argjson to "$TIMEOUT" \
    --argjson env "$ENV_JSON" \
    '{
        command: $cmd,
        workdir: (if $cwd == "" then null else $cwd end),
        background: $bg,
        processId: (if $pid == "" then null else $pid end),
        powershell: $ps,
        timeout: $to,
        env: $env
    }')

# Execute request (curl -f would hide body; keep -s and check exit + empty)
RESPONSE=$(curl -s --connect-timeout 5 --max-time "${CURL_MAX_TIME:-120}" -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$SERVER_URL/run")
CURL_RC=$?
if [[ $CURL_RC -ne 0 ]]; then
    echo "Error: Could not connect to winb-server at $SERVER_URL (curl exit $CURL_RC)" >&2
    exit 1
fi

# Format output
if [[ "$BACKGROUND" == "true" ]]; then
    echo "$RESPONSE" | jq -r 'if .error then "Error: \(.error)" else "Started background process ID: \(.processId) (PID: \(.pid))" end'
else
    ERROR=$(echo "$RESPONSE" | jq -r '.error // empty')
    if [[ -n "$ERROR" ]]; then
        echo "Server Error: $ERROR" >&2
        exit 1
    fi
    
    STDOUT=$(echo "$RESPONSE" | jq -r '.stdout // empty')
    STDERR=$(echo "$RESPONSE" | jq -r '.stderr // empty')
    STATUS=$(echo "$RESPONSE" | jq -r '.status // empty')
    EXIT_CODE=$(echo "$RESPONSE" | jq -r '.exitCode // empty')
    
    if [[ -n "$STDOUT" ]]; then echo -n "$STDOUT"; fi
    if [[ -n "$STDERR" ]]; then echo -n "$STDERR" >&2; fi
    
    if [[ "$STATUS" == "timeout" ]]; then
        echo -e "\n[Timeout reached after ${TIMEOUT}s]" >&2
        exit 124
    fi
    
    exit ${EXIT_CODE:-0}
fi
