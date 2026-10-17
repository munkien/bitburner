/*
 * ============================================================================
 * CHOOSING A GANG
 * ============================================================================
 * The coin flip, and the faction it points at.
 *
 * The gang type is fixed when the gang is created and there is no API to change it, so
 * the choice is permanent for the BitNode. That makes two properties load-bearing:
 *
 *   it must be DETERMINISTIC   a choice recomputed per pass would alternate, and the run
 *                              would work toward a hacking gang one tick and a combat one
 *                              the next. The orchestrator self-restarts on every file
 *                              edit, so this is not hypothetical.
 *   it must actually DIVIDE    a seeded flip that always lands the same way is not a coin
 *                              toss, it is a constant with extra steps.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GANG_FACTIONS, GANG_KARMA, chosenGangKind, factionsOfKind, gangFactionFor, gangKindOf } from "./gangs.ts";
import type { FactionName } from "@ns";

test("the flip can produce either kind", () => {
    // A real coin toss. Both outcomes must be reachable, or the run always plays the same
    // gang and the choice is a constant with extra steps — which is what the previous
    // BitNode-seeded version had become, silently making every BitNode 2 run a hacking
    // gang.
    assert.equal(chosenGangKind(() => 0.0), "hacking");
    assert.equal(chosenGangKind(() => 0.99), "combat");
});

test("the flip divides an even spread of draws", () => {
    // Not a statistical test — a check that the threshold sits at the middle rather than
    // at an edge, where one kind would almost never be drawn.
    const hacking = Array.from({ length: 100 }, (_, i) => chosenGangKind(() => i / 100));
    assert.equal(hacking.filter(k => k === "hacking").length, 50);
    assert.equal(hacking.filter(k => k === "combat").length, 50);
});

test("the default draw is not fixed", () => {
    // With no argument the flip must use real randomness. A constant here would pin every
    // run to one kind, which is the bug this replaced.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(chosenGangKind());
    assert.equal(seen.size, 2, "the default flip produced only one kind across 200 draws");
});

test("every gang faction maps to exactly one kind", () => {
    for (const [faction, kind] of Object.entries(GANG_FACTIONS)) {
        assert.ok(kind === "hacking" || kind === "combat", `${faction} has kind ${kind}`);
        assert.equal(gangKindOf(faction as FactionName), kind, `${faction} disagrees with itself`);
    }
    assert.equal(gangKindOf("Sector-12" as FactionName), null, "a non-gang faction mapped to a kind");
});

test("the game's hacking gangs are the two backdoor factions", () => {
    // Fixed by the game: NiteSec and The Black Hand give hacking gangs, the rest combat.
    // If this ever changes, the routing in the feature is silently wrong.
    assert.deepEqual([...factionsOfKind("hacking")].sort(), ["NiteSec", "The Black Hand"].sort());
});

test("a faction already joined is preferred, so no further joining is needed", () => {
    const kind = "hacking" as const;
    const all = factionsOfKind(kind);
    const joined = [all[all.length - 1]!];

    const pick = gangFactionFor(kind, joined);
    assert.ok(pick !== null);
    assert.equal(pick.faction, joined[0], "a held faction was not chosen over an unheld one");
    assert.equal(pick.haveIt, true);
});

test("with nothing joined, the caller is told it must still join", () => {
    const pick = gangFactionFor("combat", []);
    assert.ok(pick !== null);
    assert.equal(pick.haveIt, false, "an unjoined faction reported as already held");
    assert.ok(factionsOfKind("combat").includes(pick.faction));
});

test("the karma a gang needs is the karma the run already farms", () => {
    // Not a coincidence and not a preference: the game's own
    // `GangConstants.GangKarmaRequirement` is -54000, and `GOAL_TARGETS.karma` targets the
    // same figure for the late-game factions. If they drift, the run farms karma to one
    // number while a gang waits for another.
    return import("./objective.ts").then(objectiveModule => {
        assert.equal(
            objectiveModule.GOAL_TARGETS.karma,
            GANG_KARMA,
            "the karma goal and the gang threshold disagree",
        );
    });
});
