import type { NS } from "@ns";

import type { Context } from "../../lib/context.ts";
import { announce } from "../../lib/log.ts";
import { findScriptOnHome } from "../../lib/scripts.ts";
import { INSTALL_THRESHOLD, decideRetirement } from "./retire-decisions.ts";

/*
 * ============================================================================
 * RETIREMENT (Feature)
 * ============================================================================
 * The deliberate end of a run: liquidate, spend on things that survive the reset, then
 * hand off the install and restart.
 *
 * Why this is now a Feature, and where the boundary is. Retirement used to be a
 * Standalone Entry that began by calling `ns.killall("home")` — safe, because
 * `killall` spares the calling script. As a Feature it runs INSIDE the Orchestrator,
 * so that same call would kill the thing running it, and the Orchestrator is what
 * would have restarted it. A Feature cannot kill its own driver and survive.
 *
 * So the sequence is split by what each half can do:
 *
 *   this Feature   the in-run work: liquidate stocks and hashes, buy home upgrades,
 *                  buy NeuroFlux Governors. None of it needs the network stopped, and
 *                  all of it leaves the run playable if it fails.
 *   the handoff    a small standalone script that stops everything, installs, and lets
 *                  the game restart the Orchestrator. It must be a separate script
 *                  because it has to outlive the killall.
 *
 * The split also fixes a real defect in the old order. That version killed the
 * orchestrator FIRST and only restarted it through `installAugmentations`, so an early
 * return or a throw anywhere in between left the framework dead with nothing to bring
 * it back. Now nothing is torn down until the install is certain.
 * ============================================================================
 */

/** The standalone half, resolved at runtime like every other spawned script. */
const HANDOFF_NAME = "install.ts";

/** Retirement is not urgent: it is checked on a slow cadence by the registry. */
export function intervalMs(): number {
    return 60_000;
}

let handoffStarted = false;

/** Forget the one-shot flag. Exported for tests, like the other features' resets. */
export function reset(): void {
    handoffStarted = false;
}

/**
 * Put the module back into the state a stalled run reaches: a handoff that was started
 * and never finished. Exported for tests only — there is no runtime path that should set
 * this directly, because the flag is owned by `reconcileHandoff` and `handoff`.
 */
export function markHandoffStartedForTest(): void {
    handoffStarted = true;
}

export function tick(ns: NS, context: Context): void {
    // Reconcile before deciding: a handoff that exited without installing must not keep
    // the decision answering "already running" for the rest of the run.
    reconcileHandoff(ns);

    const facts = readFacts(ns, context);
    const verdict = decideRetirement(facts);

    if (verdict.kind === "wait") {
        // Once per state rather than every tick. A feature that reports "not yet" every
        // minute for a whole run is noise, and the reason changes rarely.
        return;
    }

    announce(ns, "RETIRE", `=== INITIATING RETIREMENT: ${verdict.reason} ===`, "warn");

    // In-run work first, and each step is independent: a failure in one leaves the run
    // playable rather than half-torn-down, which is the property the old ordering lost.
    const gained = liquidate(ns);
    const upgraded = upgradeHome(ns);
    const neuro = buyNeuroFlux(ns);

    announce(
        ns, "RETIRE",
        `Liquidated $${ns.format.number(gained)}; home +${upgraded.ram} RAM +${upgraded.cores} cores; ` +
        `bought ${neuro} NeuroFlux Governor(s).`,
    );

    handoff(ns);
}

/** What the run looks like to the decision, read from the snapshot where possible. */
function readFacts(ns: NS, context: Context): Parameters<typeof decideRetirement>[0] {
    const installed = safeOwned(ns, false);
    const all = safeOwned(ns, true);

    return {
        // Counted from the two lists rather than trusting one: `queued` is what is in
        // `all` but not in `installed`, which is the game's own definition.
        queued: all.filter(aug => !installed.includes(aug)).length,
        installed: installed.length,
        factions: context.snapshot.player.factions.length,
        cash: context.snapshot.homeCash,
        canInstall: context.capabilities.has("singularity"),
        alreadyStarted: handoffStarted,
    };
}

/** `getOwnedAugmentations` throws without the Singularity API, so the count is 0 then. */
function safeOwned(ns: NS, includeQueued: boolean): string[] {
    try {
        return ns.singularity.getOwnedAugmentations(includeQueued);
    } catch {
        return [];
    }
}

/**
 * Sell everything that will not survive the reset.
 *
 * Stocks and Hacknet hashes both become cash, and cash is what the home upgrades and
 * NeuroFlux Governors are bought with. Both are best-effort: neither can leave the run
 * worse off than not trying, so neither is allowed to stop the sequence.
 */
function liquidate(ns: NS): number {
    let total = 0;

    try {
        if (ns.stock.hasWseAccount() && ns.stock.hasTixApiAccess()) {
            for (const symbol of ns.stock.getSymbols()) {
                const [shares, avgPx, shortShares, avgShortPx] = ns.stock.getPosition(symbol);
                if (shares > 0) total += (ns.stock.sellStock(symbol, shares) - avgPx) * shares;
                if (shortShares > 0) total += (avgShortPx - ns.stock.sellShort(symbol, shortShares)) * shortShares;
            }
        }
    } catch {
        announce(ns, "RETIRE", "Stock liquidation failed; continuing.");
    }

    try {
        const sell = "Sell for Money";
        const n = Math.floor(ns.hacknet.numHashes() / ns.hacknet.hashCost(sell));
        if (n > 0) ns.hacknet.spendHashes(sell, "", n);
    } catch {
        // No Hacknet, or no hashes. Not worth reporting: the common case early on.
    }

    return total;
}

/**
 * Home RAM and cores, which persist across a reset.
 *
 * These are the only permanent purchases retirement makes, so they are done before
 * NeuroFlux: a Governor is lost if the augmentations are not installed, and these are
 * not lost either way.
 */
function upgradeHome(ns: NS): { ram: number; cores: number } {
    let ram = 0;
    let cores = 0;

    try {
        while (ns.singularity.upgradeHomeRam()) ram += 1;
    } catch {
        // Ran out of money, or the API refused. Either way the loop is done.
    }

    try {
        while (ns.singularity.upgradeHomeCores()) cores += 1;
    } catch {
        // As above.
    }

    return { ram, cores };
}

/**
 * Buy NeuroFlux Governors with whatever is left.
 *
 * Cheapest-value-per-rep first among the factions that sell it: a donation is only
 * worth making when the faction's favour allows it, and the faction with the highest
 * reputation needs the smallest donation.
 */
function buyNeuroFlux(ns: NS): number {
    const NEURO = "NeuroFlux Governor";
    let count = 0;

    try {
        const player = ns.getPlayer();
        const repMult = player.mults.faction_rep || 1;
        const donateFavor = ns.getFavorToDonate();
        const sellers = player.factions.filter(faction =>
            ns.singularity.getAugmentationsFromFaction(faction).includes(NEURO));

        // Bounded rather than `while (true)`: the loop always breaks when nothing is
        // bought, but a bound makes it provably terminate if the game ever reports a
        // purchase that did not change the price.
        for (let attempt = 0; attempt < 100; attempt++) {
            const price = ns.singularity.getAugmentationPrice(NEURO);
            const money = ns.getServerMoneyAvailable("home");
            if (money < price) break;

            const repRequired = ns.singularity.getAugmentationRepReq(NEURO);
            const ranked = sellers
                .map(faction => ({ faction, rep: ns.singularity.getFactionRep(faction) }))
                .sort((a, b) => b.rep - a.rep);

            let bought = false;
            for (const { faction, rep } of ranked) {
                if (rep < repRequired) {
                    if (ns.singularity.getFactionFavor(faction) < donateFavor) continue;
                    const donation = Math.ceil(((repRequired - rep) * 1e6) / repMult);
                    if (money < price + donation) continue;
                    if (!ns.singularity.donateToFaction(faction, donation)) continue;
                }
                if (ns.singularity.purchaseAugmentation(faction, NEURO)) {
                    bought = true;
                    break;
                }
            }

            if (!bought) break;
            count += 1;
        }
    } catch {
        announce(ns, "RETIRE", "NeuroFlux purchase stopped early; continuing.", "warn");
    }

    return count;
}

/**
 * Hand the install to a script that can outlive the teardown.
 *
 * The handoff, not this Feature, does the `killall`: this runs inside the Orchestrator,
 * so it cannot stop the machine it is running on. The script is spawned once and
 * remembered, because a second copy would fight the first for the same augmentations.
 *
 * Failing to spawn it is reported loudly rather than silently retried: the run has
 * already liquidated its holdings by now, so the player needs to know that the install
 * did not happen and can be started by hand.
 */
function handoff(ns: NS): void {
    const file = findScriptOnHome(ns, HANDOFF_NAME);
    if (file === null) {
        announce(
            ns, "RETIRE",
            `ERROR: ${HANDOFF_NAME} is not deployed, so the install cannot run. ` +
            `The run is still playable; start the install by hand if ${HANDOFF_NAME} appears.`,
        );
        return;
    }

    if (ns.scriptRunning(file, "home")) {
        handoffStarted = true;
        return;
    }

    const pid = ns.run(file, 1);
    if (pid > 0) {
        handoffStarted = true;
        announce(ns, "RETIRE", `Install started (${file}, PID ${pid}). The Orchestrator will stop shortly.`, "success");
        return;
    }

    announce(ns, "RETIRE", `ERROR: failed to start ${file}. Retrying next tick.`, "error");
}

/**
 * Whether the handoff we started is still in flight.
 *
 * THE FLAG USED TO LATCH, AND THAT STALLED RUNS WITH AUGMENTATIONS QUEUED. Once
 * `handoffStarted` was set the decision returned "the installer is already running" on
 * every later tick, whether or not anything was. `install.ts` refuses and exits without
 * installing in two ordinary cases — the orchestrator is not on home, or nothing is
 * actually queued — and the orchestrator survives both, because a refused handoff never
 * killed anything. So the run reported an installer that had already exited, forever, with
 * nine augmentations bought and no install.
 *
 * Cleared here rather than in the failure paths inside `install.ts`: that script may be
 * killed or reset mid-flight, and a flag it is responsible for clearing would leak in
 * exactly the cases that matter. The orchestrator is the only process that observes the
 * outcome, so the orchestrator is the one that reconciles it.
 */
export function reconcileHandoff(ns: NS): void {
    if (!handoffStarted) return;
    const file = findScriptOnHome(ns, HANDOFF_NAME);
    // Deployed but not running: it exited without installing. Reset so the next tick can
    // try again, and say so once — silence here is what made the stall look like patience.
    if (file !== null && !ns.scriptRunning(file, "home")) {
        handoffStarted = false;
        announce(
            ns, "RETIRE",
            `The install handoff exited without installing; retrying. ` +
            `(${HANDOFF_NAME} reports its reason above.)`,
            "warn",
        );
    }
}
