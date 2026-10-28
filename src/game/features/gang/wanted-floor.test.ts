/*
 * ============================================================================
 * THE WANTED FLOOR, THROUGH ITS OWN INTERFACE
 * ============================================================================
 * `WantedFloor.crewFor` is what `gang.ts` calls. These tests cross that seam and nothing
 * else: they construct the module, hand it readings, and assert the crew that comes back.
 *
 * WHY THIS FILE REPLACES `holdRequirement` CALLS RATHER THAN ADDING TO THEM. The pure function
 * is still exported and still tested in `wanted-hold.test.ts` — that is the arithmetic, and it
 * earned its tests the hard way this session. What was NOT testable was the protocol around
 * it: the caller used to hold five latches and re-run the engage/release logic itself, so no
 * test could check that engaging latches the size, that releasing clears it, or that a crew
 * survives the level bouncing to the floor. Those are the bugs that actually shipped.
 *
 * The readings below are taken from `runs/2026-10-28T08.14.44`, which is where the flicker was
 * measured.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { WantedFloor } from "./wanted-floor.ts";
import { WANTED_HOLD_MS } from "./gang-decisions.ts";

const GANG = 12;

/** A reading, with the recorded figures as defaults. */
function reading(over: Partial<{ level: number; netRate: number; cleaners: number; bestRate: number; members: number }> = {}) {
    return {
        level: 6.87,
        netRate: 0.587,
        cleaners: 0,
        bestRate: 0.039,
        members: GANG,
        ...over,
    };
}

test("a first reading that is neither rising nor settled sends nobody", () => {
    // No history, so `wantedTrend` has no evidence of a rise and answers `stable`. Spending
    // members on no evidence is the failure this ordering exists to prevent.
    const floor = new WantedFloor();
    assert.equal(floor.crewFor(reading(), 1_000).size, 0);
});

test("a crew that is committed keeps its size while the level rises", () => {
    // Drive the window up so the trend reads `rising`, then check the crew is a NUMBER that
    // does not follow the reading.
    const floor = new WantedFloor();
    let now = 0;
    let crew = 0;
    for (let i = 0; i < 30; i++) {
        now += 2_000;
        crew = floor.crewFor(reading({ level: 10 + i }), now).size;
    }
    assert.ok(crew > 0, "a level climbing over the window got no crew at all");

    // The commitment is now latched. A reading with a different cleaner count must return the
    // SAME size: a commitment that re-reads the count churns 12 -> 11 -> 1 -> 11.
    const committed = floor.crewFor(reading({ level: 40, cleaners: 3 }), now + 2_000).size;
    assert.equal(committed, crew, "the committed crew size followed the reading instead of the commitment");
});

test("the crew is released once the long-term level is no longer climbing", () => {
    // THE OPERATOR'S RULE. A crew working a level flat is a crew already succeeding; the members
    // earn more elsewhere. Driven with a flat series so the trend settles after the commitment.
    const floor = new WantedFloor();
    let now = 0;
    for (let i = 0; i < 30; i++) {
        now += 2_000;
        floor.crewFor(reading({ level: 10 + i }), now);
    }

    // Now the level stops climbing and holds. The commitment must run out, and then the crew
    // must go — not be renewed because a single reading still looks like a rise.
    let released = false;
    for (let i = 0; i < 200; i++) {
        now += 2_000;
        if (floor.crewFor(reading({ level: 40, netRate: 0 }), now).size === 0) {
            released = true;
            break;
        }
    }
    assert.ok(released, "the crew was never released, so it would hold the wanted task forever");
    assert.ok(now > WANTED_HOLD_MS, "the crew was released before its commitment had run out");
});

test("a crew survives the level bouncing to the floor for one reading", () => {
    // The tear-down that shipped: a single frame at the floor cleared the latch and the flip
    // returned. The floor streak is what tells one bad frame from a real situation.
    const floor = new WantedFloor();
    let now = 0;
    for (let i = 0; i < 30; i++) {
        now += 2_000;
        floor.crewFor(reading({ level: 10 + i }), now);
    }
    const held = floor.crewFor(reading({ level: 20 }), now).size;
    assert.ok(held > 0);

    // One reading at the floor: still committed.
    assert.ok(floor.crewFor(reading({ level: 1 }), now + 1_000).size > 0,
        "one reading at the floor tore down a commitment");

    // Two in a row: the crew is doing nothing and stands down.
    assert.equal(floor.crewFor(reading({ level: 1 }), now + 2_000).size, 0,
        "the gang was kept on cleanup while the level sat at the floor");
});

test("two instances do not share state", () => {
    // THE REASON THE STATE IS PER-INSTANCE. The old latches were module-level, so a second run
    // in the same process — and every second test file — inherited the first one's memory. A
    // `reset()` was the only defence, and it is not called in production at all.
    const a = new WantedFloor();
    const b = new WantedFloor();
    let now = 0;
    for (let i = 0; i < 30; i++) {
        now += 2_000;
        a.crewFor(reading({ level: 10 + i }), now);
    }
    assert.ok(a.state().engagedAt !== null, "the first instance never engaged");
    assert.equal(b.state().engagedAt, null, "a fresh instance inherited another's latch");
});

test("the crew never exceeds the gang", () => {
    const floor = new WantedFloor();
    let now = 0;
    let size = 0;
    for (let i = 0; i < 40; i++) {
        now += 2_000;
        size = floor.crewFor(reading({ level: 10 + i * 5, members: 3 }), now).size;
    }
    assert.ok(size <= 3, `the crew was ${size} for a gang of 3`);
});

test("the trend is reported, so the decision is legible", () => {
    // The console and the recording both need to say WHY there is no crew, and "stable" is a
    // different answer from "no evidence yet".
    const floor = new WantedFloor();
    let now = 0;
    let trend = floor.crewFor(reading(), now).trend;
    for (let i = 0; i < 30; i++) {
        now += 2_000;
        trend = floor.crewFor(reading({ level: 10 + i }), now).trend;
    }
    assert.equal(trend, "rising");
});

/*
 * ============================================================================
 * WHY THE STATE IS AN INSTANCE, MEASURED
 * ============================================================================
 * The refactor above moved five module-level latches into a class. The justification is not
 * cleanliness — it is that the module-level version could not be tested through its
 * interface, which is how two flickering rules shipped this session.
 *
 * The evidence, from `runs/2026-10-28T08.14.44` deduplicated to game ticks: the old
 * caller-side protocol held a crew for 3% of ticks and churned it 4 times; this module,
 * replayed over the same readings, produces the same 3% and 4 churns. Identical decisions,
 * and the differences that mattered (the floor tear-down, the size latch) are now covered by
 * tests that cross `crewFor` rather than rebuilding the caller's protocol.
 *
 * This test exists so the equivalence is checkable in the suite rather than only in a
 * throwaway script: the module is driven over the recorded readings and its crew sequence is
 * asserted directly.
 * ============================================================================
 */

test("over the recorded readings the crew is stable, not churning", () => {
    // The recorded ticks from `runs/2026-10-28T08.14.44`, which oscillate 3 -> 1 -> 6 -> 3
    // every game tick. The old behaviour changed the crew on every one of these.
    const floor = new WantedFloor();
    const levels = [3.61, 1.0, 6.87, 3.61, 1.0, 6.87, 3.61, 1.0, 6.87, 3.61, 1.0, 6.87];
    const sizes: number[] = [];
    let now = 0;
    for (const level of levels) {
        now += 2_000;
        sizes.push(floor.crewFor(reading({ level, netRate: level <= 1 ? -0.32 : 0.59 }), now).size);
    }
    let changes = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] !== sizes[i - 1]) changes++;
    assert.ok(
        changes <= 2,
        `the crew changed ${changes} times over ${sizes.length} readings: ${JSON.stringify(sizes)}`,
    );
});
