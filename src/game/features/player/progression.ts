import type { Player } from "@ns";

import type { Goal, SubGoalKey } from "../../lib/objective.ts";
import { targetFor } from "../../lib/objective.ts";

/*
 * ============================================================================
 * PROGRESSION THRESHOLDS
 * ============================================================================
 * The decisions in the progression feature that depend only on a threshold.
 *
 * Why this exists. `statFloor` and `karmaFarmingWanted` were private functions in
 * an 869-line feature with no test surface, and each declared its own target:
 * `MIN_STAT` of 100 here, while `sleeves.ts` used 75 for the same measurement.
 * Sleeve experience is shared with the player, so sleeves stopped contributing to
 * a target this file was still working on.
 *
 * Split out so the decisions can be tested, and so the targets arrive as
 * arguments from the run's goal rather than being constants owned here. What
 * remains in the feature is the choosing; what is here is the arithmetic.
 * ============================================================================
 */

/** Which combat skill a player is weakest in, which is what to train. */
export type CombatSkill = "strength" | "defense" | "dexterity" | "agility";

const COMBAT_SKILLS: readonly CombatSkill[] = ["strength", "defense", "dexterity", "agility"];

export function lowestCombatSkill(player: Player): CombatSkill {
    let best: CombatSkill = COMBAT_SKILLS[0];
    let min = Infinity;
    for (const skill of COMBAT_SKILLS) {
        const value = player.skills[skill];
        if (value < min) {
            min = value;
            best = skill;
        }
    }
    return best;
}

/**
 * The measurement a player is furthest behind on, or null when nothing is needed.
 *
 * Hacking is checked first, so it is trained before combat stats: the factions
 * with hacking gates unlock earlier than the ones with combat gates, and hacking
 * also gates which servers can be attacked.
 *
 * The targets come from the goal rather than from constants. `fallback` is
 * used when the goal names no target this can train, which happens when the
 * player is between goals.
 */
export interface FloorTargets {
    readonly hacking: number;
    readonly combat: number;
}

export function trainingTargets(
    goal: Goal | null,
    fallback: FloorTargets,
): FloorTargets {
    let hacking = fallback.hacking;
    let combat = fallback.combat;

    // The MAXIMUM of the two, not the goal's value outright, which is why
    // this reads `subGoals` rather than going through `targetFor`. A goal wanting
    // combat 50 must not lower the floor below the fallback: the early faction and
    // company gates want 100 regardless of what the nearest goal happens to name,
    // and dropping below it would strand the player short of work that pays.
    for (const subGoal of goal?.subGoals ?? []) {
        if (subGoal.key === "hacking" && subGoal.target > hacking) hacking = subGoal.target;
        if (subGoal.key === "combat" && subGoal.target > combat) combat = subGoal.target;
    }

    return { hacking, combat };
}

/**
 * Whether the player still has stats to train, and which.
 *
 * Returns the measurement and its target, or null when the floors are met. The
 * caller turns that into an action, because which gym or university is a fact
 * about the game rather than about the decision.
 */
export function belowFloor(
    player: Player,
    targets: FloorTargets,
): { kind: "hacking" | "combat"; skill: CombatSkill | null; target: number } | null {
    if (player.skills.hacking < targets.hacking) {
        return { kind: "hacking", skill: null, target: targets.hacking };
    }

    const lowest = lowestCombatSkill(player);
    if (player.skills[lowest] < targets.combat) {
        return { kind: "combat", skill: lowest, target: targets.combat };
    }

    return null;
}

/**
 * Whether farming kills and karma is still worth the player's time.
 *
 * True while NEITHER target is met, because the two are separate goals for
 * separate factions: a kill count for the combat gangs, deep karma for the
 * late-game ones. Farming stops as soon as either lands.
 *
 * The stop condition is the important half. Homicide lowers karma without bound,
 * and karma far past the target is not neutral: it closes off content that wants a
 * less vicious player. This replaced an `||`, which farmed while EITHER was unmet
 * and ran to -240K karma against a -54K target because the kill count had not
 * reached 30.
 */
export function karmaFarmingWanted(
    player: Player,
    targets: { kills: number; karma: number },
): boolean {
    return player.numPeopleKilled < targets.kills && player.karma > targets.karma;
}

/**
 * Kills and karma targets, from the goal where it names them.
 *
 * The goal WINS when it is present, rather than being merged with the
 * fallback. Karma is negative, so taking the deeper of the two would mean farming
 * past what the goal needs — which is the bug this area already produced once,
 * running to -240K against a -54K target. The fallback applies only with no goal.
 */
export function karmaTargets(
    goal: Goal | null,
    fallback: { kills: number; karma: number },
): { kills: number; karma: number } {
    return {
        kills: targetFor(goal, "kills", fallback.kills),
        karma: targetFor(goal, "karma", fallback.karma),
    };
}
