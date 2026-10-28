import type { NS } from "@ns";

import { detectCapabilities, type Capabilities } from "./caps.ts";
import type { Context } from "./context.ts";
import { isFeatureModule, unavailableReason, type FeatureMeta, type FeatureModule } from "./features.ts";
import { featuresInOrder } from "./registry.ts";
import { announce, type MessageLevel } from "./log.ts";
import {
    createBudget,
    describeFailure,
    fits,
    lookupFeature,
    release,
    reserve,
    type RamBudget,
} from "./ram-budget.ts";

/*
 * ============================================================================
 * FEATURE RUNTIME
 * ============================================================================
 * Everything the orchestrator does to its features, behind one method.
 *
 * Why this exists. This was the whole body of `nexus.ts`'s `main`, interleaved
 * with the loop that called it, so neither half could be exercised without the
 * other. The RAM gate, the load cooldowns and the tick cadence could only be
 * reached by starting the loop and racing a timer.
 *
 * The seam is `pass`. A caller supplies this pass's `Context` and the capability
 * reading it was built from, and gets back whether the pass worked. Everything
 * else — which features are loaded, how much RAM they were allowed, how long a
 * failure silences one, how often each is ticked — is behind that seam.
 *
 * What is deliberately NOT here:
 *
 *   - The capability refresh cadence. `main` re-reads capabilities on its own
 *     interval, because it is also what builds the `Context` the tick receives,
 *     and a runtime that refreshed them would be deciding what a pass's input
 *     is rather than consuming it.
 *   - The managed scripts. Those are separate scripts with their own RAM and no
 *     `tick`, so they are Standalone Entries rather than Features (see
 *     GLOSSARY.md), and an augmentation reset restarts them for a different
 *     reason than a feature is loaded.
 *   - The loop itself: sleeping, counting consecutive failures, deciding to
 *     stop, clearing the log, drawing the dashboard. A `pass` that fails reports
 *     it and returns; what to do about a run of failures is the loop's business.
 *
 * Two facts about the game, both easy to break and both preserved here:
 *
 *   - Features are loaded with `dynamicImport` and their RAM is accounted for by
 *     hand with `ramOverride`, because `dynamicImport` does not adjust a script's
 *     RAM usage. See docs/adr/0001.
 *   - A feature that turns out to be unavailable is not retried on every pass.
 *     Anything that warns fifty times a second is a bug, so both "cannot load"
 *     and "cannot run" are remembered with a cooldown (see ADR-0002 for why the
 *     RAM is charged the way it is).
 * ============================================================================
 */

const SECOND = 1_000;
/** Re-running the load phase every 20 ms is wasted work. */
const LOAD_INTERVAL_MS = SECOND;
/** How long to wait before retrying a feature that failed to load or threw. */
export const RETRY_MS = 10_000;

type FeatureState = "active" | "unavailable" | "unloadable" | "failed" | "disabled";

/** What the orchestrator knows about one feature between passes. */
export interface FeatureStatus {
    readonly meta: FeatureMeta;
    state: FeatureState;
    module: FeatureModule | null;
    /** RAM charged for this feature, in GB. Zero while it is not loaded. */
    ramGb: number;
    /**
     * The last status reported for this feature, so it is reported once rather
     * than every pass.
     *
     * The LEVEL is part of the identity, not just the text: the same sentence can
     * mean different things at different levels, and deduplicating on text alone
     * would swallow a change from "warn" to "error".
     */
    reported: { message: string; level: MessageLevel } | null;
    /** Tick is not offered again before this timestamp. */
    nextAttemptAt: number;
    /** Tick was last offered at this timestamp, for `meta.intervalMs`. */
    lastTickAt: number;
}

/**
 * The feature runtime's interface: one pass, one answer.
 *
 * `ok` is false when the pass itself failed — the game threw while loading, or a
 * feature threw while being ticked and the runtime could not recover. `main`
 * counts those and stops after too many in a row. A feature that is merely
 * unavailable or unloadable is not a failed pass: that is the framework
 * degrading by dropping a feature, which is its designed behaviour.
 *
 * `status()` exists for the dashboard, which reports what happened rather than
 * deciding anything. It is a read of the module's state, not a second interface:
 * nothing that changes behaviour goes through it.
 */
export interface FeatureRuntime {
    pass(context: Context, capabilities: Capabilities): Promise<{ ok: boolean; error?: unknown }>;
    status(): readonly FeatureStatus[];
}

export function createFeatureRuntime(ns: NS): FeatureRuntime {
    // SORTED ONCE, HERE, and the order of this array is the whole priority mechanism:
    // `load` walks it to decide who gets home RAM first, and `tickAll` walks it to decide
    // what runs first. Sorting in the registry rather than at each site keeps the two from
    // disagreeing — and they would, because `priority` depends on the BitNode, which only
    // this function has read at this point.
    //
    // The node is read before the states are built so the order is right from the first
    // pass. `detectCapabilities` costs one `getResetInfo`, which this already pays for on
    // the same call path.
    const bitNode = detectCapabilities(ns).bitNode;
    const states: FeatureStatus[] = featuresInOrder(bitNode).map((meta): FeatureStatus => ({
        meta,
        state: "unavailable",
        module: null,
        ramGb: 0,
        reported: null,
        nextAttemptAt: 0,
        lastTickAt: 0,
    }));

    // The orchestrator's own RAM, which every feature is added to. Read from the
    // script's declared cost rather than from `ramOverride()`, which returns the
    // limit the game picked (home's total RAM) rather than what this script
    // actually needs. `budget.gb` tracks what we have asked for, because
    // `ramOverride` reports refusals by returning the old value.
    const budget: RamBudget = createBudget(ns);

    let lastLoadAt = 0;

    return {
        async pass(context: Context, capabilities: Capabilities): Promise<{ ok: boolean; error?: unknown }> {
            try {
                const now = Date.now();

                if (now - lastLoadAt >= LOAD_INTERVAL_MS) {
                    lastLoadAt = now;
                    await load(ns, { ...context, capabilities }, states, budget);
                }

                await tickAll(ns, states, context);
                return { ok: true };
            } catch (error) {
                return { ok: false, error };
            }
        },
        status: () => states,
    };

    /**
     * Load every feature whose requirements and RAM are met.
     *
     * `capabilities` is passed rather than read from `context`, because the caller
     * refreshes it on its own cadence and the two must agree: the `Context` a
     * feature ticks with and the requirements it was admitted under are the same
     * reading.
     */
    async function load(
        ns: NS,
        context: Context & { capabilities: Capabilities },
        states: FeatureStatus[],
        budget: RamBudget,
    ): Promise<void> {
        const now = Date.now();
        const reserves = context.reserves;

        // Home RAM the features that did not fit are still waiting for. Published
        // as a reserve so the hacking feature does not take that RAM for its
        // workers.
        let pendingRamGb = 0;

        for (const state of states) {
            // The operator's switch comes FIRST: a disabled feature is refused
            // before capability or RAM are considered, and an already-loaded one
            // is unloaded and its RAM released. That ordering matters — otherwise
            // a disabled feature could still be admitted on a pass where it
            // happened to fit, and the operator's instruction would be ignored.
            if (context.disabled.has(state.meta.id)) {
                if (state.state === "active" && state.module !== null) {
                    release(budget, ns, state.ramGb);
                    state.module = null;
                    state.ramGb = 0;
                    reportOnce(ns, state, `${state.meta.name} disabled by operator`);
                }
                if (state.state !== "disabled") {
                    state.state = "disabled";
                }
                continue;
            }

            if (state.state === "active") continue;
            if (now < state.nextAttemptAt) continue;

            const reason = unavailableReason(state.meta, context);
            if (reason !== null) {
                state.state = "unavailable";
                // Availability can change without a reload (the player buys the
                // TIX API), so this is re-checked every load pass, but only logged
                // on change.
                reportOnce(ns, state, `${state.meta.name} skipped: ${reason}`);
                continue;
            }

            reportOnce(ns, state, "");

            // Which path form each API wants, and the difference between "not
            // there" and "there but will not compile", are the budget module's
            // business. It returns the failure in the terms the fix requires.
            const lookup = lookupFeature(ns, state.meta.path);
            if (!lookup.ok) {
                state.state = "unloadable";
                const failure = describeFailure(ns, state.meta.name, lookup.failure);
                reportOnce(ns, state, failure.message, failure.level);
                state.nextAttemptAt = now + RETRY_MS;
                continue;
            }

            // Reservations are charged to home immediately, so the free figure
            // already accounts for everything loaded so far.
            if (!fits(ns, lookup.ramGb)) {
                // Genuine RAM shortfall. Lower priorities wait until it clears.
                pendingRamGb += lookup.ramGb;
                continue;
            }

            if (await importFeature(ns, state, state.meta.path, lookup.ramGb, budget)) continue;
            // A load that failed because the reservation was refused is already
            // counted: the RAM is genuinely unavailable, so lower priorities must
            // treat it as spoken for rather than retrying it immediately.
            pendingRamGb += lookup.ramGb;
        }

        reserves.homeRamGb = pendingRamGb;
    }
}

/**
 * Charge a feature's RAM and import it, keeping the reservation only if the
 * import produced a usable feature.
 *
 * The reservation itself, and the game's habit of reporting a refusal by
 * returning the unchanged limit, belong to `lib/ram-budget.ts`. What stays here
 * is the part that is about features rather than RAM: a module that cannot be
 * ticked is not a feature, and the reservation has to come back before the next
 * feature tries.
 */
async function importFeature(
    ns: NS,
    state: FeatureStatus,
    /**
     * The registry's path, which is relative to the orchestrator and is what
     * `dynamicImport` expects. `lookupFeature` handles the absolute form that
     * `getScriptRam` wants, so the two are never confused.
     */
    path: string,
    ramRequired: number,
    budget: RamBudget,
): Promise<boolean> {
    const reserved = reserve(budget, ns, ramRequired);
    if (!reserved.ok) {
        state.state = "unloadable";
        const failure = describeFailure(ns, state.meta.name, reserved.failure);
        reportOnce(ns, state, failure.message, failure.level);
        state.nextAttemptAt = Date.now() + RETRY_MS;
        return false;
    }

    try {
        const module: unknown = await ns.dynamicImport(path);
        if (!isFeatureModule(module)) {
            release(budget, ns, ramRequired);
            state.state = "unloadable";
            // Report what came back, not just that it was wrong. A resolved but
            // empty module and a module whose `tick` is not a function look
            // identical from the outside and have different causes.
            reportOnce(
                ns,
                state,
                `ERROR: ${state.meta.name} has no tick() export: imported ${describeImport(module)}`,
            );
            return false;
        }

        state.module = module;
        state.ramGb = ramRequired;
        state.state = "active";
        state.nextAttemptAt = 0;
        reportOnce(ns, state, `${state.meta.name} loaded (${ns.format.ram(ramRequired, 0)})`);
        return true;
    } catch (error) {
        release(budget, ns, ramRequired);
        state.ramGb = 0;
        state.state = "failed";
        reportOnce(ns, state, `${state.meta.name} failed to load: ${describeError(error)}`, "error");
        state.nextAttemptAt = Date.now() + RETRY_MS;
        return false;
    }
}

/**
 * Offer every active feature a tick, in registry order.
 *
 * A faulting feature is isolated: it is stopped until its cooldown expires rather
 * than taking the pass with it. Only a failure here that escapes the per-feature
 * catch — none does today — would fail the pass.
 */
async function tickAll(ns: NS, states: readonly FeatureStatus[], context: Context): Promise<void> {
    const now = Date.now();

    for (const state of states) {
        const { module } = state;
        if (state.state !== "active" || module === null) continue;

        // A feature may slow itself down once it has nothing urgent left to do.
        const intervalMs = module.intervalMs?.() ?? state.meta.intervalMs;
        if (now - state.lastTickAt < intervalMs) continue;
        state.lastTickAt = now;

        try {
            await module.tick(ns, context);
        } catch (error) {
            // One faulting feature must not stop the others. It is stopped until
            // its cooldown expires, then given another chance.
            state.state = "failed";
            state.nextAttemptAt = now + RETRY_MS;
            reportOnce(ns, state, `${state.meta.name} faulted: ${String(error)}`, "error");
        }
    }
}

/**
 * Report a change of state, once, per feature.
 *
 * An event rather than a redrawn frame: "Hacking loaded", "Gang skipped: needs
 * the Gang API", "Hacking faulted: <error>". Those happen once and are the
 * messages worth reading afterwards to work out what the framework did.
 *
 * NOT the Terminal — it goes through `announce`, so the line reaches the log
 * panel and the console's message stream. (It said "to the Terminal" for a while,
 * which was never true of a feature: the orchestrator calls `ns.disableLog("ALL")`
 * at boot, so `tprint` from here produces nothing at all. See `lib/log.ts`.)
 *
 * THE LEVEL IS AN ARGUMENT, and this is the fix for a real defect. The level used
 * to be baked into the message ("INFO: …", "ERROR: …") and every line was then
 * logged at `warn`, so a routine load and a genuine fault were indistinguishable
 * in the console and on the panel. The prefix is gone; the level carries it.
 *
 * Deduplicated, because a feature that fails every pass would otherwise repeat the
 * same line forever. The identity is the message AND its level — a change from
 * "warn" to "error" with the same words is a change worth reporting.
 */
function reportOnce(
    ns: NS,
    state: FeatureStatus,
    message: string,
    level: MessageLevel = "info",
): void {
    // The clear signal: forget what was reported, so the next message is sent.
    if (message === "") {
        state.reported = null;
        return;
    }

    if (state.reported?.message === message && state.reported.level === level) return;
    state.reported = { message, level };
    announce(ns, "nexus", message, level);
}

/** The message alone is useless without the call site for a game API failure. */
function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack === undefined ? error.message : `${error.message}\n${error.stack}`;
    }
    return String(error);
}

/**
 * Describe what `dynamicImport` handed back, for the case where it is not a
 * feature module.
 *
 * "No tick() export" covered several situations that need different fixes: an
 * empty module (the import resolved to nothing), a module whose exports are named
 * differently, and a module whose `tick` is present but not callable.
 */
function describeImport(module: unknown): string {
    if (module === null) return "null";
    if (module === undefined) return "undefined";
    if (typeof module !== "object") return `a ${typeof module}`;

    const keys = Object.keys(module);
    if (keys.length === 0) return "an object with no exports";

    const tick = (module as { tick?: unknown }).tick;
    return `exports [${keys.join(", ")}], tick is ${typeof tick}`;
}

/**
 * Re-exported so a caller building the `Context` it hands to `pass` reads
 * capabilities from the same module as the runtime that judges them.
 */
export { detectCapabilities };
