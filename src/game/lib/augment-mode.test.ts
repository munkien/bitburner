/*
 * ============================================================================
 * GRAFTING **OR** BUYING, NEVER BOTH
 * ============================================================================
 * Every BitNode gains augmentations one way. Grafting them at The Sphere and purchasing
 * them from a faction are not two optimisations that happen to be available — they are
 * competing answers to the same question, and a run that does both spends its money on a
 * reserve for a purchase while tying its activity slot up in hour-long grafts.
 *
 * WHY THIS FILE EXISTS. The two capabilities were declared independently:
 *
 *   augmentPurchase   excluded in BitNode 8
 *   grafting          unlocked by SF10, BitNode 10, or BitNode 8
 *
 * Each was correct about its own half and nobody owned the interaction. So on any node
 * other than 8 where the grafting API was unlocked — SF10 owned, which is most late
 * profiles — BOTH were satisfied, and the run ran both pipelines. The bug is a composition
 * again, which is why the tests below ask about the PAIR rather than about either rule.
 *
 * The exclusive answer is a table (`augmentMode`) that both capabilities are derived from.
 * These tests assert the invariant that makes the fix worth having: across every BitNode,
 * exactly one of the two is available — never both, never neither.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { augmentMode, deriveCapabilities, type StaticCapabilities } from "./caps.ts";

/**
 * A player with the Singularity and grafting Source Files at full level.
 *
 * SF10 is the interesting case: it unlocks the grafting API on a node where buying is also
 * allowed, which is exactly the composition that used to run both pipelines. Using the
 * most permissive profile means the invariant is tested where it is hardest to hold.
 */
const WELL_EQUIPPED: ReadonlyMap<number, number> = new Map([[4, 1], [10, 3]]);

const BITNODES = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function capsIn(bitNode: number, sourceFiles: ReadonlyMap<number, number> = WELL_EQUIPPED) {
    const staticCaps: StaticCapabilities = { bitNode, sourceFiles };
    return deriveCapabilities(staticCaps, {} as never);
}

/* ─── the invariant ─── */

test("every BitNode buys XOR grafts, never both and never neither", () => {
    for (const bitNode of BITNODES) {
        const caps = capsIn(bitNode);
        const buys = caps.has("augmentPurchase");
        const grafts = caps.has("grafting");

        assert.ok(
            buys !== grafts,
            bitNode === 8
                ? `BitNode 8 reported buys=${buys} grafts=${grafts}; the node with no faction purchases must graft and cannot buy`
                : `BitNode ${bitNode} reported buys=${buys} grafts=${grafts}; a node must have exactly one route to augmentations`,
        );
    }
});

test("BitNode 8 grafts, because it is the node that cannot buy", () => {
    // The one node whose answer is forced by the game rather than chosen.
    const caps = capsIn(8);
    assert.equal(augmentMode(8), "graft");
    assert.equal(caps.has("augmentPurchase"), false, "BitNode 8 cannot purchase from factions");
    assert.equal(caps.has("grafting"), true, "BitNode 8's only route to augmentations is off");
});

test("BitNode 9 BUYS, and does not also graft", () => {
    // THE REPORTED CASE. BN9's multipliers touch Hacknet Servers, stat levels and server
    // money — never `AugmentationMoneyCost` or `AugmentationRepCost` — so it augments
    // normally. The second assertion is the half that used to be missing: an SF10 player in
    // BN9 had both pipelines running.
    const caps = capsIn(9);
    assert.equal(augmentMode(9), "buy");
    assert.equal(caps.has("augmentPurchase"), true, "BitNode 9 augments by purchasing");
    assert.equal(
        caps.has("grafting"),
        false,
        "BitNode 9 also grafted, which spends the run's slot and cash on the purchase it is already working toward",
    );
});

test("SF10 outside BitNode 8 buys and does NOT graft", () => {
    // The composition that produced the bug, stated on its own: the grafting API is
    // unlocked (SF10 = SF.SLEEVES), yet this node's answer is to buy, so the API being
    // available is not the same as grafting being wanted.
    const caps = capsIn(1);
    assert.equal(caps.has("augmentPurchase"), true);
    assert.equal(
        caps.has("grafting"),
        false,
        "grafting ran because the API was unlocked, which ignores which route the node uses",
    );
});

/* ─── what the change must NOT break ─── */

test("exclusivity does not smuggle grafting into a buying node", () => {
    // THE HALF THAT MUST NOT BE LOOSENED. Making grafting the graft-mode answer must not
    // mean "grafting is available because the mode says graft" — the API requirement still
    // gates it. A node in buy mode is the control: neither the mode nor an unlock of the
    // API by number may put grafting back on.
    //
    // BitNode 10 unlocks the grafting API BY NUMBER, so this is the case where the API
    // genuinely is available and the mode is what refuses it. If the exclusivity were ever
    // implemented by weakening the API rule instead, BN10 would graft again.
    const bn10 = capsIn(10, new Map());
    assert.equal(bn10.has("augmentPurchase"), true, "BitNode 10 augments by purchasing");
    assert.equal(
        bn10.has("grafting"),
        false,
        "the API unlock alone satisfied grafting, so the mode is not what decides",
    );
});

test("the node that unlocks grafting by number still satisfies the API rule", () => {
    // BitNode 8 and BitNode 10 both satisfy `grafting`'s API half by being themselves.
    // BitNode 8 is the graft node, so there the API and the mode agree and it grafts.
    const caps = capsIn(8, new Map());
    assert.equal(caps.has("grafting"), true, "BitNode 8 could not reach its own only route");

    // BitNode 10 unlocks the API by number, but it is a BUY node, so the exclusivity
    // overrides the unlock. Pinned because it is the surprising consequence of making
    // grafting strictly the graft-mode answer: BN10 loses grafting it used to do.
    const bn10 = capsIn(10, new Map());
    assert.equal(augmentMode(10), "buy");
    assert.equal(bn10.has("augmentPurchase"), true);
    assert.equal(
        bn10.has("grafting"),
        false,
        "BitNode 10 grafted although it is a buying node; the one shared answer was not applied",
    );
});

test("the reason a buying node cannot graft says so", () => {
    // A feature skipped with a reason the console can print. "unavailable" would not tell a
    // reader why an SF10 player is not grafting in BN9.
    const caps = capsIn(9);
    const reason = caps.unavailableReason("grafting");
    assert.ok(reason !== null, "grafting reported available in a buying node");
    assert.match(reason, /buys augmentations instead/);
});
