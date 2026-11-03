/*
 * ============================================================================
 * A GANG THAT CANNOT TAKE GROUND MUST BUILD POWER FOR IT
 * ============================================================================
 * `WARFARE_PREP` is the mode that trains members past their ordinary targets to raise the
 * gang's power. Nothing else does: every other mode puts members on economic work, which
 * earns money and respects and raises power only incidentally.
 *
 * It was UNREACHABLE for the whole early and middle game. The mode chain checked
 * `netWorth < moneyFloor` first and returned MONEY there, and the `WARFARE_PREP` branch sits
 * below that gate — so a gang short of `moneyFloor` was told to earn money on every tick,
 * forever, and never trained.
 *
 * Measured in `runs/2026-11-03T21.07.59.680Z--15`: power flat at 29.93K -> 29.98K across
 * ten minutes, twelve members all on `Human Trafficking` and `Traffick Illegal Arms`, and
 * not one `→ trainer`, `pinned territory` or `Territory Warfare` line in the entire session.
 * The gang held 14.3% of the map against four rivals with `moneyFloor` at 25b and net worth
 * around 3b, so the money gate fired on every single pass.
 *
 * THE ORDERING ARGUMENT, which the file already made in a comment without acting on it: the
 * money gate exists so a poor gang does not chase respect it cannot use. A gang that is
 * weaker than its rivals has a POWER problem, and no amount of money fixes it — the money is
 * capped by the territory it cannot take. Training is what closes that gap, and it is the
 * one thing the money modes will never do.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GANG_CONFIG_DEFAULT, decideMode } from "./gang-decisions.ts";
import type { EnemyScan } from "./gang-decisions.ts";
import type { GangGenInfo } from "@ns";

/** The recorded state: past respect phase, poor, holding little ground, four rivals. */
function gang(overrides: Partial<GangGenInfo> = {}): GangGenInfo {
    return {
        respect: 1.16e9,
        power: 29_980,
        wantedLevel: 1,
        wantedLevelGainRate: 0,
        wantedPenalty: 0.99999,
        // WELL BELOW `territoryEnableBelow` (0.9 with four rivals), so the gang is short of
        // ground it cannot take.
        territory: 0.143,
        territoryClashChance: 0,
        territoryWarfareEngaged: false,
        ...overrides,
    } as unknown as GangGenInfo;
}

const FOUR_RIVALS: EnemyScan = { enemyCount: 4, winnable: false } as unknown as EnemyScan;

/** Far below `moneyFloor` (25e9), which is the condition the gate keys on. */
const POOR = 3e9;

test("a poor gang short of ground prepares for war instead of earning", () => {
    // THE DEFECT. This returned MONEY:below-money-floor on every tick, so WARFARE_PREP —
    // the only mode that trains for power — could never run.
    const decided = decideMode(gang(), GANG_CONFIG_DEFAULT, false, FOUR_RIVALS, POOR, false);

    assert.equal(
        decided.mode,
        "WARFARE_PREP",
        `a gang at ${14.3}% territory against four rivals was told to earn money, so it never trains`,
    );
    assert.equal(decided.reason, "weaker-than-enemy");
});

test("the money gate still fires once the gang holds enough ground", () => {
    // THE CONTROL, and the thing that must not regress. Above `territoryEnableBelow` there
    // is no ground worth fighting for, so earning money is the right answer and the poor
    // gang must still be sent to do it. Without this, moving the branch would have made
    // WARFARE_PREP win for every gang that was simply poor.
    const decided = decideMode(
        gang({ territory: 0.95 }),
        GANG_CONFIG_DEFAULT,
        false,
        FOUR_RIVALS,
        POOR,
        false,
    );

    assert.equal(decided.mode, "MONEY");
    assert.equal(decided.reason, "below-money-floor");
});

test("a gang with no rivals never prepares for war", () => {
    // `enemyCount > 0` guards the branch, and it must keep doing so: territory against
    // nobody is already all held, and prep would train for a fight that does not exist.
    const noRivals = { enemyCount: 0, winnable: false } as unknown as EnemyScan;
    const decided = decideMode(gang(), GANG_CONFIG_DEFAULT, false, noRivals, POOR, false);

    assert.notEqual(decided.mode, "WARFARE_PREP");
});

test("a hacking gang never prepares for war", () => {
    // Hacking gangs cannot clash for territory at all — the branch is guarded on
    // `!isHacking`, and moving it above the money gate must not drop that guard. A hacking
    // gang put into prep would train combat stats it does not use.
    const decided = decideMode(gang(), GANG_CONFIG_DEFAULT, true, FOUR_RIVALS, POOR, false);

    assert.notEqual(decided.mode, "WARFARE_PREP");
});

test("a wealthy gang short of ground also prepares for war", () => {
    // The branch is about TERRITORY, not about money. Above `moneyFloor` the money gate
    // never fired anyway, so this already worked — asserted so the reorder cannot break the
    // case that was previously reachable.
    const decided = decideMode(gang(), GANG_CONFIG_DEFAULT, false, FOUR_RIVALS, 1e15, false);

    assert.equal(decided.mode, "WARFARE_PREP");
});
