import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * ============================================================================
 * RUN RECORDER
 * ============================================================================
 * Append-only JSONL, one file per server start, so a session leaves an artefact
 * to analyse instead of a memory that dies with the process.
 *
 * WHY THIS EXISTS, stated as the questions it answers. Every hard question in
 * this framework's development had the same shape — "what was true a moment ago,
 * and how did it change?" — and none of them could be answered, because the
 * server held everything in memory and discarded it:
 *
 *   "Is the run stuck or merely slow?"    a time series of stats
 *   "Why did progression stop acting?"    which guard returned, and when
 *   "Is a closer goal waiting?"           the goal list over time
 *   "Did my fix take effect?"             a build marker in a persistent file
 *
 * The log ring is the sharpest example: 500 lines in memory, with no receive
 * time, which is why reading it positionally produced three wrong conclusions in
 * one session. Stamping arrival time is what turns it into a timeline.
 *
 * THREE STREAMS, all already arriving at the server:
 *
 *   meta       one header line: when the run started, and which build
 *   telemetry  each observation the game posts — the time series
 *   log        each framework message, with its RECEIVE time
 *   command    what the operator asked for, so behaviour can be tied to it
 *
 * WHY SYNCHRONOUS WRITES. `appendFileSync` blocks the event loop for the length
 * of one small append. That is the right trade here: an asynchronous writer needs
 * a queue, ordering guarantees and a flush on shutdown, and losing the last lines
 * of a crashed run is exactly when the file matters most. The file is a debug aid,
 * not a hot path.
 *
 * WHY IT CANNOT BREAK THE RUN. Every write is wrapped: a full disk or a bad path
 * disables the recorder and reports once, rather than throwing into a request
 * handler. A recorder that takes down the thing it observes is worse than none,
 * so the failure mode is "no data", never "no server".
 * ============================================================================
 */

/** A recorded event, as it appears on disk. */
interface Record {
    /** Milliseconds since the run started, so a file reads as a timeline. */
    t: number;
    /** Which stream this line belongs to. */
    kind: 'meta' | 'telemetry' | 'log' | 'command';
    [key: string]: unknown;
}

let dir: string | null = null;
let file: string | null = null;
let startedAt = 0;
let broken = false;

/**
 * Begin a run, writing the header.
 *
 * The file name is the start time, so runs sort chronologically and a directory
 * of them reads as a history. Returns the path, for logging.
 */
export function startRun(build: string): string | null {
    try {
        startedAt = Date.now();
        dir = resolve(process.cwd(), 'runs');
        mkdirSync(dir, { recursive: true });

        // Colons are awkward in file names on some platforms; the dots keep it
        // sortable and readable without them.
        const stamp = new Date(startedAt).toISOString().replace(/:/g, '.');
        file = resolve(dir, `${stamp}.jsonl`);

        // `w` not `a`: the name already identifies the run, and a collision would
        // mean two runs sharing a file, which is worse than overwriting.
        writeFileSync(file, '');

        record({ t: 0, kind: 'meta', build, startedAt, pid: process.pid });
        return file;
    } catch (error) {
        return disable('start', error);
    }
}

/** Append one record. Best-effort, never throws. */
export function record(entry: Record): void {
    if (broken || file === null) return;
    try {
        appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (error) {
        disable('append', error);
    }
}

/** Record a telemetry sample, verbatim. */
export function recordTelemetry(state: unknown, receivedAt: number): void {
    record({ t: elapsed(), kind: 'telemetry', receivedAt, state });
}

/**
 * Record framework messages, stamped with their RECEIVE time.
 *
 * `at` is the game's own clock and `receivedAt` the server's; both are kept
 * because they differ and the difference is itself a fact about the link.
 */
export function recordLog(lines: readonly { seq: number; at: number }[], receivedAt: number): void {
    for (const line of lines) {
        record({ t: elapsed(), kind: 'log', receivedAt, ...line });
    }
}

/** Record an operator command, so a behaviour change can be tied to it. */
export function recordCommand(command: unknown, receivedAt: number): void {
    record({ t: elapsed(), kind: 'command', receivedAt, command });
}

/** Where the current run is being written, or null when recording is off. */
export function runFile(): string | null {
    return file;
}

/** Milliseconds since the run began, or 0 before it has. */
function elapsed(): number {
    return startedAt === 0 ? 0 : Date.now() - startedAt;
}

/**
 * Turn recording off after a failure, reporting once.
 *
 * Once, because a broken writer would otherwise log on every request: the disk
 * being full is one fact, not one per telemetry tick.
 */
function disable(where: string, error: unknown): null {
    broken = true;
    console.error(`recorder disabled (${where}):`, error);
    return null;
}
