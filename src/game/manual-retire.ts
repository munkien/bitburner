import type { NS } from "@ns";

import { announce } from "./lib/log.ts";
import { findScriptOnHome } from "./lib/scripts.ts";
import type { Context } from "./lib/context.ts";
import { retireNow } from "./features/retire/retire.ts";

/*
 * ============================================================================
 * MANUAL RETIRE (Standalone Entry)
 * ============================================================================
 * Retire now, on demand, instead of waiting for the automatic decision.
 *
 * WHY THIS EXISTS. The automatic rule is deliberately slow: it waits an hour with no
 * augmentation purchased, and it needs more than two queued. That is the right default —
 * it protects a run from resetting before the queue has earned the reputation spent on
 * it — but it makes "I want to stop HERE" impossible to express. This is that, and it is
 * the operator's override rather than a change to the rule.
 *
 * IT RUNS THE SAME SEQUENCE, not a copy of it. `retireNow` is the function the automatic
 * path calls once its clock has elapsed, so a manual retirement liquidates stocks and
 * hashes, buys home upgrades and NeuroFlux Governors, and hands off the install in the
 * same order. A second implementation would eventually disagree with the first, which is
 * the failure `retire-decisions.ts` was created to stop.
 *
 * WHAT IT DOES NOT DO: decide. There is no threshold to satisfy and no minimum queue — you
 * asked, so it runs. The one refusal is an empty queue, because installing with nothing
 * queued resets the game for no gain and would look like the script silently failed.
 *
 * RUN IT WITH:
 *     run manual-retire.js
 *
 * It spawns the same `install.ts` handoff the automatic path uses, which stops every
 * script including the orchestrator and restarts it after the reset. Nothing here needs to
 * survive that, so the script is free to exit.
 * ============================================================================
 */

/**
 * The handoff script, resolved by BASENAME rather than by path.
 *
 * The sync mirrors `src/game` into the game with its directory structure intact, so the
 * file lives at `/features/retire/scripts/install.ts`. `retire.ts` has always resolved it
 * with `findScriptOnHome`, which is why the automatic path works; a fixed root path here
 * would be true only of a hand-copied deploy and would refuse on every synced one.
 */
const HANDOFF_NAME = "install.ts";

export function main(ns: NS): void {
    ns.disableLog("ALL");
    ns.ui.openTail();

    // ── Preflight, all of it BEFORE anything is sold ──
    //
    // Every check that could abandon this runs first. Liquidating is irreversible, and a
    // refusal after it would leave a run with its stocks sold and nothing installed —
    // which is the exact shape of the defect the automatic retirement already fixed.
    //
    // RESOLVED THE SAME WAY THE AUTOMATIC PATH RESOLVES IT, and it must be. The sync
    // mirrors `src/game` into the game with its directories intact, so the handoff lives
    // at `/features/retire/scripts/install.ts`. A fixed root path is true only of a
    // hand-copied deploy, which is why an earlier version of this check refused on every
    // synced one while `retire.ts` went on spawning the file perfectly well.
    if (findScriptOnHome(ns, HANDOFF_NAME) === null) {
        announce(
            ns, "RETIRE",
            `ERROR: ${HANDOFF_NAME} is not on home, so the install cannot run. Deploy it first.`,
            "error",
        );
        return;
    }

    const queued = queuedAugments(ns);
    if (queued <= 0) {
        announce(
            ns, "RETIRE",
            "Nothing queued to install. Buy some augmentations first — a reset with an empty queue gains nothing.",
            "warn",
        );
        return;
    }

    announce(ns, "RETIRE", `=== MANUAL RETIREMENT: ${queued} augmentation(s) queued ===`, "warn");

    // ── The same sequence the automatic path runs ──
    const started = retireNow(ns, manualContext(ns));

    if (!started) {
        // `retireNow` has already reported why (the spawn failed, or a handoff was already
        // running). Repeating the reason here would be the "warns fifty times a second"
        // noise the feature runtime goes out of its way to avoid.
        announce(ns, "RETIRE", "Retirement did not hand off; see the line above.", "warn");
    }
}

/**
 * The smallest `Context` `retireNow` will accept.
 *
 * `retireNow` takes a Context because the automatic path already holds one, and threading
 * a second, feature-shaped way of asking "what does the run have" would be the duplicate
 * source of truth `retire-decisions.ts` exists to prevent. This script has no orchestrator
 * around it, so it builds one instead of asking `retireNow` to do without.
 *
 * A CAST, and the bound is real rather than wishful: `retireNow` reads `snapshot.homeCash`
 * in `tick`'s path only for the stall clock and the decision, neither of which a manual
 * retirement runs — the liquidation between them reads the game directly. Filling in the
 * rest of the snapshot here would mean duplicating `context.ts`'s assembly in a script
 * that needs one field of it.
 */
function manualContext(ns: NS): Context {
    return { snapshot: { homeCash: ns.getServerMoneyAvailable("home") } } as unknown as Context;
}

/**
 * Purchased but not yet installed.
 *
 * THE SAME CLAMP AS `install.ts`, for the same reason and not by accident. The game is
 * free to report the installed and queued lists inconsistently — notably during the tick
 * an install is being processed — and the raw difference of two lengths is then negative.
 * A negative is truthy, so an unclamped check would sail past "nothing queued" and reset
 * the game with nothing to install.
 *
 * Without the Singularity API this throws, and 0 is the right answer: there is nothing
 * this script could install either way.
 */
function queuedAugments(ns: NS): number {
    try {
        return Math.max(
            0,
            ns.singularity.getOwnedAugmentations(true).length
            - ns.singularity.getOwnedAugmentations(false).length,
        );
    } catch {
        return 0;
    }
}
