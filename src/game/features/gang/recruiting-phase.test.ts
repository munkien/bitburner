/*
 * ============================================================================
 * THE RECRUITING PHASE
 * ============================================================================
 * While the gang can still take on a member, growth outranks the money floor.
 *
 * Respect gates `canRecruitMember`, so a gang that stops earning it stops growing — and a
 * small gang earns less for the rest of the run. The money floor exists because a poor run
 * cannot afford a war, but a gang that never grows never becomes worth having.
 *
 * BOTH `decideMode` and `decideWarfare` must read the flag. The module documents at
 * `decideWarfare` that the two disagreeing sends members to earn in the mode machine while
 * fighting in the field, which is why these tests assert them together rather than
 * separately.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GANG_CONFIG_DEFAULT, decideMode, decideWarfare, type EnemyScan } from "./gang-decisions.ts";
import type { GangGenInfo } from "@ns";

/** A combat gang well under the money floor, with no war in reach. */
function gang(over: Partial<GangGenInfo> = {}): GangGenInfo {
    return {
        isHacking: false,
        respect: 10e6,
        respectGainRate: 1,
        respectForNextRecruit: 25e6,
        territory: 0.1,
        territoryClashChance: 0,
        territoryWarfareEngaged: false,
        wantedLevel: 0,
        wantedLevelGainRate: 0,
        wantedPenalty: 0,
        power: 1,
        ...over,
    } as unknown as GangGenInfo;
}

/** No rival is beatable and none is a threat worth accounting for. */
const ENEMIES: EnemyScan = {
    strongestName: "rivals",
    strongestPower: 1e12,
    lowestClashChance: 0,
    enemyCount: 6,
};

/** The player is far below the money floor: 1b against a 25b floor. */
const POOR = 1e9;

test("a recruiting gang does not enter money mode when poor", () => {
    const cfg = { ...GANG_CONFIG_DEFAULT, recruitingPhase: true };
    const { mode } = decideMode(gang(), cfg, false, ENEMIES, POOR);
    assert.notEqual(mode, "MONEY", "a growing gang was told to stop and earn");
});

test("a grown gang does enter money mode when poor", () => {
    // The other half: the override is a phase, not a permanent exception. Without this the
    // floor would never apply at all.
    const cfg = { ...GANG_CONFIG_DEFAULT, recruitingPhase: false };
    const { mode } = decideMode(gang(), cfg, false, ENEMIES, POOR);
    assert.equal(mode, "MONEY");
});

test("warfare is held for RESPECT, not for poverty, while recruiting", () => {
    // A growing gang must still earn respect, and `respectPhaseEnd` IS the recruit threshold
    // (`respectForNextRecruit`), so holding here is the respect phase doing its job rather
    // than the money floor doing its. The reason is what distinguishes them — and the
    // point of the override is that the reason stops being "below-money-floor".
    const cfg = { ...GANG_CONFIG_DEFAULT, recruitingPhase: true };
    const { action, reason } = decideWarfare(gang(), false, cfg, ENEMIES, POOR);
    assert.equal(action, "HOLD");
    assert.equal(reason, "respect-phase", "a growing gang was held back for being poor");
});

test("a grown gang holds warfare below the floor", () => {
    const cfg = { ...GANG_CONFIG_DEFAULT, recruitingPhase: false };
    const { action } = decideWarfare(gang(), false, cfg, ENEMIES, POOR);
    assert.equal(action, "HOLD");
});

test("the two decisions agree about the money floor, not about each other", () => {
    // THE REAL INVARIANT, and it is narrower than the pairing this test first asserted.
    //
    // `decideMode` asks what members DO for income and respect; `decideWarfare` asks
    // whether the gang FIGHTS for territory. They share one exception — the money floor —
    // and nothing else. Asserting mode MONEY <=> war HOLD was an invented pairing: a gang
    // in money mode can still fight a war it would win, and a gang in respect mode can be
    // too weak to fight at all.
    //
    // What must hold is that the floor is overridden by BOTH or by NEITHER. A gang told
    // to earn money while its members were sent to take territory is the disagreement the
    // module documents at `decideWarfare`.
    for (const recruitingPhase of [true, false]) {
        const cfg = { ...GANG_CONFIG_DEFAULT, recruitingPhase };
        const moneyByFloor = decideMode(gang(), cfg, false, ENEMIES, POOR).reason === "below-money-floor";
        const heldByFloor = decideWarfare(gang(), false, cfg, ENEMIES, POOR).reason === "below-money-floor";
        assert.equal(
            moneyByFloor,
            heldByFloor,
            `recruitingPhase=: the money floor was applied to one decision and not the other`,
        );
    }
});

test("a gang at its size cap is never pinned to money by an unreachable floor", () => {
    // THE RECORDED DEFECT. `runs/2026-10-28T08.14.44`, whole session: 12 members (the cap),
    // `recruitingPhase: false`, peak net worth 7.7e6 against a `moneyFloor` of 1e11 — thirteen
    // thousand times short. `decideMode` therefore returned MONEY on every tick, and the mode
    // log shows exactly one line for the entire run:
    //
    //   MODE: MONEY:below-money-floor (respect=3.19M/never power=247 wanted=100.0% ...)
    //
    // Note `respect=3.19M/never`: `respectForNextRecruit` is Infinity at the size cap, so the
    // respect phase never ends — the gang is finished growing and should be banking respect and
    // money both. Instead it was told to chase money it could not reach, forever.
    //
    // WHAT IT COST. In MONEY the score is `100*log10(money) + ...`, so a task earning NO money
    // scores about zero however much respect it brings. TERRORISM earns no money and has the
    // highest baseRespect of any combat task (0.01, fifty times Human Trafficking's 0.0002) —
    // it is the gang's single best respect task, and the run never used it once. The
    // assignments over the whole session were Vigilante Justice, Human Trafficking and
    // Traffick Illegal Arms, and nothing else.
    //
    // A floor that cannot be reached is not a floor, it is a permanent instruction. Once the
    // gang can no longer grow, money is no longer the thing standing between it and everything
    // else, so the unreachable-floor rule must not override the respect phase.
    const cfg = { ...GANG_CONFIG_DEFAULT, recruitingPhase: false, moneyFloor: 1e11 };
    const atCap = gang({ respectForNextRecruit: Infinity, respect: 3.19e6 });

    const { mode } = decideMode(atCap, cfg, false, ENEMIES, 7.7e6);
    assert.notEqual(
        mode,
        "MONEY",
        "a gang at its size cap was pinned to money mode by a floor it cannot reach",
    );

});
