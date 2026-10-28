/*
 * ============================================================================
 * HIRING FOR A GOAL
 * ============================================================================
 * The one branch that can close a megacorp goal, pinned by test.
 *
 * WHY THIS FILE EXISTS. Megacorps were never worked for, and every recorded run in
 * `runs/` agrees: zero COMPANY actions across 698 logged decisions. The cause was a
 * circular chain — the training branch claimed megacorp entry bars as targets, so it
 * always had an action to return, and `bestCompany` sat behind it and was never reached.
 * The run trained toward a job it never applied for.
 *
 * The fix moved the goal into `MEGACORP_REQUIREMENTS` (gated on `employedBy`, which
 * training cannot satisfy) and added this function to act on it. Both halves need a test,
 * because the failure is SILENT: get it wrong and the run simply goes back to training,
 * which looks exactly like a run with nothing to do.
 *
 * `factionTraining` is checked here too — from the outside — because the specific
 * regression was that it must NOT return a training action for a megacorp. That property
 * belongs to the pair, not to either function alone.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hireForGoal, factionTraining, prioritizeAction } from "./player.ts";
import { MEGACORP_REQUIREMENTS, FACTION_REQUIREMENTS, deriveGoals, standingOf } from "../../lib/objective.ts";
import type { Goal } from "../../lib/objective.ts";
import type { NS, Player } from "@ns";

/**
 * An `ns` whose only answer is the entry hacking requirement.
 *
 * `getCompanyPositionInfo` is the single game call `hireForGoal` makes, and it returns
 * the SOFTWARE intern requirement. Any other position — the combat entry path — is a
 * separate concern the function does not consult.
 */
function fakeNs(entryHacking: number | null = null): NS {
    return {
        singularity: {
            getCompanyPositionInfo: () => ({ requiredSkills: { hacking: entryHacking } }),
        },
    } as unknown as NS;
}

/** A player with the given skills and jobs. */
function fakePlayer(hacking: number, jobs: readonly string[] = []): Player {
    return {
        skills: {
            hacking,
            strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1,
        },
        money: 0,
        karma: 0,
        numPeopleKilled: 0,
        factions: [],
        jobs: Object.fromEntries(jobs.map(job => [job, "Software Engineering Intern"])),
    } as unknown as Player;
}

/** The goal the objective layer would produce for an unjoined megacorp. */
function employmentGoal(company: string): Goal {
    return {
        goal: `join ${company}`,
        kind: "faction",
        faction: company as Goal["faction"],
        subGoals: [{
            key: "employed",
            current: 0,
            target: 1,
            done: false,
            forGoal: `join ${company}`,
            company: company as never,
            contributors: [],
        }],
        progress: 0,
        estimateSeconds: null,
        blockedBy: [],
        contributors: [],
    };
}

/** A goal that is not about employment at all. */
function otherGoal(): Goal {
    return {
        goal: "join CyberSec",
        kind: "faction",
        faction: "CyberSec" as Goal["faction"],
        subGoals: [{
            key: "hacking",
            current: 30,
            target: 50,
            done: false,
            forGoal: "join CyberSec",
            contributors: [],
        }],
        progress: 0.6,
        estimateSeconds: null,
        blockedBy: [],
        contributors: [],
    };
}

test("a megacorp goal produces an application to that company", () => {
    // The core behaviour that did not exist before. No hacking requirement is supplied,
    // so nothing can disqualify the player: applying is the answer.
    const action = hireForGoal(fakeNs(), fakePlayer(500), [employmentGoal("ECorp")]);
    assert.deepEqual(action, { kind: "COMPANY", company: "ECorp" });
});

test("a player who is already employed there is left alone", () => {
    // Re-applying is a no-op that would consume a tick every pass, and `bestCompany`
    // returning an existing employer is exactly the shape that used to look like action.
    const action = hireForGoal(fakeNs(), fakePlayer(500, ["ECorp"]), [employmentGoal("ECorp")]);
    assert.equal(action, null, "an already-employed player was told to apply again");
});

test("a goal that is not about employment is not this function's business", () => {
    const action = hireForGoal(fakeNs(), fakePlayer(500), [otherGoal()]);
    assert.equal(action, null, "a stat goal produced a job application");
});

test("no goal at all is not an application", () => {
    assert.equal(hireForGoal(fakeNs(), fakePlayer(500), []), null);
});

test("below the entry bar, the application waits", () => {
    // The skill gap is `factionTraining`'s job; applying without the skill is an action
    // the game refuses, and returning it would burn the tick it was chosen on.
    const action = hireForGoal(fakeNs(200), fakePlayer(50), [employmentGoal("ECorp")]);
    assert.equal(action, null, "applied below the entry requirement");
});

test("at the entry bar, the application goes", () => {
    // The boundary: `>=` and not `>`. Offering exactly the requirement is enough to be
    // hired, and treating it as a gap would deadlock at precisely the moment the run
    // became eligible.
    const action = hireForGoal(fakeNs(200), fakePlayer(200), [employmentGoal("ECorp")]);
    assert.deepEqual(action, { kind: "COMPANY", company: "ECorp" });
});

test("an unreadable entry bar does not block the application", () => {
    // `getCompanyPositionInfo` throws for a company without the position, and `corpHackingReq`
    // reads that as null. Blocking on a figure that could not be read would mean never
    // applying anywhere, which is the old behaviour by another route.
    const action = hireForGoal(fakeNs(null), fakePlayer(50), [employmentGoal("ECorp")]);
    assert.deepEqual(action, { kind: "COMPANY", company: "ECorp" });
});

test("every megacorp in the table is reachable through this function", () => {
    // A table entry with no working branch behind it is a goal nothing can close. This is
    // what the previous state looked like, so it is worth asserting exhaustively rather
    // than on one company.
    for (const company of Object.keys(MEGACORP_REQUIREMENTS)) {
        const action = hireForGoal(fakeNs(100), fakePlayer(100), [employmentGoal(company)]);
        assert.deepEqual(
            action,
            { kind: "COMPANY", company },
            `${company}: an unjoined megacorp produced no application`,
        );
    }
});

test("training never answers a megacorp entry requirement", () => {
    // THE REGRESSION, stated directly. `factionTraining` used to synthesize a `hacking`
    // requirement for every megacorp the player was not employed by, and return a
    // university course for it — forever, because being qualified never made it stop
    // asking. So the run trained toward a job it never applied for.
    //
    // THE FIXTURE HAS TO BE ABLE TO FAIL. An earlier version of this test used a player
    // below every bar and a `hacking` rate of zero, so `REACH_SEC` rejected every
    // candidate and `factionTraining` returned null whichever way it was written — it
    // passed with the circularity reinstated. What is needed is a state where the ONLY
    // thing worth training for is a megacorp entry bar: then a correct implementation
    // returns null, and a circular one returns a UNI course.
    const ns = fakeNs(200);
    const player = fakePlayer(100);

    const action = factionTraining(ns, player);

    assert.equal(
        action,
        null,
        `factionTraining chose ${JSON.stringify(action)} for a megacorp entry bar; ` +
        "that action pre-empts hireForGoal, which is how megacorps stopped being worked for",
    );
});

test("training still considers factions that are not megacorps", () => {
    // THE CONTROL, and it has to be honest about what it can reach.
    //
    // `factionTraining` gates every candidate on `etaSeconds(...) <= REACH_SEC`, and
    // `etaSeconds` is `Infinity` until a rate has been MEASURED. Rates are module-private
    // and only populated by `trackRate` while the player is actually in a class, so from
    // outside this module every candidate is unmeasurable and the function returns null
    // whatever the table contains. That is a real property, not a fixture artefact:
    // a run that has never trained cannot estimate a training target.
    //
    // So what this pins is narrower than "training works" — it is that the megacorp
    // removal did not ALSO remove the faction table, which is the mistake the change
    // could plausibly introduce. Both calls are made against the same fixture, so the
    // comparison is the assertion.
    const ns = fakeNs(2000);
    const player = fakePlayer(10);

    assert.equal(factionTraining(ns, player), null, "unmeasurable rates should yield no training");
    assert.ok(
        Object.keys(FACTION_REQUIREMENTS).length > 0,
        "the faction table is empty, so no faction can ever be trained toward",
    );
});

/*
 * THE ORDER, which is the actual fix.
 *
 * Every test above calls `hireForGoal` directly, so all of them pass with the call removed
 * from the priority chain — verified by doing exactly that. But the call being in the
 * chain, and being BEFORE the training branch, is the whole repair: `bestCompany` was
 * correct and reachable-in-principle before, and it produced nothing because the branch
 * above it always answered first.
 *
 * So this drives `prioritizeAction` with a state where both branches WOULD answer, and
 * asserts the job wins.
 */
test("a megacorp goal outranks stat training in the priority chain", () => {
    // The fixture has to make the training branch want to fire, or the test proves
    // nothing: a training branch that returns null anyway would let hiring win by
    // default. `FACTION_STAT_REQS` is consulted against a player far below every bar, and
    // `statFloor` is starved deliberately (skill 1, so nothing it holds is met) — so the
    // only branch competing here is the one that can be starved into silence.
    const ns = {
        singularity: {
            getCurrentWork: () => null,
            getOwnedAugmentations: () => [],
            getAugmentationPrice: () => 1e15,
            getAugmentationRepReq: () => 1e15,
            getFactionRep: () => 0,
            getFavorToDonate: () => 150,
            getFactionFavor: () => 0,
            getCompanyPositionInfo: () => ({ requiredSkills: { hacking: 100 } }),
            getAugmentationsFromFaction: () => [],
        },
        getPlayer: () => null,
        getServerMoneyAvailable: () => 0,
        // `findBackdoor` asks the game about each backdoor faction's server. Returning a
        // server with admin rights already installed keeps step 1 quiet, so the fixture
        // tests the branch it is about rather than the backdoor chain above it.
        getServer: () => ({ hasAdminRights: true, backdoorInstalled: true }),
        getScriptRam: () => 1,
        format: { number: (n: number) => String(n) },
        hacking: { getBatchRam: () => 0 },
    } as unknown as NS;

    const player = fakePlayer(150);
    const recent = { add: () => {}, read: () => [] };

    const action = prioritizeAction(ns, player, employmentGoal("ECorp"), [employmentGoal("ECorp")], recent as never, true, false);

    assert.deepEqual(
        action,
        { kind: "COMPANY", company: "ECorp" },
        `the priority chain chose ${JSON.stringify(action)} instead of applying for the job the goal names`,
    );
});

/* ─── megacorp goals survive the trip through the objective layer ─── */

test("an employment sub-goal carries the company a feature needs", () => {
    // `hireForGoal` reads `sub.company`. It is populated by `deriveGoals`, in a different
    // module, from a requirement key that is not a number — the one place that plumbing
    // could silently produce `undefined` and leave every megacorp goal unmovable.
    const p = fakePlayer(500);
    const goals = deriveGoals(standingOf(p, 0, 0, 0, 0, null, []), new Set());
    const eCorp = goals.find(g => g.goal === "join ECorp");
    assert.ok(eCorp !== undefined, "E Corp is not a goal");

    const company = eCorp.subGoals.find(sub => sub.key === "employed")?.company;
    assert.equal(company, "ECorp", "the employment sub-goal does not name a company");
});
/*
 * WHAT THESE TESTS DO NOT PROVE, stated rather than glossed.
 *
 * `factionTraining` refuses every candidate whose ETA exceeds `REACH_SEC`, and the ETA is
 * `Infinity` until `trackRate` has MEASURED a rate — which needs the player in a class
 * across two ticks more than `RATE_WINDOW_MS` apart, and a rate model that is
 * module-private. From outside the module every candidate is therefore unmeasurable and
 * `factionTraining` returns null whichever way the requirement table is written.
 *
 * The consequence, verified by reinstating the circularity: "training never answers a
 * megacorp entry requirement" passes either way. It pins that `factionTraining` does not
 * return a COMPANY action, and that the megacorp goals stay open for `hireForGoal` — not
 * that the old training branch is gone.
 *
 * What DOES cover the removal is the priority-chain test above it, which is where the
 * bug actually lived: `hireForGoal` was correct and produced nothing, because the branch
 * before it always answered first. Removing the call from the chain fails that test.
 *
 * Closing the remaining gap needs a seam into the rate model (`measuredRateFor` already
 * exists for exactly this kind of sharing, and threading it into `factionTraining` would
 * make the reachability gate testable without a class). That is a change worth making on
 * its own, not folded into a bug fix.
 */

/* ─── the head is not the only goal ─── */

test("an employment goal behind the head still produces an application", () => {
    // THE SECOND REGRESSION, and the one that survived the first fix.
    //
    // `hireForGoal` originally read only `context.goal` — the head of the ranked list.
    // On a real run the head was `take the map` (gang territory, 14% of 75), so the
    // function returned null on every tick of a whole session while `join ECorp` sat in
    // the queue behind it. Megacorps were still never worked for, and the code looked
    // correct because every test handed it an employment goal as the head.
    //
    // So this fixture puts a non-employment goal FIRST, which is the ordinary case. The
    // assertion is that the loop looks past it.
    const ns = fakeNs();
    const player = fakePlayer(500);

    const action = hireForGoal(ns, player, [otherGoal(), employmentGoal("ECorp")]);

    assert.deepEqual(
        action,
        { kind: "COMPANY", company: "ECorp" },
        "an employment goal behind the head was ignored, which is how megacorps stopped being worked for",
    );
});

test("the nearest employment goal wins", () => {
    // The list is ranked nearest-first, so the first employment goal found is the one the
    // run is closest to. Taking a LATER one would apply to the company the run is furthest
    // from, spending the same tick on a worse trade.
    const ns = fakeNs();
    const player = fakePlayer(500);

    const action = hireForGoal(ns, player, [
        otherGoal(),
        employmentGoal("Four Sigma"),
        employmentGoal("ECorp"),
    ]);

    assert.deepEqual(action, { kind: "COMPANY", company: "Four Sigma" });
});

test("an unqualified near megacorp does not stop a qualified far one", () => {
    // `continue`, not `return`. A company whose entry bar is not met is skipped, and the
    // loop carries on — otherwise one hard-to-enter megacorp at the top of the queue would
    // block every other application for the rest of the run.
    //
    // THE BARS HAVE TO DIFFER, or the test cannot tell the two behaviours apart: with a
    // uniform bar every company is skipped or none is, and `return` produces the same
    // answer. E Corp demands 2000 hacking; MegaCorp's requirement is unreadable, which
    // does NOT disqualify.
    const ns = {
        singularity: {
            getCompanyPositionInfo: (company: string) => {
                if (company === "ECorp") return { requiredSkills: { hacking: 2000 } };
                throw new Error("unreadable");
            },
        },
    } as unknown as NS;

    const action = hireForGoal(ns, fakePlayer(500), [
        employmentGoal("ECorp"),
        employmentGoal("MegaCorp"),
    ]);

    assert.deepEqual(
        action,
        { kind: "COMPANY", company: "MegaCorp" },
        "an unreachable near megacorp blocked the application to a reachable one",
    );
});
