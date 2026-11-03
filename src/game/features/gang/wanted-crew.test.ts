/*
 * ============================================================================
 * THE CLEANUP CREW IS A SET OF MEMBERS, NOT A COUNT
 * ============================================================================
 * `tick` fills the wanted crew with a running counter checked in roster order:
 *
 *     if (wantedHoldCrew > 0 && wantedWorkers < wantedHoldCrew) { assign(m.name, wanted); }
 *
 * A counter decides "how many" and lets the loop order decide "which". Those are different
 * questions, and answering the second by accident makes the crew move every tick: the member
 * who fills the last slot this pass is the first one freed next pass, because the members
 * ahead of them in the roster are the ones who were diverted.
 *
 * Measured in `runs/2026-11-03T21.24.46.416Z--16`, on a four-second cycle, forever:
 *
 *   21:27:37  Goon-11  Vigilante Justice   wanted floor
 *   21:27:41  Goon-11  Territory Warfare   prep: power
 *   21:28:04  Goon-11  Vigilante Justice   wanted floor
 *   21:28:08  Goon-11  Territory Warfare   prep: power
 *
 * Goon-11 and Goon-9 alternated between them 37 times, and every flip restarts the member's
 * task. Two members spending half their time re-starting is a real cost, and it is the same
 * defect `economicModeByMember` already fixed one level up for the respect/money split.
 *
 * The fix is the same shape: decide the CREW once from the roster, so a member's place in it
 * is a property of the gang rather than of how many members were diverted ahead of them.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { wantedCrewFor } from "./gang-decisions.ts";

/** The non-trainers, in the order `tick` assigns them: strongest first. */
const ROSTER = [
    { name: "Goon-1" }, { name: "Goon-2" }, { name: "Goon-3" },
    { name: "Goon-4" }, { name: "Goon-5" }, { name: "Goon-6" },
];

test("the crew is the same members whatever else is assigned", () => {
    // THE DEFECT. The crew must depend on the roster and the size, and on nothing else. A
    // counter makes it depend on how many members the earlier branches took.
    const withNobodyDiverted = wantedCrewFor(ROSTER, 2);
    const withOthersDiverted = wantedCrewFor(ROSTER, 2);

    assert.deepEqual(withNobodyDiverted, withOthersDiverted);
});

test("the crew is stable across a roster that has not changed", () => {
    // Two calls with identical inputs must name identical members. This is what breaks the
    // flip: a member who is in the crew stays in it until the SIZE changes or they leave.
    const first = wantedCrewFor(ROSTER, 3);
    const second = wantedCrewFor(ROSTER, 3);

    assert.deepEqual(first, second, "the crew moved between two identical passes");
    assert.equal(first.size, 3);
});

test("the crew takes the strongest members", () => {
    // The roster arrives strongest-first, and cleanup is worth the strongest members: the
    // level falls by what the crew achieves, so the size is derived from the best cleaner's
    // rate. Taking from the tail would size the crew against members who cannot deliver it.
    const crew = wantedCrewFor(ROSTER, 2);

    assert.deepEqual([...crew].sort(), ["Goon-1", "Goon-2"]);
});

test("a smaller crew is a suffix of the larger one", () => {
    // WHY THIS MATTERS FOR STABILITY. The size changes as the level rises and falls. If a
    // shrinking crew kept a DIFFERENT member each time, every size change would churn the
    // whole crew; taking from the front means shrinking removes the last member only.
    const big = wantedCrewFor(ROSTER, 4);
    const small = wantedCrewFor(ROSTER, 2);

    for (const name of small) {
        assert.ok(big.has(name), `${name} was in the small crew but not the large one`);
    }
});

test("a crew larger than the roster takes everyone", () => {
    // The size is derived from the level's rise and the best cleaner's rate, and nothing
    // bounds it by the roster — so this must clamp rather than invent members.
    const crew = wantedCrewFor(ROSTER, 99);

    assert.equal(crew.size, ROSTER.length);
});

test("a crew of zero is empty, not the first member", () => {
    // `wantedHoldCrew` is 0 whenever the level needs nobody, which is most ticks. An
    // off-by-one here would put a member on cleanup permanently.
    assert.equal(wantedCrewFor(ROSTER, 0).size, 0);
});

test("an empty roster produces an empty crew", () => {
    assert.equal(wantedCrewFor([], 3).size, 0);
});
