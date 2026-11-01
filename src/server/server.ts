import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDocStore } from '@syncstate/core';
import type { BitNodeStamp, Command, LogLine } from '../shared/types.ts';
import { recordCommand, recordLog, recordTelemetry, rollRun, runFile, startRun } from './recorder.ts';
import { describeAnnouncedStart, describeBoundary, isAnnouncedRun, isNewSession, type RunStart, type SessionAnchor } from './session.ts';

// `@syncstate/core`'s build touches `window` under `NODE_ENV !== 'production'`
// (`window['store'] = this`). There is no `window` in Node, so creating a store
// on the server throws unless we provide one. Running with NODE_ENV=production
// also avoids it, but shimming is robust to either build being resolved.
(globalThis as any).window ??= globalThis;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const store = createDocStore({ player: null, portfolio: null, homeRam: null, nexus: null });
let clients: Response[] = []; // Keep track of connected React apps

/**
 * When the server last received telemetry from the game, or null before the
 * first report. The UI reads this (`GET /api/health`) to tell a live run from a
 * stopped one — a distinction the SSE connection state alone cannot make.
 */
let lastReceivedAt: number | null = null;

// --------------------------------------------------------------- recorder ---
//
// Every run writes an append-only JSONL file, so a session leaves something to
// analyse rather than a memory that dies with the process. See `recorder.ts`.

/**
 * The game build this server is paired with, as a fingerprinted timestamp.
 *
 * Recorded in the run header because "is the game actually running the code I
 * just wrote?" cost real time during development and was unanswerable afterwards.
 * The entry script's mtime answers it from the file, and the recorder threads it
 * per run so two runs of different builds do not read as one.
 *
 * Best-effort: an unreadable file records `unknown` rather than failing the run.
 */
function buildStamp(): string {
    try {
        const entry = resolve(process.cwd(), 'src/game/nexus.ts');
        return `${new Date(statSync(entry).mtimeMs).toISOString()}`;
    } catch {
        return 'unknown';
    }
}

let recordingTo = startRun(buildStamp());

/**
 * The evidence the current session file began with, or null when it began without any.
 *
 * Held beside the recorder rather than inside it, because what counts as a new run is a
 * decision (`session.ts`) and the recorder only writes files. A session ADOPTS the first
 * stamp it is given: a server started against a run that has been going for hours must not
 * split that run just for having an opinion at last.
 */
let sessionAnchor: SessionAnchor = { node: null, startedAt: Date.now() };

/**
 * When the orchestrator execution currently being recorded began, or null for none.
 *
 * The counterpart to `sessionAnchor`, for the other way a run ends. The anchor follows the
 * BITNODE, which catches installs; this follows the ORCHESTRATOR, which catches restarts —
 * and a restart leaves the node untouched, so the anchor cannot see one. See `isAnnouncedRun`.
 *
 * Kept beside the recorder for the same reason the anchor is: a file's boundaries are a
 * decision, and the recorder only writes.
 */
let runStartedAt: number | null = null;

// ------------------------------------------------------------------ pipe -----
//
// This server is a dumb pipe. It holds the shared document, broadcasts it over
// SSE, and relays operator commands to the game. It does NOT decide anything:
// strategy lives in the game (the nexus orchestrator), not here.

// ------------------------------------------------------------- commands ---

/**
 * The operator's latest nudge, held until the game confirms it applied it.
 *
 * A single slot rather than a queue: a nudge is target state, not an event
 * stream, so a newer one replaces an older one. The server does not interpret
 * the nudge — feature ids and reserve semantics are the game's concern.
 */
let pendingCommand: Command | null = null;

/**
 * The UI posts an operator nudge; the game polls it.
 */
app.post('/api/command', (req: Request, res: Response) => {
    const body = req.body;

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).json({ error: 'expected a command object' });
        return;
    }

    pendingCommand = body as Command;
    // Recorded before the game acts on it, so a behaviour change in the recorded
    // telemetry can be tied to the instruction that caused it rather than guessed at.
    recordCommand(body, Date.now());
    res.json({ accepted: true });
});

/**
 * The game polls for the latest nudge.
 *
 * Returns 204 when nothing is pending, so the relay can tell "no nudge" from
 * "a nudge I have already applied".
 */
app.get('/api/command', (_req: Request, res: Response) => {
    if (pendingCommand === null) {
        res.status(204).end();
        return;
    }
    res.json(pendingCommand);
});

/**
 * The game confirms it has applied the current nudge.
 *
 * Clearing on ack (rather than on read) means a relay that polls but crashes
 * before applying still sees the command again next time.
 */
app.post('/api/command/ack', (_req: Request, res: Response) => {
    pendingCommand = null;
    res.sendStatus(200);
});

// ------------------------------------------------------------------- log -----

/**
 * How many framework messages to keep.
 *
 * A ring, not a queue: the console shows recent history, and an unbounded buffer
 * on a run measured in days would grow without limit. Old lines are dropped, and
 * `seq` still tells a client where it is, so a gap after a long absence is
 * visible rather than silent.
 */
const LOG_CAPACITY = 500;

/** The message history, oldest first. Bounded by `LOG_CAPACITY`. */
const logLines: LogLine[] = [];

/** The counter stamped on the next line. Never reset, so `since` stays meaningful. */
let nextSeq = 1;

/**
 * Broadcast one SSE event.
 *
 * Log lines go as their own event type rather than as a doc patch: `/api/sync`
 * replaces the whole document on every telemetry tick, so anything folded into it
 * would be wiped a second later. The log is append-only state and travels
 * separately for exactly that reason.
 */
function broadcastEvent(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach((client) => client.write(payload));
}

/**
 * The game posts a batch of framework messages.
 *
 * Batched because the game drains its in-game message port on a cadence: a burst
 * of lines costs one request rather than one per line. The server assigns `seq`,
 * which the client uses to resume with `?since=`.
 */
app.post('/api/log', (req: Request, res: Response) => {
    const body = req.body as { lines?: unknown } | null;

    if (
        !body ||
        typeof body !== 'object' ||
        !Array.isArray(body.lines)
    ) {
        res.status(400).json({ error: 'expected { lines: [...] }' });
        return;
    }

    const accepted: LogLine[] = [];
    for (const raw of body.lines) {
        const line = asLine(raw);
        if (line === null) continue; // skip unusable entries, keep the rest
        const stamped: LogLine = { ...line, seq: nextSeq++ };
        logLines.push(stamped);
        accepted.push(stamped);
    }

    // Trim from the front, so the newest LOG_CAPACITY lines are what remain.
    if (logLines.length > LOG_CAPACITY) {
        logLines.splice(0, logLines.length - LOG_CAPACITY);
    }

    if (accepted.length > 0) broadcastEvent('LOG', accepted);
    // Stamped with the RECEIVE time, which is the specific fix for reading the log
    // positionally and getting it wrong: the file is a timeline, and `seq` alone
    // cannot say how long ago a line arrived.
    recordLog(accepted, Date.now());
    res.json({ accepted: accepted.length });
});

/**
 * The message history, for a client that has just connected or reconnected.
 *
 * `since` is the last `seq` the client already has, so a reconnect fetches only
 * what it missed rather than the whole ring.
 */
app.get('/api/log', (req: Request, res: Response) => {
    const sinceRaw = req.query.since;
    const since = typeof sinceRaw === 'string' ? Number(sinceRaw) : NaN;

    const lines = Number.isFinite(since)
        ? logLines.filter((line) => line.seq > since)
        : logLines;

    res.json({ lines });
});

/**
 * Validate one posted line, or null when it is not one.
 *
 * Structural rather than trusting: the payload crossed a network boundary, so it
 * is `unknown` until checked. A bad entry is skipped rather than failing the
 * batch, so one malformed line cannot cost the rest.
 */
function asLine(raw: unknown): Omit<LogLine, 'seq'> | null {
    if (raw === null || typeof raw !== 'object') return null;
    const candidate = raw as {
        tag?: unknown;
        message?: unknown;
        level?: unknown;
        at?: unknown;
    };
    if (typeof candidate.tag !== 'string' || candidate.tag === '') return null;
    if (typeof candidate.message !== 'string') return null;
    if (
        candidate.level !== 'error' &&
        candidate.level !== 'warn' &&
        candidate.level !== 'success' &&
        candidate.level !== 'info' &&
        candidate.level !== 'tx'
    ) {
        return null;
    }
    return {
        tag: candidate.tag,
        message: candidate.message,
        level: candidate.level,
        at: typeof candidate.at === 'number' ? candidate.at : Date.now(),
    };
}

// ------------------------------------------------------------------ sync -----

// Stream endpoint for React to connect to.
app.get('/api/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcast list
    clients.push(res);

    // Immediately send the current state so React doesn't have to wait for the
    // next Bitburner tick.
    const initialStatePatch = {
        type: "PATCH",
        payload: {
            patch: { op: "replace", path: "", value: store.getState("doc") },
            subtree: "doc",
        },
    };
    res.write(`data: ${JSON.stringify(initialStatePatch)}\n\n`);

    // Replay the most recent messages so the console is not blank on first paint.
    // Only a tail: the client backfills the rest through `GET /api/log?since=0`,
    // which is also how it resumes after a reconnect without duplicating.
    if (logLines.length > 0) {
        const tail = logLines.slice(-50);
        res.write(`event: LOG\ndata: ${JSON.stringify(tail)}\n\n`);
    }

    // Remove client when they close the browser tab
    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

app.post('/api/sync', (req: Request, res: Response) => {
    // The game POSTs plain telemetry — `{ at, player, homeRam, portfolio, nexus }`
    // — not a JSON patch. The server folds it into the shared doc as a full-root
    // replace and broadcasts that as a patch, which is what the UI consumes.
    const state = req.body;

    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
        res.status(400).json({ error: 'expected a state object' });
        return;
    }

    // Stamp the RECEIVE time. Staleness is judged from this rather than the
    // game's own `at`, because the two clocks can diverge and it is the server
    // seeing data that actually proves the pipeline is alive.
    lastReceivedAt = Date.now();

    // A new BitNode ends the run in the file. Checked BEFORE the frame is recorded, so the
    // frame that proves the transition is the first line of the new session rather than the
    // last line of the old one. See `session.ts` for what counts as a transition — notably
    // that a frame with no stamp says nothing either way, and never rolls the session.
    rollSessionOnInstall(state.bitNode);

    // The time series. Recorded as received, before it is folded into the doc, so
    // the file holds what the game actually said rather than what the store ended
    // up containing — the two differ if a later frame overwrites a field.
    recordTelemetry(state, lastReceivedAt);

    try {
        const action = {
            type: 'PATCH',
            payload: {
                patch: {
                    op: 'replace',
                    path: '',
                    value: { ...state, receivedAt: lastReceivedAt },
                },
                subtree: 'doc',
            },
        };
        store.dispatch(action); // Update server state

        // Broadcast the same action to all connected React clients.
        clients.forEach(client => client.write(`data: ${JSON.stringify(action)}\n\n`));

        res.sendStatus(200);
    } catch (error) {
        console.error("Failed to apply state:", error);
        res.sendStatus(500);
    }
});

/**
 * A new orchestrator execution has started, as the GAME reports it.
 *
 * THE OTHER HALF OF `rollSessionOnInstall`, and it exists because that rule can only see
 * what a frame carries. A frame says which BitNode it is in; it cannot say that `nexus.ts`
 * was restarted, because after a restart everything looks the same. So the node rule misses
 * every restart that does not install — a file edit with the sync watcher running, a
 * self-restart, an operator typing `run nexus.ts` again — and each of those is a genuinely
 * new run sharing a file with the execution it replaced.
 *
 * POSTed once from `main`, before the first pass, so the frame that follows is the first
 * line of the new session rather than the last line of the old one.
 *
 * Answers with the file being recorded AFTER the announcement, so the game can say where it
 * is running in its own console. That is a nicety: the game never depends on the answer, and
 * the endpoint is idempotent so a lost response costs nothing.
 */
app.post('/api/run', (req: Request, res: Response) => {
    const body = req.body as Partial<RunStart> | null | undefined;

    const announced: RunStart | null =
        typeof body === 'object' && body !== null && typeof body.startedAt === 'number'
            ? { startedAt: body.startedAt, build: typeof body.build === 'string' ? body.build : undefined }
            : null;

    // A start the server already has, announced again, is not a new run and must not split
    // the file. `isAnnouncedRun` owns that decision, including the restart-the-server case
    // where the game is older than the server recording it.
    if (!isAnnouncedRun(runStartedAt, announced) || announced === null) {
        // ADOPT, don't roll: `null` means the server knows of no run yet, so the first
        // announcement it sees becomes the baseline rather than something to roll on.
        if (announced !== null && runStartedAt === null) {
            runStartedAt = announced.startedAt;
        }
        res.status(200).json({ rolled: false, recording: recordingTo });
        return;
    }

    const reason = describeAnnouncedStart(runStartedAt, announced);
    runStartedAt = announced.startedAt;
    recordingTo = rollRun(buildStamp(), reason);
    console.log(recordingTo === null
        ? `New run (${reason}) but recording is off`
        : `New run (${reason}) → ${recordingTo}`);

    res.status(200).json({ rolled: true, recording: recordingTo });
});

/**
 * Start a new run file when the game reports a different BitNode.
 *
 * The session used to be tied to the PROCESS, which meant the operator had to stop the
 * server and start it again whenever their run reset. The game already tells us which node
 * it is in, so the session can follow the node instead — and the decision itself lives in
 * `session.ts`, pure, because "what counts as a new run" is the part worth pinning.
 *
 * Silent when nothing changes, which is every frame but one per run. When something does
 * change it says so on the console and in the file header, because the operator needs to be
 * able to tell "the log rolled" from "the recorder died at the install".
 */
function rollSessionOnInstall(stamp: BitNodeStamp | null | undefined): void {
    // Narrowed once, here: everything below needs a stamp that IS a stamp, and the two
    // guards would otherwise have to be repeated at every use.
    if (!isStamp(stamp)) return;

    if (!isNewSession(sessionAnchor, stamp)) {
        // Nothing transitions, so the only thing left to do is ADOPT evidence the session did
        // not have — the case `isNewSession` deliberately declines to roll on.
        if (sessionAnchor.node === null) {
            sessionAnchor = { node: stamp, startedAt: sessionAnchor.startedAt };
        }
        return;
    }

    const reason = describeBoundary(sessionAnchor, stamp);
    // The anchor moves to the new node BEFORE the file is opened, so every frame after this
    // one is judged against the run that is now being recorded — including a frame that
    // arrives while the write below is still happening.
    const openedAt = Date.now();
    sessionAnchor = { node: stamp, startedAt: openedAt };
    recordingTo = rollRun(buildStamp(), reason);
    console.log(recordingTo === null
        ? `New run (${reason}) but recording is off`
        : `New run (${reason}) → ${recordingTo}`);
}

/** Whether a frame's `bitNode` is a node and a time, rather than silence or half an answer. */
function isStamp(stamp: BitNodeStamp | null | undefined): stamp is BitNodeStamp {
    return stamp !== null && stamp !== undefined
        && Number.isFinite(stamp.node) && Number.isFinite(stamp.installedAt);
}

/**
 * A tiny liveness endpoint.
 *
 * The UI cannot tell "the game stopped" from "the last frame I got is still
 * true" without asking the server when it last heard from the game. This is
 * that answer, and it is deliberately separate from the SSE stream so it works
 * even when the stream is mid-reconnect.
 */
app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
        receivedAt: lastReceivedAt,
        clients: clients.length,
        now: Date.now(),
    });
});

/**
 * Terminate every error with JSON.
 *
 * Express's default handler renders an HTML stack trace, which both leaks
 * internals and breaks clients that call `response.json()`. Registered last so
 * it catches failures from every route, including body-parser errors for
 * malformed JSON.
 */
app.use(
    (
        err: Error & { status?: number; type?: string },
        _req: Request,
        res: Response,
        _next: unknown
    ) => {
        const status = err.status ?? 500;
        // Body-parser errors carry `type`; surface them as client errors.
        const message =
            err.type === 'entity.parse.failed'
                ? 'request body is not valid JSON'
                : err.message;
        res.status(status).json({ error: message });
    }
);

// `PORT` so a second server can be run beside the development one: the roll is a behaviour
// worth exercising without disturbing the session the game is currently reporting to.
const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
    console.log(`Sync server (dumb pipe) listening on http://localhost:${PORT}`);
    // Named at boot because the path is otherwise only discoverable from the file
    // system, and knowing it is the difference between having data and looking for it.
    console.log(recordingTo === null
        ? 'Run recording disabled'
        : `Recording run to ${recordingTo}`);
});
