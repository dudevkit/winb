const express = require('express');
const app = express();
const PORT = 5110;
const startedAt = new Date();
const SERVER_VERSION = '1.2.0';

app.use(express.json());

// Central state that survives hot reloads
const processes = new Map();
const serverState = {
    startedAt,
    version: SERVER_VERSION,
    port: PORT,
    hmr: true,
    workdir: process.cwd(),
    platform: process.platform,
    pid: process.pid
};

// The Reload Endpoint MUST be defined before loading api.js
// so that its route is not wiped out by the HMR cleanup slice.
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

// Initialize dynamic API routes
let cleanupApi = require('./api.js')(app, processes, serverState);

app.listen(PORT, () => {
    console.log(`Winbridge Server running on http://0.0.0.0:${PORT} (True HMR Enabled)`);
});