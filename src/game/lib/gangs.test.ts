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

test("the same node always flips the same way", () => {
    // The property the flag file exists to protect, and the one that would break worst:
    // an alternating flip contradicts a gang that already exists.
    for (let node = 1; node <= 40; node++) {
        const first = chosenGangKind(node);
        for (let i = 0; i < 25; i++) {
            assert.equal(chosenGangKind(node), first, `node ${node} flipped differently between calls`);
        }
    }
});

test("the flip divides the nodes rather than always landing one way", () => {
    const seen = new Set<string>();
    for (let node = 1; node <= 40; node++) seen.add(chosenGangKind(node));
    assert.equal(seen.size, 2, "the flip produced only one kind across 40 nodes");
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
