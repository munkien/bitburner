/*
 * ============================================================================
 * THE AUGMENT BUYER RESPECTS THE RESERVE
 * ============================================================================
 * `buyAffordableAugments` spends whenever the player can afford an augmentation:
 *
 *     if (player.money < price) continue;
 *     ns.singularity.purchaseAugmentation(faction, aug);
 *
 * It never asks what the rest of the framework has held back. So the reserve that
 * `plannedReserve` computes every tick — the money being saved toward the NEXT augmentation,
 * and the stock-access chain beside it — is spent by the very feature that reserved it, on
 * anything cheap enough to fit under the balance.
 *
 * WHY THAT MATTERS MORE NOW THAN BEFORE. `reserveFor` with `accumulate` holds a capped
 * fraction of the balance for a must-buy, precisely so the run can reach an augmentation it
 * would otherwise be outbid on. A buyer that ignores the reserve defeats that from inside:
 * the reserve exists, the console shows it, and the purchase it was protecting still never
 * happens because a cheaper augmentation took the money first.
 *
 * THE RULE IS MONOTONIC AND THAT IS THE POINT. Reserving money must make the run buy LESS,
 * never more and never something else. A buyer that ignores the reservation spends the same
 * amount whether or not a reserve is in force, which is exactly the defect.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buyAffordableAugments } from "./player.ts";
import type { RecentLines } from "../../lib/log.ts";
import type { NS, Player } from "@ns";

const FACTION = "CyberSec" as never;
const CHEAP = "Cheap Implant";
const PRICEY = "Pricey Implant";

/**
 * An `ns` selling two augmentations at fixed prices, recording every purchase.
 *
 * Prices are explicit because "the buyer ignored the reserve" is only observable as a
 * comparison against a BALANCE. A fixture where everything is free cannot express it.
 */
function fakeNs(prices: Record<string, number>) {
    const purchases: string[] = [];
    const names = Object.keys(prices);

    const ns = {
        singularity: {
            getOwnedAugmentations: () => [],
            getFactionRep: () => 1e12,
            getFactionFavor: () => 0,
            getAugmentationsFromFaction: () => names,
            getAugmentationPrereq: () => [],
            getAugmentationRepReq: () => 0,
            getAugmentationPrice: (aug: string) => prices[aug],
            purchaseAugmentation: (_f: string, aug: string) => {
                purchases.push(aug);
                return true;
            },
            donateToFaction: () => false,
            getCurrentWork: () => null,
        },
        gang: { inGang: () => false, getGangFaction: () => null },
        print: () => {},
        tprint: () => {},
        toast: () => {},
        format: { number: (n: number) => String(n), ram: (n: number) => String(n) },
    } as unknown as NS;

    return { ns, purchases };
}

/** A player holding `money`, in the one faction above. */
function player(money: number): Player {
    return {
        factions: [FACTION],
        money,
        mults: { faction_rep: 1 },
        skills: { hacking: 100, strength: 1, defense: 1, dexterity: 1, agility: 1 },
    } as unknown as Player;
}

/** A change log sink, discarded: these tests assert on purchases, not on prose. */
function silentLog(): RecentLines {
    return { add: () => {} } as unknown as RecentLines;
}

test("a reserved balance is not spent on a cheaper augmentation", () => {
    // THE DEFECT. $100m in hand, $80m reserved toward something the run is saving for, so
    // $20m is actually free. `Cheap Implant` costs $50m: affordable by balance, NOT
    // affordable by surplus.
    const { ns, purchases } = fakeNs({ [CHEAP]: 50e6 });

    buyAffordableAugments(ns, player(100e6), [], silentLog(), 80e6);

    assert.deepEqual(
        purchases,
        [],
        "the buyer spent money another feature had reserved, which is the whole point of a reserve",
    );
});

test("surplus above the reserve is still spent", () => {
    // THE CONTROL, and without it a buyer that simply never buys would pass the test above.
    // $100m with $40m reserved leaves $60m free, which covers a $50m implant.
    const { ns, purchases } = fakeNs({ [CHEAP]: 50e6 });

    buyAffordableAugments(ns, player(100e6), [], silentLog(), 40e6);

    assert.deepEqual(purchases, [CHEAP], "a genuinely affordable augmentation was not bought");
});

test("the reserve is subtracted before the price is compared, not after", () => {
    // Ordering matters: checking the balance first and the reserve second would let a buyer
    // purchase something it then could not pay for, and the loop below re-checks `bought`.
    // Asserted by choosing a price between the surplus and the balance.
    const { ns, purchases } = fakeNs({ [PRICEY]: 90e6 });

    buyAffordableAugments(ns, player(100e6), [], silentLog(), 50e6);

    assert.deepEqual(purchases, [], "the reserve was applied after the affordability test");
});

test("reserving money makes the run buy less, never different", () => {
    // THE MONOTONICITY PROPERTY, and the reason this is a rule rather than a number. Two
    // augmentations at $30m each, $100m in hand. With no reserve both are bought; with $50m
    // reserved only the one that fits in $50m of surplus is.
    //
    // Stated as "a subset" rather than an exact list, because which one the loop reaches
    // first is the faction's list order and not something this test should pin.
    const both = () => fakeNs({ [CHEAP]: 30e6, [PRICEY]: 30e6 });

    const unreserved = both();
    buyAffordableAugments(unreserved.ns, player(100e6), [], silentLog(), 0);

    const reserved = both();
    buyAffordableAugments(reserved.ns, player(100e6), [], silentLog(), 50e6);

    assert.ok(unreserved.purchases.length > 0, "the control bought nothing at all");
    assert.ok(
        reserved.purchases.length <= unreserved.purchases.length,
        `a reserve made the run buy MORE (${reserved.purchases.length} vs ${unreserved.purchases.length})`,
    );
    for (const aug of reserved.purchases) {
        assert.ok(unreserved.purchases.includes(aug), `a reserve made the run buy something different: ${aug}`);
    }
});

test("a fully reserved balance buys nothing", () => {
    // The extreme case, and the one the stock-access chain produces: the whole balance is
    // spoken for, so surplus is zero and nothing may be bought.
    const { ns, purchases } = fakeNs({ [CHEAP]: 1e6 });

    buyAffordableAugments(ns, player(100e6), [], silentLog(), 100e6);

    assert.deepEqual(purchases, [], "a fully reserved balance was spent anyway");
});

test("an over-large reserve does not produce a negative surplus that buys", () => {
    // `surplus` clamps at zero, and this pins that the clamp is what the buyer sees. A
    // reserve larger than the balance is not an error — two features can each reserve
    // against the same cash — and it must read as "nothing free", never as a negative
    // affordance that flips the comparison.
    const { ns, purchases } = fakeNs({ [CHEAP]: 1e6 });

    buyAffordableAugments(ns, player(10e6), [], silentLog(), 50e6);

    assert.deepEqual(purchases, [], "a reserve above the balance let a purchase through");
});
