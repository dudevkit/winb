const { spawn } = require('child_process');
const crypto = require('crypto');

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
    const npmGlobalPath = `${process.env.APPDATA || 'C:\\Users\\Ravi\\AppData\\Roaming'}\\npm`;
    if (!pathParts.some(p => p.toLowerCase() === npmGlobalPath.toLowerCase())) {
        pathParts.unshift(npmGlobalPath);
    }
    childEnv[pathKey] = pathParts.join(';');
    return childEnv;
}

// Clear existing routes safely for Hot Reloading
module.exports = function(app, processes, serverState = {}) {
    // We store the route stack length before adding new routes
    // so we can slice them off later if we reload
    const initialStackLength = app._router.stack.length;

    // Add HTTP Request Logger middleware
    const loggerMiddleware = (req, res, next) => {
        res.on('finish', () => {
            if (req.path !== '/reload') { // reload has its own log
                console.log(`[HTTP] ${req.method} ${req.path} - ${res.statusCode}`);
            }
        });
        next();
    };
    app.use(loggerMiddleware);

    app.post('/run', (req, res) => {
        const {
            command,
            workdir,
            background = false,
            processId,
            powershell = false,
            timeout = 0,
            env = {}
        } = req.body;

        if (!command) return res.status(400).json({ error: 'Command is required' });
        if (env === null || Array.isArray(env) || typeof env !== 'object') {
            return res.status(400).json({ error: 'env must be an object of KEY=VALUE strings' });
        }

        const cleanEnv = {};
        for (const [key, value] of Object.entries(env)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                return res.status(400).json({ error: `Invalid env key: ${key}` });
            }
            cleanEnv[key] = String(value);
        }

        let shell = true;
        if (powershell) shell = 'powershell.exe';

        const spawnOptions = {
            cwd: workdir || process.cwd(),
            shell: shell,
            windowsHide: true,
            env: buildChildEnv(cleanEnv)
        };

        const envKeys = Object.keys(cleanEnv);
        console.log(`[EXEC] ${command} (cwd: ${spawnOptions.cwd}, env: ${envKeys.length ? envKeys.join(',') : 'none'})`);

        const child = spawn(command, [], spawnOptions);
        const pid = child.pid;
        const procId = processId || crypto.randomUUID();

        if (background) {
            const entry = {
                processId: procId,
                pid,
                command,
                workdir: spawnOptions.cwd,
                envKeys,
                startedAt: new Date().toISOString(),
                stdoutLines: [],
                stderrLines: []
            };
            processes.set(procId, entry);

            const pushLine = (arr, text) => {
                text.toString().split(/\r?\n/).forEach(line => {
                    if (line.trim().length === 0) return;
                    arr.push(line);
                    if (arr.length > 500) arr.shift();
                });
            };

            child.stdout.on('data', (data) => pushLine(entry.stdoutLines, data));
            child.stderr.on('data', (data) => pushLine(entry.stderrLines, data));
            child.on('exit', (code) => {
                console.log(`[BG PROCESS EXITED] ID: ${procId} code=${code}`);
                // Keep logs after exit, but mark as exited so user can still inspect them.
                entry.exited = true;
                entry.exitCode = code;
                entry.exitedAt = new Date().toISOString();
            });

            return res.json({
                status: 'running',
                message: 'Started in background',
                processId: procId,
                pid: pid
            });
        }

        let stdout = '';
        let stderr = '';
        let isTimeout = false;
        let timer = null;

        if (timeout > 0) {
            timer = setTimeout(() => {
                isTimeout = true;
                child.kill();
            }, timeout * 1000);
        }

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            res.json({
                status: isTimeout ? 'timeout' : 'finished',
                exitCode: code,
                stdout,
                stderr
            });
        });

        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            res.status(500).json({
                status: 'error',
                error: err.message
            });
        });
    });

    app.post('/kill', (req, res) => {
        const { processId } = req.body;
        if (!processId) return res.status(400).json({ error: 'processId is required' });

        const entry = processes.get(processId);
        if (!entry) return res.status(404).json({ error: `Process ${processId} not found` });
        if (entry.exited) return res.status(410).json({ error: `Process ${processId} already exited`, processId, exitCode: entry.exitCode });

        const killer = spawn('taskkill', ['/pid', entry.pid, '/f', '/t']);
        killer.on('close', () => {
            entry.killed = true;
            entry.exited = true;
            entry.exitedAt = new Date().toISOString();
            res.json({ status: 'killed', processId });
        });
    });

    app.get('/ping', (req, res) => {
        res.json({ status: 'ok', activeProcesses: processes.size, version: serverState.version || 'unknown' });
    });

    app.get('/health', (req, res) => {
        const now = new Date();
        const records = Array.from(processes.values());
        const running = records.filter(p => !p.exited).length;
        const exited = records.filter(p => p.exited).length;
        res.json({
            status: 'ok',
            version: serverState.version || 'unknown',
            hmr: !!serverState.hmr,
            pid: serverState.pid || process.pid,
            port: serverState.port || 5110,
            platform: serverState.platform || process.platform,
            workdir: serverState.workdir || process.cwd(),
            startedAt: serverState.startedAt ? serverState.startedAt.toISOString() : null,
            now: now.toISOString(),
            uptimeSeconds: serverState.startedAt ? Math.floor((now - serverState.startedAt) / 1000) : Math.floor(process.uptime()),
            processes: {
                records: records.length,
                running,
                exited
            }
        });
    });

    app.post('/open-url', (req, res) => {
        const { url } = req.body;
        if (!isSafeUrl(url)) {
            return res.status(400).json({ error: 'A valid http(s) URL is required' });
        }

        console.log(`[OPEN URL] ${url}`);
        const child = spawn('cmd.exe', ['/c', 'start', '""', url], {
            windowsHide: true,
            shell: false
        });

        child.on('error', (err) => {
            res.status(500).json({ status: 'error', error: err.message });
        });

        child.on('close', (code) => {
            res.json({ status: code === 0 ? 'opened' : 'finished', exitCode: code, url });
        });
    });

    app.get('/port/:port', (req, res) => {
        const port = Number.parseInt(req.params.port, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return res.status(400).json({ error: 'Port must be an integer from 1 to 65535' });
        }

        console.log(`[PORT CHECK] ${port}`);
        const psScript = `
            $ErrorActionPreference = 'SilentlyContinue'
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

        const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
            windowsHide: true,
            shell: false
        });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('error', (err) => res.status(500).json({ status: 'error', error: err.message }));
        child.on('close', (code) => {
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

    // Return a function to cleanup these routes when reloading
    return function cleanup() {
        app._router.stack = app._router.stack.slice(0, initialStackLength);
    };
};
