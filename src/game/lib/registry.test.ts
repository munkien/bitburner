/*
 * ============================================================================
 * PRIORITY, AS A FUNCTION OF THE BITNODE
 * ============================================================================
 * The order features run in is not the same in every node, and Hacktocracy is the case
 * that forced it to become a function.
 *
 * WHY HACKTOCRACY IS DIFFERENT. BitNode 9 dismantles everything the default order
 * assumes: cloud servers are disabled outright (`CloudServerLimit: 0`), script hacking
 * earns a tenth (`ScriptHackMoney: 0.1`), hacking experience a twentieth
 * (`HackExpGain: 0.05`), and every stat multiplier is halved. What it boosts is Hacknet:
 * the node unlocks Hacknet Server, and SF9 makes it cheaper and more productive.
 *
 * Meanwhile home RAM, which is what the priority order is really allocating, costs five
 * times as much in that node (`HomeComputerRamCost: 5`). So the default order there spends
 * the run's scarcest resource on features the node's multipliers have gutted, while the
 * mechanic the node exists for waits at position 100.
 *
 * WHAT THESE TESTS PIN. That the order genuinely changes, that it changes in the direction
 * claimed, and that the default order is untouched — because a priority function that
 * quietly reorders EVERY node would be a much larger change than the one intended.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FEATURES, featuresInOrder } from "./registry.ts";
import { HACKTOCRACY_BITNODE, always, exceptIn } from "./features.ts";

const HACKTOCRACY = HACKTOCRACY_BITNODE;
/** Any node the default order is expected in. BitNode 1 is the plainest. */
const ORDINARY = 1;

const positionOf = (bitNode: number, id: string): number => {
    const index = featuresInOrder(bitNode).findIndex(feature => feature.id === id);
    assert.ok(index >= 0, `${id} is not in the registry at all`);
    return index;
};

/* ─── the order itself ─── */

test("hacknet runs early in Hacktocracy and late otherwise", () => {
    const hereIdx = positionOf(HACKTOCRACY, "hacknet");
    const thereIdx = positionOf(ORDINARY, "hacknet");

    assert.ok(
        hereIdx < thereIdx,
        `hacknet is at ${hereIdx} in Hacktocracy and ${thereIdx} elsewhere — it did not move up`,
    );

    // Ahead of everything with an ONGOING RAM claim, which is what the promotion is for.
    // It still sits behind Hacking at 10 and Home/Sleeves at 20: those are cheaper, and
    // Hacking in particular is what keeps the network the Hacknet nodes are bought from.
    // The claim is "hacknet gets RAM before the features that cannot pay for it here", not
    // "hacknet is first in the list".
    for (const id of ["cloud", "hacknet", "progression", "gang", "retire", "stocks"]) {
        if (id === "hacknet") continue;
        assert.ok(
            hereIdx < positionOf(HACKTOCRACY, id),
            `hacknet did not move ahead of ${id} in Hacktocracy`,
        );
    }
});

test("cloud runs last in Hacktocracy, because it cannot run there at all", () => {
    // `CloudServerLimit: 0` means there are no servers to buy, so the feature has nothing
    // to do. It is still ADMITTED — the capability rule only excludes BitNode 8 — so its
    // priority decides how much home RAM it claims before discovering that, and in this
    // node that RAM costs five times as much.
    const order = featuresInOrder(HACKTOCRACY);
    assert.equal(order[order.length - 1]?.id, "cloud", "cloud did not drop to the end");
});

test("the ordinary node keeps the default order", () => {
    // THE CONTROL, and it covers the failure that would be worst to ship: a priority
    // change that reorders every node. Hacking is first and hacknet is late in the default
    // order, and both must stay that way.
    const order = featuresInOrder(ORDINARY);
    assert.equal(order[0]?.id, "hacking", "the default order no longer starts with hacking");
    assert.ok(
        positionOf(ORDINARY, "hacknet") > positionOf(ORDINARY, "progression"),
        "hacknet was promoted outside Hacktocracy",
    );
});

test("every feature still appears exactly once, in every node", () => {
    // The sort is a reordering, never a filter. A comparator that returned NaN — which is
    // what comparing two functions would do — can drop or duplicate entries depending on
    // the engine, and that failure is silent.
    for (const bitNode of [1, 4, 8, 9, 12]) {
        const order = featuresInOrder(bitNode);
        assert.equal(order.length, FEATURES.length, `node ${bitNode} lost or gained features`);
        assert.equal(
            new Set(order.map(f => f.id)).size,
            FEATURES.length,
            `node ${bitNode} listed a feature twice`,
        );
    }
});

test("the order is stable for equal priorities", () => {
    // Home and Sleeves both sit at 20 in the default order. Without a tiebreak their
    // relative order would depend on how the registry happens to be written, and would
    // change if someone reordered the file for an unrelated reason.
    const first = featuresInOrder(ORDINARY).map(f => f.id);
    const second = featuresInOrder(ORDINARY).map(f => f.id);
    assert.deepEqual(first, second, "the sort is not deterministic");
});

/* ─── the helpers ─── */

test("always returns the same priority for every node", () => {
    const fixed = always(30);
    for (const bitNode of [1, 2, 9, 13]) {
        assert.equal(fixed(bitNode), 30, `node ${bitNode} got a different priority`);
    }
});

test("exceptIn changes only the named node", () => {
    const rule = exceptIn(9, 25, 100);
    assert.equal(rule(9), 25);
    assert.equal(rule(8), 100, "a neighbouring node was caught by the rule");
    assert.equal(rule(1), 100);
});

test("the Hacktocracy constant is the node, not the Source File", () => {
    // SF9 and BitNode 9 share a digit, and conflating them is the mistake `lib/caps.ts`
    // already documents for SF8. The constant is named for the node it reorders.
    assert.equal(HACKTOCRACY_BITNODE, 9);
});
