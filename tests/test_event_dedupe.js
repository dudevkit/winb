'use strict';
/**
 * Regression: a server restart must not re-append OS event-log rows that are already in history.
 *
 * The first sweep after start looks back 168 h (sampler.js), while `_seedFromDisk` builds the
 * dedupe set from disk. If the seed covers fewer days than the sweep looks back, every restart
 * copies 4-to-7-day-old events into history again and /timeline shows them as fresh rows.
 *
 * Deterministic, POSIX, no Windows seed: five daily history files, each carrying one event.
 * Expected after seeding: all five keys dedupe, so _applyEvents writes nothing new.
 *
 * Run: node tests/test_event_dedupe.js
 * (WINB_TEST_SERVER_DIR=path/to/srv points it at a sandboxed copy of the server)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function isoDaysAgo(days, time) {
    const d = new Date(Date.now() - days * 86400000);
    return new Date(`${d.toISOString().slice(0, 10)}T${time}Z`).toISOString();
}

function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winb-dedupe-'));
    process.env.WINB_HISTORY_DIR = dir;
    process.env.WINB_TRACK = '0';

    const events = [];
    for (let age = 4; age >= 0; age -= 1) {
        const day = new Date(Date.now() - age * 86400000)
            .toISOString().slice(0, 10).replace(/-/g, '');
        const log = 'Application';
        const id = 1000;
        const at = isoDaysAgo(age, age % 2 ? '08:00:00' : '18:00:00');
        events.push({ log, id, time: at, msg: `Faulting application name old-${age}` , age });
        fs.writeFileSync(path.join(dir, `state-${day}.jsonl`), JSON.stringify({
            t: at, kind: 'app.crash', sev: 'warn', src: 'eventlog',
            data: { log, id, at, msg: `Faulting application name old-${age}` }
        }) + '\n');
    }

    const serverDir = process.env.WINB_TEST_SERVER_DIR
        || path.join(__dirname, '..', 'winb-server');
    const sampler = require(path.join(serverDir, 'sampler.js'));
    sampler._seedFromDisk({ dir, history: true, historyDays: 7 });

    const before = fs.readdirSync(dir).length;
    // what the first tick would ask the helper for: everything the sweep sees in 168 h
    sampler._applyEvents(events.slice());

    const files = fs.readdirSync(dir).filter((n) => /^state-.*\.jsonl$/.test(n));
    const rows = [];
    for (const name of files) {
        for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
            if (line.trim()) rows.push(JSON.parse(line));
        }
    }
    const reappended = rows.filter((r) => r.src === 'eventlog' && rows.filter((o) => o.data && o.data.at === r.data.at).length > 1);
    const duplicated = events.filter((ev) => rows.filter((r) => r.data && r.data.at === ev.time).length > 1);

    console.log(`  history files=${before} rows=${rows.length} reappended=${reappended.length} events duplicated=${duplicated.length}`);
    assert.strictEqual(before, 5, 'expected five seeded daily files');
    assert.strictEqual(rows.length, 5, `restart re-appended event rows: total ${rows.length}, want 5`);
    assert.strictEqual(duplicated.length, 0,
        `duplicated events: ${duplicated.map((e) => e.age).join(',')} days old`);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('[PASS] restart sweep does not re-append events already on disk');
}

main();