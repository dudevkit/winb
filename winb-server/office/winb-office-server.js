/**
 * winb-office-server.js - execution bridge for the OFFICE Windows PC (v1.3.0-office).
 *
 * Same API surface as the home winb-server: it loads the shared api.js, which carries
 * every fix from the 2026-11-01 hardening (64 mb body limit, forced UTF-8, process-tree
 * kill on timeout, multi-line cmd staging, bounded output with spill, typed fs/proc
 * endpoints, sticky sessions, persisted job records).
 *
 * Differences from the home bootstrap:
 *   - the port comes from WINB_PORT (default 5110),
 *   - the default scratch dir comes from WINB_DEFAULT_CWD (this machine has no
 *     the temp scratch dir unless WINB_DEFAULT_CWD was set),
 *   - the allowed write roots come from WINB_ALLOWED_ROOTS,
 *   - SERVICE_NAME keeps the health line distinguishable from the home server.
 *
 * Auth: requests are checked against .token, but loopback is always trusted. The office
 * PC is only reachable through the bastion reverse tunnel, and the tunnel delivers
 * connections from 127.0.0.1, so the bridge stays the security boundary. The token is
 * still worth having: it covers the case where 5110 is reachable directly on an office
 * network. A missing token file means fail-open (recovery hatch).
 *
 * Usage:
 *   node winb-office-server.js
 *   WINB_PORT=5110 WINB_DEFAULT_CWD="C:\\winb-scratch" node winb-office-server.js
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = Number(process.env.WINB_PORT || 5110);
const startedAt = new Date();
const SERVER_VERSION = '1.3.0-office';
const BODY_LIMIT_MB = 64;
const TOKEN_FILE = path.join(__dirname, '.token');
const SCRATCH_DIR = process.env.WINB_DEFAULT_CWD || process.env.TEMP || __dirname;

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
    service: 'winb-office'
};

// The Reload Endpoint MUST be defined before loading api.js so its route is not wiped
// out by the HMR cleanup slice. cleanupApi() runs before require(), so a broken api.js
// removes every route: validate with `node --check` before hitting /reload.
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
    console.log(`winb-office server running on http://0.0.0.0:${PORT} (${SERVER_VERSION})`);
});
