/*
 * ============================================================================
 * THE STOCK MARKET RESPECTS THE FRAMEWORK'S RESERVES
 * ============================================================================
 * `stocks.ts` computed its own budget from the raw balance:
 *
 *     const cash = context.snapshot.player.money;
 *     const reserveCash = netWorth * CONFIG.RESERVE_CASH_PCT;   // 10% of NET WORTH
 *     const deployable = Math.max(0, (cash - reserveCash) * profile.deployTargetPct);
 *
 * `RESERVE_CASH_PCT` is the market's OWN solvency margin — a fraction of net worth kept back
 * so positions are not all-in. It is not the framework's reserve, and nothing in this
 * calculation ever read `context.reserves`. So the market spent money another feature had
 * spoken for, which is the one thing `surplus()` exists to prevent.
 *
 * Measured in `runs/2026-11-03T21.39.26.280Z--18`, three breaches in five minutes:
 *
 *   21:40:45  reserve  45.8m  money  62.6m ->  9.1m   STOCK BUY MGCP
 *   21:41:39  reserve  97.7m  money 118.2m -> 17.6m   STOCK BUY ECP
 *   21:43:15  reserve 148.9m  money 186.4m -> 41.1m   STOCK BUY FSIG
 *
 * Worst case in that run: cash 65.6m against a 218.5m reserve — 152.9m short.
 *
 * THE TWO RESERVES ARE DIFFERENT QUESTIONS and both still apply. The framework's is "this
 * cash is spoken for by another feature"; the market's is "do not put everything into
 * positions". Spending the framework's reserve defeats it from inside, exactly as the augment
 * buyer did before its own fix.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { deployableFor } from "./stocks.ts";

test("cash another feature reserved is not deployed", () => {
    // THE DEFECT. 100m in hand, 80m reserved for an augmentation. Only 20m is the market's
    // to consider, whatever its own margin says.
    const deployable = deployableFor({
        cash: 100e6,
        reservedCash: 80e6,
        netWorth: 100e6,
        reserveCashPct: 0.10,
        deployTargetPct: 1.0,
    });

    assert.ok(
        deployable <= 20e6,
        `deployed ${deployable / 1e6}m of money another feature had reserved`,
    );
});

test("a fully reserved balance deploys nothing", () => {
    // The extreme case, and the one that produced the 152.9m shortfall on the live run.
    const deployable = deployableFor({
        cash: 65.6e6,
        reservedCash: 218.5e6,
        netWorth: 65.6e6,
        reserveCashPct: 0.10,
        deployTargetPct: 1.0,
    });

    assert.equal(deployable, 0, "a balance smaller than its own reserve was deployed anyway");
});

test("the market's own margin still applies on top", () => {
    // THE CONTROL, and the thing that must not be lost. `RESERVE_CASH_PCT` exists so the
    // market does not put everything into positions; adding the framework's reserve must not
    // replace it. With nothing reserved by anyone, 10% of net worth is still held back.
    const deployable = deployableFor({
        cash: 100e6,
        reservedCash: 0,
        netWorth: 100e6,
        reserveCashPct: 0.10,
        deployTargetPct: 1.0,
    });

    assert.equal(deployable, 90e6, "the market's own solvency margin stopped applying");
});

test("both reserves apply together", () => {
    // Neither one replaces the other: 100m with 50m reserved, less the market's own 10m.
    const deployable = deployableFor({
        cash: 100e6,
        reservedCash: 50e6,
        netWorth: 100e6,
        reserveCashPct: 0.10,
        deployTargetPct: 1.0,
    });

    assert.equal(deployable, 40e6);
});

test("the profile's deployment target still scales the result", () => {
    // The tier decides how much of the deployable cash to use. That is a later decision and
    // must not be flattened by putting the reserve in the wrong place.
    const deployable = deployableFor({
        cash: 100e6,
        reservedCash: 0,
        netWorth: 100e6,
        reserveCashPct: 0,
        deployTargetPct: 0.5,
    });

    assert.equal(deployable, 50e6);
});

test("a reserve above the balance never yields a negative deployment", () => {
    // `surplus()` clamps at zero and so must this: a negative deployable would read as cash
    // the market could spend, and `Math.max(0, ...)` is the difference between "nothing" and
    // "an absurdly large unsigned value" once it reaches the order sizing.
    const deployable = deployableFor({
        cash: 0,
        reservedCash: 500e6,
        netWorth: 1e9,
        reserveCashPct: 0.10,
        deployTargetPct: 1.0,
    });

    assert.ok(deployable >= 0, `deployable was negative: ${deployable}`);
});
