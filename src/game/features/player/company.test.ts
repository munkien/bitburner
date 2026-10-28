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

import { ensureCompanyJob, maybePromote, reset } from "./player.ts";

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
