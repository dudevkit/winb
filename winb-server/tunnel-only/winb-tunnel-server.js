/**
 * winb-tunnel-server.js - bootstrap for a host that is reachable only through a tunnel.
 *
 * Loads the same shared api.js, so the API surface and every hardening fix are identical
 * to the default server. Use this bootstrap instead of server.js when the machine must
 * present its own service identity, or when its launcher (tray, scheduled task, service
 * wrapper) is one you do not control and you want the health line to say which host
 * answered.
 *
 * Everything is environment driven:
 *   WINB_PORT             listen port (default 5110)
 *   WINB_TOKEN, WINB_TOKEN_FILE   bearer token (default .token next to this file)
 *   WINB_DEFAULT_CWD      working directory for calls that pass none
 *   WINB_ALLOWED_ROOTS    ";"-separated write roots
 *   WINB_BODY_LIMIT_MB    JSON body limit (default 64)
 *
 * Auth: identical to server.js - a valid bearer token is required from every non-loopback
 * caller, /ping and /health stay public, and a missing token file means fail-open (the
 * documented recovery hatch). When the host is reached through a reverse tunnel the
 * forwarder connects from 127.0.0.1 and is therefore trusted, which makes the loopback
 * endpoint the real boundary. Keep the token anyway: it covers the case where the port is
 * reachable directly on some other network.
 *
 * Usage:
 *   node winb-tunnel-server.js
 *   WINB_PORT=5110 WINB_DEFAULT_CWD="C:\\winb-scratch" node winb-tunnel-server.js
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = express();
const PORT = Number(process.env.WINB_PORT || 5110);
const startedAt = new Date();
const SERVER_VERSION = '1.3.0-tunnel';
const BODY_LIMIT_MB = Number(process.env.WINB_BODY_LIMIT_MB || 64);
const TOKEN_FILE = process.env.WINB_TOKEN_FILE || path.join(__dirname, '.token');
const SCRATCH_DIR = process.env.WINB_DEFAULT_CWD || path.join(os.tmpdir(), 'winb-scratch');

// 64 mb instead of the 100 kb default: file payloads above ~75 KB used to fail with an
// HTML 413 that surfaced as a cryptic parse error.
app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));

function loadToken() {
    if (process.env.WINB_TOKEN) return process.env.WINB_TOKEN.trim();
    try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function isLoopback(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const PUBLIC_PATHS = new Set(['/ping', '/health']);
app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || isLoopback(req)) return next();
    const expected = loadToken();
    if (!expected) return next();
    if ((req.get('Authorization') || '') === `Bearer ${expected}`) return next();
    console.log(`[AUTH] 401 ${req.method} ${req.path} from ${req.socket.remoteAddress}`);
    return res.status(401).json({ error: 'unauthorized: send Authorization: Bearer <token>' });
});

// Central state that survives hot reloads
const processes = new Map();
const serverState = {
    startedAt,
    version: SERVER_VERSION,
    port: PORT,
    hmr: true,
    workdir: SCRATCH_DIR,
    platform: process.platform,
    pid: process.pid,
    bodyLimitMB: BODY_LIMIT_MB,
    service: process.env.WINB_SERVICE_NAME || 'winb-tunnel'
};

// The reload endpoint MUST be defined before loading api.js so its route is not wiped out
// by the HMR cleanup slice. cleanupApi() runs before require(), so a broken api.js removes
// every route: validate with `node --check` before hitting /reload.
app.get('/reload', (req, res) => {
    try {
        if (cleanupApi) cleanupApi();
        delete require.cache[require.resolve('./api.js')];
        cleanupApi = require('./api.js')(app, processes, serverState);
        console.log('[HOT RELOAD] API routes updated successfully.');
        res.json({ status: 'reloaded', activeProcesses: processes.size });
    } catch (err) {
        console.error('[HOT RELOAD ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

let cleanupApi = require('./api.js')(app, processes, serverState);

app.listen(PORT, () => {
    console.log(`winb-tunnel server running on http://0.0.0.0:${PORT} (${SERVER_VERSION})`);
});
