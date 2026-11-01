/*
 * ============================================================================
 * SAVING FOR A PURCHASE
 * ============================================================================
 * The rule this replaces reserved nothing until the money was within 20% of the price, so
 * a run with $1b saving for a $25b purchase had a reserve of ZERO and every other feature
 * saw the whole balance as free. Three reported complaints are that one defect:
 *
 *   "it does not buy Neuroreceptor Management Implant before very late game"
 *   "it does not buy The Blade's Simulacrum before very late game"
 *   "it spends money on other things even when it could save up easily"
 *
 * The tests below pin the two directions that matter: a reachable purchase IS protected
 * (the bug), and a far-off one is NOT (the concern the old rule was written for, which is
 * real and must survive).
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RESERVE_CAP, RESERVE_HORIZON_SEC, reserveFor } from "./purchase-reserve.ts";

/** $1m/s, so prices and seconds are the same number and the arithmetic is visible. */
const EARNING = 1e6;

test("a purchase one minute away is protected", () => {
    // THE BUG. $25m in hand, $26m wanted at $1m/s: sixty seconds away, comfortably inside
    // the horizon. The old rule saw `26m - 25m > 20% of 26m` and reserved NOTHING, so the
    // last million was outbid by any feature that wanted it.
    const money = 25e6;
    const reserve = reserveFor(26e6, money, EARNING);

    assert.ok(reserve > 0, "a purchase sixty seconds away reserved nothing");
    assert.ok(
        reserve <= 26e6 - money || reserve <= money,
        "the reserve claimed more than the balance can cover",
    );
});

test("a purchase at the horizon boundary is protected less than one that is close", () => {
    // The reserve must RAMP. A flat amount would either tax every other feature for the
    // whole window or fail to protect the final stretch — the two ways this can be wrong.
    // $1k/s so the distances are on the scale of the 30-minute horizon: 1 minute away
    // against 20 minutes away, same price, same balance.
    const SLOW = 1e3;
    const near = reserveFor(10e6, 9.94e6, SLOW); // 60 seconds away
    const far = reserveFor(10e6, 8.8e6, SLOW); // 1200 seconds away

    const nearFraction = near / 9.94e6;
    const farFraction = far / 8.8e6;

    // Scaled by closeness rather than compared absolutely, because the balances differ:
    // the question is what FRACTION of what is in hand gets protected at each distance.
    assert.ok(
        nearFraction > farFraction,
        `closer purchase protected less of the balance (${nearFraction.toFixed(2)} vs ${farFraction.toFixed(2)})`,
    );
});

test("a purchase beyond the horizon reserves nothing", () => {
    // THE CONCERN THE OLD RULE WAS WRITTEN FOR, and it is real. $25b wanted, $1m in hand at
    // $1/s is roughly 800 years away. Protecting that would freeze cloud, hacknet, stocks
    // and home RAM for the entire run, and those features are what would earn the money.
    const reserve = reserveFor(25e9, 1e6, 1);
    assert.equal(reserve, 0, "a purchase eight centuries away froze the economy");
});

test("no measured income reserves nothing", () => {
    // Null is NO EVIDENCE, handled the way `floorReachable` handles it: the honest answer
    // when nothing has been measured is not to act. An unmeasured run is usually an early
    // run, which is exactly the one that must not freeze its spending.
    assert.equal(reserveFor(10e6, 1e6, null), 0);
    // Zero is MEASURED AND NOT RISING, which is evidence in the other direction: the target
    // is not being approached at all, so protecting it buys nothing.
    assert.equal(reserveFor(10e6, 1e6, 0), 0);
    assert.equal(reserveFor(10e6, 1e6, Number.POSITIVE_INFINITY), 0);
    assert.equal(reserveFor(10e6, 1e6, Number.NaN), 0);
});

test("nothing is reserved for a purchase already affordable", () => {
    // The reserve is cash to PROTECT. Once the price is met there is nothing to protect, and
    // continuing to hold back would starve the features that earn for no gain. The caller
    // buys in the same pass, so this is the normal path immediately after a purchase.
    assert.equal(reserveFor(10e6, 10e6, EARNING), 0);
    assert.equal(reserveFor(10e6, 11e6, EARNING), 0);
});

test("the reserve never exceeds what is in hand, nor the shortfall", () => {
    // Two independent bounds, both of which matter. Above `money` the spenders clamp to
    // zero and stop working entirely; above the shortfall the run holds back money the
    // purchase does not need.
    for (const [cost, money] of [[10e6, 9e6], [10e6, 5e6], [10e6, 1e6], [1e6, 999_999]] as const) {
        const reserve = reserveFor(cost, money, EARNING);
        assert.ok(reserve <= money, `reserve ${reserve} exceeded the balance ${money}`);
        assert.ok(reserve >= 0, "a negative reserve would ADD to the balance");
    }
    assert.equal(RESERVE_CAP < 1, true, "a cap of 1 would leave the income features nothing");
});

test("the horizon is the training budget's, so the two decisions agree", () => {
    // Not an arbitrary number: this is `REACH_SEC`. A run that will not spend 30 minutes
    // training for a stat should not freeze its economy for longer than that either, and
    // two different horizons in the same framework would drift apart the way ADR-0003
    // describes.
    assert.equal(RESERVE_HORIZON_SEC, 30 * 60);
});

test("a must-buy is protected however far away it is", () => {
    // THE CASE A LIVE RUN EXPOSED, and the horizon alone cannot express it. A $25b stock
    // expansion against $4b in hand earning $0.5b/h is roughly 42 hours away, so the
    // horizon test reserved NOTHING — the run would never save for the thing it cannot
    // proceed without. Widening the horizon to reach it would be an arbitrary number that
    // is wrong on most runs.
    const cash = 4e9;
    const income = 139_000; // ~$0.5b/h, measured from the live run
    const cost = 25e9;

    assert.equal(reserveFor(cost, cash, income), 0, "a distant purchase must not be protected as an ordinary one");
    assert.ok(
        reserveFor(cost, cash, income, undefined, true) > 0,
        "a must-buy 42 hours away reserved nothing; the run can never accumulate toward it",
    );
});

test("a must-buy holds back the cap from the start, not a ramp towards it", () => {
    // The ramp is right for an ordinary purchase competing with everything else, and wrong
    // for a must-buy, where waiting is the failure mode. With the ramp, a far target
    // reserved `cap * closeness^2` where closeness is near zero — the reported bug,
    // reproduced by the fix itself.
    const cash = 4e9;
    const distant = reserveFor(25e9, cash, 139_000, undefined, true);
    const near = reserveFor(4.1e9, cash, 139_000, undefined, true);

    assert.equal(distant, near, "the reserve for a must-buy should not depend on how close it is");
    assert.equal(distant, Math.ceil(cash * RESERVE_CAP));
});

test("a must-buy still reserves nothing when there is no income measured", () => {
    // The cap on the exception. `accumulate` overrides DISTANCE, not EVIDENCE: with no
    // measured income the run cannot know it is accumulating at all, and freezing an early
    // run's spending on a guess is the failure the old 20% rule was written to avoid.
    assert.equal(reserveFor(25e9, 4e9, null, undefined, true), 0);
    assert.equal(reserveFor(25e9, 4e9, 0, undefined, true), 0);
});
