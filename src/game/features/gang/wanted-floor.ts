/*
 * ============================================================================
 * THE WANTED FLOOR
 * ============================================================================
 * How many members it takes to hold the gang's wanted level against the rise, and when to
 * give them back.
 *
 * WHY THIS EXISTS AS A MODULE RATHER THAN A FUNCTION. The rule used to be a pure
 * `holdRequirement(...)` plus five latches maintained by its caller: the level it engaged at,
 * when the commitment expires, the crew size it committed to, how many readings it had spent
 * at the floor, and the window the trend is measured over. Every one of those was in
 * `gang.ts` at module scope, and the caller re-implemented the engage/release protocol around
 * the call. The interface grew to eight parameters, three of them added in one session, each
 * because the caller had to hand back something the module had told it to remember.
 *
 * The latches ARE the decision — they are what turns a noisy reading into a stable crew — so
 * they belong behind the same interface as the arithmetic. The caller now hands over a
 * reading and gets a crew.
 *
 * WHAT IS STILL PURE, AND WHY. `holdRequirement` and `wantedTrend` remain exported and
 * untouched: they are the arithmetic, they have their own tests, and those tests are the
 * reason the rule was fixable at all this session. This module is the state around them, and
 * it is tested through its own interface — `crewFor` — which is the seam a caller crosses.
 *
 * THE STATE IS NOW OWNED BY AN INSTANCE, not by the module. That is the second half of the
 * fix: two of these cannot leak into each other, a test constructs its own, and a run cannot
 * inherit latches from the previous one because a restart drops the instance rather than
 * relying on someone remembering to call `reset()`.
 * ============================================================================
 */

import {
    WANTED_HOLD_MS,
    WANTED_LEVEL_FLOOR,
    holdRequirement,
    wantedTrend,
    type WantedTrend,
} from "./gang-decisions.ts";

/** What the gang knows about its own wanted pressure, as the module needs it. */
export interface WantedReading {
    /** The level, exactly as the game reports it. */
    readonly level: number;
    /** The NET rate per cycle, current cleaners included. */
    readonly netRate: number;
    /** How many members are on the cleanup task right now. */
    readonly cleaners: number;
    /** What one more cleaner removes per cycle. */
    readonly bestRate: number;
    /** How many members there are to send. */
    readonly members: number;
}

/** The crew the floor asks for, and why it is that size. */
export interface WantedCrew {
    /** How many members to put on cleanup. Zero means give them back. */
    readonly size: number;
    /** A label for the log line, so a reader can tell the two zero-cases apart. */
    readonly reason: string;
    /** What the level has been doing over the window. Published, not just internal. */
    readonly trend: WantedTrend;
}

/** How many readings the trend window keeps — about five minutes at one per game tick. */
export const WANTED_HISTORY_SAMPLES = 150;

export class WantedFloor {
    /** The level the crew engaged at, or null when it is not holding. */
    private engagedAt: number | null = null;
    /** When the commitment expires, in ms, or 0 when there is none. */
    private holdUntil = 0;
    /** The crew size the commitment was made at, or 0. A commitment must be to a number. */
    private committedCrew = 0;
    /** Consecutive readings that have shown the level at the floor. */
    private atFloorReadings = 0;
    /** The recent levels, oldest first, for `wantedTrend`. */
    private readonly history: number[] = [];

    /**
     * The crew for this tick.
     *
     * ONE CALL REPLACES THE WHOLE PROTOCOL the caller used to perform: count the floor streak,
     * append to the window, classify the trend, ask for a size, then latch or clear the
     * commitment and the size. All of that is a consequence of the reading and the module's own
     * memory, so none of it belongs in a caller.
     *
     * `now` is a parameter rather than a call to the clock so a test can drive a whole
     * commitment without waiting for one. That is not testability for its own sake: the
     * commitment is a duration, and a rule about durations that cannot be run at a chosen time
     * cannot be checked against the recorded runs that produced it.
     */
    crewFor(reading: WantedReading, now: number): WantedCrew {
        // The floor streak, before the arithmetic sees it: the floor is the one condition
        // allowed to cut a commitment short, and one reading is not enough to mean it.
        this.atFloorReadings = reading.level <= WANTED_LEVEL_FLOOR ? this.atFloorReadings + 1 : 0;

        // The trend window. Appended once per game tick, so the samples are evenly spaced and
        // the rolling comparison means what it says.
        this.history.push(reading.level);
        while (this.history.length > WANTED_HISTORY_SAMPLES) this.history.shift();
        const trend = wantedTrend(this.history);

        const required = holdRequirement(
            {
                level: reading.level,
                netRate: reading.netRate,
                cleaners: reading.cleaners,
                bestRate: reading.bestRate,
            },
            this.engagedAt,
            this.holdUntil,
            now,
            this.committedCrew,
            this.atFloorReadings,
            trend,
        );

        this.latch(required, reading, now);

        const size = Math.min(required, reading.members);
        return {
            size,
            reason: reading.bestRate > 0 ? "wanted floor" : "wanted floor (no cleaner can make progress)",
            trend,
        };
    }

    /**
     * Engage, hold, or release, in one place.
     *
     * THE PROTOCOL, and keeping it here is the point: engaging latches BOTH the level and the
     * crew size, because a commitment to a size that re-reads the count every tick is not a
     * commitment and churns 12 -> 11 -> 1 -> 11. Releasing clears all three together, so no
     * caller can leave the module half-released.
     *
     * `required > 0` while already engaged means the commitment is still running, and the size
     * is NOT re-latched — that is what makes it a commitment.
     */
    private latch(required: number, reading: WantedReading, now: number): void {
        if (required > 0 && this.engagedAt === null) {
            this.engagedAt = reading.level;
            this.holdUntil = now + WANTED_HOLD_MS;
            this.committedCrew = Math.min(required, reading.members);
            return;
        }
        if (required === 0) {
            this.engagedAt = null;
            this.holdUntil = 0;
            this.committedCrew = 0;
        }
    }

    /** Whether the crew is currently committed, and until when. For the status line. */
    state(): { engagedAt: number | null; holdUntil: number; committedCrew: number; floorReadings: number } {
        return {
            engagedAt: this.engagedAt,
            holdUntil: this.holdUntil,
            committedCrew: this.committedCrew,
            floorReadings: this.atFloorReadings,
        };
    }
}
