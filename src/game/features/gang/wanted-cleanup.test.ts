/*
 * ============================================================================
 * WANTED-LEVEL CLEANUP
 * ============================================================================
 * How many members the gang puts on the wanted task, and how that number is measured.
 *
 * WHY THIS FILE EXISTS. "The gang controller is no longer keeping wanted level down" was
 * reported with the pressure line in hand, and the line could not answer it: it printed
 *
 *     WANTED-PRESSURE: rise=1/cycle crew=9 (rate=1 cleaners=0 each=0)
 *
 * `each=0` reads as "a cleaner does nothing", and that is what it was taken to mean. It is
 * not what the line says. `fmt` rounds to whole numbers, so `each=0` covers everything below
 * 0.5 — and the value is a mean over EVERY member, not over the cleaners, so a gang whose one
 * capable cleaner removes 1.8 per cycle reports 1.8/9 = 0.20 and prints `0`.
 *
 * So the three numbers in that line are entangled in a way the line hides, and the crew size
 * depends on all three. This pins what they mean, so a future reading of that line does not
 * have to re-derive it.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    GANG_CONFIG_DEFAULT,
    averageCleanupRate,
    wantedRise,
    wantedWorkersFor,
} from "./gang-decisions.ts";

/** A gang whose wanted level is rising and who is off target, so cleanup is wanted. */
const RISING = { wantedLevel: 40, wantedLevelGainRate: 1, wantedPenalty: 0.5 };

const cfg = { ...GANG_CONFIG_DEFAULT };

/* ─── the measurement ─── */

test("cleanup is taken as a magnitude, and only from rates that actually remove wanted", () => {
    // The game reports `wantedLevelGain` per (member, task); negative means the member
    // removes wanted level. A task that ADDS it is not a cleaner and must not dilute the mean
    // upward or count as one.
    assert.equal(averageCleanupRate([-2, -4]), 3);
    assert.equal(averageCleanupRate([-2, 6]), 2);
    assert.equal(averageCleanupRate([6, 8]), 0, "nobody can clean, but the mean claimed someone could");
});

test("a rate too small to print is still a rate", () => {
    // THE TRAP THAT MADE THIS FILE NECESSARY. `fmt(0.2)` prints `0`, so the recorded line
    // cannot distinguish "no cleaner can help" from "a weak cleaner can". They mean very
    // different crew sizes, so the distinction has to survive in the value.
    const tiny = averageCleanupRate([-0.2]);
    assert.ok(tiny > 0, "a small positive cleanup rate was collapsed to zero");
});

/* ─── the crew size ─── */

test("the crew covers the rise, not a fraction of the gang", () => {
    // The question is a rate comparison: enough cleaners that their combined cleanup meets
    // the rise. A rise of 1 covered by 1 per cleaner is one member, whatever the gang's size.
    assert.equal(wantedWorkersFor(RISING, { gainRate: 1, cleaners: 0, cleanupRate: 1, bestCleanupRate: 1 }, 9, cfg), 1);
    assert.equal(wantedWorkersFor(RISING, { gainRate: 1, cleaners: 0, cleanupRate: 0.2, bestCleanupRate: 0.2 }, 9, cfg), 5);
    // Rounded UP: a fractional member is still a member, and rounding down leaves the level
    // climbing on the remainder.
    assert.equal(wantedWorkersFor(RISING, { gainRate: 1, cleaners: 0, cleanupRate: 0.3, bestCleanupRate: 0.3 }, 9, cfg), 4);
});

test("the crew never exceeds the gang", () => {
    assert.equal(wantedWorkersFor(RISING, { gainRate: 100, cleaners: 0, cleanupRate: 0.1, bestCleanupRate: 0.1 }, 9, cfg), 9);
});

test("a gang that cannot clean still sends one, rather than ignoring the level", () => {
    // With no usable cleanup rate the rise can never be matched at any size. One wasted
    // member is cheaper than an ignored level, and zero would be an explicit decision to let
    // it climb.
    assert.equal(wantedWorkersFor(RISING, { gainRate: 1, cleaners: 0, cleanupRate: 0, bestCleanupRate: 0 }, 9, cfg), 1);
});

test("no crew when the level is flat and the penalty is healthy", () => {
    const settled = { wantedLevel: 40, wantedLevelGainRate: 0, wantedPenalty: 0.99 };
    assert.equal(wantedWorkersFor(settled, { gainRate: 0, cleaners: 0, cleanupRate: 1, bestCleanupRate: 1 }, 9, cfg), 0);
});

test("an empty gang has nobody to assign", () => {
    assert.equal(wantedWorkersFor(RISING, { gainRate: 1, cleaners: 0, cleanupRate: 1, bestCleanupRate: 1 }, 0, cfg), 0);
});

/* ─── the rise ─── */

test("the rise is what the rest of the gang does, with the cleaners added back", () => {
    // `wantedLevelGainRate` is NET: the members already on cleanup are inside it. Sizing a
    // crew from the net rate would under-staff it, because the cleaners already working are
    // counted as if they were not.
    assert.equal(wantedRise({ gainRate: 1, cleaners: 0, cleanupRate: 0.5, bestCleanupRate: 0.5 }), 1);
    assert.equal(wantedRise({ gainRate: -2, cleaners: 4, cleanupRate: 0.5, bestCleanupRate: 0.5 }), 0, "a net fall is not a rise");
    // Net zero with one cleaner at 1 means the rest of the gang adds 1 — the level IS rising
    // and the crew must be sized for it rather than for the net figure.
    assert.equal(wantedRise({ gainRate: 0, cleaners: 1, cleanupRate: 1, bestCleanupRate: 1 }), 1);
});
