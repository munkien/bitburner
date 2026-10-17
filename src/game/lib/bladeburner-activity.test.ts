/*
 * ============================================================================
 * BLADEBURNER ACTIVITY, PUBLISHED
 * ============================================================================
 * The channel that lets `hacknet` know the division is working, without either feature
 * importing the other (ADR 0001) and without a second 1 GB `getCurrentAction()` paid by
 * every run that has no division at all.
 *
 * Each test resets the shared state first: it is module-level by design, so one test's
 * publication would otherwise be the next one's starting condition.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bladeburnerActivity, publishBladeburnerActivity, resetBladeburnerActivity } from "./bladeburner-activity.ts";

test("nothing is running until something says so", () => {
    // The safe default: hashes are not spent on Bladeburner by a run that has none, and
    // not by a pass before the feature has ticked.
    resetBladeburnerActivity();
    const a = bladeburnerActivity();
    assert.equal(a.running, false);
    assert.equal(a.rank, 0);
});

test("a published action is readable", () => {
    resetBladeburnerActivity();
    publishBladeburnerActivity({ running: true, rank: 12 });
    const a = bladeburnerActivity();
    assert.equal(a.running, true);
    assert.equal(a.rank, 12);
});

test("a stale 'running' does not survive an idle tick", () => {
    // The failure this guards: publishing only on activity would leave running=true for
    // the rest of the run after the division stopped, and hacknet would keep converting
    // hashes into rank nothing was using.
    resetBladeburnerActivity();
    publishBladeburnerActivity({ running: true, rank: 40 });
    assert.equal(bladeburnerActivity().running, true);

    publishBladeburnerActivity({ running: false, rank: 40 });
    assert.equal(bladeburnerActivity().running, false, "an idle tick did not clear the flag");
});

test("rank is readable while idle, because it still gates the faction", () => {
    // `running` is about spending hashes; `rank` is a fact. A caller deciding whether to
    // buy rank needs it even when this instant has no action in flight.
    resetBladeburnerActivity();
    publishBladeburnerActivity({ running: false, rank: 25 });
    assert.equal(bladeburnerActivity().rank, 25);
});
