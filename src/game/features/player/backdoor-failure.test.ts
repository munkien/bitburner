/*
 * ============================================================================
 * A FAILED BACKDOOR NAMES ITS CAUSE
 * ============================================================================
 * `runBackdoor` returned a bare boolean, so three unrelated failures produced the same
 * status line:
 *
 *   the worker script is not on home       -> "could not start backdoor CSEC"
 *   the game refused because RAM is short  -> "could not start backdoor CSEC"
 *   the worker is already running          -> (reported as success)
 *
 * The middle one was measured live in `runs/2026-11-03T21.39.26.280Z--18`: home stood at
 * 8191.85 of 8192 GB for 127 of 139 frames, `ns.run` returned 0, and the run reported
 * "could not start backdoor CSEC" for 56 seconds. It then succeeded on its own once RAM
 * freed, so the line was TRUE — and useless, because it did not say that waiting was the
 * right response rather than investigating a broken script.
 *
 * This is the same shape as `bladeburner: starting`: a line that is accurate and tells the
 * reader nothing. The fix is for the failure to carry its reason.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKDOOR_WORKER, runBackdoor } from "./player.ts";
import type { NS } from "@ns";

/** An `ns` whose home filesystem and `run` behave as the caller wants. */
function fakeNs(opts: {
    /** Paths `ls("home")` reports. Empty means the worker was never synced. */
    scripts?: readonly string[];
    /** Whether the worker is already running. */
    running?: boolean;
    /** What `ns.run` returns: >0 started, 0 refused for RAM. */
    runResult?: number;
}): NS {
    const scripts = opts.scripts ?? [`/${BACKDOOR_WORKER}`];
    return {
        ls: () => [...scripts],
        scriptRunning: () => opts.running ?? false,
        run: () => opts.runResult ?? 1,
    } as unknown as NS;
}

test("a missing worker is named as missing", () => {
    // The case that looks like a code fault and is really a deployment one: file sync has
    // not pushed the script. Distinct from RAM, because the response is different — wait
    // for a sync rather than wait for RAM.
    const result = runBackdoor(fakeNs({ scripts: [] }), "CSEC");

    assert.equal(result.started, false);
    assert.equal(result.reason, "missing-worker");
    assert.match(result.describe(), /not on home/);
});

test("a refusal from the game is named as RAM", () => {
    // `ns.run` returns 0 when it cannot allocate the threads. Measured live at 8191.85 of
    // 8192 GB — the reported case. Distinct from missing, because the response is to wait.
    const result = runBackdoor(fakeNs({ runResult: 0 }), "CSEC");

    assert.equal(result.started, false);
    assert.equal(result.reason, "no-ram");
    assert.match(result.describe(), /RAM/);
});

test("a started worker reports success with no reason", () => {
    // The control. `started: true` must not carry a failure reason, or the caller cannot
    // use it to decide whether to report anything.
    const result = runBackdoor(fakeNs({ runResult: 1 }), "CSEC");

    assert.equal(result.started, true);
    assert.equal(result.reason, null);
});

test("an already-running worker reports success without starting another", () => {
    // The idempotency case: a worker walks the route over several seconds, so the caller runs
    // on every tick and must not launch a second one. Reported as started, because from the
    // caller's point of view the backdoor IS under way.
    const result = runBackdoor(fakeNs({ running: true, runResult: 0 }), "CSEC");

    assert.equal(result.started, true);
    assert.equal(result.reason, null, "an already-running worker was reported as a failure");
});

test("the worker name the test uses is the one the feature looks for", () => {
    // Pinned because the two are separate literals — the constant and the file on disk — and
    // a rename in one place would silently make every backdoor report "missing-worker".
    assert.equal(BACKDOOR_WORKER, "backdoor.ts");
});
