import type { NS } from "@ns";

import { colorize, type MessageLevel } from "./message-color.ts";
import { sendMessage } from "./messages.ts";

/**
 * Re-exported so a caller logging a message imports its level type from the same
 * module that sends it, rather than reaching past it to `message-color.ts`.
 */
export type { MessageLevel };

/**
 * Write one line to the two channels a framework message reaches.
 *
 *   panel   `ns.print`, coloured by level. Wiped every pass, so it is only ever
 *           the current frame.
 *   port    the in-game message queue, UNCOLOURED (`tag` + `level` travel with
 *           the body, and the reader colours by level). The orchestrator drains
 *           it and posts the batch to the sync server, which is how a line
 *           reaches the React console.
 *
 * The two are kept in one place so a caller cannot write to one and forget the
 * other. Colouring happens only on the panel path: an ANSI escape in the port
 * payload would be rendered literally by the browser.
 */
function emit(ns: NS, tag: string, message: string, level: MessageLevel): void {
    ns.print(`${colorize(level, `[${tag}]`)} ${message}`);
    sendMessage(ns, tag, message, level);
}

/*
 * ============================================================================
 * CHANGE LOGGING
 * ============================================================================
 * Log a value only when it changes.
 *
 * Every feature that runs on a two-second game tick logs state it re-reads each
 * time, and printing unconditionally fills the tail window with the same line
 * repeated. Five features solved this separately, each with its own module-level
 * `lastX` variable and its own comparison, which is five places to get the same
 * detail wrong.
 *
 * Deliberately small. This is not a logging framework: it does not buffer, format
 * or level anything. It answers one question — has this value changed since I
 * last asked — and prints the line if so.
 *
 * Which channel a line goes to is the framework's rule, not each feature's
 * choice. There are three in principle:
 *
 *   tprint    an event worth reading later. Survives, in the Terminal, forever.
 *   Recent    a recent line worth seeing now. Survives the pass, and ages out.
 *   print     a redrawn frame. Belongs in the dashboard itself, and the panel
 *             clearing each pass is correct for it.
 *
 * **In practice a feature has only the panel.** `tprint` from a feature produced
 * nothing at all in the game, because a feature is dynamically imported into the
 * orchestrator's script and the orchestrator calls `ns.disableLog("ALL")` at boot
 * (see `announce`). Only standalone scripts — those with their own context, such as
 * `doctor.ts` and the retirement handoff `install.ts` — can rely on `tprint`.
 *
 * So the rule for a feature is two-way, not three:
 *
 *   current state, re-read every tick   ->  ChangeLog.change, ChangeLog.print
 *   something that happened once        ->  announce, unconditionally
 *
 * The distinction that matters is not importance but REPETITION. A line on a path
 * that runs every tick must be deduplicated or it becomes the panel's whole
 * content; a line that happens once is printed every time it happens, and the
 * caller is responsible for knowing which it is on.
 *
 * `sleeves.ts` established the shape of this before any of it was shared — its
 * transitions to the ring, its purchases and failures printed where they happen —
 * and every feature now routes through here rather than deciding for itself.
 * ============================================================================
 */

/**
 * One line of an error, for a log that has no room for a stack.
 *
 * A thrown `NS` call arrives with a multi-line stack whose first `\n` ends the
 * useful part and whose remainder buries every other line of the panel. The
 * message is the line above the `Stack:` marker; `sleeves.ts` worked that out
 * first, and this is the same unwrapping so the eleven features that catch errors
 * do not each re-derive it.
 *
 * Falls back to the last non-empty line, because not every throw in Bitburner
 * carries a stack.
 */
export function shortError(e: unknown): string {
    const lines = String(e).split("\n").map(line => line.trim()).filter(Boolean);
    const stack = lines.indexOf("Stack:");
    return (stack > 0 ? lines[stack - 1] : lines[lines.length - 1]) ?? String(e);
}

/**
 * Remembers the last value logged per key.
 *
 * One instance per feature, created on first tick, because the memory has to
 * outlive the tick and cannot be module state shared between features.
 */
export class ChangeLog {
    private readonly lastValues = new Map<string, string>();

    constructor(
        private ns: NS,
        /** Prepended to every line, e.g. "GANG". */
        private readonly tag: string,
    ) { }

    /**
     * The orchestrator hands over a fresh `ns` each tick: after a script restart
     * a feature would otherwise hold a dead context.
     */
    updateNs(ns: NS): void {
        this.ns = ns;
    }

    /**
     * Print `value` under `key` if it differs from the last one logged.
     *
     * `detail` is only printed on a change, because the point is to show the
     * context of a transition rather than to report a steady state.
     */
    change(key: string, label: string, value: string, detail?: string): void {
        if (this.lastValues.get(key) === value) return;
        this.lastValues.set(key, value);
        this.print(`${label}: ${value}${detail === undefined ? "" : ` (${detail})`}`);
    }

    /** Forget a key, so the next `change` logs it regardless of value. */
    reset(key: string): void {
        this.lastValues.delete(key);
    }

    /**
     * An event worth recording every time it happens, not only on change.
     *
     * The log panel, like `change` — see `announce` for why `tprint` is not
     * available from inside a feature. It differs from `change` only in not being
     * deduplicated: the caller knows it is on a path that happens once.
     */
    event(message: string, level: MessageLevel = "success"): void {
        emit(this.ns, this.tag, message, level);
    }

    /** A redrawn line for the log panel, for state that is current rather than news. */
    print(message: string, level: MessageLevel = "info"): void {
        emit(this.ns, this.tag, message, level);
    }
}

/**
 * A single remembered value, for one thing per feature.
 *
 * `once(key, message)` prints `message` the first time it is called with a given
 * key and not again. The key is a primitive rather than a string because what is
 * worth remembering is as often a tier index or a boolean as a name.
 *
 * Why this is separate from `ChangeLog`, which is the question a reader will
 * have. They take different inputs, and the difference is real rather than
 * accidental:
 *
 *   ChangeLog   is handed the PARTS of a line and assembles `label: value (detail)`
 *   ChangeOnce  is handed the finished line
 *
 * `stocks.ts` is the only caller, and it needs this form because its message is
 * computed — `Tier shift @ NW 4.20b (minEdge=0.012)` — and has no meaningful
 * label and value to give separately. Folding it into `ChangeLog` would mean
 * inventing a label and a value that nothing uses independently, which is a worse
 * interface than two small ones.
 */
export class ChangeOnce {
    private lastKey: string | number | boolean | null = null;

    constructor(
        private ns: NS,
        private readonly tag: string,
    ) { }

    updateNs(ns: NS): void {
        this.ns = ns;
    }

    /** True the first time this key is seen; false while it stays the same. */
    changed(key: string | number | boolean): boolean {
        if (this.lastKey === key) return false;
        this.lastKey = key;
        return true;
    }

    /**
     * Print `message` if `key` has changed since the last call.
     *
     * The log panel, like `ChangeLog.event` — its one caller is `stocks.ts`
     * reporting a tier shift.
     */
    once(key: string | number | boolean, message: string, level: MessageLevel = "info"): void {
        if (this.changed(key)) emit(this.ns, this.tag, message, level);
    }

    reset(): void {
        this.lastKey = null;
    }
}

/*
 * ============================================================================
 * RECENT OUTPUT
 * ============================================================================
 * A ring of the last N lines a feature produced, for the orchestrator to show
 * under its dashboard.
 *
 * Why this exists. Features are dynamically imported INTO the orchestrator's
 * script, so `ns.print` from a feature writes to the orchestrator's log panel --
 * which `clearLog` wipes every pass, after every feature has ticked. Nine features
 * had nine log streams and none of them was readable.
 *
 * Three destinations, and the choice between them is the whole point:
 *
 *   tprint    an event worth reading later. Survives, in the Terminal, forever.
 *   Recent    a recent line worth seeing now. Survives the pass, shown under the
 *             dashboard newest-first, and ages out.
 *   print     a redrawn frame. Belongs in the dashboard itself, and the panel
 *             clearing each pass is correct for it.
 *
 * The distinction between the first two is not importance but durability. "Sleeve
 * 2 purchased Nano" is an event: you want it tomorrow. "percentOfRam = 12.5%" is
 * current state: you want it now, and you want it gone once it is stale.
 * ============================================================================
 */

/** How many lines the ring keeps. Enough to cover a few ticks of a chatty feature. */
export const RECENT_CAPACITY = 20;

/**
 * The last N lines, newest first.
 *
 * Deliberately a plain object rather than a class: the orchestrator creates one
 * and hands it to every feature through the Context, so it is shared state with a
 * single owner rather than something each feature instantiates.
 */
export interface RecentLines {
    add(tag: string, message: string, level?: MessageLevel): void;
    /** Newest first, so the line that just happened is the one on top. */
    read(): readonly string[];
}

export function createRecentLines(ns: NS, capacity: number = RECENT_CAPACITY): RecentLines {
    const lines: string[] = [];

    return {
        add(tag, message, level = "info") {
            lines.unshift(`${colorize(level, `[${tag}]`)} ${message}`);
            // The same line also goes to the UI port, so it survives the panel
            // wipe that would otherwise drop it the very next pass.
            sendMessage(ns, tag, message, level);
            // Drop the oldest rather than growing without bound: this runs every
            // tick for the life of a BitNode. The oldest is now at the END, since
            // `add` puts each new line at the front.
            if (lines.length > capacity) lines.length = capacity;
        },
        read: () => lines,
    };
}

/**
 * Report an event, to the one channel that works from inside a feature.
 *
 * Why this is `print` and not `tprint`. Features are dynamically imported INTO
 * the orchestrator's script, and the orchestrator calls `ns.disableLog("ALL")` at
 * boot. `tprint` from that context was observed to produce nothing at all, so an
 * event sent there was lost rather than relocated — including "Grafting X" and
 * "Purchased Y", which is how the bug was noticed.
 *
 * That makes the three-destination split documented at the top of this file
 * aspirational rather than real for a feature: only the log panel is reliably
 * visible, and the panel is cleared every pass. So an event is printed
 * UNCONDITIONALLY, on the path where it happens, and the caller is responsible
 * for not being on a repeating path. State that re-reads every tick goes through
 * `ChangeLog.change` or the ring instead.
 *
 * `doctor.ts` and the retirement handoff `install.ts` are standalone scripts with
 * their own context, so `tprint` does work for them; they keep using it directly
 * rather than this.
 */
export function announce(ns: NS, tag: string, message: string, level: MessageLevel = "info"): void {
    emit(ns, tag, message, level);
}

/**
 * Records a line for the recent-output ring and nothing else.
 *
 * Used by features for state that is worth watching but not worth keeping. The
 * tag is the feature's own, so a line in the ring says where it came from.
 */
export function note(recent: RecentLines, tag: string, message: string, level: MessageLevel = "info"): void {
    recent.add(tag, message, level);
}

/* ─── feature status: what a feature is doing, and why it is not ─── */

/**
 * A one-line account of what a feature is doing this tick.
 *
 * WHY THIS EXISTS. A feature that is loaded and ticking is reported as "active",
 * which is true and nearly useless: it looks identical whether the feature is
 * earning or has returned early from the same guard for an hour. That gap cost
 * real time — a deadlock between progression and Bladeburner was invisible
 * because both were "active" while neither acted, and the question "which guard
 * returned?" could only be answered by reading the source.
 *
 * WHAT A FEATURE SHOULD PUBLISH. The most specific thing it knows: the reason it
 * declined to act, or what it chose to do. Not a description of the feature — the
 * panel already has its name — but the decision it reached this tick.
 *
 * Published on CHANGE only, by the caller comparing against the status getter, so
 * a steady state costs one line rather than one per pass.
 */
export type StatusPublisher = () => string;

const statuses = new Map<string, StatusPublisher>();

/** Register a feature's status getter, replacing any previous one for that id. */
export function publishStatus(id: string, get: StatusPublisher): void {
    statuses.set(id, get);
}

/** Forget a feature's status, as `reset` does for the other module state. */
export function clearStatus(id: string): void {
    statuses.delete(id);
}

/**
 * Every feature's current status, by id.
 *
 * Called by the orchestrator when building telemetry, so the reasons travel with
 * the same frame as the rest of the state and are recorded by the run recorder.
 */
export function readStatuses(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, get] of statuses) {
        try {
            out[id] = get();
        } catch {
            // A status getter is diagnostic; it must never break a pass.
            out[id] = "status unavailable";
        }
    }
    return out;
}
