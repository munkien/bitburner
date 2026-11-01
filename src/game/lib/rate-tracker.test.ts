/*
 * ============================================================================
 * MEASURING AN INCOME RATE
 * ============================================================================
 * `observeIncome` divides the change in home cash by the elapsed time. The change is not
 * always earnings: the framework spends from the same account, and a purchase makes the
 * delta negative. Clamping that to zero is the right answer for the RATE — money that left
 * is not a negative income — but reporting it as the rate for the next window is not,
 * because it says "this run is earning nothing" about a run that is earning normally.
 *
 * THE DEFECT, measured live in `runs/2026-11-01T12.22.54.797Z`. Income read a steady
 * 1,577k/s, then dropped to 0 on the tick a purchase landed, and stayed at 0 for the whole
 * of the following window:
 *
 *   13:23:15  income 1577k  money 260.7m
 *   13:23:20  income    0k  money  79.0m   <- a purchase inside the window
 *
 * The augmentation reserve is decided from this figure, so it collapsed from 212m to 0 on
 * the same tick and had to rebuild — thirteen times in that run. Reported as "the reserve
 * lowers itself once it is reserved", which is exactly what it looked like.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RATE_STALE_MS, RATE_WINDOW_MS, incomeFor, observeIncome, type IncomeSample, type OpenIncome } from "./rate-tracker.ts";

/** Drive `observeIncome` over a series of readings, one window apart. */
function drive(readings: readonly number[]): { sample: IncomeSample | null; incomes: (number | null)[] } {
    let open: OpenIncome | null = null;
    let sample: IncomeSample | null = null;
    let now = 0;
    const incomes: (number | null)[] = [];

    for (const cash of readings) {
        const measured = observeIncome(open, cash, now);
        open = measured.open;
        if (measured.rate !== null) sample = measured.rate;
        incomes.push(incomeFor(sample, now));
        now += RATE_WINDOW_MS;
    }
    return { sample, incomes };
}

test("a steady rise produces a steady rate", () => {
    // $1,000 per window, one window at a time. The control: without a purchase in the
    // series, the measurement must be untouched by the fix.
    const { incomes } = drive([0, 1e6, 2e6, 3e6, 4e6]);
    const usable = incomes.filter((r): r is number => r !== null);

    assert.ok(usable.length > 0, "no rate was produced from a steady rise");
    for (const rate of usable) {
        assert.equal(rate, 1e6 / (RATE_WINDOW_MS / 1000));
    }
});

test("a purchase does not report the run as earning nothing", () => {
    // THE BUG. Earn steadily, then buy something inside the window: home cash falls. The
    // clamped delta is 0, and reporting 0 as the rate says the run stopped earning.
    const { incomes } = drive([0, 1e6, 2e6, 40e3]);

    assert.notEqual(
        incomes[incomes.length - 1],
        0,
        "a purchase was reported as zero income, which collapses every reserve decided from it",
    );
});

test("a purchase keeps the last good rate rather than inventing one", () => {
    // Not merely "not zero" — the held figure must be the last MEASURED one, so the
    // reserve is computed from the run's actual earning rather than from a guess.
    const { incomes } = drive([0, 1e6, 2e6, 40e3]);
    const expected = 1e6 / (RATE_WINDOW_MS / 1000);

    assert.equal(incomes[incomes.length - 1], expected);
});

test("income recovers once the run starts earning again", () => {
    // The hold must not latch. After a purchase the balance rises again, and the next full
    // window measures the new rate — otherwise one purchase would pin the reserve for the
    // rest of the run.
    const { incomes } = drive([0, 1e6, 2e6, 40e3, 40e3 + 2e6, 40e3 + 4e6]);
    const last = incomes[incomes.length - 1];

    assert.ok(last !== null && last > 0, "income never recovered after a purchase");
});

test("two purchases in a row do not reset the held rate", () => {
    // A run buying several upgrades in consecutive passes — hacknet does exactly this now
    // that a pass may buy more than one — must not lose the rate to the second purchase
    // after the first already poisoned the window.
    const { incomes } = drive([0, 1e6, 2e6, 40e3, 20e3]);
    const last = incomes[incomes.length - 1];

    assert.ok(last !== null && last > 0, "a second consecutive purchase lost the held rate");
});

test("a stale held rate is still dropped", () => {
    // THE HOLD IS NOT UNBOUNDED. `RATE_STALE_MS` already says a measurement stops describing
    // the player eventually; holding a rate through purchases must not defeat that, or a run
    // that stopped earning hours ago would keep reserving against income it no longer has.
    const open: OpenIncome = { value: 0, at: 0 };
    const measured = observeIncome(open, 1e6, RATE_WINDOW_MS);
    assert.notEqual(measured.rate, null, "the fixture produced no rate at all");

    const sample = measured.rate;
    assert.ok(sample !== null);
    // The boundary is INCLUSIVE, matching `rateFor`'s `>`: a sample exactly `RATE_STALE_MS`
    // old is still usable, one millisecond past it is not. Asserted from both sides so the
    // two functions cannot drift apart on the edge without a test noticing.
    //
    // Measured from `sample.at`, not from zero — the sample is taken at `RATE_WINDOW_MS`, so
    // using the bare constant left it 29 minutes SHORT of stale and the assertion passed for
    // the wrong reason. Caught by the test failing when it should have passed.
    const staleAt = sample.at + RATE_STALE_MS;
    assert.notEqual(incomeFor(sample, staleAt), null, "the boundary sample was dropped early");
    assert.equal(incomeFor(sample, staleAt + 1), null, "a stale rate was still returned");
});
