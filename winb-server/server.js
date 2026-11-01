const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = express();
// Required here and in api.js: the require cache makes both references the same instance,
// which is what lets GET /reload swap api.js without leaking sampler children or timers.
const sampler = require('./sampler.js');
const PORT = Number(process.env.WINB_PORT || 5110);
const startedAt = new Date();
const SERVER_VERSION = '1.4.0';
const BODY_LIMIT_MB = Number(process.env.WINB_BODY_LIMIT_MB || 64);
const TOKEN_FILE = process.env.WINB_TOKEN_FILE || path.join(__dirname, '.token');
const LOG_FILE = path.join(__dirname, 'server.log');
const LOG_ROTATE_BYTES = Number(process.env.WINB_LOG_ROTATE_MB || 20) * 1024 * 1024;
const LOG_KEEP = Number(process.env.WINB_LOG_KEEP || 2);

// 64 mb instead of the 100 kb default: --stdin-file and file payloads above ~75 KB
// used to fail with an HTML 413 that surfaced as a cryptic parse error.
app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));

// ---------------------------------------------------------------- auth
// Applied before every route, including /reload. Loopback is always trusted so local
// scripts and watchdogs keep working; other callers need the bearer token from
// .token (or WINB_TOKEN). No token file means fail-open: that is the documented
// recovery hatch when a token is lost, and the reason not to delete it casually.
function loadToken() {
    if (process.env.WINB_TOKEN) return process.env.WINB_TOKEN.trim();
    try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function isLoopback(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const PUBLIC_PATHS = new Set(['/ping', '/health']);

// Endpoints that describe who uses this host and what they run. A local process reaches a
// loopback socket for free, so with WINB_PRIVATE_API on (default) these require the token even
// from localhost. Turn it off only when a local tool genuinely cannot be handed the token.
const PRIVATE_PATHS = new Set(['/state', '/timeline', '/events/since', '/apps', '/history/purge']);
const PRIVATE_API = !['0', 'off', 'false', 'no'].includes(String(process.env.WINB_PRIVATE_API || 'on').toLowerCase());

app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const expected = loadToken();
    const needsToken = PRIVATE_API && PRIVATE_PATHS.has(req.path);
    if (!needsToken && isLoopback(req)) return next();
    if (!expected) return next();
    if ((req.get('Authorization') || '') === `Bearer ${expected}`) return next();
    console.log(`[AUTH] 401 ${req.method} ${req.path} from ${req.socket.remoteAddress}${needsToken ? ' (private endpoint)' : ''}`);
    return res.status(401).json({ error: 'unauthorized: send Authorization: Bearer <token>' });
});

// ---------------------------------------------------------------- log rotation
// stdout is redirected to server.log by the launcher, so the file handle is opened
// before this process starts. Renaming while held fails on Windows (EBUSY); the rename
// only succeeds when the handle is closed, which is why rotation is attempted here and
// reported through /health instead of silently ignored.
function rotateLogIfNeeded() {
    try {
        const size = fs.statSync(LOG_FILE).size;
        if (size < LOG_ROTATE_BYTES) return null;
        for (let i = LOG_KEEP; i >= 1; i--) {
            const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
            const to = `${LOG_FILE}.${i}`;
            try { if (fs.existsSync(to)) fs.unlinkSync(to); } catch (_) { /* best effort */ }
            try { fs.renameSync(from, to); } catch (_) { /* handle still open */ }
        }
        return fs.existsSync(LOG_FILE) ? 'rename-failed-handle-open' : 'rotated';
    } catch (_) {
        return null;
    }
}

const rotation = rotateLogIfNeeded();

// Central state that survives hot reloads
const processes = new Map();
const serverState = {
    startedAt,
    version: SERVER_VERSION,
    port: PORT,
    hmr: true,
    workdir: process.env.WINB_DEFAULT_CWD || path.join(os.tmpdir(), 'winb-scratch'),
    platform: process.platform,
    pid: process.pid,
    bodyLimitMB: BODY_LIMIT_MB,
    rotation
};

// The Reload Endpoint MUST be defined before loading api.js
// so that its route is not wiped out by the HMR cleanup slice.
app.get('/reload', (req, res) => {
    try {
        // Keep a single-response guarantee: cleanupApi() runs first, so a broken
        // api.js would remove every route (including /health) and the watchdog would
        // refuse to restart while the port is still listening. Validate before reloading.
        if (cleanupApi) cleanupApi();
        delete require.cache[require.resolve('./api.js')];
        cleanupApi = require('./api.js')(app, processes, serverState);
        console.log('[HOT RELOAD] API routes updated successfully.');
        sampler.record({ kind: 'bridge.reload', src: 'bridge', data: { version: SERVER_VERSION, pid: process.pid } });
        res.json({ status: 'reloaded', activeProcesses: processes.size });
    } catch (err) {
        console.error('[HOT RELOAD ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// Initialize dynamic API routes
let cleanupApi = require('./api.js')(app, processes, serverState);

app.listen(PORT, () => {
    console.log(`winB server listening on http://0.0.0.0:${PORT} (HMR enabled, v${SERVER_VERSION})`);
    if (rotation) console.log(`[LOG ROTATION] ${rotation}`);
    // Host context sampler: starts with the server, one row per change plus one resource
    // sample per interval. WINB_TRACK=off leaves it idle but answering. See sampler.js.
    const status = sampler.start();
    console.log(`[SAMPLER] ${status.enabled ? (status.supported ? 'enabled' : 'enabled (non-windows: resource samples only)') : 'disabled by WINB_TRACK'} :: sample ${status.sampleSec}s, titles ${status.titles ? 'on' : 'off'}${status.titles && !status.titlesPersist ? ' (live-only)' : ''}, history ${status.history ? status.historyDir : 'off'}`);
});

const shutdown = (signal) => {
    console.log(`[SHUTDOWN] ${signal}: closing sampler`);
    try { sampler.stop(); } catch (_) { /* best effort on the way out */ }
    process.exit(0);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
