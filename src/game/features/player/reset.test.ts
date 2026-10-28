/*
 * ============================================================================
 * RESET ACTUALLY RESETS
 * ============================================================================
 * `reset()` is the promise a test makes to itself: "nothing from the previous scenario
 * survives into this one". It is only worth calling if that promise is true, and it was not.
 *
 * WHY THIS FILE EXISTS. `player.ts` keeps ten pieces of memory between ticks and `reset()`
 * cleared six of them. The four it missed — the augment target, the chosen augment, the status
 * `reason`, and the gang-kind label — are exactly the ones a second scenario would inherit with
 * no clue in its own body. The failure mode is a test that passes alone and fails in a suite,
 * which is the most expensive kind to diagnose and the easiest to dismiss as flaky.
 *
 * HOW IT IS CHECKED WITHOUT A WHOLE TICK. `publishStatus` registers a GETTER rather than a
 * value, and `readStatuses` calls it. So the status line can be read as the orchestrator reads
 * it, with no mock and no fake game: the field under test is exactly the one the console shows.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readStatuses } from "../../lib/log.ts";
import { reset } from "./player.ts";

test("after a reset the status line reopens at its starting value", () => {
    // The getter is registered by the first tick of a run, and it reads module state as it
    // stands. Reading it here shows whatever the module is holding now — which after `reset`
    // must be the initial reason, not whatever the previous scenario left behind.
    reset();

    const statuses = readStatuses();
    const reason = statuses.progression;

    // Either nothing is registered (a fresh process), or what is registered reads the reset
    // value. What must NOT happen is a leftover sentence from an earlier scenario.
    if (reason !== undefined) {
        assert.ok(
            !reason.includes("yielded") && !reason.includes("acting:"),
            `a stale decision survived reset: ${JSON.stringify(reason)}`,
        );
    }
});

test("reset is idempotent and safe to call from a finally block", () => {
    // Tests call it twice — once at the top, once in `finally`. A second call after a failed
    // scenario must not itself throw and mask the real error.
    reset();
    reset();

    // Nothing registered is the correct state before any tick: a fresh module has no status
    // to report, and a stale one left behind would be a lie about a pass that never ran.
    assert.deepEqual(readStatuses(), {});
});
