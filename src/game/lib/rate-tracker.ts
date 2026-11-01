/*
 * ============================================================================
 * XP RATES
 * ============================================================================
 * How fast a measurement is actually rising, and what that implies.
 *
 * Why this exists. The training budget — "give up on a target we cannot reach in thirty
 * minutes" — is only as good as the rate it divides by, and that rate was computed inside
 * `player.ts` from `Date.now()` read in three separate places. That made it untestable:
 * the one bug this area produced (training for 1.5 hours on an unreachable target) could
 * not be reproduced end-to-end, because a test cannot move a clock it does not own.
 *
 * So time arrives as a PARAMETER here. Nothing in this module reads a clock, which means
 * a test can simulate an hour of training in a few lines and assert what the framework
 * decides. That is the seam the `player.ts` version was missing.
 *
 * The rate is deliberately measured rather than assumed. A target's reachability is a
 * property of how fast the player is actually improving, which changes as their stats,
 * equipment and multipliers change — a constant would be wrong on almost every run.
 *
 * WHY THIS LIVES IN `lib/` NOW. It was `features/player/rate-tracker.ts`, which was right
 * while the player was the only thing whose rate mattered. Sleeves now apply the same
 * training budget and need a rate for it, and they cannot import the player feature
 * (ADR 0001): a static import between features charges one feature's RAM to the other.
 * This module imports nothing at all and reads no clock, so moving it costs nothing and
 * makes it reachable from both. It is the same reasoning as `lib/training-budget.ts`,
 * which is the module that consumes these rates.
 * ============================================================================
 */

/** Which measurement a rate belongs to. Matches the short codes `player.ts` uses. */
export type MeasuredStat = "hacking" | "str" | "def" | "dex" | "agi" | "cha";

/** One measurement's rate, and when it was taken. */
export interface RateSample {
    /** Levels per second. */
    readonly rate: number;
    /** The timestamp the measurement was taken at, in ms. */
    readonly at: number;
}

/** The open observation, waiting for enough elapsed time to become a rate. */
export interface OpenSample {
    readonly stat: MeasuredStat;
    readonly value: number;
    readonly at: number;
}

/** How long between two readings of the same measurement before a rate can be taken. */
export const RATE_WINDOW_MS = 60_000;

/**
 * How long a rate stays usable.
 *
 * Past this, the measurement no longer describes the player. Stats, equipment and
 * BitNode multipliers all change, and an ancient rate divided into a current gap gives a
 * confident answer about a player who no longer exists.
 */
export const RATE_STALE_MS = 30 * 60_000;

/**
 * The rate below which a measurement counts as "not really rising".
 *
 * NO LONGER APPLIED INSIDE `observe` — see the report there. It used to floor the measured
 * rate upward, which made the framework believe a stalled stat was rising and train it
 * forever. The measurement now reports the true gain and this constant is the CONSUMER's
 * threshold for deciding a rate is too small to act on.
 *
 * Half a level per window: a rate below this is indistinguishable from noise at the sample
 * resolution, so a target whose ETA is computed from it should be treated as unreachable
 * rather than as slowly reachable.
 */
export const MIN_RATE = 0.5 / (RATE_WINDOW_MS / 1000);

/**
 * Take a reading and, once enough time has passed, produce a rate.
 *
 * Returns the next open sample and, when one could be taken, the rate it produced. Pure:
 * it computes from its arguments and returns the result rather than mutating anything, so
 * the caller owns the state and a test can drive any sequence of readings it likes.
 *
 * A change of measurement discards the open sample rather than averaging across it.
 * Hacking levels and strength levels rise at very different rates, so a rate blended from
 * both describes neither.
 */
export function observe(
    open: OpenSample | null,
    stat: MeasuredStat,
    value: number,
    now: number,
): { open: OpenSample; rate: RateSample | null } {
    if (open === null || open.stat !== stat) {
        // Nothing to compare against yet, or a different measurement entirely.
        return { open: { stat, value, at: now }, rate: null };
    }

    const elapsedMs = now - open.at;
    if (elapsedMs < RATE_WINDOW_MS) {
        // Not enough time for the difference to mean anything. The open sample is kept,
        // so the window is measured from the FIRST reading rather than sliding forward.
        return { open, rate: null };
    }

    const elapsedSeconds = elapsedMs / 1000;

    // THE TRUE GAIN, unfloored. This used to be
    // `Math.max(value - open.value, MIN_RATE * elapsedSeconds)`, which reported a rate of at
    // least `MIN_RATE` no matter what actually happened — so a stat rising at a tenth of
    // MIN_RATE was recorded as rising at MIN_RATE, eight times faster than reality.
    //
    // That floor was a LIE IN THE MEASUREMENT, and it broke the one decision the measurement
    // exists for. `floorReachable` divides the gap by this rate to decide whether a target is
    // worth training; with the rate floored upward, a gap of 35 points at a real rate far
    // below the floor still produced an ETA inside the budget, so the feature never gave up
    // and the player trained a hopeless target indefinitely. The reported case: agility 165
    // toward 200, fifteen minutes with no movement.
    //
    // A rate of zero or less is now reported as exactly that, and it is the honest answer:
    // the stat did not rise. The "do not abandon a target on no evidence" policy lives in
    // `floorReachable`, which already has a branch for a rate that is not usable — that is
    // the right place for it, because it is a decision about what to DO rather than a fact
    // about what happened. Correcting the number here and the policy there keeps the two
    // from being tangled, which is what the old floor did.
    const gained = value - open.value;

    return {
        open: { stat, value, at: now },
        // Clamped at zero: a stat that FELL is not a negative rate to divide into a positive
        // gap, and a negative rate would make an unreachable target look reachable again by
        // flip-flopping the sign. Zero is the honest reading — no progress this window.
        rate: { rate: Math.max(0, gained / elapsedSeconds), at: now },
    };
}

/**
 * The rate for one measurement, or null when there is no usable one.
 *
 * Null covers both "never measured" and "measured too long ago", because the caller can
 * do nothing different about them: either way it has no rate, and the honest response is
 * to keep training and measure again rather than to guess.
 */
export function rateFor(
    rates: Readonly<Partial<Record<MeasuredStat, RateSample>>>,
    stat: MeasuredStat,
    now: number,
): RateSample | null {
    const sample = rates[stat];
    if (sample === undefined) return null;
    if (now - sample.at > RATE_STALE_MS) return null;
    return sample;
}

/**
 * How far the measurement is from closing the gap, as a ratio of the budget.
 *
 * `1` means exactly the budget; above it, the target is out of reach. Returning a ratio
 * rather than a boolean keeps "how much too slow" answerable, which is what a reader
 * needs when the framework decides to stop — "13.9h against a 30m budget" says what a
 * bare `false` cannot.
 *
 * `Infinity` when there is no usable rate, which callers must treat as out of reach.
 */
export function budgetRatio(gap: number, rate: number | null, budgetSeconds: number): number {
    if (gap <= 0) return 0;
    if (rate === null || !Number.isFinite(rate) || rate <= 0) return Infinity;
    if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) return Infinity;
    return gap / rate / budgetSeconds;
}

/* ─── INCOME, AS A RATE ─── */

/**
 * How fast cash is arriving, as a rate sample, or null when nothing is measured.
 *
 * SEPARATE FROM THE STAT RATES DELIBERATELY. `MeasuredStat` is the set of TRAINING
 * measures, and every consumer indexes a `Record<MeasuredStat, ...>` keyed by stat name —
 * adding "money" to that union would make a hacking-rate lookup able to ask for a cash
 * rate and still compile. Income is a different question with the same arithmetic.
 *
 * The arithmetic IS shared, through `observe`. That is the point: the measurement window,
 * the staleness rule and the refusal to floor a rate upward are properties of measuring
 * anything over time, and a second copy of those rules is a second thing to disagree with.
 * The one difference is the direction of "good": a falling balance is not a negative rate
 * to divide into a gap, and `observe` already clamps at zero.
 *
 * Measured from HOME CASH rather than `player.money`. The two differ when money is in the
 * stock market, and the reserve is spent from home cash — measuring the wrong one would
 * make a run that keeps its wealth invested look like it earns nothing.
 */
export interface IncomeSample {
    /**
     * Dollars per second. Never negative: a balance that FALL is a purchase, not a
     * negative income, and `observe` already clamps for exactly this reason.
     */
    readonly rate: number;
    /** The timestamp the measurement was taken at, in ms. */
    readonly at: number;
}

/** The open income observation, waiting for enough elapsed time to become a rate. */
export interface OpenIncome {
    readonly value: number;
    readonly at: number;
}

/**
 * Take a cash reading and, once enough time has passed, produce a rate.
 *
 * Shaped exactly like `observe` and for the same reason: time arrives as a parameter, so a
 * test can simulate an hour of earning in a few lines. The window is the same
 * `RATE_WINDOW_MS`, because an income rate averaged over a different period than a stat
 * rate would make the two budgets incomparable.
 */
export function observeIncome(
    open: OpenIncome | null,
    cash: number,
    now: number,
): { open: OpenIncome; rate: IncomeSample | null } {
    if (open === null) return { open: { value: cash, at: now }, rate: null };

    const elapsedMs = now - open.at;
    if (elapsedMs < RATE_WINDOW_MS) return { open, rate: null };

    const gained = cash - open.value;

    // A FALL IS A PURCHASE, NOT AN EARNING RATE — SO NO RATE IS PRODUCED AT ALL.
    //
    // This used to return `Math.max(0, gained / elapsed)`, which clamped a fall to a rate of
    // ZERO. That is the right answer to "what is the income" and the wrong thing to publish:
    // zero is a MEASUREMENT, and every consumer reads it as evidence that the run is not
    // earning. The augmentation reserve is decided from this figure, so it collapsed to
    // nothing on the tick any purchase landed and stayed there for a whole window —
    // thirteen times in `runs/2026-11-01T12.22.54.797Z`:
    //
    //   13:23:15  income 1577k  money 260.7m
    //   13:23:20  income    0k  money  79.0m   <- a purchase inside the window
    //
    // Returning null instead leaves the caller holding its previous sample, which is the
    // honest state: nothing new was measured, and what was measured last is still the best
    // description of how fast this run earns. `incomeFor` ages it out on its own, so a run
    // that genuinely stops earning loses the figure within `RATE_STALE_MS`.
    //
    // The open sample is STILL RESET to the new balance, so the next window measures from
    // just after the purchase rather than straddling it.
    if (gained < 0) {
        return { open: { value: cash, at: now }, rate: null };
    }

    return {
        open: { value: cash, at: now },
        rate: { rate: gained / (elapsedMs / 1000), at: now },
    };
}

/** The income rate, or null when there is none or it is too old to describe the run. */
export function incomeFor(sample: IncomeSample | null, now: number): number | null {
    if (sample === null) return null;
    if (now - sample.at > RATE_STALE_MS) return null;
    return sample.rate;
}
