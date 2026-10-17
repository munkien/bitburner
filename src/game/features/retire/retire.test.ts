/*
 * ============================================================================
 * A STALLED INSTALL HANDOFF
 * ============================================================================
 * `handoffStarted` used to latch. Once set, the retirement decision answered "the
 * installer is already running" on every later tick, whether or not anything was
 * running — and `install.ts` refuses and exits without installing in two ordinary cases
 * (no orchestrator on home, nothing queued). The orchestrator survives both, because a
 * refused handoff never killed anything.
 *
 * The reported symptom: nine augmentations bought, and no install, for a whole run.
 *
 * The first test drives `tick` rather than `reconcileHandoff` directly. Calling the
 * helper in isolation proves the helper works and proves nothing about whether the tick
 * uses it — a version of this file that called the helper by hand passed with the call
 * removed from `tick`, which is exactly the vacuous test to avoid.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { tick, markHandoffStartedForTest, reset } from "./retire.ts";
import type { NS } from "@ns";
import type { Context } from "../../lib/context.ts";

/** Nine queued augmentations, none installed — the reported state. */
const QUEUED = Array.from({ length: 9 }, (_, i) => `Aug${i}`);

/**
 * An `ns` with a deployed handoff that is NOT running, and nothing else to do.
 *
 * `liquidate`, `upgradeHome` and `buyNeuroFlux` are all reached once the decision says
 * "retire"; they fail safely here because home has no cash and no scripts, which is the
 * point — the test is about the decision being reachable again, not about the install.
 */
function fakeNs(): NS & { announcements: string[] } {
    const announcements: string[] = [];
    const ns = {
        fileExists: () => true,
        // The handoff script is deployed but not running: it exited without installing.
        scriptRunning: () => false,
        ls: (_host: string, substring: string) => [`/${substring}`],
        getOwnedAugmentations: (includeQueued: boolean) => (includeQueued ? QUEUED : []),
        announce: (_tag: string, message: string) => { announcements.push(message); },
        getServerMaxRam: () => 1024,
        getServerUsedRam: () => 0,
        getServerMoneyAvailable: () => 0,
        getScriptRam: () => 1,
        run: () => 0,
        singularity: {
            getOwnedAugmentations: (includeQueued: boolean) => (includeQueued ? QUEUED : []),
            getAugmentationPrice: () => 1e9,
            getFavorToDonate: () => 150,
            getFactionFavor: () => 0,
            getFactionRep: () => 0,
            upgradeHomeRam: () => false,
            upgradeHomeCores: () => false,
            purchaseAugmentation: () => false,
        },
        sleep: async () => {},
        // `announce` reaches the player through `ns.print`, so that is where a test
        // observes it — not through an `ns.announce` stub, which the real logger
        // never calls.
        print: (line: string) => { announcements.push(line); },
        tprint: () => {},
        toast: () => {},
        writePort: () => true,
        format: { number: (n: number) => String(n), ram: (n: number) => String(n) },
        hacknet: { numHashes: () => 0 },
       } as unknown as NS & { announcements: string[] };
    ns.announcements = announcements;
    return ns;
}

const context = {
    snapshot: { player: { factions: [] }, homeCash: 0 },
    capabilities: { has: () => true },
} as unknown as Context;

test("a tick retries a handoff that exited without installing", () => {
    // THE REGRESSION. With the latch, this tick decided "already started" and returned,
    // for the rest of the run. Driving `tick` is what makes the test fail if the
    // reconcile call is removed from it.
    reset();
    markHandoffStartedForTest();

    const ns = fakeNs();
    tick(ns, context);

    // The decision was reached: retirement announces what it is about to do, which it
    // never does on the "already started" path.
    assert.ok(
        ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
        `retirement was not reached; announced: ${JSON.stringify(ns.announcements)}`,
    );
});

test("a running handoff is not retried", () => {
    // The other half: an install in flight must not be started a second time.
    reset();
    markHandoffStartedForTest();

    const announcements: string[] = [];
    const ns = {
        fileExists: () => true,
        scriptRunning: () => true,
        ls: (_host: string, substring: string) => [`/${substring}`],
        getOwnedAugmentations: (q: boolean) => (q ? QUEUED : []),
        print: (line: string) => { announcements.push(line); },
        writePort: () => true,
        tprint: () => {},
        toast: () => {},
    } as unknown as NS;

    tick(ns, context);
    assert.ok(
        !announcements.some(m => m.includes("INITIATING RETIREMENT")),
        "a running install was retried",
    );
});
