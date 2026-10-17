/*
 * ============================================================================
 * THE TRAINING CAP
 * ============================================================================
 * A wall-clock limit, because the reachability budget cannot refuse a target whose rate
 * it cannot measure — `floorReachable` treats an unknown rate as "keep going", so a stat
 * the rate model cannot see is trained indefinitely.
 *
 * The clock is module state, so a `nexus.ts` restart resets it. That is intended rather
 * than incidental: a restart is an explicit act. Each test resets first, since one test's
 * clock would otherwise be the next one's starting condition.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    TRAIN_CAP_MS,
    TRAIN_COOLDOWN_MS,
    TRAIN_INTERRUPTION_MS,
    capApplies,
    noteTraining,
    releaseIfTrainingStopped,
    clearTrainingClock,
    reset,
    trainCapVerdict,
} from "./training-cap.ts";

test("the cap governs gym and university only", () => {
    // Faction work, crimes and backdoors are productive in their own right; interrupting
    // them on a clock would cost reputation or a backdoor and gain nothing.
    assert.equal(capApplies("GYM"), true);
    assert.equal(capApplies("UNI"), true);
    for (const kind of ["FACTION", "CRIME", "BACKDOOR", "COMPANY", "PROGRAM", "TRAVEL"]) {
        assert.equal(capApplies(kind), false, `${kind} must not be capped`);
    }
});

test("training starts, runs, and is capped at fifteen minutes", () => {
    reset();
    const t0 = 1_000_000;

    assert.equal(trainCapVerdict(t0), "start");
    assert.equal(trainCapVerdict(t0 + 1_000), "allow");
    // Just short of the cap, still allowed.
    assert.equal(trainCapVerdict(t0 + TRAIN_CAP_MS - 1), "allow");
    // At the cap, it stops.
    assert.equal(trainCapVerdict(t0 + TRAIN_CAP_MS), "capped");
});

test("the cooldown must elapse before training can start again", () => {
    reset();
    const t0 = 2_000_000;

    trainCapVerdict(t0);
    const cappedAt = t0 + TRAIN_CAP_MS;
    assert.equal(trainCapVerdict(cappedAt), "capped");

    // Still cooling down, however often it is asked.
    assert.equal(trainCapVerdict(cappedAt + 1_000), "capped");
    assert.equal(trainCapVerdict(cappedAt + TRAIN_COOLDOWN_MS - 1), "capped");

    // Once the cooldown passes, a fresh stretch begins.
    assert.equal(trainCapVerdict(cappedAt + TRAIN_COOLDOWN_MS), "start");
});

test("clearing releases the budget without triggering a cooldown", () => {
    // The run spent ten minutes training, then went and did faction work. Its patience was
    // not being spent, so the next stretch must start whole rather than capped one minute in.
    reset();
    const t0 = 3_000_000;

    trainCapVerdict(t0);
    assert.equal(trainCapVerdict(t0 + 600_000), "allow");

    clearTrainingClock();
    assert.equal(trainCapVerdict(t0 + 600_001), "start");
});

test("a reset gives back a full budget, as a nexus restart does", () => {
    // The behaviour the memory-only clock is chosen for: restarting the orchestrator is an
    // explicit act and starts the run's patience over.
    reset();
    const t0 = 4_000_000;
    trainCapVerdict(t0);
    assert.equal(trainCapVerdict(t0 + TRAIN_CAP_MS), "capped");

    reset();
    assert.equal(trainCapVerdict(t0 + TRAIN_CAP_MS + 1), "start");
});

test("the clock covers a stretch, not one stat", () => {
    // Switching from str to def mid-stretch keeps one budget: what is being limited is the
    // run's patience with training, not any single measurement.
    reset();
    const t0 = 5_000_000;
    trainCapVerdict(t0);
    assert.equal(trainCapVerdict(t0 + 600_000), "allow");
    // Ten minutes later the stretch is still the same one, and still ends at the cap.
    assert.equal(trainCapVerdict(t0 + TRAIN_CAP_MS), "capped");
});

test("a brief interruption does NOT reset the training budget", () => {
    // THE BUG THE CAP HAD. Backdoors, the cash floor and travel all sit AHEAD of training
    // in the priority chain, so a mostly-training run takes a non-training action every so
    // often. Releasing the budget on each of those reset fourteen minutes of patience, and
    // a run trained for four hours with the cap never firing.
    reset();
    const t0 = 6_000_000;
    noteTraining(t0);
    // The first verdict STARTS the stretch, and it starts it at the time it is called —
    // so it must be called at t0 for the arithmetic below to mean anything.
    assert.equal(trainCapVerdict(t0), "start");

    // Ten minutes in, a SHORT interruption: one backdoor, under two minutes. The stretch
    // must continue rather than reset.
    //
    // `noteTraining` is called on every training tick in the real run, so the "last
    // trained" stamp is the interruption's START, not the last time the test happened to
    // mention it.
    noteTraining(t0 + 600_000);
    assert.equal(trainCapVerdict(t0 + 600_000), "allow");
    releaseIfTrainingStopped(t0 + 630_000);
    noteTraining(t0 + 630_000);

    // At fifteen minutes the cap still fires, interruption and all.
    assert.equal(trainCapVerdict(t0 + TRAIN_CAP_MS), "capped");
});

test("a genuine stop releases the budget after the interruption window", () => {
    reset();
    const t0 = 7_000_000;
    noteTraining(t0);
    trainCapVerdict(t0);

    // No training for longer than the window: the stretch is over.
    releaseIfTrainingStopped(t0 + TRAIN_INTERRUPTION_MS);
    assert.equal(trainCapVerdict(t0 + TRAIN_INTERRUPTION_MS + 1), "start");
});
