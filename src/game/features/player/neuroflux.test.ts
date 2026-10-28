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
