import { createDocStore, type DocStore } from "@syncstate/core";
import { createDocSync } from "./syncConnection";
import type { GameDoc } from "./doc";
import type { Command, LogLine } from "../shared/types";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Whether the GAME is still reporting — a different question from whether the
 * browser is connected to the server.
 *
 *   live     telemetry arrived recently; the game is running
 *   stale    nothing for a few seconds; a hitch, or the script was stopped
 *   silent   nothing for a long time; the game is almost certainly not running
 *   unknown  the server has never seen a report since it started
 *
 * The SSE connection state alone cannot tell these apart: a dead game leaves
 * the browser happily "connected" with a frozen frame on screen.
 */
export type GameHealth = "live" | "stale" | "silent" | "unknown";

/** Telemetry older than this (ms) reads as stale rather than live. */
const STALE_AFTER_MS = 5_000;
/** ...and older than this as silent. */
const SILENT_AFTER_MS = 20_000;
/** How often to re-derive health, so the badge ages without new data arriving. */
const HEALTH_TICK_MS = 1_000;

/**
 * UI-side store and connection as one module behind a small interface.
 *
 * Callers get the store to render from, a `connect`/`disconnect` pair, a
 * `status()` read, and `onStatusChange` for the status indicator. Everything
 * about the event stream and transport lives behind that surface.
 *
 * `health()`/`onHealthChange` answer the separate question of whether the game
 * is still reporting, so a stopped script is visible rather than looking like a
 * frozen-but-live dashboard.
 *
 * `log()`/`onLogChange` carry the framework's messages — what features are doing
 * and saying — which arrive as their own stream rather than as part of the
 * document, because the server appends them while it replaces the document.
 *
 * The UI is a pure console: it renders game state read-only and sends operator
 * commands. It holds no strategy state and makes no decisions.
 */
export interface UiBridge {
    store: DocStore;
    connect(): void;
    disconnect(): void;
    status(): ConnectionStatus;
    onStatusChange(cb: (s: ConnectionStatus) => void): () => void;
    health(): GameHealth;
    onHealthChange(cb: (h: GameHealth) => void): () => void;
    /** The framework's messages, oldest first. */
    log(): readonly LogLine[];
    onLogChange(cb: (lines: readonly LogLine[]) => void): () => void;
    /** Send an operator nudge to the game (reserves / feature toggles). */
    sendCommand(command: Command): Promise<void>;
}

let singleton: UiBridge | null = null;

/**
 * How many messages the browser keeps.
 *
 * Smaller than the server's ring: this is a display buffer, and the server holds
 * the authoritative history for a client that needs to look further back.
 */
const CLIENT_LOG_CAPACITY = 300;

/**
 * Optional sync-server override. Empty by default, which means same-origin.
 * Set `VITE_SYNC_URL` to point at a sync server elsewhere.
 */
const SYNC_URL = (import.meta.env?.VITE_SYNC_URL as string | undefined) ?? "";

export function getUiBridge(baseUrl: string = SYNC_URL): UiBridge {
    if (singleton) return singleton;

    // Seed with the same shape the server documents so the UI has a stable
    // structure to render before the first patch arrives.
    const store = createDocStore({ player: null } as GameDoc);
    const statusListeners = new Set<(s: ConnectionStatus) => void>();
    const healthListeners = new Set<(h: GameHealth) => void>();
    const logListeners = new Set<(lines: readonly LogLine[]) => void>();

    let status: ConnectionStatus = "idle";
    let health: GameHealth = "unknown";
    let lastReceivedAt: number | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    // The message buffer, oldest first. Capped, because this is a display window
    // and a run lasts days.
    let log: LogLine[] = [];
    /** The highest `seq` held, so a reconnect can ask for only what it missed. */
    let lastSeq = 0;
    /** Set once lines were lost to a gap the server could no longer fill. */
    let gapNoted = false;

    /**
     * Merge incoming lines, dropping anything already seen.
     *
     * De-duplicated by `seq` because the same batch can arrive twice: the server
     * replays a tail on connect AND the client backfills through `GET /api/log`,
     * and the two can overlap. The server's counter is monotonic, so `seq` is the
     * one field that makes this exact rather than approximate.
     *
     * Returns true when the batch continued the sequence without a hole. A false
     * result means `seq` jumped, which can only happen when lines were dropped:
     * the server's ring is bounded, so a long enough outage ages them out and no
     * amount of asking will retrieve them. The caller records that, so the gap is
     * visible rather than silently stitched over.
     */
    function appendLog(lines: readonly LogLine[]): boolean {
        const fresh = lines.filter((line) => line.seq > lastSeq);
        if (fresh.length === 0) return true;

        const first = fresh[0]!.seq;
        // `lastSeq === 0` is the first load, which has nothing to be continuous with.
        const continuous = lastSeq === 0 || first === lastSeq + 1;

        lastSeq = fresh[fresh.length - 1]!.seq;
        log = [...log, ...fresh].slice(-CLIENT_LOG_CAPACITY);
        for (const listener of logListeners) listener(log);
        return continuous;
    }

    /**
     * Say that messages were lost, once.
     *
     * A gap is unrecoverable by definition — the server has already dropped those
     * lines from its bounded ring — so the only useful thing to do is admit it.
     * Rendered as a line in the feed, because that is where a reader looks when
     * wondering what they missed.
     */
    function noteGap(): void {
        if (gapNoted) return;
        gapNoted = true;
        const marker: LogLine = {
            tag: "console",
            message:
                "messages were lost while the stream was down — the server " +
                "no longer holds them",
            level: "warn",
            at: Date.now(),
            // Above any real line, so it is not filtered as a duplicate and
            // does not advance `lastSeq` past a line that may still arrive.
            seq: Number.MAX_SAFE_INTEGER,
        };
        log = [...log, marker].slice(-CLIENT_LOG_CAPACITY);
        for (const listener of logListeners) listener(log);
    }

    /**
     * Ask the server for whatever the stream has not delivered.
     *
     * Called on every connection. Idempotent: `appendLog` drops anything already
     * held, so overlapping with the server's connect-tail replay is harmless, and
     * a reconnect asks only past what the buffer already contains.
     */
    async function backfill(url: string): Promise<void> {
        const continuous = await backfillLog(url, lastSeq, appendLog);
        if (!continuous) noteGap();
    }

    /**
     * Derive health from the last receive time and notify only on change, so
     * the badge re-renders on transitions rather than every tick.
     */
    function refreshHealth(): void {
        const next = deriveHealth(lastReceivedAt, Date.now());
        if (next === health) return;
        health = next;
        for (const listener of healthListeners) listener(health);
    }

    const sync = createDocSync({
        store,
        baseUrl,
        onStatus: (next) => {
            const wasConnected = status === "connected";
            status = next;
            for (const listener of statusListeners) listener(status);

            // Backfill on EVERY connection, not only the first.
            //
            // `EventSource` reconnects by itself, and until this ran here the
            // backfill happened once inside `connect()` — so anything logged
            // during a dropped stream was lost, with only the server's 50-line
            // connect-tail to cover it. Asking from `lastSeq` is exact, and the
            // same call serves the first load because `lastSeq` starts at 0.
            //
            // The guard is "newly connected", which covers both the first
            // connection and a reconnect; a repeat of the same state is ignored.
            if (next === "connected" && !wasConnected) {
                void backfill(baseUrl);
            }
        },
        onMessage: () => {
            // Any message from the server proves the pipeline is alive. The
            // server stamps `receivedAt` on each frame; fall back to now if a
            // frame predates that field.
            lastReceivedAt = readReceivedAt(store) ?? Date.now();
            refreshHealth();
        },
        onLog: appendLog,
    });

    singleton = {
        store,
        connect: () => {
            sync.start();
            // Age the badge locally: with no new data arriving, nothing else
            // would move it from "live" to "stale"/"silent".
            if (timer === null) {
                timer = setInterval(refreshHealth, HEALTH_TICK_MS);
            }
            void primeHealth(baseUrl, (receivedAt) => {
                lastReceivedAt = receivedAt;
                refreshHealth();
            });
            // No backfill here: it is driven by the connection reaching
            // "connected" (see `onStatus`), which covers the first load and every
            // reconnect through the same path rather than special-casing one.
        },
        disconnect: () => {
            sync.stop();
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        },
        status: () => status,
        onStatusChange: (cb) => {
            statusListeners.add(cb);
            cb(status);
            return () => statusListeners.delete(cb);
        },
        health: () => health,
        onHealthChange: (cb) => {
            healthListeners.add(cb);
            cb(health);
            return () => healthListeners.delete(cb);
        },
        log: () => log,
        onLogChange: (cb) => {
            logListeners.add(cb);
            cb(log);
            return () => logListeners.delete(cb);
        },
        // An operator nudge goes straight to the game via the command channel —
        // the server stores it, the relay polls and applies it. No strategy
        // evaluation in between.
        sendCommand: async (command) => {
            const res = await fetch(`${baseUrl}/api/command`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(command),
            });
            if (!res.ok) {
                const detail = await res.json().catch(() => null);
                throw new Error(detail?.error ?? `command failed: ${res.status}`);
            }
        },
    };

    return singleton;
}

/** Map an age in ms to a health label. */
function deriveHealth(receivedAt: number | null, now: number): GameHealth {
    if (receivedAt === null) return "unknown";
    const age = now - receivedAt;
    if (age < STALE_AFTER_MS) return "live";
    if (age < SILENT_AFTER_MS) return "stale";
    return "silent";
}

/**
 * Read the server's receive time out of the shared doc.
 *
 * The server folds `receivedAt` into every telemetry frame, so the store already
 * holds it; reading it here avoids a second source of truth.
 */
function readReceivedAt(store: DocStore): number | null {
    const value = store.getStateAtPath("doc", "/receivedAt");
    return typeof value === "number" ? value : null;
}

/**
 * Ask the server when it last heard from the game.
 *
 * A fallback for the case where SSE never delivered a frame: on a fresh page
 * load the store is empty, and without this the badge would read "unknown"
 * until the next telemetry tick rather than reflecting a healthy run.
 *
 * It passes back the SERVER's `receivedAt`, not the current time: seeding with
 * `Date.now()` would mark the game live on every page load regardless of how
 * long ago it actually reported, which is worse than showing nothing.
 */
async function primeHealth(
    baseUrl: string,
    onHeard: (receivedAt: number) => void
): Promise<void> {
    try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (!res.ok) return;
        const body = (await res.json()) as { receivedAt?: number | null };
        if (typeof body.receivedAt === "number") onHeard(body.receivedAt);
    } catch {
        // Server unreachable; the SSE status already reports that.
    }
}

/**
 * Fetch the message history the client is missing.
 *
 * `since` is the highest `seq` already held, so a reconnect asks only for what
 * arrived while the stream was down rather than re-fetching the whole ring. On a
 * first load `since` is 0, which is the same full fetch as before.
 *
 * Returns false when the server's oldest surviving line is NEWER than the one
 * asked for, which means the gap cannot be filled: the ring is bounded, so a
 * long outage ages lines out. The caller reports that rather than pretending the
 * history is complete.
 */
async function backfillLog(
    baseUrl: string,
    since: number,
    append: (lines: LogLine[]) => boolean
): Promise<boolean> {
    try {
        const res = await fetch(`${baseUrl}/api/log?since=${since}`);
        if (!res.ok) return true;
        const body = (await res.json()) as { lines?: LogLine[] };
        if (!Array.isArray(body.lines) || body.lines.length === 0) return true;
        // `append` reports whether the batch was contiguous with what we had.
        return append(body.lines);
    } catch {
        // Server unreachable; the SSE status already reports that.
        return true;
    }
}
