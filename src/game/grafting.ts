import type { NS } from "@ns";

import type { Context } from "./lib/context.ts";
import { announce } from "./lib/log.ts";
import { BLADES_SIMULACRUM } from "./lib/caps.ts";
import { hasBladeburnerAction } from "./features/player/activity.ts";

/*
 * ============================================================================
 * GRAFTING
 * ============================================================================
 * Grafts augmentations the player already owns from another faction, which is
 * the only way to get an augmentation without buying it again.
 *
 * This is a feature of its own rather than a step inside `progression` for one
 * specific reason: RAM. Bitburner charges a script's static RAM for every `ns`
 * call in its code, whether or not the call runs, so having `ns.grafting` appear
 * in progression made every player pay 16.25 GB for it. A `try/catch` returned
 * none of that: it is charged for the code path, not the call. Outside BitNode 4
 * that 16.25 GB is then multiplied by 16/4/1 along with everything else
 * Singularity in the module.
 *
 * Registered with `requires: ["grafting"]`, so the RAM is only ever charged to
 * players who have SF10 or are in BitNode 10 and can actually use it.
 * See docs/adr/0002.
 *
 * The `hasBladeburnerAction` guard costs a further ~1 GB of static RAM
 * (`getCurrentAction`), charged under the same rule. That is the price of not
 * cancelling a Bladeburner action to start a graft, and it is paid only by the
 * same players — those who already have grafting at all. It is not conditional on
 * being in the division: the RAM is charged for the call appearing in the code,
 * which is exactly the property this file was split out to manage.
 * ============================================================================
 */

/**
 * Grafting takes real time and cannot be started while other work is running,
 * and the graftable list rarely changes. Once a minute is plenty, so this
 * overrides the registry's interval.
 */
export function intervalMs(): number {
    return 60_000;
}

export function tick(ns: NS, context: Context): void {
    // Never interrupt anything. Grafting is asynchronous, it cannot be started while
    // other work is running, and starting it CANCELS whatever holds the activity slot
    // — so the slot must be free before this does anything.
    //
    // Two checks, because one source of truth is not enough. `getCurrentWork` reports
    // Singularity work (a course, faction job, crime, program, or an in-flight graft)
    // but is BLIND to Bladeburner: the game does not surface Bladeburner actions
    // through it, which is the same fact that has already caused two bugs elsewhere in
    // this framework (see `lib/activity.ts`).
    //
    // So with only the first check, a running contract looked exactly like an idle
    // player here, and `graftAugmentation` silently cancelled it. `hasBladeburnerAction`
    // is the shared predicate for the missing half, and it is the same one `player.ts`
    // uses to yield.
    //
    // It covers RESTING as well as contracts and operations, deliberately. A rest is
    // forced by stamina and gates every action the division can take, so cancelling one
    // to graft is no better than cancelling a contract. Whatever Bladeburner is doing,
    // grafting waits — it is throttled to once a minute and a graft has no deadline,
    // whereas the division's actions do.
    if (ns.singularity.getCurrentWork() !== null) return;
    // Bladeburner actions block the slot UNLESS the run owns The Blade's
    // Simulacrum, which is exactly the augment that stops them doing so. With it,
    // a running contract no longer conflicts with a graft and there is no reason
    // to wait for one.
    if (hasBladeburnerAction(ns, !context.capabilities.has("bladesSimulacrum"))) return;

    const { player } = context.snapshot;
    const target = bestGraft(ns, player.money, context);
    if (target === null) return;

    // Grafting is only possible from New Tokyo.
    if (player.city !== "New Tokyo" && !ns.singularity.travelToCity("New Tokyo")) return;

    if (!ns.grafting.graftAugmentation(target, false)) return;
    // An event, not current state: a finished graft is worth reading tomorrow, and
    // grafting is throttled to once a minute, so nothing repeats it.
    announce(ns, "GRAFT", `Grafting ${target}`, "tx");
}

/**
 * The augmentation to graft next, or null when there is nothing worth grafting.
 *
 * WHAT CAN BE GRAFTED, and the bug this had. `getGraftableAugmentations` returns
 * "the augmentations that you already own" (the game's own words) — grafting is
 * for RE-ACQUIRING an augmentation you own but do not currently have, which is
 * what happens to your installed augmentations when a node reset leaves them
 * behind. The previous version then filtered that list against
 * `getOwnedAugmentations(true)` and kept only entries NOT in it, so it kept
 * `graftable AND NOT owned`, and since `graftable ⊆ owned` that is the empty set
 * every time. The feature could never graft anything.
 *
 * The filter that belongs here is against what is ALREADY INSTALLED: grafting
 * something you currently have would be spending hours to stand still.
 *
 * PRIORITY OVER PRICE. Normally cheapest-first, because graft time scales with
 * price so the cheap ones are the ones that actually finish. A few augmentations
 * are worth more than that ordering implies and jump the queue — see
 * `GRAFT_PRIORITY`.
 */
function bestGraft(ns: NS, money: number, context: Context): string | null {
    // Installed only (no queued): a queued augmentation is not in effect, and
    // re-grafting it would be the same waste as re-grafting an installed one.
    const installed = new Set(safeOwned(ns, false));
    const reserve = context.reserves.cash;

    const candidates = ns.grafting.getGraftableAugmentations()
        .filter(aug => aug !== "NeuroFlux Governor" && !installed.has(aug))
        // The reserve belongs to whoever is saving for a purchase; a graft that
        // would eat it is not worth doing.
        .filter(aug => money - ns.grafting.getAugmentationGraftPrice(aug) >= reserve);

    if (candidates.length === 0) return null;

    // A priority pick wins outright, but only if it is affordable — the filters
    // above have already dropped anything that is not.
    const priority = candidates.find(aug => GRAFT_PRIORITY.has(aug));
    if (priority !== undefined) return priority;

    return candidates
        .sort((a, b) => ns.grafting.getAugmentationGraftPrice(a) - ns.grafting.getAugmentationGraftPrice(b))[0]
        ?? null;
}

/**
 * Augmentations that jump the cheapest-first queue.
 *
 * The Blade's Simulacrum is the reason this exists. It stops Bladeburner actions
 * occupying the player's single activity slot, so with it the division runs
 * ALONGSIDE gang work, training and faction work instead of excluding them — a
 * larger change to how a run spends its time than any other single augmentation,
 * and one no price ordering would ever surface, because graft time scales with
 * price and it is not cheap.
 *
 * It is granted by SF7.3 rather than bought, so `getGraftableAugmentations` only
 * offers it when the run already owns it — grafting is how it is re-acquired on a
 * node where the Source File does not apply.
 */
const GRAFT_PRIORITY: ReadonlySet<string> = new Set([BLADES_SIMULACRUM]);

/**
 * `getOwnedAugmentations` throws without the Singularity API. A graft cannot be
 * started without it either, so an empty list is the honest answer rather than an
 * error to propagate.
 */
function safeOwned(ns: NS, includeQueued: boolean): string[] {
    try {
        return ns.singularity.getOwnedAugmentations(includeQueued);
    } catch {
        return [];
    }
}
