import type { GangGenInfo, GangMemberInfo } from "@ns";

import { GANG_CONFIG_DEFAULT, memberPower, type GangConfig } from "./gang-decisions.ts";
import {
    RESPECT_MARGIN,
    respectPhaseEnd as respectPhaseEndFor,
    territoryEnableBelow,
} from "../../lib/gang-measures.ts";

// The two derivable gang thresholds live in `lib/gang-measures.ts` now, because the run's
// goal for the gang needs to read them too and `lib/` is the only place both can reach
// without a feature importing a feature. Re-exported here so the gang feature and its
// tests keep importing them from where they always have.
export { RESPECT_MARGIN, territoryEnableBelow };

/*
 * ============================================================================
 * GANG CONFIG DERIVATION
 * ============================================================================
 * The gang thresholds that can be worked out from the gang itself, so the player
 * never has to set them.
 *
 * What this is and is not. Most of `GangConfig` is strategy rather than a
 * property of the game: how much of the gang to keep training, how much budget
 * to spend on gear, how much wanted level to tolerate. Those stay defaults,
 * because there is no fact in the game that says what the right answer is.
 *
 * The rest are thresholds where the game does have an answer, and hard-coding
 * them was a guess that is wrong on some run:
 *
 *   respectPhaseEnd   The gang moves from respect to money once respect stops
 *                     being the bottleneck. A fixed 25M ignores gang size, and
 *                     `respectForNextRecruit` is the game's own answer for how
 *                     much respect this gang needs right now.
 *
 *   territoryEnableBelow  Whether territory is worth taking depends on how much
 *                     is already held and how many gangs there are to take it
 *                     from.
 *
 * One threshold is deliberately NOT derived, and it is worth saying why so it is not
 * "fixed" later: `moneyFloor` is a statement about the PLAYER's needs rather than the
 * gang's condition. The game has no opinion about how much cash a run requires, because
 * that depends on which augmentations it is chasing. So it stays a declared figure in
 * the defaults, and `derivedGangConfig` passes it through unchanged.
 *
 * The rest of a gang's behaviour is genuinely unaffected by BitNode: respect,
 * money and wanted rates are not in the BitNode multiplier table, so a gang
 * earns the same base rates everywhere. `GangSoftcap` scales the gains but not
 * the strategy.
 * ============================================================================
 */

/**
 * Respect needed past which further respect is worth less than money.
 *
 * Adapts the gang object to the shared rule in `lib/gang-measures.ts`, which takes the
 * raw `respectForNextRecruit` figure. Kept here so callers that hold a `GangGenInfo` do
 * not each have to unpack it, and so the name stays where the gang feature expects it.
 */
export function respectPhaseEnd(g: Pick<GangGenInfo, "respectForNextRecruit">): number {
    return respectPhaseEndFor(g.respectForNextRecruit);
}

/**
 * The gang's thresholds with the derivable ones computed from its current state.
 *
 * `members` is used for size, because the trainer fraction is a share of the
 * gang and an empty gang should not reserve trainers for members that do not
 * exist.
 */
export function deriveGangConfig(
    g: GangGenInfo,
    members: readonly GangMemberInfo[],
    enemyCount: number,
): GangConfig {
    const base = GANG_CONFIG_DEFAULT;
    const recruiting = members.length > 0;

    return {
        ...base,
        respectPhaseEnd: respectPhaseEnd(g),
        territoryEnableBelow: territoryEnableBelow(enemyCount),
        // A gang still growing should not spend its trainer slots on members that
        // are already good enough to work.
        trainMaxFraction: recruiting ? base.trainMaxFraction : 0,
    };
}

/**
 * Members worth spending gear on, strongest first.
 *
 * Gear is expensive and permanent per member, so buying it for the whole gang
 * early is a way to have none for anyone. This is the order the controller
 * already assigns in; naming it makes the intent explicit and testable.
 */
export function gearPriority(
    members: readonly GangMemberInfo[],
    isHacking: boolean,
): GangMemberInfo[] {
    return [...members].sort((a, b) => memberPower(b, isHacking) - memberPower(a, isHacking));
}
