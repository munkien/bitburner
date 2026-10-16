import type { TimingFacts } from "./target-facts.ts";

/*
 * ============================================================================
 * BATCH PLANNING
 * ============================================================================
 * The batch-shape arithmetic for the hacking feature, as pure functions.
 *
 * Why this exists. This is the only real algorithm in the framework — an HWGW
 * pipeline whose four launches have to land in a fixed order, sized to the thread
 * pool and spaced so the pipeline does not collide with itself — and it had no
 * tests at all. It lived inside a function that also made 10 `ns` calls, so no
 * test could reach the arithmetic without faking a game.
 *
 * The seam is facts versus arithmetic. `target-facts.ts` gathers the numbers;
 * everything here is arithmetic on them, so a test supplies numbers and asserts a
 * shape. One thing is deliberately NOT here: how many grow threads restore a
 * given amount of money, because that is the game's growth formula and belongs
 * with the other facts. It arrives as a function on the inputs.
 * ============================================================================
 */

/** Everything the planner needs to choose a batch, and nothing about the game. */
export interface PlanInputs {
    /** Timing for the target at minimum security and maximum money, post-prep. */
    readonly prep: TimingFacts;
    /** Security added per hack and grow thread, and removed per weaken thread. */
    readonly costs: { hackSecurity: number; growSecurity: number; weakenPerThread: number };
    /** Threads the pool can run across the whole network. */
    readonly poolThreads: number;
    /** Threads worth giving this target, given how many targets are active. */
    readonly slots: number;
    /** Player hacking level, recorded so a plan can be invalidated when it rises. */
    readonly level: number;
    /**
     * How many grow threads restore the fraction of money a hack leaves behind.
     *
     * Supplied rather than computed here because it is the game's growth formula:
     * `ns.formulas.hacking.growThreads` or `ns.growthAnalyze`, whichever the
     * caller's capabilities allow. Keeping it out means this file has no `ns`.
     */
    readonly growThreadsFor: (moneyFractionRemaining: number) => number;
}

export interface BatchPlan {
    readonly h: number;
    readonly g: number;
    readonly w1: number;
    readonly w2: number;
    /** Delays, in ms, that land the four launches in HWGW order. */
    readonly dH: number;
    readonly dG: number;
    readonly dW2: number;
    readonly timeToWeaken: number;
    readonly gap: number;
    /** Milliseconds from first launch to last landing. */
    readonly span: number;
    /** Security the batch adds, used to detect a spike above the plan's swing. */
    readonly swing: number;
    readonly level: number;
    readonly pool: number;
}

/** Tuning for the planner itself, separated so tests can shrink the search. */
export interface PlannerConfig {
    /** Milliseconds between the four launches within a batch. */
    readonly spacingMs: number;
    /** Fraction of the target's money one batch should take. */
    readonly hackFraction: number;
    /** Multiplier on the computed grow threads, to cover rounding and drift. */
    readonly growBuffer: number;
    /** Caps the pipeline depth, which caps how long a batch spans. */
    readonly maxDepth: number;
}

/** Ratio by which the hack fraction is relaxed between attempts. */
const RELAX = 0.8;
/** Below this the attempt is not worth trying and the search stops. */
const MIN_FRACTION = 0.005;
/** Milliseconds of slack after the last landing before the batch is called done. */
const TAIL_MS = 100;

/**
 * Choose a batch, or `null` when no batch fits the pool.
 *
 * The search is deliberately simple, and worth reading as the algorithm:
 *
 *   - A batch is `h` hack threads, `g` grow threads and two weaken groups, and it
 *     has to fit the target's slot budget all at once.
 *   - Bigger `h` takes more money but needs proportionally more grow and weaken,
 *     so the search starts at the configured hack fraction and relaxes it until a
 *     shape fits. That is why a target with a small pool still gets a small batch
 *     rather than none.
 *   - The first budget is a fair share of the pool, the second is all of it.
 *     Trying the fair share first stops one greedy target starving the others,
 *     and the second attempt is the fallback for when nothing else wants them.
 *
 * The search returns the first shape that fits rather than the largest, because
 * the two budgets already express how greedy to be.
 */
export function chooseBatch(inputs: PlanInputs, config: PlannerConfig): BatchPlan | null {
    const { prep, costs, slots, poolThreads } = inputs;
    const { spacingMs: S, hackFraction, growBuffer, maxDepth } = config;

    if (slots < 2) return null;
    if (!(prep.hackPercent > 0)) return null;
    if (!(costs.weakenPerThread > 0)) return null;

    const timeToWeaken = prep.weakenTime;
    // The gap bounds the pipeline's depth: many shallow batches rather than one
    // that spans several weaken times.
    const gap = Math.max(S * 4, Math.ceil(timeToWeaken / maxDepth));
    const depth = Math.max(1, Math.floor(timeToWeaken / gap));
    const fairShare = poolThreads / Math.max(1, depth);

    for (const budget of [Math.min(slots, fairShare), slots]) {
        for (let fraction = hackFraction; fraction >= MIN_FRACTION; fraction *= RELAX) {
            const h = Math.floor(fraction / prep.hackPercent);
            if (h < 1) continue;
            const taken = h * prep.hackPercent;

            // Grow restores what the hack takes; the caller supplies the count.
            const g = Math.ceil(inputs.growThreadsFor(1 - taken) * growBuffer);
            if (!(g >= 1)) continue;

            const w1 = Math.ceil((h * costs.hackSecurity) / costs.weakenPerThread);
            const w2 = Math.ceil((g * costs.growSecurity) / costs.weakenPerThread);
            if (h + g + w1 + w2 > budget) continue;

            return {
                h,
                g,
                w1,
                w2,
                // HWGW order: hack lands, then weaken absorbs it, then grow
                // restores the money, then weaken absorbs that. Each delay is
                // measured from this batch's own launch, so all four land in
                // sequence off one weaken time.
                dH: Math.max(0, timeToWeaken - S - prep.hackTime),
                dG: Math.max(0, timeToWeaken + S - prep.growTime),
                dW2: S * 2,
                timeToWeaken,
                gap,
                span: timeToWeaken + S * 2 + TAIL_MS,
                swing: h * costs.hackSecurity + g * costs.growSecurity,
                level: inputs.level,
                pool: poolThreads,
            };
        }
    }

    return null;
}

/**
 * Whether an existing plan is stale enough to replace.
 *
 * A plan is built against a pool size and a hacking level, and both grow. Below
 * these ratios the difference is not worth the disruption of rebuilding a
 * pipeline mid-flight; above them, the old plan is leaving real throughput on the
 * table.
 */
export function shouldReplan(
    plan: BatchPlan,
    currentLevel: number,
    currentPoolThreads: number,
    config: { levelRatio: number; poolRatio: number },
): boolean {
    if (currentLevel >= plan.level * config.levelRatio) return true;
    return currentPoolThreads > Math.max(1, plan.pool) * config.poolRatio;
}

/**
 * Whether a batch in flight has been disturbed enough to abandon.
 *
 * Security above the plan's own swing means something else — another feature, or
 * an interrupted batch — has acted on the target, so the pipeline's timings no
 * longer describe what will happen.
 */
export function isDisturbed(plan: BatchPlan, minDifficulty: number, securityLevel: number): boolean {
    return securityLevel > minDifficulty + plan.swing + 1;
}
