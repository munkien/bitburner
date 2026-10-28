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

import { GANG_CONFIG_DEFAULT, WANTED_HOLD_MS, computeTrainerCap, holdRequirement, wantedHoldWorkers } from "./gang-decisions.ts";

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

/* ─── the floor must not chase its own crew ─── */

test("a crew already holding the level is not stood down and immediately re-sent", () => {
    // THE FLICKER THIS FILE DID NOT CATCH. The floor sized its crew from `wantedRise`, which
    // ADDS the current cleaners back to the net rate — a figure the floor's own assignment
    // changes. So one cleaner working (-1.5 net from a +1 rise) makes the rise read zero, the
    // floor releases them, the net rate goes positive again, and the floor re-sends the same
    // member. Every tick. Reported as "flipping between Vigilante Justice and Human
    // Trafficking", which is those two tasks and nothing else.
    //
    // The fix is a latched requirement: once the floor is engaged it stays engaged until the
    // level has actually come down, which is the same shape as the activity hold. Asking the
    // question fresh every tick cannot work when the answer moves the question.
    const netWithOneCleaner = -1.5;
    const requirement = holdRequirement(
        { level: 40, netRate: netWithOneCleaner, cleaners: 0, bestRate: 1.5 },
        /* engaged when the level was 40 */ 40,
    );
    assert.ok(requirement > 0, "the floor stood down while its own cleaner was holding the level");
});

test("the floor engages when the level is genuinely rising", () => {
    const requirement = holdRequirement(
        { level: 40, netRate: 1, cleaners: 0, bestRate: 1.5 },
        null,
    );
    assert.equal(requirement, 1);
});

test("the floor holds while the level is still at or above where it engaged", () => {
    // "Come down" means below the level it engaged at, not merely below where it started
    // climbing. A level that has stopped rising but not fallen is still being held — letting
    // go there is the flip, because the next tick sees it rising again.
    assert.equal(
        holdRequirement({ level: 40, netRate: 0, cleaners: 1, bestRate: 1.5 }, 40),
        1,
        "released while the level had not fallen",
    );
    assert.equal(
        holdRequirement({ level: 46, netRate: 0, cleaners: 1, bestRate: 1.5 }, 40),
        1,
        "released while the level was still above where it engaged",
    );
});

test("the floor releases once the level has fallen below where it engaged", () => {
    // Held is not forever: the level falling is the evidence that cleanup worked, and the
    // crew should be given back. A latch that never released would keep a member on a task
    // with nothing to do for the rest of the run.
    assert.equal(
        holdRequirement({ level: 38, netRate: -1, cleaners: 1, bestRate: 1.5 }, 40),
        0,
    );
});

test("a crew that IS reducing the level still hands it back", () => {
    // THE OTHER HALF, and the reason the flicker is not a release-rule bug.
    //
    // Deduplicated to real game ticks, `runs/2026-10-28T05.21.21` reads:
    //
    //   417  cleaners=11  rate=-0.50      <- crew on, level falling
    //   560  cleaners=0   rate=+0.51      <- crew off, level climbs back
    //   429  cleaners=11  rate=-0.50
    //   558  cleaners=0   rate=+0.51
    //
    // Eleven of twelve members, one game tick on and one off, for the whole session. The crew
    // is released because the rule says so and the rule is RIGHT: with them on, the level came
    // down from 560 to 429 and was still falling. Releasing is correct by every honest reading.
    //
    // That makes this a SIZE problem, not a release problem. One tick of coverage out of two
    // is the smallest possible duty cycle, so releasing — however well justified — is always
    // followed immediately by re-sending. What the floor needs is a commitment that outlasts a
    // single tick, so see `wantedHoldUntil`. This test pins the release so it is not silently
    // made sticky instead.
    assert.equal(
        holdRequirement({ level: 429, netRate: -0.499, cleaners: 11, bestRate: 0.0389 }, 560),
        0,
        "cleanup that is working must hand the crew back; the flicker is the re-send, not the release",
    );
});

test("a committed crew stays through the tick that would release it", () => {
    // THE DUTY CYCLE. Releasing correctly is not enough when the crew is assigned on one game
    // tick and released on the next: that is one tick of work in two, and the re-send follows
    // at once. See `WANTED_HOLD_MS` and the recorded sequence in the test above.
    //
    // The release condition is still satisfied here — 429 is below 560 and the rate is
    // negative — so this is exactly the tick that used to hand the crew back.
    const engagedAt = 560;
    const committedUntil = 1_000 + WANTED_HOLD_MS;
    const p = { level: 429, netRate: -0.499, cleaners: 11, bestRate: 0.0389 };

    // The SIZE is latched too: the reading says 11 cleaners, but the commitment is to 12, and
    // a commitment that re-reads the count churns 12 -> 11 -> 1 -> 11 rather than holding.
    assert.equal(
        holdRequirement(p, engagedAt, committedUntil, 1_000 + 1_000, 12),
        12,
        "the committed crew size followed the reading instead of the commitment",
    );

    // And once the commitment has expired the same reading does release them: a hold that
    // never lets go would keep eleven of twelve members on a task with nothing left to do.
    assert.equal(
        holdRequirement(p, engagedAt, committedUntil, committedUntil),
        0,
        "the crew never stood down, so it would hold the wanted task for the rest of the run",
    );
});

test("a commitment survives the level bouncing to the floor", () => {
    // THE REGRESSION THE COMMITMENT ITSELF CAUSED, and it is a placement bug rather than a
    // logic one. With the floor test ABOVE the commitment, a level that bounced to 1 for a
    // single reading returned 0 — which the caller reads as "release" and acts on by clearing
    // the latch. The commitment was destroyed by the very noise it existed to ride out, and
    // `runs/2026-10-28T08.14.44` shows the result, identical to the unfixed flip:
    //
    //   lvl=3 -> hold=12
    //   lvl=1 -> hold=0    <- floor test fired, latch cleared, commitment gone
    //   lvl=6 -> hold=12   <- engaged from scratch on the next bounce
    //
    // The floor test is right in substance — a crew at the bottom of the scale achieves
    // nothing — but once a crew is out they stay out for the span, and the floor applies when
    // the commitment expires.
    assert.equal(
        holdRequirement({ level: 1, netRate: -0.315, cleaners: 12, bestRate: 0.039 }, 7.31, 999_999, 0, 12),
        12,
        "a single reading at the floor tore down a commitment that had ticks left to run",
    );
});

test("two consecutive readings at the floor end the commitment", () => {
    // THE OTHER HALF OF THE PLACEMENT PROBLEM, and the one that made the fix worse than the
    // bug. Moving the floor check below the commitment stopped a single frame tearing the
    // latch down — but it also let a crew sit at the bottom of the scale for the whole span.
    // Replayed over `runs/2026-10-28T05.44.43`, that took cleaning from 49% of frames to 93%,
    // with 1631 frames of it at a level of 1 where cleanup achieves nothing. Trading a flicker
    // for permanently doing the wrong thing is not a fix.
    //
    // So the floor gets a voice that survives one bad frame but not two. One reading can be
    // noise — the same tick is read twice, and the bounce is real — but the level being at the
    // bottom of the scale on two consecutive readings is not noise, it is the situation.
    const p = { level: 1, netRate: -0.315, cleaners: 12, bestRate: 0.039 };

    // First reading at the floor: still committed, because this may be the bounce.
    assert.equal(
        holdRequirement(p, 7.31, 999_999, 0, 12, 1),
        12,
        "one reading at the floor tore down a commitment, which is the tear-down this placement fixed",
    );

    // Second consecutive reading at the floor: the crew is doing nothing and must stand down.
    assert.equal(
        holdRequirement(p, 7.31, 999_999, 0, 12, 2),
        0,
        "the gang was kept on cleanup for the rest of the span while the level sat at the floor",
    );
});

test("a level that bounces off the floor keeps its crew", () => {
    // The counter-case, and the reason the count is CONSECUTIVE readings rather than a total.
    // The recorded loop is 3 -> 1 -> 6 -> 3: the level touches 1 and leaves. A crew held through
    // that is right; a crew released on it is the flicker.
    const atFloorOnce = holdRequirement({ level: 1, netRate: -0.315, cleaners: 12, bestRate: 0.039 }, 7.31, 999_999, 0, 12, 1);
    assert.equal(atFloorOnce, 12);

    // And back above the floor, the streak resets, so a later single dip cannot accumulate
    // with an earlier one.
    const above = holdRequirement({ level: 6, netRate: 0.6, cleaners: 12, bestRate: 0.039 }, 7.31, 999_999, 0, 12, 0);
    assert.equal(above, 12, "the crew was released by a reading that was above the floor");
});

test("a long-term level that is already stable releases the whole crew", () => {
    // THE OPERATOR'S RULE, and it is a different question from every rule above.
    //
    // Nothing here is wrong about a single reading: the level genuinely rises when nobody
    // cleans and genuinely falls when they do. The mistake was asking that question at all
    // when the LONG-TERM level is already where it should be.
    //
    // `runs/2026-10-28T08.14.44` measures it: the rolling 30-tick mean of the level is 3.83,
    // 3.81, 3.80 across the run — flat to two decimal places — while 11 of 12 members are on
    // Vigilante Justice for 83% of frames. The crew is paying for a trend that is not moving.
    //
    // So the floor's question is not "is the level rising this tick" but "is the long-term
    // level stable or falling". A crew that is holding a level flat has already succeeded, and
    // the members belong somewhere they earn something.
    assert.equal(
        holdRequirement(
            { level: 6.87, netRate: 0.587, cleaners: 0, bestRate: 0.039 },
            null, 0, 0, 0, 0,
            /* long-term trend */ "stable",
        ),
        0,
        "a gang kept cleaning while its long-term wanted level was flat",
    );
});

test("a long-term level that is genuinely climbing still gets a crew", () => {
    // The other side, and the reason the trend is measured over a window rather than dropped.
    // A level rising across the window is a real defence, and the crew is how it is held.
    assert.ok(
        holdRequirement(
            { level: 6.87, netRate: 0.587, cleaners: 0, bestRate: 0.039 },
            null, 0, 0, 0, 0,
            "rising",
        ) > 0,
        "a level climbing over the long term was left alone",
    );
});

test("with no commitment, a level at the floor still sends nobody", () => {
    assert.equal(
        holdRequirement({ level: 1, netRate: -0.315, cleaners: 12, bestRate: 0.039 }, 7.31, 0, 0, 12),
        0,
        "the floor stopped being a floor once the commitment expired",
    );
});

test("a level at the floor releases even while the rate is positive", () => {
    // `wantedLevel` cannot fall below 1: the game clamps it. At the floor, cleanup achieves
    // nothing however the rate reads, so no member should be sent.
    const requirement = holdRequirement(
        { level: 1, netRate: 1, cleaners: 1, bestRate: 1.5 },
        40,
    );
    assert.equal(requirement, 0);
});
