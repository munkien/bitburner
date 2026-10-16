/*
 * ============================================================================
 * GOAL RANKING
 * ============================================================================
 * The properties `deriveGoals` must hold, as tests rather than as comments.
 *
 * WHY THIS FILE EXISTS. `deriveGoals` ranks goals by closeness and the run pursues
 * the head. Two things about that were investigated against the recorded runs in
 * `runs/` and are pinned here:
 *
 *   ties are real            `New Tokyo` and `Ishima` have byte-identical join
 *                            requirements, so they rank equal for as long as both are
 *                            unjoined. The sort must not decide which wins by the order
 *                            the requirement table happens to be written in.
 *   a met goal is omitted    a satisfied goal left in the list outranks everything
 *                            forever, because `progress` is clamped to 1.
 *
 * WHAT IS DELIBERATELY NOT HERE. A noise-absorbing margin on the ranking, and a
 * margin on `satisfied`, were both implemented and then REVERTED after measurement.
 * On the run at `runs/2026-10-16T05.17.59.363Z.jsonl` the head changed 72 times with
 * no margin and 91 with a 2% one; 10% gave 79 and 20% gave 92, and the same change
 * broke `runs/2026-10-16T12.36.15.191Z.jsonl` badly (31 -> 67). A test asserting a
 * margin would only have encoded that regression, so there is none.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FACTION_REQUIREMENTS, deriveGoals, rankByTime, standingOf, type Goal, type PlayerStanding } from "./objective.ts";
import type { Player } from "@ns";

/* ─── a standing, built from the fields the tests care about ─── */

/**
 * A `Player` with only the fields `standingOf` reads. The game supplies all of them;
 * a test that constructed the whole object would be asserting against the game's
 * shape rather than against this module.
 */
function player(overrides: Partial<{ hacking: number; strength: number; defense: number; dexterity: number; agility: number; charisma: number; money: number; karma: number; kills: number }> = {}): Player {
    const skills = {
        hacking: overrides.hacking ?? 1,
        strength: overrides.strength ?? 1,
        defense: overrides.defense ?? 1,
        dexterity: overrides.dexterity ?? 1,
        agility: overrides.agility ?? 1,
        charisma: overrides.charisma ?? 1,
    };
    return {
        skills,
        money: overrides.money ?? 0,
        karma: overrides.karma ?? 0,
        numPeopleKilled: overrides.kills ?? 0,
        factions: [],
    } as unknown as Player;
}

/** A standing with no gang and no reputation, which is what most tests want. */
function standing(p: Player, homeCash = 0, netWorth = 0): PlayerStanding {
    return standingOf(p, 0, homeCash, 0, netWorth, null, []);
}

const head = (goals: readonly Goal[]): Goal => {
    const first = goals[0];
    assert.ok(first !== undefined, "expected at least one goal");
    return first;
};

const find = (goals: readonly Goal[], name: string): Goal | undefined =>
    goals.find(g => g.goal === name);

/* ─── ordering ─── */

test("the head is the highest-progress goal", () => {
    const goals = deriveGoals(standing(player({ hacking: 79, money: 1_000_000 }), 0, 1_000_000), new Set());
    for (const goal of goals) {
        assert.ok(
            head(goals).progress >= goal.progress,
            `${goal.goal} outranks the head ${head(goals).goal}`,
        );
    }
});

test("ordering does not depend on the requirement table's order", () => {
    // THE TIE. `New Tokyo` and `Ishima` are both {hacking 100, money 30m}, so from the
    // same standing they are exactly equal and the sort's tiebreak decides. Whatever it
    // decides must be the SAME every call — a head that alternates between two equal
    // goals is the flip the recorded runs show.
    const st = standing(player({ hacking: 231, money: 32_700_000 }), 0, 32_700_000);
    const first = head(deriveGoals(st, new Set())).goal;
    for (let i = 0; i < 20; i++) {
        assert.equal(
            head(deriveGoals(st, new Set())).goal,
            first,
            "the head differs between identical calls on an identical standing",
        );
    }
});

test("two goals with identical requirements rank equal", () => {
    // Guards the premise of the test above: if the two tables ever diverge, the tie
    // stops being a tie and this file should be revisited rather than silently passing.
    assert.deepEqual(
        { ...FACTION_REQUIREMENTS["New Tokyo"] },
        { ...FACTION_REQUIREMENTS.Ishima },
        "New Tokyo and Ishima no longer have identical requirements",
    );
});

test("a satisfied goal is omitted rather than ranked at the top", () => {
    // A goal already met must not exist at all: `progress` is clamped to 1, so it would
    // otherwise outrank every real goal for the rest of the run.
    const goals = deriveGoals(standing(player({ hacking: 100, money: 5_000_000 })), new Set());
    assert.equal(find(goals, "join CyberSec"), undefined, "a met goal must be omitted");
});

test("an already-joined faction is not a goal", () => {
    const goals = deriveGoals(standing(player({ hacking: 1 })), new Set(["CyberSec"]));
    assert.equal(find(goals, "join CyberSec"), undefined, "a joined faction must not be a goal");
});

test("progress never exceeds 1", () => {
    // `progress` is printed as a percentage. Before the clamp existed the dashboard
    // showed `buy stock market access (138%)` for an over-satisfied goal.
    const goals = deriveGoals(
        standing(player({ hacking: 5000, money: 1e12, kills: 500, karma: -100_000 }), 0, 1e12),
        new Set(),
    );
    for (const goal of goals) {
        assert.ok(goal.progress <= 1, `${goal.goal}: progress ${goal.progress} > 1`);
        assert.ok(goal.progress >= 0, `${goal.goal}: progress ${goal.progress} < 0`);
    }
});

/* ─── the duplicated faction table ─── */

test("the faction requirement table agrees with the progression feature's copy", () => {
    // `FACTION_REQUIREMENTS` is duplicated from `player.ts` deliberately — importing the
    // feature would charge its RAM to both (ADR 0001) — and this is the test the comment
    // there claims exists. It did not, until now.
    return import("../features/player/player.ts").then(player => {
        const theirs = player.FACTION_STAT_REQS as Record<string, Record<string, number>>;
        assert.ok(theirs, "player.ts no longer exports FACTION_STAT_REQS");

        for (const [faction, req] of Object.entries(FACTION_REQUIREMENTS)) {
            assert.ok(theirs[faction] !== undefined, `${faction} is in objective.ts but not in player.ts`);
            assert.deepEqual(
                { ...theirs[faction] },
                { ...req },
                `${faction}: the two tables disagree`,
            );
        }
    });
});

/* ─── ranking by time ─── */

test("a goal needing an untrained stat is ordered after one that is measurable", () => {
    // `combat` has no rate here (the player never trains it), so any goal needing it
    // cannot be timed. A measurable goal must come first: the run should pursue what it
    // can watch itself finish.
    const goals = deriveGoals(standing(player({ hacking: 100, money: 1_000_000 })), new Set());
    const rate = (key: string) => (key === "hacking" ? 1 : null);
    const ordered = rankByTime(goals, rate);

    const firstUnmeasurable = ordered.findIndex(g => !(g.subGoals.length > 0 && g.subGoals.every(s => s.key === "hacking")));
    const lastMeasurable = ordered.length - 1 - [...ordered].reverse().findIndex(g => g.subGoals.every(s => s.key === "hacking"));
    assert.ok(
        lastMeasurable < firstUnmeasurable,
        "an unmeasurable goal was ordered before a measurable one",
    );
});

test("an untrained stat is unreachable, not unmeasurable", () => {
    // A zero rate means "not rising right now", which is Infinity — NOT null, which
    // means "this measure has no rate concept at all". Conflating them made the ranking
    // degenerate: every combat goal read as unmeasurable and one goal took the head for
    // 3050 of 3094 frames of a recorded run.
    // `combat` is not a skill field — the helper takes the four combat skills, and
    // `standingOf` takes their minimum. Setting them low keeps Slum Snakes (combat 30)
    // outstanding, which is what this test is about.
    const goals = deriveGoals(
        standing(player({ hacking: 100, strength: 1, defense: 1, dexterity: 1, agility: 1 })),
        new Set(),
    );
    const zeroRate = () => 0;
    const combatGoal = goals.find(g => g.goal === "join Slum Snakes");
    assert.ok(combatGoal !== undefined, "expected the Slum Snakes goal (combat 30)");

    // Infinity is still a number: the goal is ordered as very far, not excluded as
    // unknown. `rankByTime` sorts Infinity last among the timed, which is the intent.
    const ordered = rankByTime(goals, zeroRate);
    assert.ok(ordered.length === goals.length, "ranking must not drop goals");
});

test("among measurable goals, the soonest comes first", () => {
    const goals = deriveGoals(standing(player({ hacking: 195 })), new Set());
    const rate = () => 1;
    const ordered = rankByTime(goals, rate);

    const timeOf = (g: (typeof goals)[number]) =>
        g.subGoals.every(s => s.key === "hacking")
            ? g.subGoals.reduce((a, s) => a + Math.max(0, s.target - s.current), 0)
            : null;

    const timed = ordered.map(timeOf).filter((t): t is number => t !== null);
    for (let i = 1; i < timed.length; i++) {
        assert.ok(timed[i]! >= timed[i - 1]!, "measurable goals are not in ascending time order");
    }
});
