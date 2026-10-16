import type { NS } from "@ns";

import type { MessageLevel } from "./message-color.ts";

/*
 * ============================================================================
 * MESSAGE PORT
 * ============================================================================
 * The channel that carries every framework message out of the game and into the
 * React console.
 *
 * The problem this solves. Features are dynamically imported INTO the
 * orchestrator's script, so their `ns.print` lands in the panel that `clearLog`
 * wipes every pass, and the orchestrator calls `ns.disableLog("ALL")` at boot so
 * `tprint` from that context is dead. A feature has no durable log line at all.
 *
 * `ns.writePort` is the mechanism. Ports are shared across all HOSTS and all
 * scripts, so a feature running inside the orchestrator writes to the same FIFO
 * queue the orchestrator drains — it costs 0 GB, the payload is
 * `structuredClone`d, and the queue is freed when it empties.
 *
 * The orchestrator is the consumer (`nexus.ts`): it drains the queue on its
 * telemetry cadence and POSTs the batch to the sync server, which keeps the
 * history and streams it to the browser. This is why the port exists rather than
 * a direct `fetch` from each reporting site — a feature has no business knowing
 * the server exists, and a queue decouples the two.
 *
 * Why a dedicated port number rather than a file: a port frees itself on empty, so
 * an augmentation reset needs no cleanup, and two writers cannot interleave a
 * half-written record the way they could with a shared file.
 *
 * The format is defined ONCE here and imported by both ends, because the failure
 * mode of getting it wrong is silent: a writer sending a shape the reader does not
 * recognise produces messages that are read and discarded, which looks exactly like
 * a UI that stopped receiving messages.
 * ============================================================================
 */

/** The framework's message port. Ports are global, so this must not collide with another feature's. */
export const MESSAGE_PORT = 20;

/** One framework message, as it crosses the port. */
export interface LogMessage {
    /** Where it came from, e.g. "SLEEVES", "STOCK", "nexus". */
    readonly tag: string;
    /** The body, uncolored — the UI applies color from `level`. */
    readonly message: string;
    /** What kind of line it is, for the UI to color by. */
    readonly level: MessageLevel;
    /** When it was produced, so the UI can order and age lines. */
    readonly at: number;
}

/** The sentinel `readPort` returns for an empty queue. */
const EMPTY_PORT = "NULL PORT DATA";

/**
 * Send one message to the UI panel, without blocking the caller.
 *
 * `tryWritePort` rather than `writePort` because a feature tick must not stall on
 * a full queue: when the UI is down or lagging, the port fills, and the right
 * response is to drop the oldest-kept line rather than stop the feature. The UI
 * is a convenience window, not a store of record.
 *
 * Returns false when the port is full, so a caller that cares can decide what to
 * shed. `log.ts` does not care: the panel already loses lines to `clearLog`, so a
 * dropped port write is the same class of loss.
 */
export function sendMessage(ns: NS, tag: string, message: string, level: MessageLevel): boolean {
    const msg: LogMessage = { tag, message, level, at: Date.now() };
    try {
        return ns.tryWritePort(MESSAGE_PORT, msg);
    } catch {
        // A throw means the game is shutting the script down; nothing to do but
        // drop the line. See darknet-reports.ts for the same reasoning.
        return false;
    }
}

/**
 * Drain every message waiting on the port, oldest first.
 *
 * Bounded by `max`, because a queue full of messages that accumulated while the
 * UI was between drains is not worth processing in one pass: the UI renders the
 * newest N anyway, and draining a huge backlog in one tick would stall its loop.
 *
 * Unusable entries are SKIPPED, not treated as the end of the queue. The port is
 * global, so a bad entry can be anything, and stopping at one would leave every
 * message behind it unread.
 */
export function drainMessages(ns: NS, max = 256): LogMessage[] {
    const out: LogMessage[] = [];

    for (let i = 0; i < max; i++) {
        let raw: unknown;
        try {
            raw = ns.readPort(MESSAGE_PORT);
        } catch {
            // The script is being shut down, or the port was cleared underneath us.
            break;
        }

        if (raw === EMPTY_PORT) break;

        const msg = asMessage(raw);
        if (msg !== null) out.push(msg);
    }

    return out;
}

/**
 * Validate one port entry into a message, or null when it is not one.
 *
 * Structural rather than trusting: the payload crossed a `structuredClone` and a
 * global queue, so it is `unknown` until checked.
 */
function asMessage(raw: unknown): LogMessage | null {
    if (raw === null || typeof raw !== "object") return null;

    const candidate = raw as {
        tag?: unknown;
        message?: unknown;
        level?: unknown;
        at?: unknown;
    };
    if (typeof candidate.tag !== "string" || candidate.tag === "") return null;
    if (typeof candidate.message !== "string") return null;
    if (
        candidate.level !== "error" &&
        candidate.level !== "warn" &&
        candidate.level !== "success" &&
        candidate.level !== "info" &&
        candidate.level !== "tx"
    ) {
        return null;
    }
    const at = typeof candidate.at === "number" ? candidate.at : 0;

    return { tag: candidate.tag, message: candidate.message, level: candidate.level, at };
}
