import type { NS } from "@ns";

import { announce } from "../../../lib/log.ts";
import { findScriptOnHome } from "../../../lib/scripts.ts";
import { scanNetwork } from "../../../lib/network.ts";

/*
 * ============================================================================
 * INSTALL (Standalone Entry)
 * ============================================================================
 * The second half of retirement: stop everything, install, and let the game restart
 * the Orchestrator.
 *
 * Why this is a separate script rather than part of the retirement Feature. Retirement
 * runs inside the Orchestrator, and the first thing this sequence needs to do is stop
 * every script on home — including the Orchestrator. `ns.killall` spares the CALLING
 * script, so this works from here and would have killed the Feature's host from there.
 *
 * It must also outlive the install. `installAugmentations` resets the game, which kills
 * every running script; the game then runs the callback script you pass it. That is the
 * restart mechanism, and it is why the Orchestrator comes back without this script
 * having to start it by hand.
 *
 * Ordering is the whole point of the file, and it is the opposite of what it used to
 * be. The old retirement killed the orchestrator FIRST and only restarted it through
 * the install, so an early return or a throw anywhere in between left the framework
 * dead with nothing to bring it back. Here the teardown is the last thing that happens,
 * and nothing can return early after it.
 * ============================================================================
 */

/** Restarted by the game after the reset, wherever the file sync put it. */
const ORCHESTRATOR = "nexus.ts";

export async function main(ns: NS): Promise<void> {
    ns.ui.openTail();

    const orchestrator = findScriptOnHome(ns, ORCHESTRATOR);
    if (orchestrator === null) {
        // Refuse BEFORE tearing anything down: without a callback the reset would leave
        // the player with no framework and nothing running, which is unrecoverable
        // without noticing.
        announce(ns, "INSTALL", `ERROR: ${ORCHESTRATOR} not on home; refusing to reset with nothing to restart.`, "error");
        return;
    }

    if (queuedAugments(ns) === 0) {
        // Nothing to install. Reported rather than silently doing nothing, because the
        // Feature that spawned this has already liquidated the run's holdings.
        announce(ns, "INSTALL", "Nothing queued to install; leaving the run alone.");
        return;
    }

    announce(ns, "INSTALL", "Stopping all scripts...");
    // Everything except home first, so a worker on a remote host cannot interfere with
    // the install. Home last, and `killall` spares this script, which is the reason it
    // can do the rest.
    for (const host of scanNetwork(ns)) {
        if (host !== "home") ns.killall(host);
    }
    ns.killall("home");

    announce(ns, "INSTALL", `Installing augmentations. ${ORCHESTRATOR} will start after the reset.`);
    // The game runs `orchestrator` after the reset, with 1 thread and no arguments.
    // Passing it here is what makes the restart the game's job rather than ours — the
    // old version called `ns.run` afterwards, which only worked because nothing had
    // thrown in between.
    ns.singularity.installAugmentations(orchestrator);

    await ns.sleep(10_000);
}

/** Purchased but not yet installed. */
function queuedAugments(ns: NS): number {
    try {
        return ns.singularity.getOwnedAugmentations(true).length
            - ns.singularity.getOwnedAugmentations(false).length;
    } catch {
        return 0;
    }
}
