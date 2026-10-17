/*
 * ============================================================================
 * TRAINING CAP
 * ============================================================================
 * A hard wall-clock limit on gym and university training, with a cooldown after it.
 *
 * WHY THIS EXISTS. The reachability budget (`REACH_SEC`) refuses a target it can measure
 * as too far away — but it refuses nothing when the rate is UNKNOWN, which is the common
 * case: `floorReachable` returns "keep training" for a null or infinite rate, on the
 * reasoning that refusing on no evidence would stop a fresh run from ever training. The
 * result is that a stat the rate model cannot see is trained indefinitely, which is the
 * complaint this answers: training that goes on forever with nothing to show for it.
 *
 * So this is a different kind of limit. It does not ask WHETHER the target is reachable —
 * it asks HOW LONG the run has been at it, and stops regardless. A rate model can be
 * wrong or silent; a clock cannot.
 *
 * IT APPLIES ONLY TO GYM AND UNIVERSITY TRAINING. Faction work, crimes and backdoors are
 * productive in their own right and are not capped: an arbitrary interruption there would
 * cost reputation or a backdoor for no gain. `capApplies` is the single place that says
 * so, so the rule cannot drift between callers.
 *
 * WHY IT PERSISTS TO A FILE. The orchestrator self-restarts on every file edit, and a
 * module variable would reset to "just started" each time — so a run that is edited often
 * would never reach fifteen minutes, which is the opposite of the intent. The state is
 * two numbers on disk instead, which survive a restart the same way the gang choice does.
 *
 * THE STATE IS SELF-HEALING. Every read reconciles against the clock: a spent budget is
 * not returned until the cooldown has passed, and a stale record from a previous run is
 * discarded rather than inherited. Nothing here needs a cleanup step, because a file that
 * says something impossible is simply rewritten.
 * ============================================================================
 */

import type { NS } from "@ns";

/** How long a stretch of training may run before it must stop. */
export const TRAIN_CAP_MS = 15 * 60_000;

/** How long training stays stopped after hitting the cap. */
export const TRAIN_COOLDOWN_MS = 5 * 60_000;

/** Where the clock lives. Beside the other flag files, on home. */
const STATE_FILE = "training_cap.txt";

/** A stretch of training in progress. */
interface TrainingClock {
    /** When the current stretch began, in ms since epoch. */
    readonly startedAt: number;
    /** When the last cap was hit, or 0 if it has not been. */
    readonly cappedAt: number;
}

const NO_CLOCK: TrainingClock = { startedAt: 0, cappedAt: 0 };

/**
 * Whether the cap governs this action kind.
 *
 * Gym and university only. Everything else is productive work whose interruption would
 * cost something real and gain nothing, which is why the caller checks this rather than
 * applying the cap to whatever happens to be running.
 */
export function capApplies(kind: string): boolean {
    return kind === "GYM" || kind === "UNI";
}

/**
 * What the clock says to do right now.
 *
 *   start   no stretch in progress; the caller should record one
 *   allow   a stretch is running and under the cap
 *   capped  the cap was hit and the cooldown has not elapsed
 *
 * Returned rather than a bare boolean because "not allowed" has two meanings that read
 * differently in the log — "you have been at this long enough" and "you are cooling down"
 * — and collapsing them would make the reason unreadable.
 */
export type CapVerdict = "start" | "allow" | "capped";

/** Read the clock, or the empty one when there is nothing usable on disk. */
function readClock(ns: NS): TrainingClock {
    try {
        if (!ns.fileExists(STATE_FILE, "home")) return NO_CLOCK;
        const [startedAt, cappedAt] = ns.read(STATE_FILE).trim().split(",").map(Number);
        // A malformed or half-written file reads as "nothing recorded" rather than as a
        // clock starting at NaN, which would compare false against everything and let
        // training run unbounded — the exact failure this module prevents.
        if (!Number.isFinite(startedAt) || !Number.isFinite(cappedAt)) return NO_CLOCK;
        return { startedAt, cappedAt };
    } catch {
        return NO_CLOCK;
    }
}

function writeClock(ns: NS, clock: TrainingClock): void {
    try {
        ns.write(STATE_FILE, `${clock.startedAt},${clock.cappedAt}`, "w");
    } catch {
        // A clock that cannot be written is a run with no cap, not a crash. The caller
        // still gets an answer; it simply cannot be trusted to persist.
    }
}

/**
 * What to do about training right now, and record the decision.
 *
 * WRITES ON EVERY CALL, because the state it writes IS the decision: starting a stretch,
 * ending one at the cap, or leaving a running one alone. A read-only version would have
 * to be paired with a separate "now do it" call, and the two could disagree.
 *
 * The clock is anchored to the first tick of training, not to a stat value, so a run that
 * switches from str to def mid-stretch keeps one budget rather than restarting it — the
 * thing being limited is the run's patience, not any one measurement.
 */
export function trainCapVerdict(ns: NS, now: number = Date.now()): CapVerdict {
    const clock = readClock(ns);

    // Cooling down: the cap was hit, and the cooldown has not elapsed. Nothing is
    // recorded as started, so the next stretch begins cleanly once it expires.
    if (clock.cappedAt > 0 && now - clock.cappedAt < TRAIN_COOLDOWN_MS) {
        return "capped";
    }

    // No stretch, or the stored one is from a previous session. `startedAt` after `now`
    // is impossible from a real clock and means the file is stale — a reset in time, a
    // different run — so it is discarded rather than trusted.
    if (clock.startedAt <= 0 || clock.startedAt > now) {
        writeClock(ns, { startedAt: now, cappedAt: 0 });
        return "start";
    }

    // A stretch that has been running since before the last cap is also stale: the cap
    // clears `startedAt`, so finding one still set means the file predates that write.
    if (now - clock.startedAt < TRAIN_CAP_MS) return "allow";

    writeClock(ns, { startedAt: 0, cappedAt: now });
    return "capped";
}

/**
 * Forget the clock, as when training stops for a reason other than the cap.
 *
 * The cap is the run's patience with TRAINING. When the run stops training for its own
 * reasons — the target was reached, the goal moved on — that patience is not being
 * spent, and carrying a half-used budget into the next stretch would cap the second one
 * early. Called by the caller when whatever it is doing is not training.
 */
export function clearTrainingClock(ns: NS): void {
    writeClock(ns, NO_CLOCK);
}

/** For tests: the file the clock lives in. */
export const TRAINING_CAP_FILE = STATE_FILE;
