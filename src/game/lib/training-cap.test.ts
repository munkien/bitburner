/*
 * ============================================================================
 * THE TRAINING CAP
 * ============================================================================
 * A wall-clock limit, because the reachability budget cannot refuse a target whose rate
 * it cannot measure — `floorReachable` treats an unknown rate as "keep going", so a stat
 * the rate model cannot see is trained indefinitely. A clock does not care whether the
 * target is reachable.
 *
 * The state lives in a file because the orchestrator self-restarts on every edit; a
 * module variable would reset to "just started" and a frequently-edited run would never
 * reach fifteen minutes.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    TRAIN_CAP_MS,
    TRAIN_COOLDOWN_MS,
    TRAINING_CAP_FILE,
    capApplies,
    clearTrainingClock,
    trainCapVerdict,
} from "./training-cap.ts";
import type { NS } from "@ns";

/** An `ns` whose home holds one small file, mutated in place across calls. */
function fakeNs(initial?: string) {
    const files = new Map<string, string>();
    if (initial !== undefined) files.set(TRAINING_CAP_FILE, initial);

    const ns = {
        fileExists: (name: string) => files.has(name),
        read: (name: string) => files.get(name) ?? "",
        write: (name: string, data: string) => { files.set(name, data); return true; },
    } as unknown as NS;

    return { ns, files };
}

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
    const { ns } = fakeNs();
    const t0 = 1_000_000;

    assert.equal(trainCapVerdict(ns, t0), "start");
    // A second later, the stretch is running and allowed.
    assert.equal(trainCapVerdict(ns, t0 + 1_000), "allow");
    // Just short of the cap, still allowed.
    assert.equal(trainCapVerdict(ns, t0 + TRAIN_CAP_MS - 1), "allow");
    // At the cap, it stops.
    assert.equal(trainCapVerdict(ns, t0 + TRAIN_CAP_MS), "capped");
});

test("the cooldown must elapse before training can start again", () => {
    const { ns } = fakeNs();
    const t0 = 2_000_000;

    trainCapVerdict(ns, t0);
    const cappedAt = t0 + TRAIN_CAP_MS;
    assert.equal(trainCapVerdict(ns, cappedAt), "capped");

    // Still cooling down, however often it is asked.
    assert.equal(trainCapVerdict(ns, cappedAt + 1_000), "capped");
    assert.equal(trainCapVerdict(ns, cappedAt + TRAIN_COOLDOWN_MS - 1), "capped");

    // Once the cooldown passes, a fresh stretch begins.
    assert.equal(trainCapVerdict(ns, cappedAt + TRAIN_COOLDOWN_MS), "start");
});

test("clearing releases the budget without triggering a cooldown", () => {
    // The run spent ten minutes training, then went and did faction work. Its patience was
    // not being spent, so the next stretch must start whole rather than capped one minute in.
    const { ns } = fakeNs();
    const t0 = 3_000_000;

    trainCapVerdict(ns, t0);
    assert.equal(trainCapVerdict(ns, t0 + 600_000), "allow");

    clearTrainingClock(ns);
    assert.equal(trainCapVerdict(ns, t0 + 600_001), "start");
});

test("a stale clock from a previous run is discarded, not inherited", () => {
    // A reset or a different run leaves a start time in the future. Trusting it would
    // suppress training for the whole session; discarding it is the only safe reading.
    const { ns } = fakeNs("9999999999999,0");
    assert.equal(trainCapVerdict(ns, 4_000_000), "start");
});

test("a malformed file does not disable the cap", () => {
    // The failure that matters: `NaN` compares false against everything, so a bad file
    // read naively would let training run unbounded — the exact problem this prevents.
    const { ns } = fakeNs("garbage");
    assert.equal(trainCapVerdict(ns, 5_000_000), "start");
    assert.equal(trainCapVerdict(ns, 5_000_000 + TRAIN_CAP_MS), "capped");
});
