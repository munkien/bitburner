/*
 * ============================================================================
 * COMPANY PROMOTION
 * ============================================================================
 * Getting hired at a megacorp, and then getting promoted.
 *
 * WHY THIS FILE EXISTS. The run got its entry-level job at all nine megacorps, worked one
 * tick at each, settled on one, and stayed an intern for the rest of its life. Rep
 * accrued at the entry rate — the slowest in the game — while the augmentations those
 * factions sell are gated on that same rep.
 *
 * The reported symptom was "it does not get a better job". The cause was a placement:
 * `ensureCompanyJob` sat BEFORE the `isDoingAction` early return, so an employed player
 * working at the company hit that return every tick and the call was reached only on the
 * hiring tick. `applyToCompany` promotes — the game's docs say so — and nothing ever asked
 * it to.
 *
 * WHAT IS PINNED HERE. That a promotion is actually attempted, that it names the FIELD
 * the player already holds (the game promotes within a field), that a combat character has
 * a route in at all, and that the cadence is not once per tick.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bestCompany, ensureCompanyJob, maybePromote, reset } from "./player.ts";

/** Mirrors the constant in `player.ts`; tested through the behaviour, not imported. */
const PROMOTION_INTERVAL_MS = 60_000;
import type { CompanyName, JobName, NS, Player } from "@ns";

/** Records what `applyToCompany` was called with, and answers from a script. */
function fakeNs(
    jobs: Record<string, string>,
    answers: (company: string, field: string) => string | null,
): NS & { calls: Array<[string, string]> } {
    const calls: Array<[string, string]> = [];
    const ns = {
        calls,
        getPlayer: () => ({ jobs }) as unknown as Player,
        print: () => { },
        tryWritePort: () => true,
        singularity: {
            applyToCompany: (company: string, field: string) => {
                calls.push([company, field]);
                return answers(company, field) as JobName | null;
            },
        },
    } as unknown as NS & { calls: Array<[string, string]> };
    ns.calls = calls;
    return ns;
}

test("an unemployed player is hired through the first field that accepts", () => {
    const ns = fakeNs({}, (_c, field) => (field === "Software" ? "Software Engineering Intern" : null));

    const got = ensureCompanyJob(ns, "ECorp" as CompanyName, 0);

    assert.equal(got, "Software Engineering Intern");
    assert.deepEqual(ns.calls, [["ECorp", "Software"]], "the loop stopped at the field that worked");
});

test("a combat character can be hired at all", () => {
    // THE REGRESSION FOR THE FIELD LIST. It used to be Software, IT, Business and Security
    // — every one of them a hacking position — so a run built on strength had no route in.
    // `Agent` is the combat entry field, and it was not in the list.
    const ns = fakeNs({}, (_c, field) => (field === "Agent" ? "Agent" : null));

    const got = ensureCompanyJob(ns, "ECorp" as CompanyName, 0);

    assert.equal(got, "Agent", "the combat entry field was never tried");
});

test("an employed player applies in the field they already hold", () => {
    // The game promotes WITHIN a field: `applyToCompany(company, field)` returns the best
    // position in that field. Naming a different field is a parallel application, which the
    // game refuses while employed.
    const ns = fakeNs(
        { ECorp: "Software Engineering Intern" },
        () => "Senior Software Engineer",
    );

    const got = ensureCompanyJob(ns, "ECorp" as CompanyName, 0);

    assert.equal(got, "Senior Software Engineer");
    assert.deepEqual(
        ns.calls,
        [["ECorp", "Software"]],
        "a promotion must name the held field, and only that one",
    );
});

test("every field maps to itself, so a promotion never names the wrong one", () => {
    // `FIELD_OF_JOB` is a reverse lookup the game does not provide, so it is a hand-written
    // map and the place a typo would hide. Each held position must produce the field that
    // would promote it.
    const cases: Array<[string, string]> = [
        ["Software Engineering Intern", "Software"],
        ["Senior Software Engineer", "Software"],
        ["Software Consultant", "Software Consultant"],
        ["IT Intern", "IT"],
        ["Network Engineer", "Network Engineer"],
        ["Security Engineer", "Security Engineer"],
        ["Security Analyst", "Security"],
        ["Business Intern", "Business"],
        ["Business Consultant", "Business Consultant"],
        ["Agent", "Agent"],
    ];

    for (const [job, expected] of cases) {
        const ns = fakeNs({ ECorp: job }, () => "promoted");
        ensureCompanyJob(ns, "ECorp" as CompanyName, 0);
        assert.deepEqual(
            ns.calls,
            [["ECorp", expected]],
            `${job} was promoted through the wrong field`,
        );
    }
});

test("an unrecognised position is not applied for in a guessed field", () => {
    // A waiter or a part-time employee is not a position this feature promotes. Applying
    // in `Software` because nothing matched would be a rejected call every minute for the
    // life of the run, which is worse than doing nothing.
    const ns = fakeNs({ "Noodle Bar": "Waiter" }, () => "promoted");

    const got = ensureCompanyJob(ns, "Noodle Bar" as CompanyName, 0);

    assert.equal(got, null, "a recognised-nowhere position produced an application");
    assert.deepEqual(ns.calls, [], "a guess was made instead of declining");
});

test("a refused application returns null rather than throwing", () => {
    // The common case: not qualified yet. This runs every tick on the hiring path, so a
    // throw here would fault the whole feature.
    const ns = fakeNs({}, () => null);
    assert.equal(ensureCompanyJob(ns, "ECorp" as CompanyName, 0), null);
});

test("a throwing API does not escape into the pass", () => {
    const ns = {
        getPlayer: () => ({ jobs: {} }) as unknown as Player,
        singularity: {
            applyToCompany: () => { throw new Error("API unavailable"); },
        },
    } as unknown as NS;

    assert.equal(ensureCompanyJob(ns, "ECorp" as CompanyName, 0), null);
});

/* ─── the cadence ─── */

test("a promotion is attempted at most once a minute", () => {
    // THE COST SIDE. `maybePromote` runs on the work path, which fires every tick. An
    // unguarded call there is one 3 GB `applyToCompany` per tick per company, for the whole
    // run — and promotion is gated on reputation, which does not move between ticks.
    reset();
    const jobs: Record<string, string> = { ECorp: "Software Engineering Intern" };
    const ns = fakeNs(jobs, () => null);
    const company = "ECorp" as CompanyName;

    // Six ticks inside one minute: exactly one attempt.
    for (let i = 0; i < 6; i++) maybePromote(ns, company, i * 1_000);
    assert.equal(ns.calls.length, 1, `expected one attempt in a minute, got ${ns.calls.length}`);

    // Just past the interval: a second.
    maybePromote(ns, company, PROMOTION_INTERVAL_MS);
    assert.equal(ns.calls.length, 2, "the cadence never advanced");
});

test("the cadence is per company, not global", () => {
    // A shared timer would mean working at one company starves every other for a minute,
    // which matters because the run holds jobs at several at once.
    reset();
    const ns = fakeNs(
        { ECorp: "Software Engineering Intern", NWO: "Software Engineering Intern" },
        () => null,
    );

    maybePromote(ns, "ECorp" as CompanyName, 0);
    maybePromote(ns, "NWO" as CompanyName, 0);

    assert.equal(ns.calls.length, 2, "one company's attempt suppressed another's");
});

test("a successful promotion is reported, and a same-rank answer is not", () => {
    // `applyToCompany` returns the position; it may return the one already held when the
    // application is refused. Announcing that as a promotion would be a false success line
    // every minute.
    reset();
    const lines: string[] = [];
    const jobs: Record<string, string> = { ECorp: "Software Engineering Intern" };
    const ns = {
        getPlayer: () => ({ jobs }) as unknown as Player,
        singularity: {
            applyToCompany: () => "Software Engineering Intern" as JobName,
        },
        print: (line: string) => { lines.push(line); },
        tryWritePort: () => true,
    } as unknown as NS;

    maybePromote(ns, "ECorp" as CompanyName, 0);

    assert.ok(
        !lines.some(l => l.includes("Promoted")),
        `a same-rank answer was announced as a promotion: ${JSON.stringify(lines)}`,
    );
});

test("a promotion that does not happen is not attempted at all when unemployed there", () => {
    // `maybePromote` is for a held job. Calling it for a company the player does not work
    // at must not spend a game call, because the work path only reaches it for the company
    // being worked for and a bug there would mean applying to strangers.
    reset();
    const ns = fakeNs({}, () => "hired");

    maybePromote(ns, "ECorp" as CompanyName, 0);

    assert.deepEqual(ns.calls, [], "promoted a player who does not work there");
});

/* ─── a held job survives faction membership ─── */

test("a company the player works at is still chosen after joining its faction", () => {
    // THE BUG BEHIND "better positions are not applied for".
    //
    // A megacorp is both a company and a company faction, and joining the faction is the
    // ordinary consequence of working there. `bestCompany` tested membership FIRST, so the
    // one company the player was employed by became the one company it refused to choose.
    //
    // `maybePromote` is only reachable from the work path, so losing the choice to work there
    // silently ended promotion: the job and its entry-level title stayed, rep accrued at the
    // entry rate, and nothing reported a problem.
    const player = {
        jobs: { ECorp: "Software Engineering Intern" },
        factions: ["ECorp"],
        skills: { hacking: 500 },
    } as unknown as Player;

    assert.equal(
        bestCompany({} as NS, player),
        "ECorp",
        "an employer was rejected because the player had joined its faction",
    );
});

test("membership still excludes a company the player does NOT work at", () => {
    // The other half, which must not be lost: membership means access, so re-hiring where the
    // player is already a member is pointless — but only when there is no job there.
    const player = {
        jobs: { ECorp: "Software Engineering Intern" },
        factions: ["ECorp", "NWO"],
        skills: { hacking: 500 },
    } as unknown as Player;

    const chosen = bestCompany({} as NS, player);
    assert.notEqual(chosen, "NWO", "a faction-only company was chosen for hiring");
});

test("every held job is swept, not only the one being worked at", () => {
    // THE INDEPENDENCE THIS WAS SPLIT FOR. Promotion used to run only from the work path,
    // for the action the priority chain chose — so a long training block or a Bladeburner
    // chain held the slot for hours and no application was made anywhere. Reputation accrues
    // whether or not the player is at work, so the position should follow it regardless.
    reset();
    const ns = fakeNs(
        { ECorp: "Software Engineering Intern", NWO: "IT Intern" },
        () => "promoted",
    );

    // The sweep `promoteEveryHeldJob` performs, driven directly.
    for (const company of Object.keys(ns.getPlayer().jobs)) {
        maybePromote(ns, company as CompanyName, 0);
    }

    assert.deepEqual(
        ns.calls.map(([c]) => c).sort(),
        ["ECorp", "NWO"],
        "a held job was skipped because the player was not working there",
    );
});

test("the sweep stays inside the once-a-minute cadence", () => {
    // The cost bound the work path had is unchanged: sweeping every company every tick would
    // be one `applyToCompany` per company per tick, which is the thing the cadence exists to
    // prevent.
    reset();
    const ns = fakeNs(
        { ECorp: "Software Engineering Intern", NWO: "IT Intern" },
        () => "promoted",
    );

    const sweep = (now: number) => {
        for (const company of Object.keys(ns.getPlayer().jobs)) {
            maybePromote(ns, company as CompanyName, now);
        }
    };

    // Ten ticks inside one minute: two calls, one per company.
    for (let i = 0; i < 10; i++) sweep(i * 1_000);
    assert.equal(ns.calls.length, 2, `expected two attempts in a minute, got ${ns.calls.length}`);

    // Past the interval: two more.
    sweep(PROMOTION_INTERVAL_MS);
    assert.equal(ns.calls.length, 4, "the sweep never advanced past its cadence");
});
