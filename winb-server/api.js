const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Singleton: require cache keeps one instance across GET /reload. The sampler owns the
// probe child process and the sampling interval, so it must live outside this module's
// lifecycle or every reload would leak another one.
const sampler = require('./sampler.js');

// ---------------------------------------------------------------- config

const SERVER_DIR = __dirname;
const TOKEN_FILE = process.env.WINB_TOKEN_FILE || path.join(SERVER_DIR, '.token');
const JOBS_FILE = path.join(SERVER_DIR, 'jobs.json');
const LOG_FILE = path.join(SERVER_DIR, 'server.log');
// Default working directory for commands that do not pass one. Nothing machine
// specific: an explicit WINB_DEFAULT_CWD is expected in real deployments.
const SCRATCH_DIR = process.env.WINB_DEFAULT_CWD || path.join(os.tmpdir(), 'winb-scratch');
const OUTPUT_CAP = Number(process.env.WINB_OUTPUT_CAP_MB || 2) * 1024 * 1024;   // bytes kept in the response
const MANIFEST_TTL = 10 * 60 * 1000;       // device probe cache
const DEFAULT_TIMEOUT = 0;                 // 0 = no server-side timeout (client bounds it)
const SESSIONS_FILE = path.join(SERVER_DIR, 'sessions.json');
const MAX_READ_BYTES = Number(process.env.WINB_MAX_READ_MB || 8) * 1024 * 1024;

// Writes, moves and deletes are confined to these roots. Reads are not restricted
// (reading a binary or a log elsewhere in the system is normal agent work).
// Safe by default: only the scratch directory and the system temp area. Set
// WINB_ALLOWED_ROOTS (semicolon separated, e.g. "D:\\;C:\\work") to widen it.
const ALLOWED_ROOTS = (process.env.WINB_ALLOWED_ROOTS
    ? process.env.WINB_ALLOWED_ROOTS.split(';')
    : [SCRATCH_DIR, os.tmpdir()])
    .map((p) => p.trim()).filter(Boolean);

// Auth is enforced in server.js. A token file (or WINB_TOKEN) turns it on; a
// missing token means fail-open, which is the documented recovery hatch.

// ---------------------------------------------------------------- helpers

function loadToken() {
    if (process.env.WINB_TOKEN) return process.env.WINB_TOKEN.trim();
    try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function isSafeUrl(url) {
    if (typeof url !== 'string' || url.trim().length === 0) return false;
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch (_) {
        return false;
    }
}

function buildChildEnv(extraEnv = {}) {
    const childEnv = { ...process.env, ...extraEnv };
    const pathKey = Object.prototype.hasOwnProperty.call(childEnv, 'Path') ? 'Path' : 'PATH';
    const pathParts = (childEnv[pathKey] || '').split(';').filter(Boolean);
    const npmGlobalPath = path.join(process.env.APPDATA || os.homedir(), 'npm');
    if (!pathParts.some(p => p.toLowerCase() === npmGlobalPath.toLowerCase())) {
        pathParts.unshift(npmGlobalPath);
    }
    childEnv[pathKey] = pathParts.join(';');
    // UTF-8 by default: python tools output UTF-8 regardless of console codepage.
    // Explicit user env vars win (set earlier via the spread), so only fill defaults.
    if (!Object.prototype.hasOwnProperty.call(childEnv, 'PYTHONUTF8')) childEnv.PYTHONUTF8 = '1';
    if (!Object.prototype.hasOwnProperty.call(childEnv, 'PYTHONIOENCODING')) childEnv.PYTHONIOENCODING = 'utf-8';
    return childEnv;
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
}

function normalizePath(p) {
    return path.resolve(p).replace(/[\\/]+$/, '');
}

// path.sep, not '\\': the guard must compare with the separator of the host it runs
// on, otherwise every POSIX deployment refuses every write.
function isAllowedForWrite(target) {
    const norm = normalizePath(target).toLowerCase();
    return ALLOWED_ROOTS.some((root) => {
        const r = normalizePath(root).toLowerCase();
        return norm === r || norm.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
    });
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadSessions() {
    try {
        const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        return new Map(Object.entries(raw));
    } catch (_) {
        return new Map();
    }
}

function saveSessions(sessions) {
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 0));
    } catch (_) { /* best effort */ }
}

/**
 * Bounded output collector. Keeps up to OUTPUT_CAP bytes in memory for the HTTP
 * response and spills the remainder to a %TEMP% file so nothing is silently lost.
 */
function makeSink(label) {
    const chunks = [];
    let total = 0;
    let stream = null;
    let spillPath = null;

    const sink = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        total += buf.length;
        if (total <= OUTPUT_CAP) {
            chunks.push(buf);
            return;
        }
        if (!stream) {
            spillPath = path.join(os.tmpdir(), `winb-${label}-${crypto.randomUUID()}.log`);
            stream = fs.createWriteStream(spillPath);
            if (chunks.length) stream.write(Buffer.concat(chunks));
        }
        stream.write(buf);
    };
    sink.text = () => Buffer.concat(chunks).toString('utf8');
    sink.bytes = () => total;
    sink.truncated = () => !!stream;
    sink.spillPath = () => spillPath;
    sink.close = () => new Promise((resolve) => {
        if (stream) stream.end(resolve); else resolve();
    });
    return sink;
}

/** Kill a process tree. child.kill() only reaches cmd.exe, which leaks grandchildren. */
function killTree(pid, done) {
    if (!pid) return done();
    const killer = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true });
    killer.once('close', () => done());
    killer.once('error', () => done());
}

function loadJobs(processes) {
    try {
        const raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        for (const entry of raw) {
            if (!entry || !entry.processId) continue;
            entry.stdoutLines = entry.stdoutLines || [];
            entry.stderrLines = entry.stderrLines || [];
            if (!entry.exited && entry.pid) {
                // A record from a previous process generation can never still be running.
                entry.exited = true;
                entry.exitCode = entry.exitCode ?? null;
                entry.note = 'stale record from a previous server process';
            }
            processes.set(entry.processId, entry);
        }
    } catch (_) { /* no prior records */ }
}

let saveTimer = null;
function saveJobs(processes) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const trimmed = Array.from(processes.values()).slice(-60).map((e) => ({ ...e, stdoutLines: e.stdoutLines.slice(-200), stderrLines: e.stderrLines.slice(-200) }));
            fs.writeFileSync(JOBS_FILE, JSON.stringify(trimmed));
        } catch (_) { /* best effort */ }
    }, 250);
}

// ---------------------------------------------------------------- module

module.exports = function (app, processes, serverState = {}) {
    const initialStackLength = app._router.stack.length;
    const version = serverState.version || '1.4.0';

    // Auth lives in server.js, registered before /reload, so it also covers the reload
    // endpoint. Loading the module by hand (without server.js) leaves the API open, which
    // is the intended recovery hatch.

    app.use((req, res, next) => {
        res.on('finish', () => {
            if (req.path !== '/reload') console.log(`[HTTP] ${req.method} ${req.path} - ${res.statusCode}`);
        });
        next();
    });

    loadJobs(processes);

    // ---- manifest: one call that replaces a dozen device probes
    let manifestCache = { at: 0, data: null };
    const runProbe = (command, powershell) => new Promise((resolve) => {
        const child = spawn(command, [], {
            shell: powershell ? 'powershell.exe' : true,
            windowsHide: true,
            env: buildChildEnv({})
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.once('close', () => resolve(out.trim()));
        child.once('error', () => resolve(''));
    });

    async function buildManifest() {
        const [python, node, git, drives] = await Promise.all([
            runProbe('python -V', false),
            runProbe('node --version', false),
            runProbe('git --version', false),
            runProbe('Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n=\'FreeGB\';e={[math]::Round($_.Free/1GB,1)}},@{n=\'UsedGB\';e={[math]::Round($_.Used/1GB,1)}} | ConvertTo-Json -Compress', true)
        ]);
        let driveList = [];
        try { driveList = JSON.parse(drives || '[]'); } catch (_) { driveList = []; }
        if (!Array.isArray(driveList)) driveList = [driveList];
        return {
            host: os.hostname(),
            platform: `${os.platform()} ${os.release()} ${os.arch()}`,
            cpus: os.cpus().length,
            memoryGB: +(os.totalmem() / 1e9).toFixed(1),
            node: process.version,
            serverVersion: version,
            defaultCwd: SCRATCH_DIR,
            shells: ['cmd', 'powershell'],
            tools: { python, node, git },
            drives: driveList.map((d) => ({ name: d.Name, freeGB: d.FreeGB, usedGB: d.UsedGB })),
            capabilities: ['exec', 'put', 'get', 'fs.stat', 'fs.list', 'fs.read', 'fs.write',
                'fs.mkdir', 'fs.move', 'fs.rm', 'proc.list', 'proc.kill', 'proc.logs',
                'port.check', 'open-url', 'manifest', 'jobs', 'sessions',
                'state', 'timeline', 'apps', 'history.purge'],
            // What is being collected about this host, always inspectable without reading code.
            tracking: sampler.status(),
            allowedWriteRoots: ALLOWED_ROOTS,
            limits: {
                bodyMB: serverState.bodyLimitMB || 0.1,
                outputCapMB: +(OUTPUT_CAP / 1048576).toFixed(1),
                defaultTimeout: DEFAULT_TIMEOUT,
                stdinMaxBytes: Math.floor((serverState.bodyLimitMB || 0.1) * 1024 * 1024 * 0.7)
            },
            authRequired: !!loadToken(),
            generatedAt: new Date().toISOString()
        };
    }

    app.get('/manifest', (req, res) => {
        const force = req.query.refresh === '1';
        const fresh = force || !manifestCache.data || Date.now() - manifestCache.at > MANIFEST_TTL;
        // tracking is merged live, not cached: the manifest cache is 10 minutes and the
        // tracking flags are exactly what an operator wants to see as it currently is.
        if (!fresh) return res.json({ ...manifestCache.data, tracking: sampler.status() });
        buildManifest()
            .then((data) => {
                manifestCache = { at: Date.now(), data };
                res.json({ ...data, tracking: sampler.status() });
            })
            .catch((err) => {
                // never leak a rejection: an unhandled one takes the whole server down
                res.status(500).json({ error: `manifest failed: ${err.message}` });
            });
    });

    // ---- exec
    app.post('/run', (req, res) => {
        const {
            command,
            cmdB64,
            stdinB64,
            workdir,
            session,
            background = false,
            processId,
            powershell = false,
            timeout = 0,
            env = {}
        } = req.body;

        // A session supplies default cwd/env; explicit arguments always win.
        const sessionEntry = session ? sessions.get(session) : null;
        if (session && !sessionEntry) {
            return res.status(400).json({ error: `session not found: ${session}` });
        }
        const effectiveWorkdir = workdir || (sessionEntry && sessionEntry.workdir) || null;
        const effectiveEnv = { ...((sessionEntry && sessionEntry.env) || {}), ...(env || {}) };

        let finalCommand = command;
        if (cmdB64) {
            try {
                finalCommand = Buffer.from(cmdB64, 'base64').toString('utf8');
            } catch (err) {
                return res.status(400).json({ error: `Invalid cmdB64: ${err.message}` });
            }
        }
        if (!finalCommand) return res.status(400).json({ error: 'Command is required' });
        if (env === null || Array.isArray(env) || typeof env !== 'object') {
            return res.status(400).json({ error: 'env must be an object of KEY=VALUE strings' });
        }

        const cleanEnv = {};
        for (const [key, value] of Object.entries(effectiveEnv)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                return res.status(400).json({ error: `Invalid env key: ${key}` });
            }
            cleanEnv[key] = String(value);
        }

        // Workdir is validated BEFORE spawning: a bad cwd used to make spawn fail,
        // which answered 500 and then a second response on the same socket, killing
        // the whole node process (ERR_HTTP_HEADERS_SENT).
        let cwd = effectiveWorkdir || SCRATCH_DIR;
        if (!effectiveWorkdir) ensureDir(cwd);   // only the scratch default is created on demand
        if (!fs.existsSync(cwd)) {
            return res.status(400).json({ error: `workdir not found on the PC: ${cwd}` });
        }
        try {
            if (!fs.statSync(cwd).isDirectory()) {
                return res.status(400).json({ error: `workdir is not a directory: ${cwd}` });
            }
        } catch (err) {
            return res.status(400).json({ error: `workdir unusable: ${err.message}` });
        }

        const tempFiles = [];
        let shell = true;
        if (powershell) shell = 'powershell.exe';

        let stdinBuffer = null;
        if (stdinB64) {
            try {
                stdinBuffer = Buffer.from(stdinB64, 'base64');
            } catch (err) {
                return res.status(400).json({ error: `Invalid stdinB64: ${err.message}` });
            }
        }

        // PowerShell has no usable stdin redirection for piped commands, so its payload
        // goes to a file that is piped in explicitly. cmd mode pipes the bytes directly.
        let stdinFile = null;
        if (stdinBuffer && powershell) {
            try {
                stdinFile = path.join(os.tmpdir(), `winb-stdin-${crypto.randomUUID()}.txt`);
                fs.writeFileSync(stdinFile, stdinBuffer);
                tempFiles.push(stdinFile);
            } catch (err) {
                return res.status(400).json({ error: `could not stage stdin: ${err.message}` });
            }
        }

        // Multi-line command in cmd mode used to run only the FIRST line and still
        // exit 0. Materialise it into a .cmd file so every line executes.
        if (!powershell && /\r?\n/.test(finalCommand)) {
            const scriptPath = path.join(os.tmpdir(), `winb-cmd-${crypto.randomUUID()}.cmd`);
            try {
                fs.writeFileSync(scriptPath, '@echo off\r\n' + finalCommand + '\r\n', 'utf8');
                tempFiles.push(scriptPath);
                finalCommand = `"${scriptPath}"`;
            } catch (err) {
                return res.status(400).json({ error: `could not stage multi-line command: ${err.message}` });
            }
        }

        // UTF-8 everywhere: PowerShell re-encodes output into the OEM codepage by
        // default, which turned every non-ASCII character into U+FFFD.
        const utf8Prefix = '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';
        if (powershell) {
            finalCommand = stdinFile
                ? `${utf8Prefix}Get-Content -Raw '${stdinFile}' | ${finalCommand}`
                : `${utf8Prefix}${finalCommand}`;
        } else if (process.platform === 'win32') {
            // cmd.exe defaults to the OEM codepage; chcp only exists there.
            finalCommand = `chcp 65001 >nul & ${finalCommand}`;
        }

        const spawnOptions = {
            cwd,
            shell,
            windowsHide: true,
            env: buildChildEnv(cleanEnv)
        };

        const envKeys = Object.keys(cleanEnv);
        console.log(`[EXEC] ${finalCommand} (cwd: ${cwd}, env: ${envKeys.length ? envKeys.join(',') : 'none'}, stdin: ${stdinFile ? 'yes' : 'no'})`);

        let child;
        try {
            child = spawn(finalCommand, [], spawnOptions);
        } catch (err) {
            return res.status(500).json({ status: 'error', error: err.message });
        }

        const procId = processId || crypto.randomUUID();
        const pid = child.pid;
        const stdoutSink = makeSink('out');
        const stderrSink = makeSink('err');
        let finished = false;
        let timer = null;

        const cleanupFiles = () => {
            for (const file of tempFiles) {
                try { fs.unlinkSync(file); } catch (_) { /* best effort */ }
            }
        };

        child.stdout.on('data', (data) => stdoutSink(data));
        child.stderr.on('data', (data) => stderrSink(data));

        // Feed cmd-mode stdin from the request body, then close the pipe. Closing it is not
        // optional: a reader that never sees EOF blocks forever, which used to hang the
        // whole request (a pipeline like "findstr x | find /c y" was enough to trigger it).
        try {
            if (!powershell && stdinBuffer) child.stdin.write(stdinBuffer);
            child.stdin.end();
        } catch (_) { /* the child may already be gone */ }

        const respond = (payload, status = 200) => {
            if (finished || res.headersSent) return;
            finished = true;
            if (timer) clearTimeout(timer);
            res.status(status).json({
                ...payload,
                stdoutBytes: stdoutSink.bytes(),
                truncated: stdoutSink.truncated() || stderrSink.truncated(),
                stdoutSpill: stdoutSink.spillPath() || null
            });
        };

        if (background) {
            const entry = {
                processId: procId,
                pid,
                command: finalCommand,
                workdir: cwd,
                envKeys,
                startedAt: new Date().toISOString(),
                stdoutLines: [],
                stderrLines: []
            };
            processes.set(procId, entry);
            saveJobs(processes);

            const pushLine = (arr, text) => {
                text.toString().split(/\r?\n/).forEach(line => {
                    if (line.trim().length === 0) return;
                    arr.push(line.slice(0, 4000));
                    if (arr.length > 500) arr.shift();
                });
            };
            child.stdout.on('data', (data) => { pushLine(entry.stdoutLines, data); stdoutSink(data); });
            child.stderr.on('data', (data) => { pushLine(entry.stderrLines, data); stderrSink(data); });
            child.once('exit', (code) => {
                cleanupFiles();
                console.log(`[BG PROCESS EXITED] ID: ${procId} code=${code}`);
                entry.exited = true;
                entry.exitCode = code;
                entry.exitedAt = new Date().toISOString();
                saveJobs(processes);
            });

            // Background jobs answer immediately; the sinks above keep the last output
            // available through /logs without holding the response open.
            finished = true;
            return res.json({ status: 'running', message: 'Started in background', processId: procId, pid });
        }

        child.once('error', (err) => {
            cleanupFiles();
            respond({ status: 'error', error: err.message }, 500);
        });

        child.once('close', (code) => {
            cleanupFiles();
            if (timer) clearTimeout(timer);
            const isTimeout = !!(timer && timer._winbTimeout);
            stdoutSink.close().then(() => stderrSink.close()).then(() => {
                respond({
                    status: isTimeout ? 'timeout' : 'finished',
                    exitCode: isTimeout ? null : code,
                    stdout: stdoutSink.text(),
                    stderr: stderrSink.text()
                });
            });
        });

        if (timeout > 0) {
            timer = setTimeout(() => {
                timer._winbTimeout = true;
                console.log(`[TIMEOUT] ${procId} after ${timeout}s - killing process tree ${pid}`);
                killTree(pid, () => {
                    // If 'close' never arrives (a grandchild can hold stdout open), answer
                    // anyway with whatever was captured instead of hanging forever.
                    setTimeout(() => {
                        stdoutSink.close().then(() => stderrSink.close()).then(() => {
                            respond({
                                status: 'timeout',
                                exitCode: null,
                                stdout: stdoutSink.text(),
                                stderr: stderrSink.text(),
                                note: 'process tree killed after timeout'
                            });
                        });
                    }, 2000);
                });
            }, timeout * 1000);
        }
    });

    app.post('/kill', (req, res) => {
        const { processId } = req.body;
        if (!processId) return res.status(400).json({ error: 'processId is required' });

        const entry = processes.get(processId);
        if (!entry) return res.status(404).json({ error: `Process ${processId} not found` });
        if (entry.exited) return res.status(410).json({ error: `Process ${processId} already exited`, processId, exitCode: entry.exitCode });

        killTree(entry.pid, () => {
            entry.killed = true;
            entry.exited = true;
            entry.exitedAt = new Date().toISOString();
            saveJobs(processes);
            res.json({ status: 'killed', processId });
        });
    });

    app.get('/ping', (req, res) => {
        res.json({ status: 'ok', activeProcesses: processes.size, version });
    });

    app.get('/health', (req, res) => {
        const now = new Date();
        const records = Array.from(processes.values());
        let logBytes = null;
        try { logBytes = fs.statSync(LOG_FILE).size; } catch (_) { logBytes = null; }
        res.json({
            status: 'ok',
            version,
            hmr: !!serverState.hmr,
            auth: !!loadToken(),
            pid: serverState.pid || process.pid,
            port: serverState.port || 5110,
            platform: serverState.platform || process.platform,
            workdir: SCRATCH_DIR,
            logBytes,
            startedAt: serverState.startedAt ? serverState.startedAt.toISOString() : null,
            now: now.toISOString(),
            uptimeSeconds: serverState.startedAt ? Math.floor((now - serverState.startedAt) / 1000) : Math.floor(process.uptime()),
            processes: {
                records: records.length,
                running: records.filter(p => !p.exited).length,
                exited: records.filter(p => p.exited).length
            },
            // /health is public, so this stays non-identifying: no user name, no titles.
            // Detail lives behind the token on /state.
            state: (() => {
                const st = sampler.status();
                const sample = sampler.lastSample || {};
                return {
                    tracking: st.enabled && st.sampling ? (st.degraded ? 'degraded' : 'on') : 'off',
                    session: sampler.sessionState(sample.idleSec),
                    bootTime: sample.boot || null,
                    lastSampleAgoSec: st.lastTick ? Math.max(0, Math.round((Date.now() - Date.parse(st.lastTick)) / 1000)) : null
                };
            })()
        });
    });

    app.post('/open-url', (req, res) => {
        const { url } = req.body;
        if (!isSafeUrl(url)) {
            return res.status(400).json({ error: 'A valid http(s) URL is required' });
        }

        console.log(`[OPEN URL] ${url}`);
        const child = spawn('cmd.exe', ['/c', 'start', '""', url], { windowsHide: true, shell: false });

        child.once('error', (err) => res.status(500).json({ status: 'error', error: err.message }));
        child.once('close', (code) => res.json({ status: code === 0 ? 'opened' : 'finished', exitCode: code, url }));
    });

    app.get('/port/:port', (req, res) => {
        const port = Number.parseInt(req.params.port, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return res.status(400).json({ error: 'Port must be an integer from 1 to 65535' });
        }

        console.log(`[PORT CHECK] ${port}`);
        const psScript = `
            $ErrorActionPreference = 'SilentlyContinue'
            $OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
            $rows = @(Get-NetTCPConnection -LocalPort ${port} | Sort-Object State, OwningProcess | Select-Object -First 20)
            $result = foreach ($row in $rows) {
                $proc = Get-Process -Id $row.OwningProcess -ErrorAction SilentlyContinue
                [PSCustomObject]@{
                    localAddress = $row.LocalAddress
                    localPort = $row.LocalPort
                    remoteAddress = $row.RemoteAddress
                    remotePort = $row.RemotePort
                    state = [string]$row.State
                    pid = $row.OwningProcess
                    processName = if ($proc) { $proc.ProcessName } else { $null }
                }
            }
            @{ port = ${port}; listening = @($result | Where-Object { $_.state -eq 'Listen' }).Count -gt 0; connections = @($result) } | ConvertTo-Json -Depth 4 -Compress
        `;

        const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { windowsHide: true, shell: false });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.once('error', (err) => res.status(500).json({ status: 'error', error: err.message }));
        child.once('close', (code) => {
            if (code !== 0) {
                return res.status(500).json({ status: 'error', exitCode: code, stderr });
            }
            try {
                const parsed = JSON.parse(stdout || '{}');
                res.json(parsed);
            } catch (err) {
                res.status(500).json({ status: 'error', error: `Could not parse port output: ${err.message}`, stdout, stderr });
            }
        });
    });

    app.get('/list', (req, res) => {
        const list = [];
        for (const [id, entry] of processes.entries()) {
            list.push({
                processId: id,
                pid: entry.pid,
                command: entry.command,
                workdir: entry.workdir,
                startedAt: entry.startedAt,
                status: entry.exited ? 'exited' : 'running',
                exitCode: entry.exitCode ?? null
            });
        }
        res.json({ processes: list });
    });

    app.get('/logs/:processId', (req, res) => {
        const entry = processes.get(req.params.processId);
        if (!entry) return res.status(404).json({ error: `Process ${req.params.processId} not found` });

        const tail = Math.max(1, Math.min(parseInt(req.query.tail || '80', 10), 500));
        res.json({
            processId: entry.processId,
            pid: entry.pid,
            command: entry.command,
            workdir: entry.workdir,
            status: entry.exited ? 'exited' : 'running',
            exitCode: entry.exitCode ?? null,
            stdout: entry.stdoutLines.slice(-tail),
            stderr: entry.stderrLines.slice(-tail)
        });
    });

    // ------------------------------------------------------------------ sessions
    // Sticky cwd/env so a caller does not have to repeat -w and -e on every call.
    // A session does not hold a shell open; it is just state applied to each /run.
    const sessions = loadSessions();

    const sessionView = (id, entry) => ({ id, workdir: entry.workdir || null, env: entry.env || {}, updatedAt: entry.updatedAt });

    app.get('/sessions', (req, res) => {
        res.json({ sessions: Array.from(sessions.entries()).map(([id, e]) => sessionView(id, e)) });
    });

    app.get('/session/:id', (req, res) => {
        const entry = sessions.get(req.params.id);
        if (!entry) return res.status(404).json({ error: `session ${req.params.id} not found` });
        res.json(sessionView(req.params.id, entry));
    });

    app.post('/session', (req, res) => {
        const { id, workdir, env } = req.body || {};
        if (!id || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
            return res.status(400).json({ error: 'id must match [A-Za-z0-9_.-]{1,64}' });
        }
        const prev = sessions.get(id) || { env: {} };
        const next = {
            workdir: workdir || prev.workdir || SCRATCH_DIR,
            env: { ...(prev.env || {}), ...(env || {}) },
            updatedAt: new Date().toISOString()
        };
        if (next.workdir && !fs.existsSync(next.workdir)) {
            return res.status(400).json({ error: `workdir not found on the PC: ${next.workdir}` });
        }
        sessions.set(id, next);
        saveSessions(sessions);
        res.json(sessionView(id, next));
    });

    app.delete('/session/:id', (req, res) => {
        const existed = sessions.delete(req.params.id);
        if (existed) saveSessions(sessions);
        res.json({ status: existed ? 'deleted' : 'not-found', id: req.params.id });
    });

    // ------------------------------------------------------------------ filesystem
    const fsGuard = (target, res) => {
        if (!target || typeof target !== 'string') {
            res.status(400).json({ error: 'path is required' });
            return false;
        }
        if (!isAllowedForWrite(target)) {
            res.status(403).json({
                error: `path is outside the allowed write roots: ${ALLOWED_ROOTS.join(', ')}`,
                path: target
            });
            return false;
        }
        return true;
    };

    app.get('/fs/stat', (req, res) => {
        const target = req.query.path;
        if (!target) return res.status(400).json({ error: 'path is required' });
        try {
            const st = fs.statSync(target);
            const out = {
                path: target,
                exists: true,
                type: st.isDirectory() ? 'dir' : 'file',
                size: st.size,
                mtime: st.mtime.toISOString(),
                mode: st.mode?.toString(8)
            };
            if (st.isFile() && req.query.sha256 === '1' && st.size <= MAX_READ_BYTES) {
                out.sha256 = sha256File(target);
            }
            res.json(out);
        } catch (err) {
            res.json({ path: target, exists: false, error: err.code || err.message });
        }
    });

    app.get('/fs/list', (req, res) => {
        const target = req.query.path || SCRATCH_DIR;
        const limit = Math.max(1, Math.min(parseInt(req.query.limit || '500', 10), 5000));
        const pattern = req.query.pattern ? new RegExp(req.query.pattern, 'i') : null;
        let entries;
        try {
            entries = fs.readdirSync(target, { withFileTypes: true });
        } catch (err) {
            return res.status(400).json({ error: `cannot list ${target}: ${err.code || err.message}` });
        }
        const out = [];
        for (const entry of entries) {
            if (pattern && !pattern.test(entry.name)) continue;
            const full = path.join(target, entry.name);
            let st = null;
            try { st = fs.statSync(full); } catch (_) { /* skip broken link */ }
            out.push({
                name: entry.name,
                path: full,
                type: entry.isDirectory() ? 'dir' : 'file',
                size: st ? st.size : null,
                mtime: st ? st.mtime.toISOString() : null
            });
            if (out.length >= limit) break;
        }
        out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
        res.json({ path: target, count: out.length, entries: out });
    });

    app.get('/fs/read', (req, res) => {
        const target = req.query.path;
        if (!target) return res.status(400).json({ error: 'path is required' });
        const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
        const length = Math.max(0, parseInt(req.query.length || String(MAX_READ_BYTES), 10) || MAX_READ_BYTES);
        if (length > MAX_READ_BYTES) {
            return res.status(400).json({ error: `length is capped at ${MAX_READ_BYTES} bytes per read` });
        }
        try {
            const st = fs.statSync(target);
            if (st.isDirectory()) return res.status(400).json({ error: 'path is a directory' });
            const fh = fs.openSync(target, 'r');
            const buf = Buffer.alloc(Math.min(length, Math.max(0, st.size - offset)));
            const read = buf.length ? fs.readSync(fh, buf, 0, buf.length, offset) : 0;
            fs.closeSync(fh);
            const slice = buf.subarray(0, read);
            const encoding = req.query.encoding || 'utf8';
            res.json({
                path: target,
                offset,
                bytes: read,
                totalBytes: st.size,
                eof: offset + read >= st.size,
                encoding,
                content: encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8')
            });
        } catch (err) {
            res.status(400).json({ error: `cannot read ${target}: ${err.code || err.message}` });
        }
    });

    app.post('/fs/write', (req, res) => {
        const { path: target, text, dataB64, append = false, mkdirs = true, sha256 = false } = req.body || {};
        if (!fsGuard(target, res)) return;
        let payload;
        try {
            payload = dataB64 !== undefined ? Buffer.from(dataB64, 'base64') : Buffer.from(String(text ?? ''), 'utf8');
        } catch (err) {
            return res.status(400).json({ error: `invalid payload: ${err.message}` });
        }
        try {
            if (mkdirs) ensureDir(path.dirname(target));
            fs.writeFileSync(target, payload, append ? { flag: 'a' } : undefined);
            const out = {
                path: target,
                bytes: payload.length,
                mode: append ? 'append' : 'overwrite',
                totalBytes: fs.statSync(target).size
            };
            if (sha256) out.sha256 = sha256File(target);
            res.json(out);
        } catch (err) {
            res.status(400).json({ error: `cannot write ${target}: ${err.code || err.message}` });
        }
    });

    app.post('/fs/mkdir', (req, res) => {
        const { path: target } = req.body || {};
        if (!fsGuard(target, res)) return;
        try {
            fs.mkdirSync(target, { recursive: true });
            res.json({ path: target, status: 'created' });
        } catch (err) {
            res.status(400).json({ error: `cannot mkdir ${target}: ${err.code || err.message}` });
        }
    });

    app.post('/fs/move', (req, res) => {
        const { from, to, overwrite = true } = req.body || {};
        if (!fsGuard(from, res) || !fsGuard(to, res)) return;
        try {
            if (fs.existsSync(to)) {
                if (!overwrite) return res.status(409).json({ error: `target exists: ${to}` });
                fs.rmSync(to, { recursive: true, force: true });
            }
            ensureDir(path.dirname(to));
            fs.renameSync(from, to);
            res.json({ from, to, status: 'moved' });
        } catch (err) {
            res.status(400).json({ error: `cannot move: ${err.code || err.message}` });
        }
    });

    app.post('/fs/rm', (req, res) => {
        const { path: target, recursive = false } = req.body || {};
        if (!fsGuard(target, res)) return;
        const norm = normalizePath(target);
        // Refuse anything that could take a whole drive or a top-level system folder.
        if (norm.length < 8 || /^[A-Za-z]:$/.test(norm) || ALLOWED_ROOTS.map(normalizePath).includes(norm)) {
            return res.status(400).json({ error: `refusing to delete ${target}: too close to a root` });
        }
        try {
            const st = fs.statSync(norm);
            if (st.isDirectory() && !recursive) {
                return res.status(400).json({ error: 'path is a directory; pass "recursive": true explicitly' });
            }
            fs.rmSync(norm, { recursive: !!recursive, force: false });
            res.json({ path: norm, status: 'deleted', type: st.isDirectory() ? 'dir' : 'file' });
        } catch (err) {
            res.status(400).json({ error: `cannot delete ${target}: ${err.code || err.message}` });
        }
    });

    // ------------------------------------------------------------------ processes
    app.get('/proc/list', (req, res) => {
        const filter = (req.query.filter || '').toLowerCase();
        const limit = Math.max(1, Math.min(parseInt(req.query.limit || '200', 10), 2000));
        const psScript = `
            $OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
            Get-Process | Select-Object Id,ProcessName,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},@{n='Path';e={$_.Path}} |
                ConvertTo-Json -Depth 3 -Compress
        `;
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { windowsHide: true, shell: false });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.once('error', (e) => res.status(500).json({ error: e.message }));
        child.once('close', () => {
            let list;
            try {
                list = JSON.parse(out || '[]');
            } catch (e) {
                return res.status(500).json({ error: `could not parse process list: ${e.message}`, stderr: err });
            }
            if (!Array.isArray(list)) list = [list];
            let rows = list.map((p) => ({ pid: p.Id, name: p.ProcessName, memMB: p.MemMB, path: p.Path }));
            if (filter) rows = rows.filter((p) => (p.name || '').toLowerCase().includes(filter) || (p.path || '').toLowerCase().includes(filter));
            rows.sort((a, b) => (b.memMB || 0) - (a.memMB || 0));
            res.json({ count: rows.length, processes: rows.slice(0, limit) });
        });
    });

    app.post('/proc/kill', (req, res) => {
        const { pid, name, tree = true } = req.body || {};
        if (!pid && !name) return res.status(400).json({ error: 'pid or name is required' });
        const args = pid ? ['/pid', String(pid), '/f'] : ['/im', String(name), '/f'];
        if (pid && tree) args.push('/t');
        const killer = spawn('taskkill', args, { windowsHide: true, shell: false });
        let out = '';
        let err = '';
        killer.stdout.on('data', (d) => { out += d.toString(); });
        killer.stderr.on('data', (d) => { err += d.toString(); });
        killer.once('close', (code) => {
            res.json({ status: code === 0 ? 'killed' : 'failed', pid: pid || null, name: name || null, exitCode: code, stdout: out.trim(), stderr: err.trim() });
        });
    });

    // ---- host context (v1.4): sampler state, timeline, app usage
    // These five endpoints expose who uses the host and for what. server.js requires the
    // bearer token for them even from loopback (WINB_PRIVATE_API, default on).
    app.get('/state', (req, res) => {
        try {
            res.json(sampler.state());
        } catch (err) {
            res.status(500).json({ error: `state failed: ${err.message}` });
        }
    });

    app.get('/timeline', (req, res) => {
        const hours = Number(req.query.hours || 6);
        const limit = Number(req.query.limit || 500);
        const kinds = req.query.kinds
            ? String(req.query.kinds).split(',').map((k) => k.trim()).filter(Boolean)
            : null;
        try {
            res.json(sampler.timeline({ hours, kinds, limit }));
        } catch (err) {
            res.status(500).json({ error: `timeline failed: ${err.message}` });
        }
    });

    app.get('/events/since', (req, res) => {
        try {
            res.json(sampler.since(req.query.cursor));
        } catch (err) {
            res.status(500).json({ error: `events/since failed: ${err.message}` });
        }
    });

    app.get('/apps', (req, res) => {
        const days = req.query.days === undefined ? null : Number(req.query.days);
        try {
            res.json(sampler.apps({ days }));
        } catch (err) {
            res.status(500).json({ error: `apps failed: ${err.message}` });
        }
    });

    // GET, not DELETE: the CLI is curl based and the token is the boundary. Still the only
    // destructive endpoint in the surface, so it is listed in PRIVATE_PATHS too.
    app.get('/history/purge', (req, res) => {
        const days = req.query.days === undefined ? null : Number(req.query.days);
        try {
            const result = sampler.purge({ days });
            console.log(`[HISTORY PRUNE] removed ${result.removedCount} file(s), kept ${result.kept}`);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: `purge failed: ${err.message}` });
        }
    });

    return function cleanup() {
        app._router.stack = app._router.stack.slice(0, initialStackLength);
    };
};