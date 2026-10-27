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
 * ONE FILE PER SESSION, and a session is one BitNode. When the game installs a node the
 * server rolls to a new file rather than waiting to be restarted; `rollRun` closes the old
 * one with a final `meta` line so the file cannot be mistaken for a run that was killed.
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
 * How many runs this process has written.
 *
 * The session outlives a BitNode: when the game installs a node the server rolls to a new
 * file rather than the operator restarting it. So this is a counter, not a constant — and
 * every record's `t` is measured from ITS session's start, so a file reads as a timeline
 * whichever session in the process wrote it.
 */
let sessions = 0;

/**
 * Begin a run, writing the header.
 *
 * The file name is the start time, so runs sort chronologically and a directory
 * of them reads as a history. Returns the path, for logging.
 */
export function startRun(build: string): string | null {
    return open(build, null);
}

/**
 * Close the current run and open a new one, keeping both.
 *
 * WHY A ROLL RATHER THAN A RESTART. The session boundary is a BitNode install, and the
 * operator was previously expected to stop the server and start it again at that moment —
 * which is the one moment a run resets and a terminal is the last thing on their mind.
 * Rolling keeps the old file whole and opens a new one after a closing line.
 *
 * The closing line is written so a file is self-describing: a run that simply stops, with
 * no final record, cannot be told apart from a server killed mid-run, and the difference
 * matters when reading a directory of them back.
 */
export function rollRun(build: string, reason: string): string | null {
    // The reason belongs to the file that is ENDING, not the one that follows: it names the
    // transition that closed this run, and the new file's header will carry the same words
    // as the reason it EXISTS. Both are written, because a reader could arrive from either
    // direction — a file that stops with no explanation, and a file whose header is read out
    // of context, are the two ways this directory gets misread.
    if (!broken && file !== null) {
        record({ t: elapsed(), kind: 'meta', event: 'end', session: sessions, reason });
    }
    return open(build, reason);
}

/**
 * Open a run file and write its header.
 *
 * `reason` is set only when the file continues a process rather than starting one, and it
 * is also a filename suffix: a roll can land in the same millisecond as the open it
 * follows — frames arrive every second, so the name is that coarse — and `w` would then
 * overwrite the session it was meant to preserve.
 */
function open(build: string, reason: string | null): string | null {
    try {
        sessions += 1;
        startedAt = Date.now();
        dir = resolve(process.cwd(), 'runs');
        mkdirSync(dir, { recursive: true });

        // Colons are awkward in file names on some platforms; the dots keep it
        // sortable and readable without them.
        const stamp = new Date(startedAt).toISOString().replace(/:/g, '.');
        const name = reason === null ? `${stamp}.jsonl` : `${stamp}--${sessions}.jsonl`;
        file = resolve(dir, name);

        // `w` not `a`: the name already identifies the run, and a collision would
        // mean two runs sharing a file, which is worse than overwriting.
        writeFileSync(file, '');

        record({
            t: 0,
            kind: 'meta',
            build,
            startedAt,
            pid: process.pid,
            session: sessions,
            ...(reason === null ? {} : { reason }),
        });
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

/** Milliseconds since this SESSION began, or 0 before one has. */
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
