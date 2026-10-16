/*
 * ============================================================================
 * TRAINING BUDGET
 * ============================================================================
 * How long closing a gap would take, and whether that is worth doing.
 *
 * WHY THESE LIVE IN `lib/`. They were private to `features/player/progression.ts`, which
 * was right while the player was the only thing that trained. Sleeves train too, and a
 * sleeve that grinds an unreachable target burns the run exactly as the player did — so
 * the sleeves feature needs the same rule. It cannot import `progression.ts`: features do
 * not import features (ADR 0001), because a static import between them charges the
 * imported feature's RAM to the importing one. A shared definition in `lib/` is the only
 * place both can reach, which is the same reason `lib/gang-measures.ts` exists.
 *
 * WHY THEY ARE SHARED AT ALL, rather than copied. ADR 0003 exists because a threshold two
 * features each declared drifted apart. A sleeve deciding a target is reachable while the
 * player's own training decides it is not would be that bug again, and the failure is
 * silent: the two just disagree, and neither is wrong by its own lights.
 *
 * Nothing here reads a clock, a stat, or the game. Time arrives as a parameter, which is
 * what makes an hour of training testable in a few lines.
 * ============================================================================
 */

/**
 * How long the framework will spend training toward a single goal before giving up on it.
 *
 * Thirty minutes, and it is ONE constant for every consumer. It used to live in `player.ts`
 * with only the faction path reading it — the stat-floor path had no view of reachability at
 * all, which is how a run spent 1.5 hours on a goal it could not reach.
 */
export const REACH_SEC = 30 * 60;

/**
 * How long training to close a gap would take, in seconds.
 *
 * `Infinity` when a measurement has no usable rate, which is the honest answer rather
 * than a guess: a stat with no measurement is one the framework cannot predict, and
 * predicting optimistically from nothing is how a feature ends up grinding for hours.
 *
 * A rate of ZERO also returns `Infinity`, and that is now a real answer rather than a
 * fallback — `observe` reports a true zero when the stat did not move, so zero means "not
 * rising" and the honest ETA for a gap that is not closing is "never". The two cases are
 * distinguished one level up, in `floorReachable`, which needs to treat "no measurement yet"
 * differently from "measured, and not rising".
 *
 * Callers that want "unknown means proceed" rather than "unknown means never" must check
 * for a known rate themselves — see `floorReachable`, which does exactly that, and the
 * `ratePerSecond === null` guard in the sleeves scoring, which keeps a fresh run from
 * refusing every target before anything has been measured.
 */
export function floorEtaSeconds(
    under: { target: number } | null,
    current: number,
    ratePerSecond: number,
): number {
    if (under === null) return 0;
    const gap = under.target - current;
    if (gap <= 0) return 0;
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return Infinity;
    return gap / ratePerSecond;
}

/**
 * Whether a floor is worth training toward, given how long it would take.
 *
 * WHY THIS EXISTS. Training used to run unconditionally: `statFloor` returned a gym or
 * university action whenever any measurement was below its target, with no view of how
 * long that would take. A run with an unreachable target therefore trained forever — the
 * reported case was 1.5 hours on one goal with nothing to show for it.
 *
 * The rule: if closing the gap would take longer than `budgetSeconds`, the target is not
 * a plan, it is a wall. Better to do something else — work for reputation, earn money,
 * raise a stat that CAN be closed — than to spend the whole run on one number.
 *
 * `Infinity` ETA counts as unreachable, deliberately. "I cannot measure this" and "this
 * will never finish" both mean stop, and treating an unmeasurable stat as worth training
 * is what produced the endless grind in the first place.
 */
export function worthTraining(
    under: { target: number } | null,
    current: number,
    ratePerSecond: number,
    budgetSeconds: number,
): boolean {
    return floorEtaSeconds(under, current, ratePerSecond) <= budgetSeconds;
}

/**
 * Whether a floor is worth starting, given a rate that may not exist yet.
 *
 * This is the ONE place the budget rule is decided, and every caller that either trains a
 * floor or yields the activity slot for one asks it here, so they cannot disagree. The rule
 * is the user's: a target that cannot be reached within `budget` is not a plan.
 *
 * `null` AND `0` ARE DIFFERENT ANSWERS, and separating them is the fix for a real fault.
 * They used to be treated alike — "not a usable rate, so keep going" — which meant a stat
 * that was measured as NOT RISING was trained indefinitely. The reported case was agility
 * held at 165 toward a target of 200: the rate was floored upward by `observe` (see the
 * report there), so the ETA looked acceptable, and this function's refusal to act on a zero
 * rate meant nothing ever stopped it. Fifteen minutes produced no movement.
 *
 *   - `null` means NO MEASUREMENT YET. A fresh run has no baseline, and refusing on no
 *     evidence would mean never training at all, so this returns true. This is the case the
 *     old shared branch was written for, and it is still correct.
 *   - `0` means MEASURED, AND NOT RISING. That is evidence, and it points the other way: a
 *     target this player is not making progress on is not reachable by waiting. It returns
 *     false, so the caller does something else.
 *
 * The user's instruction is explicit that the second case is the common one: an unreachable
 * target should be abandoned and the activity slot spent on anything else, with training the
 * last resort rather than the default.
 *
 * A non-finite rate is treated as `null` rather than as zero. `Infinity` and `NaN` come from
 * an unusable arithmetic result rather than from an observation, so they carry no evidence
 * either way.
 */
export function floorReachable(
    under: { target: number } | null,
    current: number,
    ratePerSecond: number | null,
    budgetSeconds: number = REACH_SEC,
): boolean {
    if (under === null) return true;
    if (under.target - current <= 0) return true;
    if (ratePerSecond === null || !Number.isFinite(ratePerSecond)) return true;
    if (ratePerSecond <= 0) return false;
    return worthTraining(under, current, ratePerSecond, budgetSeconds);
}
