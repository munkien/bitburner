/*
 * ============================================================================
 * TRAINING CAP
 * ============================================================================
 * A hard wall-clock limit on gym and university training, with a cooldown after it.
 *
 * WHY THIS EXISTS. The reachability budget (`REACH_SEC`) refuses a target it can measure
 * as too far away — but refuses nothing when the rate is UNKNOWN, which is the common
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
 * THE CLOCK IS IN MEMORY, so restarting `nexus.ts` resets it. That is the intended
 * behaviour: a restart is an explicit act, and treating it as "the run is new" is simpler
 * than persisting a budget and reconciling it against the clock on every read. The cost
 * is that a file edit — which restarts the orchestrator through `self-restart.ts` — also
 * resets it, so the cap is only fully in force on a run left alone.
 * ============================================================================
 */

/** How long a stretch of training may run before it must stop. */
export const TRAIN_CAP_MS = 15 * 60_000;

/** How long training stays stopped after hitting the cap. */
export const TRAIN_COOLDOWN_MS = 5 * 60_000;

/** When the current stretch of training began, or 0 when none is running. */
let startedAt = 0;

/** When the last cap was hit, or 0 if it has not been. */
let cappedAt = 0;

/**
 * When training was last seen, so a brief interruption does not reset the budget.
 *
 * WHY THIS EXISTS. Releasing the clock whenever the run chose something other than
 * training was too eager, and it defeated the cap entirely. The priority chain puts
 * backdoors, the cash floor, travel and augment purchases AHEAD of training, so a run
 * that is mostly training still takes a non-training action every so often — and each one
 * reset fourteen minutes of patience. Measured consequence: a run trained for four hours
 * without the fifteen-minute cap ever firing.
 *
 * Patience is now ended by ABSENCE, not by a single tick. Training seen within
 * `TRAIN_INTERRUPTION_MS` of the last sighting continues the same stretch; a longer gap
 * ends it and the next stretch starts fresh.
 */
let lastTrainedAt = 0;

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
 *   start   no stretch in progress; one is begun
 *   allow   a stretch is running and under the cap
 *   capped  the cap was hit and the cooldown has not elapsed
 *
 * Returned rather than a bare boolean because "not allowed" has two meanings that read
 * differently in the log — "you have been at this long enough" and "you are cooling down"
 * — and collapsing them would make the reason unreadable.
 *
 * Advancing the clock here rather than in a separate "now do it" call, because the state
 * it updates IS the decision: starting a stretch, ending one at the cap, or leaving a
 * running one alone. Two calls could disagree.
 */
export type CapVerdict = "start" | "allow" | "capped";

export function trainCapVerdict(now: number = Date.now()): CapVerdict {
    // Cooling down: the cap was hit and the cooldown has not elapsed. Nothing is recorded
    // as started, so the next stretch begins cleanly once it expires.
    if (cappedAt > 0 && now - cappedAt < TRAIN_COOLDOWN_MS) return "capped";

    if (startedAt <= 0) {
        startedAt = now;
        return "start";
    }

    if (now - startedAt < TRAIN_CAP_MS) return "allow";

    startedAt = 0;
    cappedAt = now;
    return "capped";
}

/**
 * Forget the clock, as when training stops for a reason other than the cap.
 *
 * The cap is the run's patience with TRAINING. When the run stops training for its own
 * reasons — the target was reached, the goal moved on — that patience is not being spent,
 * and carrying a half-used budget into the next stretch would cap the second one early.
 * Called by the caller when what it chose is not training.
 */
export function clearTrainingClock(): void {
    startedAt = 0;
    cappedAt = 0;
}

/** Forget everything. Exported for tests, like the other features' resets. */
export function reset(): void {
    startedAt = 0;
    cappedAt = 0;
}

/**
 * How long a gap between training ticks still counts as the same stretch.
 *
 * Two minutes is longer than any single non-training action the priority chain interposes
 * between gym sessions (a backdoor, a donation, an augmentation purchase — all sub-second
 * decisions), and far shorter than the fifteen-minute budget, so a run that genuinely
 * stops training still releases its patience promptly.
 */
export const TRAIN_INTERRUPTION_MS = 2 * 60_000;

/**
 * Note that training is happening right now, continuing the current stretch.
 *
 * Separate from `trainCapVerdict` because the two answer different questions: this one
 * records a sighting, that one decides whether the budget allows another. Keeping them
 * apart means the interruption window is applied in ONE place rather than being rebuilt
 * at every call site.
 */
export function noteTraining(now: number = Date.now()): void {
    lastTrainedAt = now;
}

/**
 * Release the budget only if training has genuinely stopped.
 *
 * The caller reports "the chosen action is not training" every tick it is not, which is
 * most ticks for a run doing faction work. Only an ABSENCE longer than
 * `TRAIN_INTERRUPTION_MS` ends the stretch — see `lastTrainedAt` for why.
 */
export function releaseIfTrainingStopped(now: number = Date.now()): void {
    if (lastTrainedAt === 0) return;
    if (now - lastTrainedAt < TRAIN_INTERRUPTION_MS) return;
    startedAt = 0;
    lastTrainedAt = 0;
}
