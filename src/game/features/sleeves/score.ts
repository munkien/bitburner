import type { CompanyName, CrimeType, FactionName } from "@ns";

import type { Goal, SubGoal, SubGoalKey } from "../../lib/objective.ts";
// From `lib/`, NOT from `features/player/progression.ts`. The budget rule is shared, but a
// static import between two features would charge the player feature's RAM to this one
// (ADR 0001), and the sleeves feature is loaded on its own RAM budget.
import { floorEtaSeconds, REACH_SEC } from "../../lib/training-budget.ts";

/*
 * ============================================================================
 * SCORING
 * ============================================================================
 * Rank the things a feature could do by how much each advances the run's current
 * goal.
 *
 * Why this exists. Task choice was a static table indexed by position, so a
 * feature's job was decided by where it sat rather than by what the run needed.
 * This scores the candidates instead; any table survives as candidate ORDER, which
 * breaks ties.
 *
 * Why it is not sleeve-specific. The mechanism is the same for any feature that
 * has a choice to make: given the run's goal and the sub-goals that close it,
 * which of my options contributes most? A feature declares which sub-goal kinds it
 * can move and gets an ordering back. Sleeves declare combat and charisma; the
 * hacking feature would declare money.
 *
 * Scores are relative, not absolute. Nothing here knows how much of a thing a
 * feature earns per tick — that is the game's business — so the numbers are
 * comparable to each other and meaningless alone. What matters is the ordering,
 * and the weights that produce it are stated rather than buried.
 * ============================================================================
 */

/**
 * A thing a feature can be asked to do.
 *
 * The payloads are the game's own types rather than `string`, so a typo is a compile
 * error instead of a silently unmatched value. `crime: string` was the worst of them:
 * `setToCommitCrime` was called through a `as CrimeType` cast at the point of use, and
 * the game refuses an unrecognised crime by returning false — which reads as "the sleeve
 * declined" rather than "the name was wrong".
 */
export type Candidate =
    | {
        readonly kind: "TRAIN";
        readonly stat: SubGoalKey;
        readonly current: number;
        readonly target: number;
        /**
         * How fast this measurement is rising, in points per second, or null when no rate
         * has been measured yet.
         *
         * Optional and defaulted to null so every existing caller and test keeps working,
         * and null is the honest default rather than a guess: a caller that has not measured
         * a rate genuinely does not know one, and every rule below treats "unknown" the same
         * way `progression.ts` does — as a reason to proceed, not to refuse.
         */
        readonly ratePerSecond?: number | null;
    }
    | { readonly kind: "FACTION_WORK"; readonly faction: FactionName; readonly missingRep: number }
    | { readonly kind: "COMPANY_WORK"; readonly company: CompanyName; readonly missingRep: number }
    /**
     * Described, not specified.
     *
     * Both fields are for the log line and nothing else: `tryBladeburnerSleeve` ignores
     * the candidate for this kind entirely and re-derives the action from the sleeve's
     * ROLE. Naming the field `action` invited the belief that it selected the action, so
     * it had been populated with role names (`"SUPPORT_MAIN"`, `"INFILTRATE"`) that are
     * not Bladeburner actions at all — which a stricter type exposed the moment the field
     * was typed as one. `what` says what it is.
     */
    | { readonly kind: "BLADEBURNER"; readonly what: string; readonly why: string }
    | { readonly kind: "CRIME"; readonly crime: CrimeType }
    | { readonly kind: "SYNC" }
    | { readonly kind: "SHOCK_RECOVERY" };

/** Which sub-goal kinds a feature is able to advance. */
export type Movable = readonly SubGoalKey[];

/**
 * Weights, stated so the ordering can be argued with rather than reverse
 * engineered.
 *
 * The shape: each candidate scores for whether it touches the goal's
 * sub-goals at all. A candidate irrelevant to the goal scores near zero however
 * much of it there is, which is what stops a feature grinding something nothing is
 * waiting on.
 */
export interface Scoring {
    /**
     * Work that directly closes a sub-goal, such as reputation toward the
     * augmentations a faction offers.
     *
     * The highest ordinary score because it is the only one that finishes
     * something: reputation unlocks augmentations, training does not.
     */
    readonly onGoal: number;
    /**
     * Training a measurement the goal is waiting on.
     *
     * Below `onGoal` because training makes future work possible rather than
     * achieving anything, and there is no substitute for reputation.
     */
    readonly onGoalTraining: number;
    /** Training a measurement nothing is waiting on. Not zero, so it is a fallback. */
    readonly idleTraining: number;
    /**
     * A crime, which is what a feature does when nothing else applies.
     *
     * Above `idleTraining` because a crime always yields something: money, and
     * experience the sleeve shares with the player. Training a measurement nobody
     * is waiting on yields neither, so the two are not equivalent fallbacks.
     */
    readonly crime: number;
    /**
     * A crime while the goal is waiting on MONEY.
     *
     * The fallback crime becomes a real contribution the moment cash is what the run
     * needs, and scoring it at the flat `crime` weight hid that: a sleeve grinding
     * Homicide — the highest-yielding crime by money per unit of time — was doing
     * exactly what a money goal wants while the score treated it as idle filler, so
     * anything that merely touched the goal outranked it.
     *
     * Below `onGoal`, because a crime is a trickle next to faction work for a faction
     * whose reputation gates the run, and above `onGoalTraining`, because the goal
     * is asking for money rather than for a stat. It is deliberately not so high that a
     * sleeve abandons reputation work for it: money accumulates from the player's own
     * activity too, whereas a sleeve is often the only thing raising faction reputation.
     */
    readonly crimeOnGoal: number;
    /**
     * The fraction of `onGoalTraining` a just-started on-goal stat still earns.
     *
     * Training is scored by how much of the gap is already closed, so without a floor a stat
     * at 1 of 100 would score a hundredth of a stat at 99 of 100 and lose to almost anything
     * — including the off-goal fallback it is supposed to outrank. This keeps "on-goal but
     * barely begun" clearly above `idleTraining` while still letting a nearly-finished stat
     * win.
     */
    readonly minProgressShare: number;
    /**
     * Repair tasks, ranked above everything while they apply, because they
     * multiply what every other task earns: they are the rate at which work
     * converts rather than work itself.
     */
    readonly repair: number;
}

export const DEFAULT_SCORING: Scoring = {
    onGoal: 100,
    onGoalTraining: 40,
    crime: 5,
    crimeOnGoal: 70,
    idleTraining: 1,
    minProgressShare: 0.25,
    repair: 1000,
};

/**
 * Whether a candidate advances a sub-goal the feature can actually move.
 *
 * A sub-goal for a measurement the feature cannot raise is not this feature's
 * work, however outstanding it is. That distinction is what stops a sleeve being
 * sent to a gym for a faction gated on the player's hacking.
 */
function advances(candidate: Candidate, movable: Movable, goal: Goal | null): boolean {
    if (goal === null) return false;
    if (candidate.kind !== "TRAIN") return true;
    if (!movable.includes(candidate.stat)) return false;
    return goal.subGoals.some(subGoal => subGoal.key === candidate.stat);
}

/**
 * The measures a crime earns toward, so a money goal can recognise one.
 *
 * BOTH keys, because they are different measures of the same earning: `money` is cash in
 * hand and `netWorth` is cash plus holdings (see `currentFor`). A crime pays cash, which
 * moves both, so a goal waiting on either is served by one.
 */
const CRIME_EARNINGS: readonly SubGoalKey[] = ["money", "netWorth"];

/**
 * Whether the goal is outstanding on something a crime earns toward.
 *
 * `movable` is not consulted, unlike `advances`. That is deliberate: `movable` answers
 * "what can this FEATURE be sent to do", and a crime is offered to every feature that has
 * one — it is the universal fallback. What this asks is narrower and about the GOAL: would
 * committing a crime close anything the run is waiting on? A feature that cannot move money
 * by training can still earn it by working, which is exactly the distinction
 * `SLEEVE_MOVABLE` versus `SLEEVE_TRAINING_KEYS` draws.
 */
function crimePaysOff(goal: Goal | null): boolean {
    if (goal === null) return false;
    return goal.subGoals.some(subGoal => CRIME_EARNINGS.includes(subGoal.key));
}

/** Score one candidate against the goal. */
export function scoreCandidate(
    candidate: Candidate,
    goal: Goal | null,
    movable: Movable,
    weights: Scoring = DEFAULT_SCORING,
): number {
    switch (candidate.kind) {
        case "SYNC":
        case "SHOCK_RECOVERY":
            // Multiplies everything else, so it is worth almost any amount of work.
            return weights.repair;

        case "CRIME":
            // Always available and always yields something, which is why it is
            // the fallback rather than doing nothing. It scores as real work while the
            // goal is waiting on cash, and as filler otherwise.
            return crimePaysOff(goal) ? weights.crimeOnGoal : weights.crime;

        case "TRAIN": {
            const gap = Math.max(0, candidate.target - candidate.current);
            if (gap <= 0) return 0;

            const onGoal = advances(candidate, movable, goal);

            // A stat that cannot be closed within the budget is not a plan, it is a wall —
            // the same rule the player's own training applies, through the shared
            // `lib/training-budget.ts`.
            //
            // The guard is `rate !== null`, and the two cases are now genuinely different
            // answers rather than two flavours of "proceed". `null` means no measurement yet,
            // so a fresh sleeve is not refused for being unmeasured. A MEASURED ZERO means the
            // stat is not rising, and `floorEtaSeconds` returns Infinity for it — so a target
            // this sleeve is making no progress on is refused, which is the same reading the
            // player's path takes and the reason the two share this module.
            const rate = candidate.ratePerSecond ?? null;
            if (onGoal && rate !== null && floorEtaSeconds({ target: candidate.target }, candidate.current, rate) > REACH_SEC) {
                return 0;
            }

            if (!onGoal) return weights.idleTraining;

            // HOW FAR ALONG, not merely WHETHER. This replaces a binary `onGoalTraining`,
            // which scored a sleeve at combat 5 and one at combat 99 identically against a
            // target of 100. The measured consequence was that training candidates could not
            // be told apart, so the choice between them fell through to argument order — the
            // weakest stat first — regardless of which was actually close to done.
            //
            // Scored as the fraction of the gap already closed: a stat at 90 of 100 keeps
            // nearly all the weight and a stat at 5 of 100 keeps almost none, so a sleeve is
            // pulled toward finishing what it started. The floor of `minProgressShare` keeps
            // the score from collapsing to zero for a sleeve that has just begun, because a
            // barely-started on-goal stat is still worth more than an off-goal one — the
            // distinction `idleTraining` exists to draw.
            const done = candidate.current / Math.max(1, candidate.target);
            const share = Math.min(1, Math.max(0, done));
            return weights.onGoalTraining * (weights.minProgressShare + (1 - weights.minProgressShare) * share);
        }

        case "FACTION_WORK":
            // Reputation is the route to the augmentations a faction offers, so it
            // counts as on-goal whatever measurement the goal is waiting on.
            // With no goal it still has value for the player's own
            // augmentations, just less.
            return goal === null ? weights.onGoalTraining / 2 : weights.onGoal;

        case "COMPANY_WORK": {
            // Company work raises the matching company faction's reputation, so it
            // is worth the same as faction work when that is the goal's faction.
            if (goal !== null && candidate.company === String(goal.faction)) return weights.onGoal;
            return weights.onGoalTraining;
        }

        case "BLADEBURNER":
            // Raises rank and its own skill points, and the player's combat stats
            // indirectly. It serves no faction requirement directly, so it scores
            // below goal work and above idling.
            return weights.onGoalTraining / 4;
    }
}

/** A scored candidate, for ranking and reporting. */
export interface Scored {
    readonly candidate: Candidate;
    readonly score: number;
    /** Why this scored what it did, for the log. */
    readonly why: string;
}

/**
 * Rank candidates, best first.
 *
 * Ties break on the order the caller supplied them, so a call site can express a
 * preference when scores are equal. That is how a static role table survives: as
 * argument order rather than an override.
 */
export function rank(
    candidates: readonly Candidate[],
    goal: Goal | null,
    movable: Movable,
    weights: Scoring = DEFAULT_SCORING,
): Scored[] {
    return candidates
        .map((candidate, index) => ({
            candidate,
            score: scoreCandidate(candidate, goal, movable, weights),
            why: explain(candidate, goal),
            index,
        }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .map(({ candidate, score, why }) => ({ candidate, score, why }));
}

function explain(candidate: Candidate, goal: Goal | null): string {
    const target = goal === null
        ? "no goal"
        : `${goal.goal}${describeGaps(goal.subGoals)}`;

    switch (candidate.kind) {
        case "TRAIN": return `train ${candidate.stat} toward ${target}`;
        case "FACTION_WORK": return `faction work for ${candidate.faction}`;
        case "COMPANY_WORK": return `company work at ${candidate.company}`;
        case "BLADEBURNER": return `bladeburner ${candidate.what} (${candidate.why})`;
        case "CRIME": return crimePaysOff(goal)
            // Says WHY it is on a crime rather than that nothing else was available: a
            // sleeve earning toward a money goal is doing the run's work, and the log line
            // should not call that idling.
            ? `crime: ${candidate.crime} (earning toward ${target})`
            : `crime: ${candidate.crime} (nothing else to do)`;
        case "SYNC": return "synchronizing, which multiplies everything else";
        case "SHOCK_RECOVERY": return "recovering shock, which multiplies everything else";
    }
}

function describeGaps(subGoals: readonly SubGoal[]): string {
    if (subGoals.length === 0) return "";
    return ` (${subGoals.map(g => `${g.key} ${g.current}→${g.target}`).join(", ")})`;
}
