/*
 * ============================================================================
 * WHY THE DIVISION IS ON TRAINING
 * ============================================================================
 * `Training` is the fallback for "no contract or operation is safe", and it is the one
 * branch of the Bladeburner feature that reported nothing at all. The symptom it produced
 * was a run sitting on `BLADEBURNER | General: Training` for forty minutes with no way to
 * tell whether that was patience or a defect — the action name is all the console shows,
 * and it does not change while the action runs.
 *
 * `describeFallback` answers the question the name cannot: HOW FAR below the bar each action
 * is. A division at 0.78 on its best action is minutes from resuming; one at 0.3 needs a
 * great deal more training. Both read identically as "Training" without this.
 *
 * These tests pin the two things that make the line useful — that it reports the MIDPOINT
 * (the same figure `pickAction` compares, so the report and the decision cannot disagree)
 * and that it names why an action was skipped (counts, or the bar).
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeFallback } from "./bladeburner.ts";
import type { NS } from "@ns";

/**
 * A Bladeburner API reporting fixed estimates per action.
 *
 * `estimates` maps an action name to its `[lo, hi]` interval; `counts` maps a name to the
 * counts remaining. Anything absent defaults to a comfortable 10 counts, so a test only has
 * to state the case it is about.
 */
function fakeNs(
    estimates: Record<string, [number, number]>,
    counts: Record<string, number> = {},
    throwing: readonly string[] = [],
): NS {
    return {
        bladeburner: {
            getActionEstimatedSuccessChance: (_type: string, name: string) => {
                if (throwing.includes(name)) throw new Error("no such action");
                return estimates[name] ?? [0.95, 0.99];
            },
            getActionCountRemaining: (_type: string, name: string) => counts[name] ?? 10,
        },
    } as unknown as NS;
}

test("an action below the bar is reported with its midpoint and the bar it missed", () => {
    // 0.75 is under `MIN_CHANCE` (0.8), which is why the division fell back to training.
    const text = describeFallback(fakeNs({ Tracking: [0.7, 0.8] }));

    assert.match(text, /Tracking: 0\.750/);
    assert.match(text, /below 0\.8/);
});

test("the midpoint is what is compared, not the interval's low end", () => {
    // THE POINT OF REPORTING BOTH. An interval of 0.74-0.90 has a midpoint of 0.82, which
    // CLEARS the bar — `pickAction` would take it, and a report showing only the 0.74 would
    // look like a refusal that never happened. The two figures must agree or the line lies
    // about a decision the feature is making.
    const text = describeFallback(fakeNs({ Tracking: [0.74, 0.9] }));

    assert.match(text, /Tracking: 0\.820/);
    assert.match(text, /TAKEABLE/);
    assert.doesNotMatch(text, /Tracking: .*below/);
});

test("an action with no counts left says so, rather than reporting its chance", () => {
    // Counts are the FIRST reason `bestWork` skips an action, so an exhausted contract is
    // not "too risky" and reporting it as such would send a reader to fix the wrong thing.
    const text = describeFallback(fakeNs({ Tracking: [0.95, 0.99] }, { Tracking: 0 }));

    assert.match(text, /Tracking: .*counts=0 no counts/);
    assert.doesNotMatch(text, /Tracking: .*TAKEABLE/);
});

test("an unreadable action is named as unreadable and does not hide the others", () => {
    // An action the division has not unlocked throws on every getter. That must not abort
    // the whole report — the remaining actions are the ones that explain the decision.
    const text = describeFallback(fakeNs({ Tracking: [0.7, 0.8] }, {}, ["Assassination"]));

    assert.match(text, /Assassination: unreadable/);
    assert.match(text, /Tracking: 0\.750/, "one unreadable action suppressed the readable ones");
});

test("every candidate action appears, so a reader can see the whole field", () => {
    // The interesting comparison is often BETWEEN actions: a contract at 0.79 next to one at
    // 0.79 says the division is uniformly short, which is a different problem from a single
    // action being uniquely risky.
    const text = describeFallback(fakeNs({}));
    for (const name of ["Assassination", "Investigation", "Retirement", "Tracking"]) {
        assert.ok(text.includes(`${name}:`), `${name} is missing from the report`);
    }
});
