/*
 * ============================================================================
 * THE GANG ATTACKS AT AN 80% WIN CHANCE
 * ============================================================================
 * `territoryMinClashChance` decides when the gang stops preparing and starts taking
 * ground. It was 0.90 — the gang sat in `WARFARE_PREP` building power until a clash was
 * all but certain, which makes territory grow far more slowly than a merely favourable
 * fight would.
 *
 * 0.80 is the bar: a clash the gang wins four times in five is worth starting, and the
 * twenty slots it loses are paid for by the ground it takes in the other eighty.
 *
 * THE EXIT BAR IS DERIVED, not restated — `disengageChance` is `bar * 0.7`, so lowering the
 * engage bar lowers the exit with it. That is deliberate (see the note there): a fixed exit
 * figure could end up ABOVE the engage bar and drop the gang out of a war it had just
 * started. These tests assert the derivation, so retuning one number cannot desynchronise
 * the pair.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GANG_CONFIG_DEFAULT, decideWarfare, winnableWar, type EnemyScan } from "./gang-decisions.ts";
import type { GangGenInfo } from "@ns";

/** A gang past its respect phase, holding little ground, with rivals left to fight. */
function gang(over: Partial<GangGenInfo> = {}): GangGenInfo {
    return {
        respect: GANG_CONFIG_DEFAULT.respectPhaseEnd + 1,
        power: 50_000,
        wantedLevel: 1,
        wantedLevelGainRate: 0,
        wantedPenalty: 1,
        territory: 0.15,
        territoryClashChance: 0.85,
        territoryWarfareEngaged: false,
        ...over,
    } as unknown as GangGenInfo;
}

/** Rivals holding ground, at a given lowest clash chance. */
function enemiesAt(chance: number): EnemyScan {
    return { strongestName: "rivals", strongestPower: 10_000, lowestClashChance: chance, enemyCount: 3 } as unknown as EnemyScan;
}

test("the bar is eighty percent", () => {
    // The value itself, pinned because it is the whole of the request and nothing else
    // reports it. If this changes, the change should be deliberate.
    assert.equal(GANG_CONFIG_DEFAULT.territoryMinClashChance, 0.8);
});

test("a clash at exactly the bar is winnable", () => {
    // The boundary is INCLUSIVE — `>=`. A gang at precisely 80% should attack; the bar is
    // where the decision flips, not a figure to clear by.
    assert.equal(winnableWar(gang(), GANG_CONFIG_DEFAULT, enemiesAt(0.8)), true);
});

test("a clash just below the bar is not", () => {
    // THE OTHER SIDE, and the reason the test above needs a control: a predicate that
    // returned true unconditionally would pass it.
    assert.equal(winnableWar(gang(), GANG_CONFIG_DEFAULT, enemiesAt(0.799)), false);
});

test("warfare engages at eighty percent and holds below it", () => {
    // Asserted through `decideWarfare` rather than only `winnableWar`, because that is what
    // actually sends members to the map.
    const ready = decideWarfare(gang(), false, GANG_CONFIG_DEFAULT, enemiesAt(0.8), 1e15);
    assert.deepEqual(ready, { action: "ENGAGE", reason: "ready" });

    const tooWeak = decideWarfare(gang(), false, GANG_CONFIG_DEFAULT, enemiesAt(0.79), 1e15);
    assert.equal(tooWeak.action, "HOLD");
    assert.equal(tooWeak.reason, "too-weak");
});

test("the exit bar follows the engage bar down", () => {
    // DERIVED, so retuning cannot invert the pair. At 0.8 the exit is 0.56; a war already
    // under way continues at 0.60 and stops below 0.56.
    const engaged = gang({ territoryWarfareEngaged: true });

    assert.equal(
        decideWarfare(engaged, false, GANG_CONFIG_DEFAULT, enemiesAt(0.60), 1e15).action,
        "HOLD",
        "a war was dropped while the chance was still above the derived exit bar",
    );
    assert.equal(
        decideWarfare(engaged, false, GANG_CONFIG_DEFAULT, enemiesAt(0.55), 1e15).action,
        "DISENGAGE",
    );
});

test("the exit bar can never sit above the engage bar", () => {
    // The invariant the derivation exists to protect. Stated as a property of the constant
    // rather than of a scenario, so it holds for whatever the bar is later tuned to.
    assert.ok(
        GANG_CONFIG_DEFAULT.territoryMinClashChance * 0.7 < GANG_CONFIG_DEFAULT.territoryMinClashChance,
        "the disengage chance equals or exceeds the engage chance, which would flap every tick",
    );
});
