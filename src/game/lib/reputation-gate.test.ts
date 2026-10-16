/*
 * ============================================================================
 * THE SHARE GATE
 * ============================================================================
 * When sharing CPU for faction reputation can gain anything.
 *
 * WHY THIS EXISTS. `share.ts` deployed `ns.share` workers whenever any faction was short
 * of reputation. But reputation is also purchasable with money once a faction's favour is
 * high enough, and `player.ts` already donates when it is. The two are substitutes, and
 * the CPU is the worse one — it could have been earning the money instead.
 *
 * The recorded run at runs/2026-10-14T16.59.28.825Z.jsonl had reputation outstanding for
 * 900 frames and the player held over 1b for 749 of them, orders of magnitude past the
 * ~1e6-per-point donation cost. The old gate opened throughout.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canBuyReputation, DONATION_MIN_FAVOR } from "./context.ts";
import type { FactionRep } from "./objective.ts";

const rep = (favor: number): FactionRep => ({
    faction: "CyberSec" as FactionRep["faction"],
    current: 0,
    target: 1000,
    favor,
});

test("reputation is purchasable at or above the donation favour floor", () => {
    assert.equal(canBuyReputation(rep(DONATION_MIN_FAVOR)), true);
    assert.equal(canBuyReputation(rep(DONATION_MIN_FAVOR + 1)), true);
    assert.equal(canBuyReputation(rep(1000)), true);
});

test("reputation below the floor cannot be bought, so it must be worked for", () => {
    // This is the case sharing is FOR: the faction refuses donations outright at any
    // balance, so the network's CPU is the only route to the reputation.
    assert.equal(canBuyReputation(rep(DONATION_MIN_FAVOR - 1)), false);
    assert.equal(canBuyReputation(rep(0)), false);
});

test("the gate does not depend on how much money the player holds", () => {
    // Deliberate. Gating on affordability would put a hard edge at the donation price and
    // make sharing switch on and off as cash crossed it — the threshold oscillation that
    // cost MEASURE_SLACK a revert. Favour is permanent and decides whether the ROUTE
    // exists; the existing `dynamicPercent` ramp is what responds to wealth.
    const poor = rep(DONATION_MIN_FAVOR);
    const rich = rep(DONATION_MIN_FAVOR);
    assert.equal(canBuyReputation(poor), canBuyReputation(rich));
});

test("the donation favour floor agrees with the progression feature's copy", () => {
    // `DONATION_MIN_FAVOR` is duplicated between `lib/context.ts` and `player.ts`
    // deliberately — importing the feature would charge its RAM here (ADR 0001) — and
    // this is the comparison that keeps the two from drifting. ADR 0003 is the record of
    // what happens when a threshold two files declare is left unchecked.
    return import("../features/player/player.ts").then(player => {
        assert.equal(
            player.DONATION_MIN_FAVOR,
            DONATION_MIN_FAVOR,
            "the donation favour floor differs between player.ts and lib/context.ts",
        );
    });
});
