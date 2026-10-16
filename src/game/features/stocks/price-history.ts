/*
 * ============================================================================
 * PRICE HISTORY
 * ============================================================================
 * A momentum signal, for when 4S Market Data has not been bought.
 *
 * Why this exists. `getForecast` and `getVolatility` are the only Stock calls that
 * require 4S Market Data, and they were the feature's entire entry signal — so on a
 * node with the TIX API but no 4S data, the stock feature could only ever sell and
 * never buy. The gate was a hard stop where it should have been a fallback.
 *
 * What is available instead: `getBidPrice`, `getAskPrice` and `getMaxShares` need no
 * 4S data, so the mid price can be sampled every tick and its recent direction read.
 * That is a WEAKER signal than a forecast and this module does not pretend otherwise.
 * The game's forecasts are derived from a real model; price momentum on the same
 * random walk is mostly noise, and the honest description of what this does is
 * "trade the direction of recent movement, sized cautiously". Its purpose is to keep
 * the feature doing something defensible before 4S is affordable, not to replace it.
 *
 * Deliberately pure: it takes price samples and returns a signal, so the strategy is
 * testable without a market. See `test-fixtures`-style fakes in the tests.
 * ============================================================================
 */

/** How many samples per symbol to keep. At the feature's ~6 s tick this is a few minutes. */
export const HISTORY_LENGTH = 20;

/**
 * Sample history, oldest first, keyed by symbol.
 *
 * A plain object rather than a class, because the feature holds one for the life of
 * the run and passes it in — the same shape as `RecentLines` in lib/log.ts.
 */
export interface PriceHistory {
    get(symbol: string): readonly number[];
    /** Add a sample, dropping the oldest once the window is full. */
    record(symbol: string, price: number): void;
}

export function createPriceHistory(length: number = HISTORY_LENGTH): PriceHistory {
    const samples = new Map<string, number[]>();

    return {
        get: (symbol: string): readonly number[] => samples.get(symbol) ?? [],
        record(symbol: string, price: number): void {
            if (!Number.isFinite(price) || price <= 0) return;
            const list = samples.get(symbol) ?? [];
            list.push(price);
            // Drop the oldest rather than growing without bound: this runs every tick
            // for the life of a BitNode, once per symbol.
            if (list.length > length) list.splice(0, list.length - length);
            samples.set(symbol, list);
        },
    };
}

/** A momentum reading for one symbol. */
export interface Momentum {
    /** Direction of recent movement: +1 rising, -1 falling, 0 flat or unknown. */
    readonly direction: 1 | -1 | 0;
    /**
     * Size of the move as a fraction of the starting price, always non-negative.
     * Comparable across symbols with very different prices, which the raw difference
     * is not.
     */
    readonly strength: number;
    /**
     * How consistently the series moved in `direction`, 0 to 1.
     *
     * `strength` alone cannot tell a smooth trend from a noisy series that merely
     * ended higher than it started, and on a random walk most large window moves ARE
     * the second kind — a few big ticks in the right places. This counts the share of
     * consecutive steps that moved with the overall direction, so a series that rose
     * steadily scores near 1 and one that wandered scores near 0.5.
     *
     * WHY IT MATTERS HERE. Ranking candidates by `strength` alone systematically
     * favours the noisiest symbols, because noise is what produces the largest
     * window-to-window differences. This is the measure that separates a move worth
     * trading from a move that happened to occur.
     */
    readonly consistency: number;
    /** How many samples the reading is based on. */
    readonly samples: number;
}

/** No reading available yet, which is the state for the first few ticks of a run. */
export const NO_MOMENTUM: Momentum = { direction: 0, strength: 0, consistency: 0, samples: 0 };

/**
 * Read the direction of recent movement from a price series.
 *
 * Compares the mean of the newest third against the mean of the oldest third rather
 * than comparing two single samples. A first-vs-last comparison is dominated by
 * whichever two ticks happened to be sampled, and on a market that moves every tick
 * that is pure noise. Averaging over a few samples at each end is the cheapest way to
 * stop the signal flipping on every tick.
 *
 * Returns `NO_MOMENTUM` when there are too few samples to say anything, which is a
 * real state rather than an error: the feature has a window to fill before it can
 * trade at all, and treating that as "flat" is what stops it from acting on two
 * arbitrary readings.
 */
export function readMomentum(samples: readonly number[]): Momentum {
    // Three is the minimum that makes two non-overlapping ends possible.
    if (samples.length < 3) return NO_MOMENTUM;

    const width = Math.max(1, Math.floor(samples.length / 3));
    const oldest = samples.slice(0, width);
    const newest = samples.slice(samples.length - width);

    const start = mean(oldest);
    const end = mean(newest);
    if (start <= 0) return NO_MOMENTUM;

    const change = (end - start) / start;
    const strength = Math.abs(change);
    const direction: 1 | -1 | 0 = change > 0 ? 1 : change < 0 ? -1 : 0;

    return {
        direction,
        strength,
        consistency: consistencyOf(samples, direction),
        samples: samples.length,
    };
}

/**
 * The share of consecutive steps that moved with `direction`.
 *
 * A step is counted when it goes the right way, so a series that rises on every sample
 * scores 1 and one that alternates scores near 0.5. Comparing raw steps rather than
 * averaged thirds is deliberate: averaging is what the main reading already does, and
 * re-using it here would make this measure report the same thing twice rather than a
 * second opinion on it.
 *
 * Returns 0 when there is no direction to measure, which reads as "no confidence" —
 * the honest answer for a flat series.
 */
function consistencyOf(samples: readonly number[], direction: 1 | -1 | 0): number {
    if (direction === 0 || samples.length < 2) return 0;

    let aligned = 0;
    let steps = 0;
    for (let i = 1; i < samples.length; i++) {
        const delta = samples[i] - samples[i - 1];
        // A step that did not move says nothing either way and is not counted, so an
        // unchanging stretch cannot inflate the score.
        if (delta === 0) continue;
        steps++;
        if ((delta > 0 && direction === 1) || (delta < 0 && direction === -1)) aligned++;
    }

    return steps === 0 ? 0 : aligned / steps;
}

function mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Whether a momentum reading is worth acting on.
 *
 * The threshold is expressed as a fraction of price, and it has to clear the round
 * trip cost of a trade to mean anything: two commissions plus the spread. Trading a
 * 0.1% move when the spread alone is 1% loses money however right the direction is,
 * which is the mistake a momentum strategy makes when it is built from the signal
 * alone and never checks whether the signal can pay for itself.
 */
export function isWorthTrading(
    momentum: Momentum,
    spreadPct: number,
    commissionPct: number,
): boolean {
    if (momentum.direction === 0) return false;
    // The move must beat what it costs to enter and leave.
    return momentum.strength > spreadPct + commissionPct * 2;
}

/**
 * The round-trip cost of one trade, as a fraction of price.
 *
 * `spreadPct` is paid once — buying at the ask and selling at the bid crosses it
 * exactly one time over a round trip, not twice — while the commission is paid on
 * both the entry and the exit, hence the doubling.
 */
export function roundTripCost(spreadPct: number, commissionPct: number): number {
    return Math.max(0, spreadPct) + Math.max(0, commissionPct) * 2;
}

/**
 * Whether a position should be HELD, given the reading that would be needed to open it.
 *
 * This is the exit counterpart of `isWorthTrading`, and it exists because the two were
 * not symmetric — which is the single most expensive flaw this strategy had.
 *
 * Entry demanded a move that cleared `spread + 2×commission` before committing money.
 * Exit closed the position the moment the direction of movement turned against it, with
 * no magnitude requirement at all, so a 0.01% wiggle against a position opened on a 3%
 * move closed it and paid the full round trip to do so. The reading is a lagging
 * mean-vs-mean comparison, so its sign flips constantly on noise; the result was that a
 * rare, genuinely cost-clearing entry was immediately undone and could not be re-entered
 * until the cooldown expired. Every flip lost spread + 2×commission and gained nothing.
 *
 * The rule here is that a position is kept while the reading is either still moving the
 * right way, or has not moved far enough the wrong way to pay for closing. `deadband` is
 * a floor under that test so that an exactly-flat reading — which carries no information
 * either way — never triggers a close on its own.
 *
 * Deliberately NOT the same as `isWorthTrading`. That asks whether OPENING is worth it,
 * which is a question about the size of the opportunity; this asks whether CLOSING is
 * worth it, which is a question about whether staying in has become worse than paying
 * to leave. Applying the entry bar here would close every marginal-but-fine position;
 * applying nothing (the old behaviour) churns. The two bars are different on purpose,
 * and both must clear the round trip.
 */
export function worthHolding(
    momentum: Momentum,
    direction: 1 | -1,
    spreadPct: number,
    commissionPct: number,
    deadband: number,
): boolean {
    // No reading is not a reason to sell. The window is refilling after a restart, and
    // an unanswerable question must not close a position — the same rule the caller
    // applies to a null signal.
    if (momentum.samples === 0) return true;

    // Still moving our way: hold.
    const against = direction === 1 ? momentum.direction < 0 : momentum.direction > 0;
    if (!against) return true;

    // Moving against us. This is the case the old rule got wrong, so it is worth being
    // exact about what is required to act on it. A reversal is only worth the round trip
    // when it is large enough to pay for the exit, and `deadband` keeps a genuinely
    // flat reading — which says nothing about direction — from closing a position on
    // its own. Below either bar, this is a wiggle and the position is kept.
    const threshold = Math.max(deadband, roundTripCost(spreadPct, commissionPct));
    return momentum.strength < threshold;
}
