const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');

module.exports = function(processes) {
    const router = express.Router();
    router.use(express.json());

    router.post('/run', (req, res) => {
        const {
            command,
            workdir,
            background = false,
            processId,
            powershell = false,
            timeout = 0
        } = req.body;

        if (!command) return res.status(400).json({ error: 'Command is required' });

        let shell = true;
        if (powershell) shell = 'powershell.exe';

        const spawnOptions = {
            cwd: workdir || process.cwd(),
            shell: shell,
            windowsHide: true
        };

        console.log(`[EXEC] ${command} (cwd: ${spawnOptions.cwd})`);

        const child = spawn(command, [], spawnOptions);
        const pid = child.pid;
        const procId = processId || crypto.randomUUID();

        if (background) {
            processes.set(procId, child);
            child.on('exit', () => {
                processes.delete(procId);
                console.log(`[BG PROCESS EXITED] ID: ${procId}`);
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

    router.post('/kill', (req, res) => {
        const { processId } = req.body;
        if (!processId) return res.status(400).json({ error: 'processId is required' });

        const child = processes.get(processId);
        if (!child) return res.status(404).json({ error: `Process ${processId} not found or already exited` });

        const killer = spawn('taskkill', ['/pid', child.pid, '/f', '/t']);
        killer.on('close', () => {
            processes.delete(processId);
            res.json({ status: 'killed', processId });
        });
    });

    router.get('/ping', (req, res) => {
        res.json({ status: 'ok', activeProcesses: processes.size });
    });

    router.get('/list', (req, res) => {
        const list = [];
        for (const [id, child] of processes.entries()) {
            list.push({
                processId: id,
                pid: child.pid
            });
        }
        res.json({ processes: list });
    });

    return router;
};
