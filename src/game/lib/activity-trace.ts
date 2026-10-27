/*
 * ============================================================================
 * ACTIVITY FLIPS
 * ============================================================================
 * Keeping the player's last N activity changes IN TELEMETRY, so a flip can be read
 * afterwards instead of guessed at.
 *
 * WHY THIS EXISTS. Two complaints had the same shape and neither could be answered from a
 * recording: "it keeps flipping on and off", and "it studies but gains nothing". The
 * recorders never held the answer —
 *
 *   `work` in telemetry    a SNAPSHOT. 1 Hz. A flip that starts and ends between two
 *                          samples leaves no trace at all, and one that does not still
 *                          needs the reader to diff 36,000 frames by hand.
 *   the ACTION log tag     written only ON CHANGE, through a `ChangeLog` deduplicated by
 *                          key, and capped at 500 lines. It reports that something
 *                          changed, never what it changed FROM, and a burst of them can
 *                          push the evidence out of the ring before anyone reads it.
 *
 * So the run keeps its own short history of transitions — from, to, when, and the figures
 * that decide whether the switch was progress — and publishes it with the telemetry. A flip
 * is then a plain fact in the file: N transitions in T minutes, the same pair, alternating.
 *
 * THE HISTORY IS BOUNDED and deliberately small. This rides on a payload published every
 * second, and the point is the shape of the last minute or two, not an audit trail; the
 * JSONL recorder already holds every frame. Eight transitions is enough for a flip to be
 * unmistakable and small enough to be free.
 * ============================================================================
 */

/**
 * The label for the activity slot's current contents.
 *
 * Takes the game's own `Task` rather than a game call, so it is pure and testable, and it
 * matches the `getActionKey` encoding `player.ts` writes to the change log — the two are
 * read side by side and a second vocabulary would be a second thing to match up.
 *
 * `none` rather than an empty string when the slot is empty: a blank entry in a history
 * reads as a missing record, and "doing nothing" is the state most worth seeing named.
 */
export function activityKey(task: unknown): string {
    if (task === null || task === undefined) return "none";
    const t = task as Record<string, unknown>;
    switch (t.type) {
        case "CLASS": return `CLASS:${t.location}:${t.classType}`;
        case "FACTION": return `FACTION:${t.factionName}:${t.factionWorkType}`;
        case "COMPANY": return `COMPANY:${t.companyName}`;
        case "CRIME": return `CRIME:${t.crimeType}`;
        case "CREATE_PROGRAM": return `PROGRAM:${t.programName}`;
        case "GRAFTING": return `GRAFT:${t.augmentation}`;
        // A task type this knows nothing about is reported by its type rather than silently
        // skipped: an unrecognised state is a fact, and dropping it would make the slot look
        // unchanged while it was doing something.
        default: return `OTHER:${String(t.type)}`;
    }
}

/** A measurement the run can make about what the slot holds. */
export interface ActivitySnapshot {
    /**
     * The action as a stable string, e.g. `UNI:Rothman University:Computer Science`.
     *
     * The same encoding `getActionKey` uses for the change log, because the two are read
     * side by side and a second vocabulary would be a second thing to match up.
     */
    readonly key: string;
}

/** One transition: what the slot held before, what it holds now, and when. */
export interface ActivityChange {
    /** Milliseconds since the run started, matching every other `t` in a recording. */
    readonly t: number;
    readonly from: string;
    readonly to: string;
    /** Hacking levels at the moment of the change, so progress either side is visible. */
    readonly hacking: number;
    /** Hacking experience, which moves when the level does not — the "studying, gaining nothing" case. */
    readonly hackingExp: number;
}

/**
 * The history, and the last key seen.
 *
 * A class rather than a module-level pair of variables so a test can make one, and so two
 * runs in one process cannot inherit each other's history — the same reasoning as the
 * features' `reset`.
 */
export class ActivityTrace {
    private last: string | null = null;
    private readonly changes: ActivityChange[] = [];

    constructor(
        /** How many transitions to keep. */
        private readonly capacity = 8,
    ) {}

    /**
     * Note what the slot holds now, returning the history to publish.
     *
     * Returns a COPY. The array is published into a payload that is serialised after this
     * call and read concurrently by the next pass; handing out the live array would let a
     * later transition mutate a frame that had already been described as settled.
     *
     * The first sighting is not a transition: a run that starts mid-class has not flipped,
     * and recording "nothing → class" would put an entry in every history that says more
     * about when the script started than about the run.
     */
    observe(now: number, snapshot: ActivitySnapshot, player: { hacking: number; hackingExp: number }): readonly ActivityChange[] {
        const key = snapshot.key;
        if (this.last === null) {
            this.last = key;
            return this.snapshot();
        }
        if (key === this.last) return this.snapshot();

        this.changes.push({
            t: now,
            from: this.last,
            to: key,
            hacking: player.hacking,
            hackingExp: player.hackingExp,
        });
        this.last = key;

        // Drop the oldest rather than the newest: the recent shape is what a reader wants.
        while (this.changes.length > this.capacity) this.changes.shift();
        return this.snapshot();
    }

    /** The history as it stands, as a fresh array. */
    snapshot(): readonly ActivityChange[] {
        return this.changes.map(change => ({ ...change }));
    }

    /** Forget everything. Exported for tests, like the features' resets. */
    reset(): void {
        this.last = null;
        this.changes.length = 0;
    }
}

/** A run alternating between two activities. Mirrors `ActivityFlip` in `shared/types.ts`. */
export interface ActivityFlip {
    readonly pair: readonly [string, string];
    readonly changes: number;
    readonly windowMs: number;
}

/** How many changes inside the window make a run "thrashing" rather than merely busy. */
export const FLIP_MIN_CHANGES = 4;

/** The window examined. Long enough for a flip to show, short enough to be about now. */
export const FLIP_WINDOW_MS = 5 * 60_000;

/**
 * Whether the history shows two activities trading places.
 *
 * ALTERNATION, not volume. A run that legitimately moves between activities — a backdoor, a
 * program, a crime for cash, back to the course — produces changes too, and warning on every
 * change would be noise. What is pathological is coming BACK: the same pair repeatedly, which
 * is a decision disagreeing with itself.
 *
 * Requires a SINGLE pair throughout. Three activities in rotation is a different fault
 * (nothing is winning), and reporting it as a flip of the first two would misdescribe it, so
 * that case returns null and its history stands as the evidence.
 *
 * Distinct PARTNERS as well as distinct destinations, which is the lesson the combat training
 * already learned: three goals all wanting the same figure produce rounds that look like one
 * loop but are three decisions. Requiring the same two actions THROUGHOUT is what keeps a
 * genuinely busy run out of this.
 */
export function detectFlip(
    changes: readonly ActivityChange[],
    now: number,
    windowMs: number = FLIP_WINDOW_MS,
    minChanges: number = FLIP_MIN_CHANGES,
): ActivityFlip | null {
    const recent = changes.filter(change => now - change.t <= windowMs);
    if (recent.length < minChanges) return null;

    const [first] = recent;
    if (first === undefined) return null;
    const pair: [string, string] = [first.from, first.to].sort() as [string, string];
    if (pair[0] === pair[1]) return null;

    for (const change of recent) {
        const other: [string, string] = [change.from, change.to].sort() as [string, string];
        if (other[0] !== pair[0] || other[1] !== pair[1]) return null;
    }

    return { pair, changes: recent.length, windowMs };
}
