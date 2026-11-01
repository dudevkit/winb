'use strict';
/**
 * Host context sampler.
 *
 * Two products:
 *   1. a live picture of the host (processes, foreground app, session, disks, network)
 *      served by GET /state
 *   2. an append-only event timeline in history/state-YYYYMMDD.jsonl served by
 *      GET /timeline, /events/since and /apps
 *
 * Design notes that matter:
 *   - Sparse rows: a row is written when something changes, plus one res.sample per
 *     interval. Usage duration is stored as closed segments (app.usage), so /apps is a
 *     plain sum instead of a replay of every switch.
 *   - Window titles are the sensitive part. They live in the RAM ring and in /state;
 *     they reach the disk file only when WINB_TITLES_PERSIST=1.
 *   - This module is a singleton on purpose. api.js is re-required by GET /reload, so the
 *     sampler must never own the helper process or the interval from inside api.js, or
 *     every reload would leak another one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_DIR = __dirname;
const HELPER = path.join(SERVER_DIR, 'sampler-probe.ps1');
const DAY_RE = /^state-(\d{4})(\d{2})(\d{2})\.jsonl$/;
const RING_MAX = 2000;
const TITLE_RING_MAX = 500;
const EVENTS_EVERY_TICKS = 5;          // event-log sweep cadence, in ticks
const HELPER_TIMEOUT_MS = 20000;
const DEGRADE_AFTER = 3;               // consecutive failures before the fallback path
const SEEN_MAX = 5000;

function truthy(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return !['0', 'off', 'false', 'no'].includes(String(value).trim().toLowerCase());
}

function readConfig() {
    return {
        track: truthy(process.env.WINB_TRACK, true),
        titles: truthy(process.env.WINB_TITLES, true),
        titlesPersist: truthy(process.env.WINB_TITLES_PERSIST, false),
        titleRingMin: Number(process.env.WINB_TITLE_RING_MIN || 60),
        sampleSec: Math.max(5, Number(process.env.WINB_SAMPLE_SEC || 60)),
        history: truthy(process.env.WINB_HISTORY, true),
        historyDays: Number(process.env.WINB_HISTORY_DAYS || 7),
        appDays: Number(process.env.WINB_APP_DAYS || 90),
        historyMaxMb: Number(process.env.WINB_HISTORY_MAX_MB || 64),
        diskWarnPct: Number(process.env.WINB_DISK_WARN_PCT || 10),
        dir: process.env.WINB_HISTORY_DIR || path.join(SERVER_DIR, 'history')
    };
}

function dayKey(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function sessionState(idleSec) {
    if (idleSec === null || idleSec === undefined) return 'unknown';
    if (idleSec < 300) return 'active';
    if (idleSec < 1800) return 'idle';
    return 'away';
}

/**
 * Remove every window-title field from a value, recursively.
 *
 * Titles are the sensitive part of the timeline, so the on-disk copy loses them unless
 * WINB_TITLES_PERSIST=1. Recursive and unconditional on purpose: an empty-string title
 * (a window with no caption, e.g. the desktop) is still a title key on disk, and nested
 * structures (a list of windows inside a single event) must be covered too.
 */
function stripTitles(value) {
    if (Array.isArray(value)) return value.map(stripTitles);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            if (key === 'title') continue;
            out[key] = stripTitles(val);
        }
        return out;
    }
    return value;
}

class Sampler {
    constructor() {
        this.startedAt = null;
        this.timer = null;
        this.busy = false;
        this.busySince = null;
        this.ticks = 0;
        this.helper = null;
        this.helperPending = null;
        this.helperBuffer = '';
        this.degraded = null;              // {reason, at, failures}
        this.lastTick = null;
        this.lastError = null;
        this.lastSample = null;            // raw payload from the probe
        this.lastSource = null;            // 'helper' | 'once' | 'node'
        this.ring = [];                    // recent events, titles included
        this.titleRing = [];
        this.seenEvents = new Set();       // dedupe key for OS event-log rows
        this.activeApp = null;
        this.activeSince = null;
        this.prevBoot = null;
        this.prevSession = null;
        this.prevNet = null;
        this.prevDisks = null;
        this.lastDayKey = null;
        this.writeErrors = 0;
    }

    // ------------------------------------------------------------ lifecycle

    start() {
        if (this.timer) return this.status();
        const cfg = readConfig();
        this.startedAt = new Date();
        try { fs.mkdirSync(cfg.dir, { recursive: true }); this._restrictDir(cfg.dir); } catch (_) { /* best effort */ }
        this._seedFromDisk(cfg);
        this.record({ kind: 'sampler.state', src: 'sampler', data: { state: 'start', platform: process.platform, sampleSec: cfg.sampleSec, bootTime: this.prevBoot } });
        this._ensureHelper();
        this.timer = setInterval(() => { this._tick().catch(() => { /* _tick never rejects */ }); }, cfg.sampleSec * 1000);
        if (this.timer.unref) this.timer.unref();
        this._tick().catch(() => { /* first sample is best effort */ });
        return this.status();
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.activeApp && this.activeSince) {
            const sec = Math.round((Date.now() - this.activeSince) / 1000);
            if (sec >= 1) this.record({ kind: 'app.usage', src: 'sampler', data: { app: this.activeApp, sec, closedBy: 'stop' } });
        }
        this.record({ kind: 'sampler.state', src: 'sampler', data: { state: 'stop' } });
        if (this.helper) {
            try { this.helper.stdin.write('quit\n'); } catch (_) { /* already gone */ }
            try { this.helper.kill(); } catch (_) { /* already gone */ }
            this.helper = null;
        }
    }

    status() {
        const cfg = readConfig();
        return {
            enabled: cfg.track,
            sampling: !!this.timer,
            titles: cfg.titles,
            titlesPersist: cfg.titlesPersist,
            history: cfg.history,
            historyDir: cfg.dir,
            sampleSec: cfg.sampleSec,
            retentionDays: cfg.historyDays,
            appRetentionDays: cfg.appDays,
            diskWarnPct: cfg.diskWarnPct,
            helper: this.helper ? 'running' : 'absent',
            lastSource: this.lastSource,
            platform: process.platform,
            supported: process.platform === 'win32',
            degraded: this.degraded,
            lastTick: this.lastTick ? new Date(this.lastTick).toISOString() : null,
            ticks: this.ticks,
            writeErrors: this.writeErrors,
            startedAt: this.startedAt ? this.startedAt.toISOString() : null
        };
    }

    // ------------------------------------------------------------ reads

    state() {
        const s = this.lastSample || {};
        const cfg = readConfig();
        const now = Date.now();
        const windows = cfg.titles ? (s.windows || []) : (s.windows || []).map((w) => ({ app: w.app, cpuSec: w.cpuSec }));
        return {
            host: {
                name: os.hostname(),
                platform: `${os.platform()} ${os.release()} ${os.arch()}`,
                cpus: os.cpus().length,
                memTotalMb: s.memTotalMb || Math.round(os.totalmem() / 1048576)
            },
            power: {
                bootTime: s.boot || this.prevBoot || null,
                uptimeSec: Math.floor(os.uptime())
            },
            session: {
                user: (s.session && s.session.user) || null,
                name: (s.session && s.session.name) || null,
                locked: !!(s.session && s.session.locked),
                idleSec: s.idleSec === undefined ? null : s.idleSec,
                state: sessionState(s.idleSec)
            },
            net: s.net || [],
            disk: s.disks || [],
            res: {
                memUsedMb: s.memFreeMb && s.memTotalMb ? s.memTotalMb - s.memFreeMb : null,
                procCount: s.procCount || null,
                cpuTop: (s.procs || []).slice(0, 5)
            },
            apps: {
                active: s.fg ? {
                    app: s.fg.app,
                    title: cfg.titles ? s.fg.title : undefined,
                    durSec: this.activeSince ? Math.round((now - this.activeSince) / 1000) : null
                } : null,
                windows,
                recent: this._recentTitles(cfg)
            },
            tracking: this.status()
        };
    }

    _recentTitles(cfg, limit = 40) {
        if (!cfg.titles) return [];
        const cutoff = Date.now() - cfg.titleRingMin * 60000;
        return this.titleRing.filter((r) => r.at >= cutoff).slice(-limit).map((r) => ({
            t: new Date(r.at).toISOString(), app: r.app, title: r.title
        }));
    }

    _files() {
        const cfg = readConfig();
        let names = [];
        try { names = fs.readdirSync(cfg.dir); } catch (_) { return []; }
        return names
            .map((name) => {
                const m = DAY_RE.exec(name);
                return m ? { name, key: m[1] + m[2] + m[3], path: path.join(cfg.dir, name) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => (a.key < b.key ? -1 : 1));
    }

    _readEvents(file, fromOffset = 0) {
        let text;
        try {
            const fd = fs.openSync(file.path, 'r');
            try {
                const size = fs.fstatSync(fd).size;
                const start = Math.min(Math.max(0, fromOffset), size);
                const len = size - start;
                if (len <= 0) return [];
                const buf = Buffer.alloc(len);
                fs.readSync(fd, buf, 0, len, start);
                text = buf.toString('utf8');
            } finally { fs.closeSync(fd); }
        } catch (_) { return []; }
        const out = [];
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try { out.push(JSON.parse(trimmed)); } catch (_) { /* torn tail line, skip */ }
        }
        return out;
    }

    timeline({ hours = 6, kinds = null, limit = 500 } = {}) {
        const cutoff = Date.now() - Math.max(1, hours) * 3600000;
        const wanted = kinds && kinds.length ? new Set(kinds) : null;
        let events = [];
        for (const file of this._files()) {
            const rows = this._readEvents(file);
            if (!rows.length) continue;
            const last = Date.parse(rows[rows.length - 1].t || 0);
            if (!Number.isNaN(last) && last < cutoff) continue;   // whole file predates the window
            for (const row of rows) {
                const at = Date.parse(row.t || 0);
                if (!Number.isNaN(at) && at < cutoff) continue;
                if (wanted && !wanted.has(row.kind)) continue;
                events.push(row);
            }
        }
        const seen = new Set(events.map((e) => `${e.t}|${e.kind}`));
        for (const row of this.ring) {
            const at = Date.parse(row.t || 0);
            if (!Number.isNaN(at) && at < cutoff) continue;
            if (wanted && !wanted.has(row.kind)) continue;
            if (seen.has(`${row.t}|${row.kind}`)) continue;   // already read back from disk
            events.push(row);
        }
        events.sort((a, b) => (Date.parse(b.t || 0) - Date.parse(a.t || 0)));
        return { hours, count: events.length, events: events.slice(0, Math.max(1, limit)), source: this._files().length ? 'history+ring' : 'ring' };
    }

    _encodeCursor(fileName, offset) {
        return Buffer.from(JSON.stringify({ f: fileName || null, o: offset || 0 }), 'utf8')
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    _decodeCursor(cursor) {
        if (!cursor) return null;
        try {
            const padded = String(cursor).replace(/-/g, '+').replace(/_/g, '/');
            const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
            return { f: parsed.f || null, o: Number(parsed.o || 0) };
        } catch (_) { return null; }
    }

    currentCursor() {
        const files = this._files();
        if (!files.length) return this._encodeCursor(null, 0);
        const last = files[files.length - 1];
        let size = 0;
        try { size = fs.statSync(last.path).size; } catch (_) { size = 0; }
        return this._encodeCursor(last.name, size);
    }

    since(cursor) {
        const files = this._files();
        const base = this._encodeCursor(files.length ? files[files.length - 1].name : null,
            files.length ? (() => { try { return fs.statSync(files[files.length - 1].path).size; } catch (_) { return 0; } })() : 0);
        const decoded = this._decodeCursor(cursor);
        if (!decoded || !decoded.f) return { cursor: base, count: 0, events: [], baseline: true };
        if (!files.length) return { cursor: base, count: 0, events: [], reset: true };
        const idx = files.findIndex((f) => f.name === decoded.f);
        if (idx === -1) return { cursor: base, count: 0, events: [], reset: true };
        let events = [];
        for (let i = idx; i < files.length; i++) {
            events = events.concat(this._readEvents(files[i], i === idx ? decoded.o : 0));
        }
        events.sort((a, b) => (Date.parse(a.t || 0) - Date.parse(b.t || 0)));
        return { cursor: base, count: events.length, events };
    }

    apps({ days = null } = {}) {
        const cfg = readConfig();
        const window = Math.max(1, Number(days || cfg.appDays));
        const cutoff = Date.now() - window * 86400000;
        const rollup = new Map();
        const bucket = (app) => {
            if (!rollup.has(app)) rollup.set(app, { app, sec: 0, runs: 0, lastUsed: null, titles: new Set() });
            return rollup.get(app);
        };
        for (const file of this._files()) {
            for (const row of this._readEvents(file)) {
                const at = Date.parse(row.t || 0);
                if (Number.isNaN(at) || at < cutoff) continue;
                if (row.kind === 'app.usage' && row.data && row.data.app) {
                    bucket(row.data.app).sec += Number(row.data.sec || 0);
                } else if (row.kind === 'app.switch' && row.data && row.data.app) {
                    const entry = bucket(row.data.app);
                    entry.runs += 1;
                    if (!entry.lastUsed || at > entry.lastUsed) entry.lastUsed = at;
                    if (row.data.title) entry.titles.add(row.data.title);
                }
            }
        }
        if (this.activeApp && this.activeSince) {
            const entry = bucket(this.activeApp);
            entry.sec += Math.round((Date.now() - this.activeSince) / 1000);
            entry.runs += 1;
            entry.lastUsed = Date.now();
        }
        const apps = Array.from(rollup.values())
            .map((e) => ({
                app: e.app,
                minutes: Math.round(e.sec / 60 * 10) / 10,
                runs: e.runs,
                lastUsed: e.lastUsed ? new Date(e.lastUsed).toISOString() : null,
                active: e.app === this.activeApp,
                titles: e.titles.size ? Array.from(e.titles).slice(-5) : undefined
            }))
            .sort((a, b) => b.minutes - a.minutes || b.runs - a.runs);
        return {
            days: window,
            titlesIncluded: cfg.titles && cfg.titlesPersist,
            note: cfg.titles && !cfg.titlesPersist
                ? 'titles are live-only (WINB_TITLES_PERSIST=0): durations come from app.usage rows, titles only from the in-memory ring'
                : undefined,
            count: apps.length,
            apps
        };
    }

    purge({ days = null } = {}) {
        const cfg = readConfig();
        const keepDays = days === null || days === undefined ? cfg.historyDays : Number(days);
        const cutoffKey = keepDays <= 0 ? '99999999' : dayKey(new Date(Date.now() - keepDays * 86400000));
        const removed = [];
        let kept = 0;
        for (const file of this._files()) {
            if (keepDays <= 0 || file.key < cutoffKey) {
                try { fs.unlinkSync(file.path); removed.push(file.name); continue; } catch (_) { /* locked */ }
            }
            kept += 1;
        }
        const after = this._pruneBySize(cfg);
        return { removed, removedCount: removed.length, kept: kept, keepDays, prunedBySize: after };
    }

    // ------------------------------------------------------------ writes

    _restrictDir(dir) {
        // History holds who used what. Keep it owner-only instead of world-readable.
        if (process.platform === 'win32') {
            const user = process.env.USERNAME;
            if (!user) return;
            try {
                require('child_process').execFileSync('icacls',
                    [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`],
                    { windowsHide: true, stdio: 'ignore', timeout: 8000 });
            } catch (_) { /* best effort: a failed ACL must not stop sampling */ }
        } else {
            try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort */ }
        }
    }

    record(ev) {
        const cfg = readConfig();
        const row = {
            t: ev.t || new Date().toISOString(),
            kind: ev.kind,
            sev: ev.sev || 'info',
            src: ev.src || 'sampler',
            data: ev.data === undefined ? {} : ev.data
        };
        this.ring.push(row);
        if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
        if (row.kind === 'app.switch' && row.data.title && cfg.titles) {
            this.titleRing.push({ at: Date.parse(row.t), app: row.data.app, title: row.data.title });
            if (this.titleRing.length > TITLE_RING_MAX) this.titleRing.splice(0, this.titleRing.length - TITLE_RING_MAX);
        }
        if (!cfg.history) return row;
        try {
            const key = dayKey(new Date(row.t));
            if (this.lastDayKey && key !== this.lastDayKey) this._prune(cfg);
            this.lastDayKey = key;
            fs.mkdirSync(cfg.dir, { recursive: true });
            const onDisk = {
                ...row,
                data: cfg.titlesPersist ? { ...row.data } : stripTitles(row.data)
            };
            fs.appendFileSync(path.join(cfg.dir, `state-${key}.jsonl`), JSON.stringify(onDisk) + '\n');
        } catch (_) {
            this.writeErrors += 1;   // an unwritable history must never break the server
        }
        return row;
    }

    _prune(cfg) {
        try {
            const cutoffKey = cfg.historyDays <= 0 ? '99999999' : dayKey(new Date(Date.now() - cfg.historyDays * 86400000));
            for (const file of this._files()) {
                if (file.key < cutoffKey) { try { fs.unlinkSync(file.path); } catch (_) { /* locked */ } }
            }
        } catch (_) { /* best effort */ }
        return this._pruneBySize(cfg);
    }

    _pruneBySize(cfg) {
        const removed = [];
        try {
            const maxBytes = cfg.historyMaxMb * 1048576;
            let files = this._files().map((f) => {
                let size = 0;
                try { size = fs.statSync(f.path).size; } catch (_) { size = 0; }
                return { ...f, size };
            });
            let total = files.reduce((sum, f) => sum + f.size, 0);
            while (total > maxBytes && files.length > 1) {
                const oldest = files.shift();
                try { fs.unlinkSync(oldest.path); removed.push(oldest.name); total -= oldest.size; } catch (_) { break; }
            }
        } catch (_) { /* best effort */ }
        return removed;
    }

    _seedFromDisk(cfg) {
        const files = this._files();
        const recent = files.slice(-3);
        for (const file of recent) {
            for (const row of this._readEvents(file)) {
                if (row.kind === 'power.boot' && row.data && row.data.bootTime) this.prevBoot = row.data.bootTime;
                if (row.kind === 'app.switch' && row.data && row.data.app && row.data.title) {
                    const at = Date.parse(row.t || 0);
                    if (!Number.isNaN(at)) this.titleRing.push({ at, app: row.data.app, title: row.data.title });
                }
                if (row.src === 'eventlog' && row.data) {
                    this.seenEvents.add(`${row.data.log}|${row.data.id}|${row.data.at}`);
                }
            }
        }
        if (!this.prevBoot) this.prevBoot = cfg && cfg.history ? this._bootFromDisk(cfg) : null;
        return this.prevBoot;
    }

    _bootFromDisk() {
        // Any power.boot row counts, even an old one: all we need is a baseline to compare.
        for (const file of this._files()) {
            for (const row of this._readEvents(file)) {
                if (row.kind === 'power.boot' && row.data && row.data.bootTime) return row.data.bootTime;
            }
        }
        return null;
    }

    // ------------------------------------------------------------ probing

    _ensureHelper() {
        if (process.platform !== 'win32') {
            this.degraded = { reason: 'non-windows host: only node-level resource samples are available', at: new Date().toISOString(), failures: 0 };
            this.lastSource = 'node';
            return null;
        }
        if (this.helper) return this.helper;
        try {
            const child = spawn('powershell.exe',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
                { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this._onHelperData(chunk));
            child.stderr.on('data', () => { /* probe warnings are noise, the JSON carries the reason */ });
            child.once('exit', () => { this.helper = null; });
            child.once('error', (err) => { this.helper = null; this.lastError = `helper spawn failed: ${err.message}`; });
            this.helper = child;
            return child;
        } catch (err) {
            this.lastError = `helper spawn threw: ${err.message}`;
            this.helper = null;
            return null;
        }
    }

    _onHelperData(chunk) {
        this.helperBuffer += chunk;
        let idx;
        while ((idx = this.helperBuffer.indexOf('\n')) >= 0) {
            const line = this.helperBuffer.slice(0, idx).trim();
            this.helperBuffer = this.helperBuffer.slice(idx + 1);
            if (!line || !this.helperPending) continue;
            const pending = this.helperPending;
            this.helperPending = null;
            clearTimeout(pending.timer);
            try { pending.resolve(JSON.parse(line)); } catch (err) { pending.resolve({ error: `unparseable probe output: ${line.slice(0, 120)}` }); }
        }
    }

    _askHelper(command) {
        const child = this._ensureHelper();
        if (!child) return Promise.resolve(null);
        if (this.helperPending) return Promise.resolve({ error: 'probe busy' });
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.helperPending && this.helperPending.resolve === resolve) this.helperPending = null;
                resolve({ error: `probe timed out after ${HELPER_TIMEOUT_MS} ms` });
            }, HELPER_TIMEOUT_MS);
            if (timer.unref) timer.unref();
            this.helperPending = { resolve, timer };
            try { child.stdin.write(command + '\n'); } catch (err) { resolve({ error: `probe write failed: ${err.message}` }); }
        });
    }

    _probeOnce(withEvents, lookbackHours) {
        // Fallback path: one short-lived PowerShell per call (~0.4 s) instead of the
        // persistent child. Slower, but it keeps the timeline alive when the loop dies.
        if (process.platform !== 'win32') return Promise.resolve(null);
        return new Promise((resolve) => {
            const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Once'];
            if (withEvents) args.push('-Events');
            if (lookbackHours) args.push('-Hours', String(lookbackHours));
            const child = spawn('powershell.exe', args, { windowsHide: true });
            let out = '';
            child.stdout.on('data', (d) => { out += d.toString(); });
            // Unread stderr fills the pipe and blocks the child, which would leave this promise
            // pending forever. Warnings are noise; the JSON carries the actual reason.
            child.stderr.on('data', () => { /* drained on purpose */ });
            child.once('error', () => resolve(null));
            child.once('close', () => {
                try { resolve(JSON.parse(out.trim() || 'null')); } catch (_) { resolve(null); }
            });
        });
    }

    async _tick() {
        const cfg = readConfig();
        // A tick that never resolves (a wedged child, a hung synchronous call) must not stop the
        // timeline forever: after a generous stall window the next interval takes over.
        const stallMs = Math.max(60000, cfg.sampleSec * 3000);
        if (this.busy) {
            if (this.busySince && Date.now() - this.busySince > stallMs) {
                this._degrade(`previous tick stalled for ${Math.round((Date.now() - this.busySince) / 1000)}s`);
                this.busy = false;
            } else {
                return;
            }
        }
        this.busy = true;
        this.busySince = Date.now();
        try {
            if (!cfg.track) {
                if (this.activeApp && this.activeSince) this._closeSegment('tracking-off');
                this.lastTick = Date.now();
                return;
            }
            this.ticks += 1;
            if (process.platform !== 'win32') {
                // Non-Windows hosts have no window/session probes. Keep the timeline alive with
                // node-level resource samples instead of reporting a failure every tick.
                this.lastSource = 'node';
                this._nodeSample(cfg);
                this.lastTick = Date.now();
                return;
            }
            const wantEvents = this.ticks === 1 || this.ticks % EVENTS_EVERY_TICKS === 0;
            const sample = await this._askHelper('tick');
            if (sample && !sample.error) {
                this.degraded = null;
                this.lastSource = 'helper';
                this._applySample(sample, cfg);
            } else {
                const reason = sample && sample.error ? sample.error : 'probe unavailable';
                this._degrade(reason);
                if (this.degraded.failures >= DEGRADE_AFTER && this.helper) {
                    // The persistent child is wedged: drop it so the next tick spawns a fresh one
                    // instead of timing out against the same dead pipe forever.
                    try { this.helper.kill(); } catch (_) { /* already gone */ }
                    this.helper = null;
                    this.helperPending = null;
                    this.helperBuffer = '';
                }
                const fallback = await this._probeOnce(false);
                if (fallback && !fallback.error) {
                    this.lastSource = 'once';
                    this._applySample(fallback, cfg);
                } else {
                    this._nodeSample(cfg);
                }
            }
            if (wantEvents) {
                // 7 days on the first sweep so the timeline starts with the last boot/shutdown,
                // 3 hours afterwards: the events we care about are rare and dedupe handles overlap.
                const lookback = this.ticks === 1 ? 168 : 3;
                const rows = this.lastSource === 'helper'
                    ? await this._askHelper(`events ${lookback}`)
                    : (this.lastSource === 'once' ? await this._probeOnce(true, lookback) : null);
                if (rows && Array.isArray(rows.events)) this._applyEvents(rows.events);
            }
            this.lastTick = Date.now();
        } catch (err) {
            this.lastError = err.message;
        } finally {
            this.busy = false;
            this.busySince = null;
        }
    }

    _degrade(reason) {
        const failures = (this.degraded ? this.degraded.failures : 0) + 1;
        const wasFine = !this.degraded;
        this.degraded = { reason, at: new Date().toISOString(), failures };
        if (wasFine || failures === DEGRADE_AFTER) {
            this.record({ kind: 'sampler.state', sev: 'warn', src: 'sampler', data: { state: 'degraded', reason, failures } });
        }
    }

    _closeSegment(closedBy) {
        if (!this.activeApp || !this.activeSince) return;
        const sec = Math.round((Date.now() - this.activeSince) / 1000);
        if (sec >= 1) this.record({ kind: 'app.usage', src: 'sampler', data: { app: this.activeApp, sec, closedBy } });
        this.activeApp = null;
        this.activeSince = null;
    }

    _applySample(sample, cfg) {
        this.lastSample = sample;
        const now = Date.now();

        if (sample.boot && sample.boot !== this.prevBoot) {
            if (this.prevBoot) {
                this.record({ kind: 'power.boot', src: 'sampler', data: { bootTime: sample.boot, previousBootTime: this.prevBoot } });
            }
            this.prevBoot = sample.boot;
        }

        const fg = sample.fg && sample.fg.app ? sample.fg : null;
        const fgApp = fg ? fg.app : null;
        if (fgApp !== this.activeApp) {
            this._closeSegment('switch');
            if (fgApp) {
                this.activeApp = fgApp;
                this.activeSince = now;
                this.record({
                    kind: 'app.switch', src: 'sampler',
                    data: cfg.titles ? { app: fgApp, title: fg.title || '' } : { app: fgApp }
                });
            }
        }

        const idle = sample.idleSec === undefined ? null : sample.idleSec;
        const state = sessionState(idle);
        const sessionKey = `${(sample.session && sample.session.user) || ''}|${state}|${sample.session && sample.session.locked ? 'locked' : 'unlocked'}`;
        if (sessionKey !== this.prevSession) {
            const first = this.prevSession === null;
            this.prevSession = sessionKey;
            if (!first) {
                this.record({
                    kind: 'session.change', src: 'sampler',
                    data: {
                        user: (sample.session && sample.session.user) || null,
                        state, idleSec: idle,
                        locked: !!(sample.session && sample.session.locked)
                    }
                });
            }
        }

        const netKey = JSON.stringify((sample.net || []).map((n) => `${n.iface}|${n.state}|${n.address}`));
        if (netKey !== this.prevNet) {
            const first = this.prevNet === null;
            this.prevNet = netKey;
            if (!first) this.record({ kind: 'net.change', src: 'net', data: { adapters: sample.net || [] } });
        }

        const disks = sample.disks || [];
        const prevDisks = this.prevDisks || [];
        const diskKey = JSON.stringify(disks.map((d) => `${d.drive}|${d.pct}`));
        if (diskKey !== JSON.stringify(prevDisks.map((d) => `${d.drive}|${d.pct}`))) {
            const prevMap = new Map(prevDisks.map((d) => [d.drive, d]));
            for (const d of disks) {
                const before = prevMap.get(d.drive);
                const crossed = d.pct <= cfg.diskWarnPct && (!before || before.pct > cfg.diskWarnPct);
                if (crossed) {
                    this.record({ kind: 'disk.change', sev: 'warn', src: 'fs', data: { drive: d.drive, freeGb: d.freeGb, pct: d.pct, threshold: cfg.diskWarnPct } });
                } else if (!before) {
                    this.record({ kind: 'disk.change', src: 'fs', data: { drive: d.drive, freeGb: d.freeGb, pct: d.pct, appeared: true } });
                }
            }
            for (const before of prevDisks) {
                if (!disks.some((d) => d.drive === before.drive)) {
                    this.record({ kind: 'disk.change', sev: 'warn', src: 'fs', data: { drive: before.drive, disappeared: true } });
                }
            }
            this.prevDisks = disks;
        }

        this.record({
            kind: 'res.sample', src: 'sampler',
            data: {
                procCount: sample.procCount || null,
                memUsedMb: sample.memFreeMb && sample.memTotalMb ? sample.memTotalMb - sample.memFreeMb : null,
                memTotalMb: sample.memTotalMb || null,
                cpuTop: (sample.procs || []).slice(0, 5)
            }
        });
    }

    _nodeSample(cfg) {
        // Non-Windows or fully degraded: still useful, never nothing.
        this.record({
            kind: 'res.sample', src: 'node',
            data: {
                procCount: null,
                memUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
                memTotalMb: Math.round(os.totalmem() / 1048576),
                loadavg: os.loadavg ? os.loadavg() : []
            }
        });
    }

    _applyEvents(rows) {
        for (const row of rows) {
            const key = `${row.log}|${row.id}|${row.time}`;
            if (this.seenEvents.has(key)) continue;
            this.seenEvents.add(key);
            if (this.seenEvents.size > SEEN_MAX) this.seenEvents = new Set(Array.from(this.seenEvents).slice(-Math.floor(SEEN_MAX / 2)));
            const data = { log: row.log, id: row.id, at: row.time, msg: row.msg };
            if (row.id === 6005) this.record({ kind: 'power.boot', src: 'eventlog', data: { ...data, bootTime: row.time, clean: true } });
            else if (row.id === 1074) this.record({ kind: 'power.shutdown', src: 'eventlog', data: { ...data, clean: true, actor: row.msg } });
            else if (row.id === 6006) this.record({ kind: 'power.shutdown', src: 'eventlog', data: { ...data, clean: true, phase: 'log-service-stop' } });
            else if (row.id === 6008) this.record({ kind: 'power.shutdown', sev: 'critical', src: 'eventlog', data: { ...data, clean: false } });
            else {
                // Not every 1000/1002 row is a crash: routine .NET app exceptions land in the
                // same events. "Faulting application" and "stopped interacting" are the real ones.
                const severe = /faulting application name|stopped interacting/i.test(String(row.msg || ''));
                this.record({ kind: 'app.crash', sev: severe ? 'warn' : 'info', src: 'eventlog', data });
            }
        }
    }
}

const instance = new Sampler();
instance.sessionState = sessionState;   // reused by /health, so the thresholds live in one place
module.exports = instance;
