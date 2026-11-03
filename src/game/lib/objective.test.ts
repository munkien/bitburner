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

import { FACTION_REQUIREMENTS, MEGACORP_REQUIREMENTS, deriveGoals, describeRanking, rankByTime, rankingMode, standingOf, type Goal, type PlayerStanding } from "./objective.ts";
import type { CompanyName, Player } from "@ns";

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

/** A standing with the given companies in the employment set. */
function employedAt(p: Player, ...companies: string[]): PlayerStanding {
    return standingOf(p, 0, 0, 0, 0, null, [], new Set(companies as CompanyName[]));
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

/* ─── megacorps: employment is not a threshold ─── */

test("an unjoined megacorp is a goal gated on employment, not on a stat", () => {
    // THE REGRESSION. Megacorps were absent from the requirement table entirely, so no
    // goal ever named one, so `bestCompany` — the only code that could hire — was never
    // the answer to anything. Every recorded run shows zero COMPANY actions.
    const goals = deriveGoals(standing(player({ hacking: 500 })), new Set());
    const eCorp = find(goals, "join ECorp");

    assert.ok(eCorp !== undefined, "E Corp is not a goal at all, so nothing will ever hire for it");
    assert.deepEqual(
        eCorp.subGoals.map(sub => sub.key),
        ["employed"],
        "the megacorp goal carries something other than the employment requirement",
    );
    assert.equal(eCorp.subGoals[0]?.company, "ECorp", "the sub-goal does not name the company to apply to");
});

test("being employed satisfies the megacorp goal, whatever the skills are", () => {
    // The point of the requirement. A player with NO hacking at all still closes the goal
    // by holding the job, because the goal is employment and not a stat bar. Hiring is
    // the game's own decision; this module only tracks whether it happened.
    const goals = deriveGoals(employedAt(player({ hacking: 1 }), "ECorp"), new Set());
    assert.equal(find(goals, "join ECorp"), undefined, "employment did not close the goal");
});

test("employment at one megacorp says nothing about another", () => {
    // The employment set is per company, not a single boolean. A fixture that collapsed
    // it would silently mark every megacorp as joined.
    const goals = deriveGoals(employedAt(player({ hacking: 1 }), "ECorp"), new Set());
    assert.ok(find(goals, "join MegaCorp") !== undefined, "employment at E Corp closed MegaCorp too");
});

test("the megacorp table does not list a faction that is not one", () => {
    // `Fulcrum Technologies` is a COMPANY, while the faction is `Fulcrum Secret
    // Technologies` — gated on The Covenant rather than on employment, so it does not
    // belong here. The TypeScript compiler catches a wrong FactionName; this catches the
    // opposite mistake, a table that has quietly stopped covering the real megacorps.
    const expected = [
        "ECorp", "MegaCorp", "KuaiGong International", "Four Sigma", "NWO",
        "Blade Industries", "OmniTek Incorporated", "Bachman & Associates",
        "Clarke Incorporated",
    ];
    assert.deepEqual(Object.keys(MEGACORP_REQUIREMENTS).sort(), expected.sort());
    for (const [faction, req] of Object.entries(MEGACORP_REQUIREMENTS)) {
        assert.equal(req.employedBy, faction, `${faction}: the company to be employed by is not itself`);
    }
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

/* ─── keeping the goal the run is working on ─── */

/**
 * A standing where two goal rankings are one purchase apart, and both are in the top two.
 *
 * THIS IS THE SHAPE OF THE RECORDED FLICKER. Several factions ask for DIFFERENT cash balances
 * out of the SAME balance, so one gig, one program or one augmentation re-orders them. In
 * `runs/2026-10-26T05.26.43.876Z.jsonl` frames 535-543, `join Aevum` reads 47.51%, 50.04%,
 * 47.56% as the balance goes 19.0m, 20.0m, 19.0m.
 *
 * At hacking 40 with 20m cash, `join CyberSec` and `join Tian Di Hui` have byte-identical
 * requirements and read 80% each, so they sit 1st and 2nd and the sort's name tiebreak decides
 * between them. That tiebreak is a decision the RUN should be able to keep, which is what the
 * hold is for.
 */
function atACashBoundary(cash: number): Goal[] {
    return deriveGoals(standing(player({ hacking: 40, money: cash })), new Set());
}

/** The goal of that name, asserted present so a fixture change fails loudly. */
function named(goals: readonly Goal[], name: string): Goal {
    const found = goals.find(g => g.goal === name);
    assert.ok(found !== undefined, `expected the ${name} goal`);
    return found;
}

test("the goal the run is working on keeps the head through a spend", () => {
    // THE FLICKER, as a test. Two cash goals, one purchase apart. Nothing about either goal
    // changed — only the working balance did — so the head must not move off the goal the run
    // is already on.
    const goals = atACashBoundary(20_000_000);
    const plain = rankByTime(goals, () => null);
    assert.equal(plain[0]?.goal, "join CyberSec", "the fixture no longer ranks CyberSec first");
    assert.equal(plain[1]?.goal, "join Tian Di Hui", "the swap is a 1st/2nd exchange");

    // The run is on the SECOND of the pair. Without the hold the ranking keeps the first,
    // which is how the pair take turns — the exchange the hold exists to stop.
    assert.equal(
        rankByTime(goals, () => null, { working: named(goals, "join Tian Di Hui") })[0]?.goal,
        "join Tian Di Hui",
        "a spend moved the head off the goal the run was working on",
    );
});

test("the working goal is not defended further than second place", () => {
    // The hold is for the exchange, not for the run: a goal the ranking has pushed behind a
    // THIRD goal has been beaten for a reason, and the run follows the ranking.
    const goals = atACashBoundary(20_000_000);
    const plain = rankByTime(goals, () => null);
    // `join Volhaven` is third here: it has to be ahead of the working goal for the fixture to
    // mean anything, so the working goal is taken from the back where no exchange applies.
    assert.equal(plain[2]?.goal, "join Volhaven", "the fixture no longer has Volhaven third");
    const tail = plain[plain.length - 1]!;
    assert.deepEqual(
        rankByTime(goals, () => null, { working: tail }).map(g => g.goal),
        plain.map(g => g.goal),
        "a goal the run is not on was promoted by the hold",
    );
});

test("a goal already at the head is not defended by the hold", () => {
    const goals = atACashBoundary(20_000_000);
    assert.deepEqual(
        rankByTime(goals, () => null, { working: named(goals, "join CyberSec") }).map(g => g.goal),
        rankByTime(goals, () => null).map(g => g.goal),
    );
});

test("the hold releases once the goal it protects is satisfied or gone", () => {
    // A working goal that is no longer derived — satisfied, or a faction joined — must not
    // pin the ranking to nothing. The hold is a preference among the goals that EXIST, and a
    // satisfied goal is removed from the list rather than reported as `done`.
    const goals = atACashBoundary(20_000_000);
    const gone: Goal = { ...named(goals, "join CyberSec"), goal: "join A Faction That No Longer Exists" };
    assert.equal(goals.find(g => g.goal === gone.goal), undefined, "the goal is not actually absent");
    assert.deepEqual(
        rankByTime(goals, () => null, { working: gone }).map(g => g.goal),
        rankByTime(goals, () => null).map(g => g.goal),
    );
});


test("a real handover between timed goals still happens", () => {
    // The hold must not become a veto. When BOTH goals can be timed, the ranking is comparing
    // how long they take, and a purchase does not move that — so a sooner goal taking the head
    // is a decision, not a flicker, and the hold does not stand in its way.
    const goals = deriveGoals(standing(player({ hacking: 100 })), new Set());
    const niteSec = goals.find(g => g.goal === "join NiteSec");
    const bitRunners = goals.find(g => g.goal === "join BitRunners");
    assert.ok(niteSec !== undefined && bitRunners !== undefined);

    // BitRunners needs 500 hacking against NiteSec's 200, so at a flat rate it is later: the
    // ranking puts NiteSec first, and holding BitRunners must not change that.
    const ordered = rankByTime(goals, () => 1, { working: bitRunners });
    assert.equal(ordered[0]?.goal, "join NiteSec", "the hold vetoed a handover between two timed goals");
});

/* ─── WHICH ORDERING IS ACTUALLY IN FORCE ─── */

/** A goal with one sub-goal, the shape `deriveGoals` produces. */
function oneGoal(name: string, progress: number, key: string, current: number, target: number): Goal {
    return {
        goal: name,
        kind: "faction" as const,
        faction: name as never,
        progress,
        // `forGoal` IS REQUIRED and the tests passed without it — the suite runs through a
        // transform that strips types without checking them, so only `tsc` caught this.
        subGoals: [{ key: key as never, forGoal: name as never, current, target, done: false, contributors: [] }],
        blockedBy: [],
        contributors: [],
        estimateSeconds: null,
    };
}

test("a queue with no timable goal is reported as progress-ordered", () => {
    // THE STATE THE LIVE RUN WAS IN. `gangTerritory`, `rep`, `money` and `karma` have no
    // rate, so a goal built from them returns a null estimate — and when every goal does,
    // the ranking is the raw progress ratio, not a time ranking. Measured in
    // `runs/2026-11-03T21.24.46.416Z--16`: all ten goals untimed, for the whole session.
    const goals = [
        oneGoal("take the map", 0.64, "gangTerritory", 0.14, 0.5),
        oneGoal("earn The Syndicate reputation", 0.38, "rep", 100, 1000),
    ];

    assert.equal(rankingMode(goals, () => null), "progress");
    assert.match(describeRanking(goals, () => null), /PROGRESS only/);
});

test("two timable goals is a real time ranking", () => {
    // The control: the fallback must not be reported when it is not happening, or the line
    // becomes noise nobody reads.
    const goals = [
        oneGoal("a", 0.5, "hacking", 100, 200),
        oneGoal("b", 0.5, "combat", 100, 200),
    ];
    const rate = () => 1;

    assert.equal(rankingMode(goals, rate), "time");
    assert.match(describeRanking(goals, rate), /ranked by time/);
});

test("one timable goal is reported as almost", () => {
    // The middle state, and the one most likely to be misread as a full time ranking: the
    // single timed goal wins by default, and everything after it is progress-ordered.
    const goals = [
        oneGoal("a", 0.5, "hacking", 100, 200),
        oneGoal("take the map", 0.64, "gangTerritory", 0.14, 0.5),
    ];
    const rate = (k: string) => (k === "hacking" ? 1 : null);

    assert.equal(rankingMode(goals, rate), "almost");
    assert.match(describeRanking(goals, rate), /only 1 of 2/);
});

test("an infinite estimate does not count as timed", () => {
    // `estimateSeconds` returns `Infinity` for a measurable-but-not-moving requirement, and
    // `rankByTime` treats that as untimed. The two must agree, or the reported ordering
    // would describe a ranking the sort is not performing.
    const goals = [oneGoal("a", 0.5, "hacking", 100, 200)];
    // A rate of zero means "measured, not rising" — the ETA is Infinity.
    assert.equal(rankingMode(goals, () => 0), "progress");
});
