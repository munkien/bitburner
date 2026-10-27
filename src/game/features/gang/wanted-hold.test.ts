/*
 * ============================================================================
 * THE WANTED LEVEL NEVER RISES
 * ============================================================================
 * The wanted level must be the same or lower every game tick, in every mode.
 *
 * WHY THIS IS A RULE AND NOT A MODE. The level was treated as one of several things the
 * gang may work on, ranked against respect, money and territory — so in MONEY, TERRITORY
 * and WARFARE_PREP it was left to climb while the gang did something else. The reasoning
 * was that the penalty only multiplies income, so a poor run "has no income to defend".
 *
 * That reasoning is wrong in the direction that matters, and the recorded runs show where it
 * leads: `MODE: WANTED:wanted-cleanup ... wanted=100.0%` and `wanted=64.0%` in the same
 * sessions, with `rise=1/cycle crew=9 ... cleaners=0` — the level climbing while a full crew
 * worked something else. A collapsing penalty is not a thing to postpone: it lowers every
 * rate the gang has, so the money the other modes are chasing arrives more slowly the longer
 * it is left. And at a penalty of 0 the gang earns nothing at all, which makes "earn money
 * first, clean up later" a plan that cannot finish.
 *
 * So cleanup is a FLOOR, not a mode: whenever the level would rise, enough members are taken
 * off their task to hold it. What this file pins is the arithmetic of "enough", because that
 * is where it has been wrong before — a zero measured rate silently reduced the crew to one
 * member, which is not enough to hold a rising level, and the run could not tell the
 * difference between "one member suffices" and "one member is a fallback".
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GANG_CONFIG_DEFAULT, computeTrainerCap, wantedHoldWorkers } from "./gang-decisions.ts";

/** A prep configuration, which is the mode that reserves the most members for training. */
const PREP_CONFIG = { ...GANG_CONFIG_DEFAULT };

/** Nine members, one of whom removes 1.5 wanted level per cycle if put on the task. */
const GANG = 9;
const STRONG = 1.5;

test("a rising level is held, not merely noticed", () => {
    // The rise here is what the rest of the gang adds: 3 per cycle. One member removes 1.5,
    // so two are needed to bring the net to zero. Zero is the requirement — not "lower than
    // before", which would let a fast rise outrun a small crew for a while.
    assert.equal(wantedHoldWorkers(3, STRONG, GANG), 2);
});

test("the crew is sized from the best available cleaner", () => {
    // The mean over the WHOLE gang reports one strong cleaner as 1.5/9 = 0.17, and sizing
    // from that asks for 18 members to hold a rise of 3 — more than the gang has, so the
    // level climbs with everyone on cleanup. The best member is the honest figure for "what
    // does one more cleaner buy".
    assert.equal(wantedHoldWorkers(3, 9 * 0.17, GANG), 2);
});

test("a level that is not rising needs no crew", () => {
    assert.equal(wantedHoldWorkers(0, STRONG, GANG), 0);
    assert.equal(wantedHoldWorkers(-2, STRONG, GANG), 0, "a falling level is not a rise");
});

test("a gang that cannot clean still sends one", () => {
    // No usable rate means the rise cannot be matched at any size. One member is the
    // smallest honest answer: sending nobody is a decision to let the level climb, and the
    // caller reports it. A zero here is what the run looked like while it was broken.
    assert.equal(wantedHoldWorkers(3, 0, GANG), 1);
});

test("the crew never exceeds the gang", () => {
    assert.equal(wantedHoldWorkers(1000, 0.1, GANG), GANG);
    assert.equal(wantedHoldWorkers(3, STRONG, 0), 0, "an empty gang has nobody to send");
});

test("the crew is a whole number of members", () => {
    // A fractional member is still a member, and rounding down leaves the remainder
    // climbing. 2.4 members is 3.
    assert.equal(wantedHoldWorkers(2.4, 1, GANG), 3);
});

/* ─── the floor reserves its members ─── */

test("the floor takes its members before training does", () => {
    // A trainer is never re-assigned during the loop, so a floor that assumes members are
    // available cannot reach one. In WARFARE_PREP six of nine can be trainers, which would
    // leave the crew unfilled while the level climbs — the same shape of bug as a cap sized
    // without reserving anything for income.
    //
    // Prep's budget for nine members with a territory target of four, before the floor:
    //   fraction cap  ceil(9 * 0.35) = 4
    //   reserved cap  9 - 4 (territory) - 1 (earners) = 4
    // so four members may train. A floor of two takes two of those back, leaving two.
    assert.equal(computeTrainerCap(9, "WARFARE_PREP", PREP_CONFIG, 4), 4, "the budget changed");
    assert.equal(computeTrainerCap(9, "WARFARE_PREP", PREP_CONFIG, 4, 2), 2);
});

test("the floor cannot make the trainer cap negative", () => {
    // A gang of one with a rise it cannot match: the floor asks for the only member, and the
    // cap must clamp at zero rather than hand back a negative count.
    assert.equal(computeTrainerCap(1, "WARFARE_PREP", PREP_CONFIG, 1, 1), 0);
});

test("with no wanted pressure the cap is unchanged", () => {
    assert.equal(computeTrainerCap(9, "MONEY", PREP_CONFIG, 0, 0), Math.ceil(9 * PREP_CONFIG.trainMaxFraction));
});
