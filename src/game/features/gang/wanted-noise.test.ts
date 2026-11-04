/*
 * ============================================================================
 * A TRACE RISE IS NOT A REASON TO SEND A CREW
 * ============================================================================
 * `wantedRise` is `gainRate + cleaners * cleanupRate`, and any positive value made
 * `wantedAttentionReason` report `wanted-cleanup`. A rise of 0.002 per cycle — the gang simply
 * being alive — was enough to send a member to the wanted task.
 *
 * THE COST IS THE SWITCH, NOT THE WORK. Measured in `runs/2026-11-04T09.48.28.372Z--34`, on a
 * two-second cycle, forever:
 *
 *   09:50:05  rise=0.002  hold=0  mode-crew=1  level=1.02  cleaners=0
 *   09:50:07  rise=0.000  hold=0  mode-crew=0  level=1.00  cleaners=1
 *
 * Forty-three mode flips in eighty-eight frames. One member leaves RESPECT work, walks to the
 * wanted task, drives the level from 1.02 to the 1.00 floor — clamping far below where it
 * started — and is released again. Nothing is achieved: the level was already at the bottom of
 * the scale and the penalty was already 100%.
 *
 * The rate the crew can actually deliver is the yardstick. A cleaner removes ~11 per cycle, so
 * a rise two orders of magnitude smaller than one cleaner's work is noise, not a trend.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GANG_CONFIG_DEFAULT, WANTED_NOISE_FLOOR, decideMode, wantedAttentionReason } from "./gang-decisions.ts";
import type { GangGenInfo } from "@ns";

/** A gang at the floor of the wanted scale, with a positive but tiny rise. */
function gang(over: Partial<GangGenInfo> = {}): GangGenInfo {
    return {
        respect: GANG_CONFIG_DEFAULT.respectPhaseEnd + 1,
        power: 155_000,
        wantedLevel: 1.02,
        wantedLevelGainRate: 0.002,
        // FULL PENALTY, so the penalty half of the rule is dead and only the rate can fire.
        wantedPenalty: 1,
        territory: 0.53,
        territoryClashChance: 0.5,
        territoryWarfareEngaged: false,
        ...over,
    } as unknown as GangGenInfo;
}

const NO_FIGHT = { enemyCount: 0, winnable: false } as never;
const RICH = 1e15;

test("a rise smaller than a cleaner can remove is not worth a crew", () => {
    // THE DEFECT. 0.002 per cycle against a cleaner removing ~11: the crew is sent, achieves
    // nothing, and is released on the next tick.
    assert.equal(
        wantedAttentionReason(gang(), GANG_CONFIG_DEFAULT, false),
        null,
        "a trace rise sent a member to the wanted task",
    );
});

test("a real rise still gets a crew", () => {
    // THE CONTROL. The noise floor must not swallow a genuine climb — 5 per cycle is well
    // clear of it, and the gang must react.
    assert.equal(
        wantedAttentionReason(gang({ wantedLevelGainRate: 5 }), GANG_CONFIG_DEFAULT, false),
        "wanted-cleanup",
    );
});

test("the noise floor is a small multiple of nothing, not of one cleaner", () => {
    // Pinned so the figure is deliberate. It must be far below one cleaner's output (so a
    // genuine rise is never ignored) and above the gang's background chatter.
    assert.ok(WANTED_NOISE_FLOOR > 0, "a floor of zero reinstates the flip");
    assert.ok(
        WANTED_NOISE_FLOOR < 1,
        "a floor of a whole level per cycle would ignore rises one cleaner could handle",
    );
});

test("a mode flip at the floor does not happen", () => {
    // End to end through `decideMode`, because that is what actually moves members. Still
    // inside the respect phase and with no fight available, so the answer without a wanted
    // problem is RESPECT — and a trace rise must not disturb it.
    //
    // THE RESPECT VALUE MATTERS. `GANG_CONFIG_DEFAULT.respectPhaseEnd` is 25M, and the live
    // run that flapped had 78.72B of respect — far ABOVE it, so its `RESPECT:respect-phase`
    // came from a config derived per run (`respectPhaseEndFor(respectForNextRecruit)`), not
    // from the default. A fixture above the default's threshold reports `money-phase` and
    // would test nothing; the first version of this test did exactly that.
    const inRespectPhase = gang({ respect: GANG_CONFIG_DEFAULT.respectPhaseEnd / 2 });

    const decided = decideMode(inRespectPhase, GANG_CONFIG_DEFAULT, false, NO_FIGHT, RICH, false);

    assert.equal(decided.mode, "RESPECT");
    assert.equal(decided.reason, "respect-phase");
});

test("a level at the floor with a rate that is not rising is ignored however tiny", () => {
    // The floor clamp makes everything here meaningless: the game will not report a level
    // below 1, so a crew sent for a rise at the floor can only be released next tick.
    assert.equal(
        wantedAttentionReason(gang({ wantedLevel: 1, wantedLevelGainRate: 0.0001 }), GANG_CONFIG_DEFAULT, false),
        null,
    );
});
