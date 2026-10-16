import type { NS } from "@ns";

import { basename, findScriptOnHome } from "./scripts.ts";

/*
 * ============================================================================
 * RAM BUDGET
 * ============================================================================
 * The orchestrator's RAM accounting, as one module.
 *
 * Why this exists. Bitburner charges each running script for every `ns` call in
 * its code, so a framework that loads features on demand has to reserve their RAM
 * by hand. That accounting was spread over four functions inside the
 * orchestrator's `main`, and three defects landed in it:
 *
 *   09dc8ee  a refused reservation was treated as a success
 *   851ce9c  the baseline was read from `ramOverride()`, which returns the limit
 *            the game assigned (home's total RAM) rather than the script's cost,
 *            so a 6 GB feature was refused on a home with 3 TB free
 *   8eec956  one path form was given to two APIs that want different forms
 *
 * The common thread: four facts about the game that no type expressed, so every
 * caller had to remember them. They are sealed behind this interface instead.
 *
 * The facts:
 *   1. A dynamically imported feature is charged to the orchestrator's own
 *      thread, so its cost is ADDED to the orchestrator's cost, not held beside
 *      it. The running total is therefore the thing that must fit.
 *   2. `ns.ramOverride(ram)` does not throw when it cannot grant. It returns the
 *      limit unchanged, so a caller must compare what it asked for with what it
 *      got. Every write here checks the return value for that reason.
 *   3. `ns.ramOverride()` with no argument returns the script's CURRENT static
 *      limit per thread, which for a script started without an explicit limit is
 *      the server's total RAM. It is not the script's own cost, and reading it as
 *      such is defect 851ce9c.
 *   4. `ns.getScriptRam` takes a host and accepts an absolute path;
 *      `ns.dynamicImport` takes no host and wants the registry's relative form.
 *
 * The interface is the question the orchestrator asks: "reserve room for this
 * feature, and tell me whether it worked and why not". Tests cross the same seam
 * the orchestrator does, rather than reimplementing the rules in a local model,
 * which is what the two deleted test files did.
 * ============================================================================
 */

/** RAM is rounded to 1/100 GB, so an exact comparison reports false refusals. */
const EPSILON_GB = 0.01;

/**
 * A running reservation.
 *
 * Mutable by design: the orchestrator holds one for the whole run and every load
 * adds to it. `gb` is what the game has actually granted, which is not always
 * what was asked for — see fact 2 above. It is read and written only through the
 * functions below, so the invariant lives here rather than at each call site.
 */
export interface RamBudget {
    gb: number;
}

/** Why a feature's RAM could not be reserved, or its script could not be found. */
export type ReserveFailure =
    | { readonly kind: "not-deployed"; readonly path: string }
    | { readonly kind: "not-compilable"; readonly resolvedPath: string }
    | { readonly kind: "no-room"; readonly neededGb: number; readonly freeGb: number }
    | { readonly kind: "refused"; readonly wantedGb: number; readonly grantedGb: number };

/**
 * The orchestrator's own RAM cost, which every feature is added to.
 *
 * Read from `ns.getScriptName()` rather than `ns.ramOverride()` because of fact 3:
 * the latter reports the limit the game assigned, not what this script costs.
 */
export function orchestratorRamGb(ns: NS): number {
    return ns.getScriptRam(ns.getScriptName(), "home");
}

/** Start a budget at the orchestrator's own cost. */
export function createBudget(ns: NS): RamBudget {
    return { gb: orchestratorRamGb(ns) };
}

/** Home RAM available to the orchestrator right now, in GB. */
export function freeHomeRamGb(ns: NS): number {
    return Math.max(0, ns.getServerMaxRam("home") - ns.getServerUsedRam("home"));
}

/**
 * Whether `ramGb` more would fit alongside what is already reserved.
 *
 * Fact 1: reservations are charged to home immediately, so `freeHomeRamGb`
 * already accounts for everything loaded so far. Subtracting the reservation
 * again would double-count, which is what defect 09dc8ee's sibling did.
 */
export function fits(ns: NS, ramGb: number): boolean {
    return ramGb <= freeHomeRamGb(ns);
}

/**
 * Find a feature's script and read its cost.
 *
 * Separates "not there" from "there but will not compile", because `getScriptRam`
 * returns 0 for both and they need different fixes: one is a deployment problem,
 * the other a build problem. Conflating them is why a missing-file message was
 * once printed for a file that was present in the repo.
 */
export function lookupFeature(
    ns: NS,
    path: string,
): { ok: true; resolvedPath: string; ramGb: number } | { ok: false; failure: ReserveFailure } {
    // Fact 4: getScriptRam wants the absolute form.
    const resolvedPath = findScriptOnHome(ns, basename(path));
    if (resolvedPath === null) return { ok: false, failure: { kind: "not-deployed", path } };

    const ramGb = ns.getScriptRam(resolvedPath, "home");
    if (ramGb <= 0) return { ok: false, failure: { kind: "not-compilable", resolvedPath } };

    return { ok: true, resolvedPath, ramGb };
}

/**
 * Reserve `ramGb` on top of the current reservation.
 *
 * Fact 2: the check is on what was granted versus what was asked for, not on
 * whether the call threw. On refusal the budget is restored exactly, so a later
 * feature can still try and a partial grant cannot corrupt the total.
 */
export function reserve(
    budget: RamBudget,
    ns: NS,
    ramGb: number,
): { ok: true; grantedGb: number } | { ok: false; failure: ReserveFailure } {
    const wanted = budget.gb + ramGb;
    const granted = ns.ramOverride(wanted);

    if (granted < wanted - EPSILON_GB) {
        ns.ramOverride(budget.gb);
        return { ok: false, failure: { kind: "refused", wantedGb: wanted, grantedGb: budget.gb } };
    }

    budget.gb = granted;
    return { ok: true, grantedGb: granted };
}

/** Release a reservation, as a failed import does. */
export function release(budget: RamBudget, ns: NS, ramGb: number): void {
    budget.gb = Math.max(0, budget.gb - ramGb);
    ns.ramOverride(budget.gb);
}

/**
 * Describe a failure for the log, in the terms the fix requires.
 *
 * Returns the message and its `level` separately rather than a prefixed string.
 * The prefix used to be baked into the text (`"WARN: …"`), which meant the level
 * had to be re-parsed out of the message by whoever logged it — and in practice
 * was not, so every one of these was logged at the same level regardless of
 * whether it was a fault or a note. The level is data; this is where it is chosen.
 *
 *   not-deployed   a warning: expected on a node that cannot have the feature
 *   not-compilable an error: the file is there and broken, which is a real defect
 *   no-room        a warning: transient, and it resolves as RAM frees up
 *   refused        a warning: the game declined the override, also transient
 */
export function describeFailure(
    ns: NS,
    name: string,
    failure: ReserveFailure,
): { message: string; level: "warn" | "error" } {
    switch (failure.kind) {
        case "not-deployed":
            return { message: `${name} not deployed (${failure.path})`, level: "warn" };
        case "not-compilable":
            return {
                message: `${name} is deployed but would not compile (${failure.resolvedPath})`,
                level: "error",
            };
        case "no-room":
            return {
                message: `${name} needs ${ns.format.ram(failure.neededGb, 0)} but only ` +
                    `${ns.format.ram(failure.freeGb, 0)} of home RAM is free`,
                level: "warn",
            };
        case "refused":
            return {
                message: `${name} could not raise the orchestrator's RAM to ` +
                    `${ns.format.ram(failure.wantedGb, 0)} (granted ${ns.format.ram(failure.grantedGb, 0)})`,
                level: "warn",
            };
    }
}
