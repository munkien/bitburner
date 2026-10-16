import {
    SLEEVE_MOVABLE,
    SLEEVE_TRAINING_KEYS,
    subGoalsFor,
    type Goal,
    type SubGoal,
    type SubGoalKey,
} from "../../lib/objective.ts";

/*
 * ============================================================================
 * SLEEVE GOALS
 * ============================================================================
 * Which of the run's sub-goals a sleeve can advance, and which of those it can
 * meaningfully train toward.
 *
 * This used to own its own copy of the faction requirement table, its own
 * `standingOf`, and its own goal derivation — a duplicate of what is now
 * lib/objective.ts. That duplication produced the drift this file's history records:
 * progression trained combat to 100 while this file stopped at 75, and sleeve
 * experience is shared with the player, so sleeves were stopping short of a target that
 * was still outstanding.
 *
 * The same class of bug recurred one level up, and the fix is the same shape. This file
 * declared `SLEEVE_MOVABLE` as `["combat", "cha"]` while `lib/registry.ts` declared
 * sleeves as `["combat", "cha", "rep"]`. The registry's list is what `withParticipation`
 * uses to attribute sub-goals to features, so the goal credited sleeves with closing
 * reputation goals that this feature would never aim at — and, because `blockedBy` only
 * flags a sub-goal NOTHING can move, the false claim removed a warning without supplying
 * the work. Money was missing from both, even though a sleeve earns cash from every crime.
 *
 * The two lists are therefore no longer declared here at all. `lib/objective.ts` owns them,
 * both consumers read the same values, and they cannot drift again because there is only
 * one of each.
 * ============================================================================
 */

/** Re-exported so callers that imported this name from here keep working. */
export { SLEEVE_MOVABLE };

/**
 * The sub-goals of the goal that a sleeve can close.
 *
 * Delegated rather than reimplemented: this and `subGoalsFor` were the same filter written
 * twice, in the module that owns the interface and the module that consumes it.
 */
export function sleeveSubGoals(goal: Goal | null): readonly SubGoal[] {
    return subGoalsFor(goal, SLEEVE_MOVABLE);
}

/**
 * The sub-goals a sleeve could close by TRAINING, as opposed to by working.
 *
 * Narrower than `sleeveSubGoals` on purpose, and the difference is the whole reason both
 * exist. A sleeve advances reputation by working for a faction and money by committing a
 * crime, and neither is something it can be sent to a gym for. Scoring a training candidate
 * against a money goal would send a sleeve to study toward cash it can only earn.
 */
export function sleeveTrainingSubGoals(goal: Goal | null): readonly SubGoal[] {
    return subGoalsFor(goal, SLEEVE_TRAINING_KEYS);
}

/**
 * The measurement a sleeve should train to close the nearest goal, or null.
 *
 * Null means training closes nothing, which is the case the scoring gives a
 * near-zero weight: a sleeve grinding a stat nothing is waiting on.
 */
export function sleeveTrainingTarget(
    goal: Goal | null,
): { key: SubGoalKey; target: number } | null {
    const subGoal = sleeveTrainingSubGoals(goal)[0];
    return subGoal === undefined ? null : { key: subGoal.key, target: subGoal.target };
}
