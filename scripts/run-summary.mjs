// Summarise a recorded run.
//
// Answers the four questions that motivated recording, from the file rather than
// from memory:
//
//   how long did it run          duration, and the build it ran
//   was it moving                exp and money over time, and where it stalled
//   what did the goal do         every objective transition, with when
//   what did the operator ask    every command, so a change can be tied to it
//
// Deliberately a script and not a tool: it reads one file, prints to stdout, and
// has no dependencies beyond Node. The value is the recorded data; this just makes
// it legible.
//
// Usage: node scripts/run-summary.mjs runs/<file>.jsonl

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
    console.error('usage: node scripts/run-summary.mjs <runs/file.jsonl>');
    process.exit(1);
}

const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const meta = lines.find((l) => l.kind === 'meta');
const telemetry = lines.filter((l) => l.kind === 'telemetry');
const logs = lines.filter((l) => l.kind === 'log');
const commands = lines.filter((l) => l.kind === 'command');

/** `1.2h`, `3m`, `45s`. Coarse on purpose: these are estimates of a whole run. */
function duration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const s = ms / 1000;
    if (s < 90) return `${Math.round(s)}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
}

console.log(`=== run: ${path} ===`);
if (meta) {
    console.log(`  started   ${new Date(meta.startedAt).toISOString()}`);
    console.log(`  build     ${meta.build}`);
}
console.log(`  records   ${lines.length} (${telemetry.length} telemetry, ${logs.length} log, ${commands.length} command)`);

const last = lines[lines.length - 1];
if (last) console.log(`  duration  ${duration(last.t)}`);

/* ─── movement: did anything change, and where did it stop? ─── */

if (telemetry.length >= 2) {
    const first = telemetry[0].state;
    const end = telemetry[telemetry.length - 1].state;
    const exp = (s) => s?.player?.exp?.hacking ?? 0;
    const money = (s) => s?.player?.money ?? 0;

    console.log('');
    console.log('=== movement ===');
    console.log(`  hacking exp  ${Math.round(exp(first)).toLocaleString()} -> ${Math.round(exp(end)).toLocaleString()}`);
    console.log(`  money        ${Math.round(money(first)).toLocaleString()} -> ${Math.round(money(end)).toLocaleString()}`);

    // Longest gap between samples where NOTHING changed. A long flat stretch is
    // the thing that was invisible before: "active" says a feature is loaded, and
    // says nothing about whether it is doing anything — so the reported statuses
    // DURING that stretch are the answer to "why".
    //
    // The status of the sample at the START of the stretch, not the end: the end is
    // the first sample that moved, so its status describes the resumption rather
    // than the stall. Reporting the wrong one would explain the recovery.
    let flatStart = telemetry[0].t;
    let flatState = telemetry[0].state;
    /** @type {{ ms: number, from: number, state: any }} */
    let worst = { ms: 0, from: 0, state: null };
    for (let i = 1; i < telemetry.length; i++) {
        const moved = exp(telemetry[i].state) !== exp(telemetry[i - 1].state)
            || money(telemetry[i].state) !== money(telemetry[i - 1].state);
        if (moved) {
            const span = telemetry[i].t - flatStart;
            if (span > worst.ms) {
                worst = { ms: span, from: flatStart, state: flatState };
            }
            flatStart = telemetry[i].t;
            flatState = telemetry[i].state;
        }
    }
    const tail = telemetry[telemetry.length - 1].t - flatStart;
    if (tail > worst.ms) {
        worst = { ms: tail, from: flatStart, state: telemetry[telemetry.length - 1].state };
    }

    console.log(`  longest stall  ${duration(worst.ms)} starting at ${duration(worst.from)}`);
    // WHY it was stalled — the statuses the features published during the flat
    // stretch. This is the line that turns "nothing changed" into an explanation.
    const statuses = worst.state?.nexus?.statuses;
    if (statuses && Object.keys(statuses).length > 0) {
        console.log('  during that stall:');
        for (const [id, text] of Object.entries(statuses)) {
            console.log(`    ${id.padEnd(12)} ${text}`);
        }
    }
}

/* ─── the goal, and every time it changed ─── */

const goalAt = (s) => s?.nexus?.goal?.name ?? null;
const goals = [];
for (const t of telemetry) {
    const name = goalAt(t.state);
    if (name === null) continue;
    if (goals.length === 0 || goals[goals.length - 1].name !== name) {
        goals.push({ name, t: t.t });
    }
}
if (goals.length > 0) {
    console.log('');
    console.log('=== goal ===');
    for (const g of goals) {
        console.log(`  ${duration(g.t).padStart(6)}  ${g.name}`);
    }
    const finals = telemetry[telemetry.length - 1]?.state?.nexus;
    if (finals?.goal) {
        console.log(`  final: ${finals.goal.name} @ ${Math.round((finals.goal.progress ?? 0) * 100)}%`);
    }
}

/* ─── where each feature's output went quiet ─── */

const byTag = new Map();
for (const l of logs) {
    const prev = byTag.get(l.tag);
    if (prev === undefined || l.receivedAt > prev.at) {
        byTag.set(l.tag, { at: l.receivedAt, count: (prev?.count ?? 0) + 1 });
    } else {
        byTag.set(l.tag, { at: prev.at, count: prev.count + 1 });
    }
}
if (byTag.size > 0) {
    const endAt = last ? (meta?.startedAt ?? 0) + last.t : Date.now();
    console.log('');
    console.log('=== last heard from each tag ===');
    const rows = [...byTag.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [tag, info] of rows) {
        console.log(`  ${String(tag).padEnd(12)} ${String(info.count).padStart(5)} lines | silent for ${duration(endAt - info.at)}`);
    }
}

/* ─── what the operator asked for, and when ─── */

if (commands.length > 0) {
    console.log('');
    console.log('=== commands ===');
    for (const c of commands) {
        console.log(`  ${duration(c.t).padStart(6)}  ${JSON.stringify(c.command)}`);
    }
}
