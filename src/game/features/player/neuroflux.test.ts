/*
 * ============================================================================
 * NEUROFLUX GOVERNOR IS BOUGHT AT RETIREMENT, NOT DURING THE RUN
 * ============================================================================
 * `NeuroFlux Governor` is the one augmentation with no ceiling. Its reputation
 * requirement and its price both rise with every copy, and it grants the weakest
 * multipliers per dollar of anything a faction sells. Bought during a run it competes
 * with the finite augmentations whose reputation the run is still farming, and because
 * there is always another copy available it can absorb cash indefinitely.
 *
 * So it is a RETIREMENT purchase, and only a retirement purchase: once `retire.ts` has
 * decided the queue is about to be installed and the money has nowhere else to go.
 *
 * THE RULE IS ENFORCED BY TWO SEPARATE SKIPS, and this file pins both. Either one is a
 * one-line deletion away from turning every run into a NeuroFlux farm, and neither is
 * observable from the outside:
 *
 *   - `getBestAugmentation` filters it out, so it is never a TARGET. Losing this skip is
 *     the worse failure: the target would exist forever, `plannedReserve` would hold
 *     money back for it on every tick, and the finite augmentations would never be what
 *     the run was saving for.
 *   - `buyAffordableAugments` filters it out, so it is never BUYING the leftovers. Losing
 *     this skip spends the run's cash on copies the moment the reputation is met.
 *
 * The test does not assert on source text. It gives the player a faction whose ONLY
 * unowned augmentation is NeuroFlux, at a reputation and price that would buy it
 * instantly, and asserts nothing is bought and nothing is targeted. A control case with
 * an ordinary augmentation proves the fixture actually reaches the purchase path — a
 * test where nothing is ever bought passes just as happily when the loop is dead.
 *
 * WHERE IT IS ALLOWED IS TESTED ELSEWHERE: `retire.test.ts` drives the retirement
 * sequence that calls `buyNeuroFlux`. This file is about the run in between.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buyAffordableAugments, getBestAugmentation, reset } from "./player.ts";
import type { RecentLines } from "../../lib/log.ts";
import type { NS, Player } from "@ns";

const NEURO = "NeuroFlux Governor";
const ORDINARY = "Brain Analyzing Engine";
const FACTION = "CyberSec" as never;

/**
 * An `ns` for a player in one faction, recording every `purchaseAugmentation` call.
 *
 * Everything is priced at zero and the player is made of money, so the ONLY thing that can
 * stop a purchase is the NeuroFlux skip itself. That is deliberate: a fixture that gated
 * the buy on price or reputation could not distinguish "correctly excluded" from "could
 * not afford it", and the skip is what is being tested.
 */
function fakeNs(state: { available: readonly string[]; owned: readonly string[] }): NS & {
    purchases: { faction: string; aug: string }[];
} {
    const purchases: { faction: string; aug: string }[] = [];
    const ns = {
        singularity: {
            getOwnedAugmentations: () => state.owned,
            getFactionRep: () => 1e12,
            getFactionFavor: () => 0,
            getAugmentationsFromFaction: () => state.available,
            getAugmentationPrereq: () => [],
            getAugmentationRepReq: () => 0,
            getAugmentationPrice: () => 0,
            purchaseAugmentation: (faction: string, aug: string) => {
                purchases.push({ faction, aug });
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
    } as unknown as NS & { purchases: { faction: string; aug: string }[] };
    ns.purchases = purchases;
    return ns;
}

/** A player with effectively unlimited money, in the one faction above. */
function fakePlayer(): Player {
    return {
        factions: [FACTION],
        money: 1e15,
        mults: { faction_rep: 1 },
        skills: { hacking: 100, strength: 1, defense: 1, dexterity: 1, agility: 1 },
    } as unknown as Player;
}

/** A change log sink, discarded: these tests assert on purchases, not on prose. */
function silentLog(): RecentLines {
    return { add: () => {} } as unknown as RecentLines;
}

test("a run does not buy NeuroFlux Governor with its leftover cash", () => {
    // THE REGRESSION. This player can afford it, has the reputation for it, and owns
    // nothing else — so every gate except the skip is open.
    reset();
    const ns = fakeNs({ available: [NEURO], owned: [] });

    buyAffordableAugments(ns, fakePlayer(), [], silentLog());

    assert.deepEqual(
        ns.purchases,
        [],
        "a run bought NeuroFlux during play; it belongs to the retirement sequence only",
    );
});

test("a run does not hold reserve for NeuroFlux either", () => {
    // The target half. A target that is never null makes `plannedReserve` hold cash back
    // on every tick, which is the same mistake with a later symptom: the run stops
    // saving for the augmentation it was actually working toward.
    reset();
    const ns = fakeNs({ available: [NEURO], owned: [] });

    assert.equal(
        getBestAugmentation(ns, fakePlayer(), []),
        null,
        "NeuroFlux was chosen as the run's augmentation target; it can never be satisfied",
    );
});

test("an ordinary augmentation is bought and targeted, so the skips are not a dead loop", () => {
    // THE CONTROL for both tests above. Same fixture, one name different: if the loop or
    // the selection were broken outright, the two regressions would pass while
    // augmentation buying was simply switched off.
    reset();
    const ns = fakeNs({ available: [ORDINARY], owned: [] });
    const player = fakePlayer();

    const target = getBestAugmentation(ns, player, []);
    assert.equal(target?.name, ORDINARY, "an affordable ordinary augmentation was not targeted");

    buyAffordableAugments(ns, player, [], silentLog());
    assert.deepEqual(
        ns.purchases,
        [{ faction: FACTION, aug: ORDINARY }],
        "an affordable ordinary augmentation was not bought",
    );
});

test("NeuroFlux is still skipped when it is the cheapest thing on offer", () => {
    // The realistic shape: a faction sells an ordinary augmentation AND NeuroFlux, and the
    // run has already bought and installed the ordinary one. The only unowned augmentation
    // left is NeuroFlux, which is exactly the moment a run has spare reputation and cash
    // and would start farming it if either skip were missing.
    reset();
    const ns = fakeNs({ available: [ORDINARY, NEURO], owned: [ORDINARY] });
    const player = fakePlayer();

    assert.equal(getBestAugmentation(ns, player, [ORDINARY]), null, "NeuroFlux was targeted");

    buyAffordableAugments(ns, player, [ORDINARY], silentLog());
    assert.deepEqual(ns.purchases, [], "NeuroFlux was bought once everything else was owned");
});

/* ─── MUST-BUY AUGMENTATIONS ─── */

/**
 * An `ns` where price is explicit per augmentation, so "cheaper but better" is expressible.
 *
 * The existing fixture prices everything at zero, which cannot show the defect: with every
 * price equal, highest-price-wins has no preference to get wrong.
 */
function pricedNs(prices: Record<string, number>, rep = 1e12): NS {
    return pricedNsWithRep(prices, () => rep);
}

/** The same, with reputation per augmentation so a rep gate can be exercised. */
function pricedNsWithRep(prices: Record<string, number>, repOf: () => number, repReqOf: () => number = () => 0): NS {
    const names = Object.keys(prices);
    return {
        singularity: {
            getOwnedAugmentations: () => [],
            getFactionRep: repOf,
            getFactionFavor: () => 0,
            getAugmentationsFromFaction: () => names,
            getAugmentationPrereq: () => [],
            getAugmentationRepReq: repReqOf,
            getAugmentationPrice: (aug: string) => prices[aug],
            purchaseAugmentation: () => true,
            donateToFaction: () => false,
            getCurrentWork: () => null,
        },
        gang: { inGang: () => false, getGangFaction: () => null },
        print: () => {},
        tprint: () => {},
        toast: () => {},
        format: { number: (n: number) => String(n), ram: (n: number) => String(n) },
    } as unknown as NS;
}

test("a must-buy augmentation beats a more expensive one", () => {
    // THE BUG, in the shape it was reported: "it does not buy Neuroreceptor Management
    // Implant before very late game". The implant is cheap because its value is a MECHANIC
    // (it removes the focus penalty) rather than a multiplier, and the selector picks the
    // highest price — so any expensive multiplier outbids it forever, whatever the run does.
    reset();
    const EXPENSIVE = "Congruity Implant";
    const ns = pricedNs({
        "Neuroreceptor Management Implant": 5e6,
        [EXPENSIVE]: 5e9,
    });

    assert.equal(
        getBestAugmentation(ns, fakePlayer(), [])?.name,
        "Neuroreceptor Management Implant",
        "the expensive multiplier outbid a must-buy, which is the whole defect",
    );
});

test("The Blade's Simulacrum is a must-buy, under the game's exact name", () => {
    // THE NAME IS THE TEST as much as the ordering is. `sleeves.ts` records a check that
    // compared against "Blade's Simulacrum" while the game's own string is "The Blade's
    // Simulacrum" — a comparison that could never match, failing silently. An entry with
    // the wrong name here would be equally silent: never recognised, never bought, and the
    // capability it unlocks never available.
    reset();
    const ns = pricedNs({
        "The Blade's Simulacrum": 5e6,
        "Congruity Implant": 5e9,
    });

    assert.equal(
        getBestAugmentation(ns, fakePlayer(), [])?.name,
        "The Blade's Simulacrum",
        "the Simulacrum was outbid, or is listed under a name the game never reports",
    );
});

test("a must-buy whose reputation is not met does not stall the run", () => {
    // Reputation cannot be bought with the reserve this protects. Preferring a must-buy
    // unconditionally would make it the target forever on a faction the player has not
    // earned the rep for, and `plannedReserve` would hold cash against a purchase that can
    // never be made — the same failure NeuroFlux would cause if it were ever a target.
    reset();
    // No reputation held, and the must-buy needs 1000 of it. The first version of this test
    // had a requirement of ZERO, which the must-buy legitimately met — the failure was the
    // test describing the wrong situation, not the code misbehaving, and it is worth saying
    // so because "must-buy ignored the rep gate" and "the fixture never set one" look
    // identical from the assertion.
    const ns = pricedNsWithRep(
        { "Neuroreceptor Management Implant": 5e6, "Congruity Implant": 5e9 },
        () => 0,
        () => 1000,
    );

    // With the requirement out of reach and no donatable faction in this fixture, the
    // must-buy must not become the target; the ordinary candidate is equally gated, so the
    // honest answer is null rather than a permanently unsatisfiable target.
    const target = getBestAugmentation(ns, fakePlayer(), []);
    assert.notEqual(
        target?.name,
        "Neuroreceptor Management Implant",
        "a must-buy with unmet reputation became the target, which can never be satisfied",
    );
});
