/*
 * ============================================================================
 * THE MODE FOLLOWS THE COMMITMENT, NOT THE RATE
 * ============================================================================
 * `decideMode` releases cleanup when the wanted level stops rising. But assigning cleaners
 * is what MAKES the level stop rising, so the rule cannot see its own cause:
 *
 *   crew off -> rate +0.43 -> "needs attention" -> crew assigned
 *   crew on  -> rate -0.32 -> "nothing to do"    -> crew released
 *   crew off -> rate +0.43 -> ...
 *
 * Measured live in `runs/2026-11-01T16.36.05.158Z--3`: 148 WANTED frames against 264 MONEY
 * frames, alternating every two seconds, with the level cycling 9.3 -> 15.8 -> 9.3 while the
 * penalty sat at 100% throughout. Every other input was identical across the alternation, so
 * the rate was the only thing that differed — and the rate is the crew's own output.
 *
 * WHAT THIS FILE PINS. The three states that have to be told apart, none of which the old
 * boolean could express:
 *
 *   the level is rising or the penalty is short   cleanup, as before
 *   nothing is moving, crew committed             HOLD — the crew is why nothing is moving
 *   nothing is moving, no crew                    release, as before
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GANG_CONFIG_DEFAULT, WANTED_LEVEL_FLOOR, decideMode, wantedAttentionReason } from "./gang-decisions.ts";
import type { EnemyScan } from "./gang-decisions.ts";
import type { GangGenInfo } from "@ns";

/** A gang past its respect phase with no fight available, so only wanted/money decide. */
function gang(overrides: Partial<GangGenInfo> = {}): GangGenInfo {
    return {
        respect: GANG_CONFIG_DEFAULT.respectPhaseEnd + 1,
        power: 1_000,
        wantedLevel: 12.44,
        wantedLevelGainRate: 0.43,
        // FULL PENALTY, which is the state the recording was in and the one that makes the
        // penalty half of the rule dead — leaving the rate as the only input, which is why
        // the loop was so clean.
        wantedPenalty: 1,
        territory: 0,
        territoryClashChance: 0,
        territoryWarfareEngaged: false,
        ...overrides,
    } as unknown as GangGenInfo;
}

const NO_FIGHT: EnemyScan = { enemyCount: 0, winnable: false } as unknown as EnemyScan;

/** Net worth comfortably above any floor, so the money gate does not fire. */
const RICH = 1e15;

test("a rising level wants cleanup, committed or not", () => {
    // The unchanged case. A crew that is not there cannot be the cause of anything.
    assert.equal(wantedAttentionReason(gang(), GANG_CONFIG_DEFAULT, false), "wanted-cleanup");
    assert.equal(wantedAttentionReason(gang(), GANG_CONFIG_DEFAULT, true), "wanted-cleanup");
});

test("a crew that suppressed the rate HOLDS instead of being released", () => {
    // THE DEFECT, in one assertion. Same gang, rate now negative because the crew arrived.
    // Uncommitted, this is genuinely nothing to do; committed, it is the crew doing its job.
    const settling = gang({ wantedLevel: 9.28, wantedLevelGainRate: -0.316 });

    assert.equal(
        wantedAttentionReason(settling, GANG_CONFIG_DEFAULT, false),
        null,
        "an uncommitted crew was kept for a level that is coming down on its own",
    );
    assert.equal(
        wantedAttentionReason(settling, GANG_CONFIG_DEFAULT, true),
        "wanted-held",
        "a committed crew was released the moment it succeeded, which restarts the climb",
    );
});

test("the release reason is distinguishable from the entry reason", () => {
    // Both would otherwise report `wanted-cleanup`, and a reader diagnosing the loop could
    // not tell "the level is rising" from "the crew is holding it down". The recording is
    // the artefact this file exists for, so the two must not share a name.
    const rising = wantedAttentionReason(gang(), GANG_CONFIG_DEFAULT, true);
    const held = wantedAttentionReason(gang({ wantedLevelGainRate: -0.3 }), GANG_CONFIG_DEFAULT, true);

    assert.equal(rising, "wanted-cleanup");
    assert.equal(held, "wanted-held");
});

test("the floor of the scale releases even a committed crew", () => {
    // A fact about the LEVEL outranks the commitment: a crew working at 1 is working for
    // nothing. `WantedFloor`'s `atFloorReadings` already requires two consecutive readings
    // before releasing, so a single bad frame cannot tear a commitment down — this only
    // asserts that the floor wins once it is genuinely reached.
    const atFloor = gang({ wantedLevel: WANTED_LEVEL_FLOOR, wantedLevelGainRate: -0.5 });

    assert.equal(wantedAttentionReason(atFloor, GANG_CONFIG_DEFAULT, true), null);
    assert.equal(decideMode(atFloor, GANG_CONFIG_DEFAULT, false, NO_FIGHT, RICH, true).mode, "MONEY");
});

test("the whole recorded alternation stays clean once committed", () => {
    // The six states from the recording, replayed. Under the old wiring the negative-rate
    // ones returned MONEY and the positive-rate ones WANTED, which is the two-second flip.
    const recorded: readonly (readonly [number, number])[] = [
        [12.44, 0.430],
        [9.28, -0.316],
        [13.58, 0.430],
        [10.41, -0.317],
        [10.78, -0.186],
        [8.94, -0.185],
    ];

    for (const [level, rate] of recorded) {
        const g = gang({ wantedLevel: level, wantedLevelGainRate: rate });
        const decided = decideMode(g, GANG_CONFIG_DEFAULT, false, NO_FIGHT, RICH, true);

        assert.equal(
            decided.mode,
            "WANTED",
            `level=${level} rate=${rate} released cleanup mid-cycle, which is the recorded flip`,
        );
    }
});

test("the commitment does not keep the gang cleaning forever", () => {
    // The same defect pointing the other way. A committed crew whose level has settled well
    // away from the floor and whose penalty is healthy must still be released when its hold
    // expires — the hold is bounded by `WantedFloor`, and this asserts the DECISION does not
    // add a second, unbounded reason to keep going.
    //
    // Expressed through the uncommitted path, because that is what the decision sees once
    // the hold has lapsed.
    const settled = gang({ wantedLevel: 8, wantedLevelGainRate: -0.1, wantedPenalty: 1 });
    assert.equal(wantedAttentionReason(settled, GANG_CONFIG_DEFAULT, false), null);
});
