/*
 * ============================================================================
 * A CLOUD SERVER NAME IS CHOSEN TO BE FREE, NOT COUNTED OFF
 * ============================================================================
 * `purchase` named each new server `${prefix}${names.length}` — the name came from the
 * COUNT of existing servers rather than from what was actually taken. The game renames on a
 * collision (it appends a number until the name is unique), so a counted name is not the
 * name the run gets, and the framework is left holding a name it did not expect.
 *
 * Measured in `runs/2026-11-04T09.37.53.447Z--33`: `getServerMaxRam: Invalid host: 'cloud-0'`
 * killed both hacking and share at session start, two seconds BEFORE cloud bought its 25
 * servers. The list and the purchases had drifted apart, and the two features read the gap.
 *
 * The other half of the problem is that a removed server leaves a hole: with `cloud-0`,
 * `cloud-1`, `cloud-2` and `cloud-1` gone, the count is 2 and the next name asked for is
 * `cloud-2` — which is already taken.
 *
 * `nextServerName` walks the counter until it finds a name not in use. That is the same rule
 * the game applies, applied before the call rather than after it, so the name the run asks
 * for is the name it gets.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { nextServerName } from "./cloud.ts";

test("an empty fleet starts at zero", () => {
    assert.equal(nextServerName([], "cloud-"), "cloud-0");
});

test("a contiguous fleet takes the next number", () => {
    // The ordinary case, and the one that was already working.
    assert.equal(nextServerName(["cloud-0", "cloud-1"], "cloud-"), "cloud-2");
});

test("a hole in the fleet is FILLED, because that name is free", () => {
    // THE DEFECT, and the correction to my own first reading of it. Counting the fleet gives
    // `cloud-2`, which is taken — so the old code collided. The next FREE name is `cloud-1`,
    // which the counting approach could never produce.
    //
    // Filling the hole rather than skipping past it is deliberate: the question is "what is
    // the next unused name", not "what is the highest number plus one". A free slot costs
    // nothing to reuse and keeps the fleet numbered densely.
    assert.equal(
        nextServerName(["cloud-0", "cloud-2"], "cloud-"),
        "cloud-1",
        "a counted name collided with a live server",
    );
});

test("a fleet whose lowest name is gone reuses it", () => {
    // The reported shape: `cloud-0` was the name that would not resolve. If the remaining
    // servers are `cloud-1` and `cloud-2`, counting to `cloud-2` is a collision, and
    // `cloud-0` is free — so that is the name, and the one the run will actually get.
    assert.equal(nextServerName(["cloud-1", "cloud-2"], "cloud-"), "cloud-0");
});

test("names outside the prefix do not affect the choice", () => {
    // The list is every cloud server, and the framework names them all with the prefix — but
    // a hand-purchased server from a previous session may not match. It must not consume a
    // number.
    assert.equal(nextServerName(["my-server", "cloud-0"], "cloud-"), "cloud-1");
});

test("a non-numeric suffix does not confuse the walk", () => {
    // `cloud-abc` is not one of ours to count. Treating it as a number would produce `NaN`.
    assert.equal(nextServerName(["cloud-abc", "cloud-0"], "cloud-"), "cloud-1");
});
