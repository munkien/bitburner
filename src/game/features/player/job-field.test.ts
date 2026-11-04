/*
 * ============================================================================
 * EVERY POSITION BELONGS TO A FIELD
 * ============================================================================
 * `applyToCompany` takes a FIELD, so promoting from a held position means naming the field
 * that position is in. The game offers no reverse lookup, so `FIELD_OF_JOB` guesses from the
 * title — and the guess matched on substrings like "software" and "business", which run out
 * at the senior end of the ladder.
 *
 * REPORTED AS "it never applies for Chief Technology Officer". Measured against the game's
 * own position names, EIGHT positions mapped to nothing:
 *
 *   Head of Engineering           -> null   (Software)
 *   Vice President of Technology  -> null   (Software)
 *   Chief Technology Officer      -> null   (Software)
 *   Systems Administrator         -> null   (IT)
 *   Operations Manager            -> null   (Business)
 *   Chief Financial Officer       -> null   (Business)
 *   Chief Executive Officer       -> null   (Business)
 *   Special Operative             -> null   (Agent)
 *
 * A null field means `ensureCompanyJob` applies nowhere, so the run holds that position for
 * the rest of its life. The failure is silent: no refused call, no error, just a promotion
 * that stops happening — the same shape as the `bestCompany` bug that made this look like
 * "promotions are not applied for" rather than "the run stopped going to work".
 *
 * THE FIX IS A TABLE, not a better guess. The position names are the game's fixed strings and
 * each belongs to exactly one field; enumerating them is the only way to be right about
 * "Head of Engineering" while "Security Engineer" stays out of "Security".
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FIELD_OF_JOB } from "./player.ts";

/**
 * The game's positions, by field, transcribed from `JobNameEnumType`.
 *
 * Listed here independently of the implementation ON PURPOSE: a test that derived its
 * expectations from the same table the code uses would agree with any mistake.
 */
const POSITIONS: Record<string, readonly string[]> = {
    Software: [
        "Software Engineering Intern", "Junior Software Engineer", "Senior Software Engineer",
        "Lead Software Developer", "Head of Software", "Head of Engineering",
        "Vice President of Technology", "Chief Technology Officer",
    ],
    IT: ["IT Intern", "IT Analyst", "IT Manager", "Systems Administrator"],
    "Security Engineer": ["Security Engineer"],
    "Network Engineer": ["Network Engineer", "Network Administrator"],
    Security: ["Security Guard", "Security Officer", "Security Supervisor", "Head of Security"],
    Business: [
        "Business Intern", "Business Analyst", "Business Manager", "Operations Manager",
        "Chief Financial Officer", "Chief Executive Officer",
    ],
    Agent: ["Field Agent", "Secret Agent", "Special Operative"],
};

test("every position in every ladder maps to its own field", () => {
    // THE DEFECT, in full. Eight positions returned null, and any one of them ends promotion
    // for a run that reaches it.
    const wrong: string[] = [];
    for (const [field, titles] of Object.entries(POSITIONS)) {
        for (const title of titles) {
            const got = FIELD_OF_JOB(title as never);
            if (got !== field) wrong.push(`${title} -> ${got ?? "null"} (should be ${field})`);
        }
    }

    assert.deepEqual(wrong, [], `positions that do not map to their field:\n  ${wrong.join("\n  ")}`);
});

test("the reported case is reachable", () => {
    // The specific complaint. `Head of Engineering` returning null is what stopped the run
    // from ever applying for `Chief Technology Officer`.
    assert.equal(FIELD_OF_JOB("Head of Engineering" as never), "Software");
    assert.equal(FIELD_OF_JOB("Chief Technology Officer" as never), "Software");
});

test("Security Engineer is not folded into Security", () => {
    // The two are SEPARATE fields and the game treats them so. A substring match on
    // "security" put the engineer's position in the guard's ladder, which made the run apply
    // for a promotion in a field it did not hold.
    assert.equal(FIELD_OF_JOB("Security Engineer" as never), "Security Engineer");
    assert.equal(FIELD_OF_JOB("Head of Security" as never), "Security");
});

test("an unknown title still reports null rather than a guess", () => {
    // The table must not become a licence to guess. A position the game adds later, or one
    // from a company this does not cover, is null — applying in the wrong field is a refused
    // call every minute for the life of the run.
    assert.equal(FIELD_OF_JOB("Part-time Waiter" as never), null);
    assert.equal(FIELD_OF_JOB("Some Future Title" as never), null);
});
