import type { NS } from "@ns";

/*
 * ============================================================================
 * DARK NET REPORTS
 * ============================================================================
 * How a Worm Worker's discovery gets back to the Master.
 *
 * The problem this solves. A Worm Worker runs on a darknet host and can see that
 * host's neighbours, which the Master cannot: `dnet.probe()` reports the
 * neighbourhood of the server the CALLING SCRIPT runs on and takes no host
 * argument. But a worker is a separate script in a separate context, so it cannot
 * return a value — it exits, and its `tprint` goes to the Terminal where nothing
 * reads it.
 *
 * `ns.writePort` is the mechanism. Ports are shared across all HOSTS, not just
 * scripts, so a worker on a deep server writes to the same queue the Master reads on
 * home. It costs 0 GB, the payload is `structuredClone`d (so the worker's object
 * arrives as a plain value rather than a live reference), and the queue is FIFO.
 *
 * Why a dedicated port number rather than a file: a port is freed when its queue
 * empties, so no cleanup is needed after an augmentation reset, and two workers
 * cannot interleave a half-written record the way they could with a shared file.
 *
 * The format is defined ONCE here and imported by both ends, because the failure
 * mode of getting it wrong is silent: a worker writing a shape the Master does not
 * recognise produces reports that are read and discarded, which looks exactly like a
 * net where nothing was discovered.
 * ============================================================================
 */

/** The Dark Net's own port. Ports are global, so this must not collide with another feature's. */
export const REPORT_PORT = 17;

/** What one worker observed, as it crosses the port. */
export interface WormReport {
    /** The host the worker ran on. */
    readonly from: string;
    /** That host's darknet neighbours, as `probe` reported them from there. */
    readonly reachable: readonly string[];
    /** The host's own recorded depth, or -1 when the game would not say. */
    readonly depth: number;
    /** Caches this deployment opened, if any. Optional: older workers send none. */
    readonly opened?: number;
    /** Karma the caches cost. Negative, and 0 when nothing was opened. */
    readonly karmaLost?: number;
    /**
     * Neighbours this worker managed to start another worker on.
     *
     * Reported because reach is otherwise invisible: `ns.exec` cannot cross more than
     * one hop from where the script runs, so how far the walk can see depends entirely
     * on how far the workers have managed to chain. An empty list here on a host with
     * neighbours means the spread is blocked, which is the difference between "nothing
     * is out there" and "we cannot see it".
     */
    readonly spread?: readonly string[];
}

/**
 * The sentinel `readPort` returns for an empty queue.
 *
 * The API's own documented value, not a choice: `readPort` returns the string
 * "NULL PORT DATA" rather than null, so a reader that only checked for null would
 * treat an empty port as a report whose fields are all undefined.
 */
const EMPTY_PORT = "NULL PORT DATA";

/** Send one observation. Called from the worker, which runs on the darknet host. */
export function sendReport(ns: NS, report: WormReport): boolean {
    try {
        return ns.tryWritePort(REPORT_PORT, report);
    } catch {
        // A port write cannot meaningfully fail for us: `tryWritePort` returns false
        // when the queue is full, and a throw would mean the game is shutting the
        // script down. Either way the worker has nothing useful to do about it, and
        // the Master re-deploys, so the report is simply lost.
        return false;
    }
}

/**
 * Drain every report waiting on the port, oldest first.
 *
 * Bounded by `max`, because a queue full of stale reports from workers that ran
 * while the Master was between ticks is not worth processing in one pass: the map is
 * re-read every tick anyway, and the newest report describes the same neighbourhood.
 *
 * Unusable entries are SKIPPED, not treated as the end of the queue. Only the API's
 * own empty-port sentinel stops the loop: the port is global, so a bad entry can be
 * anything, and stopping at one would leave every report behind it unread — which
 * looks exactly like a net where nothing was discovered.
 */
export function drainReports(ns: NS, max = 64): WormReport[] {
    const out: WormReport[] = [];

    for (let i = 0; i < max; i++) {
        let raw: unknown;
        try {
            raw = ns.readPort(REPORT_PORT);
        } catch {
            // The script is being shut down, or the port was cleared underneath us.
            // Nothing more can be read this pass.
            break;
        }

        // The only value that means "there is nothing more". Every other value is
        // something that was written, and is judged on its merits below.
        if (raw === EMPTY_PORT) break;

        const report = asReport(raw);
        if (report !== null) out.push(report);
    }

    return out;
}

/**
 * Validate one port entry into a report, or null when it is not one.
 *
 * Structural rather than trusting: the payload crossed a `structuredClone` and a
 * global queue, so it is `unknown` until checked. A report missing `from` would
 * otherwise be attributed to the wrong host.
 */
function asReport(raw: unknown): WormReport | null {
    if (raw === null || typeof raw !== "object") return null;

    const candidate = raw as {
        from?: unknown;
        reachable?: unknown;
        depth?: unknown;
        opened?: unknown;
        karmaLost?: unknown;
        spread?: unknown;
    };
    if (typeof candidate.from !== "string" || candidate.from === "") return null;
    if (!Array.isArray(candidate.reachable)) return null;

    const reachable = candidate.reachable.filter((host): host is string => typeof host === "string");
    const depth = typeof candidate.depth === "number" ? candidate.depth : -1;
    // The earning fields are optional, so an older worker's report still validates —
    // a worker deployed before an update is running next to this Master until the next
    // mutation restarts the host, and rejecting its report would lose its discovery too.
    const opened = typeof candidate.opened === "number" ? candidate.opened : 0;
    const karmaLost = typeof candidate.karmaLost === "number" ? candidate.karmaLost : 0;
    const spread = Array.isArray(candidate.spread)
        ? candidate.spread.filter((host): host is string => typeof host === "string")
        : [];

    return { from: candidate.from, reachable, depth, opened, karmaLost, spread };
}
