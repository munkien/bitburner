import type { NS } from "@ns";

import { unmetRequirement, type CapabilityKey } from "./caps.ts";
import type { Context } from "./context.ts";
import type { SubGoalKey } from "./objective.ts";

/*
 * ============================================================================
 * FEATURE CONTRACT
 * ============================================================================
 * A feature is one area of automation: hacking, the stock market, the gang.
 * The orchestrator decides which features are active and drives them; a feature
 * never decides that for itself and never talks to another feature.
 *
 * The contract is two things:
 *
 *   FeatureMeta  what the orchestrator needs to know to decide whether and when
 *                to load and tick a feature. It lives in the registry, which is
 *                statically imported and therefore must stay RAM-free, so it
 *                holds no game calls and imports no feature.
 *
 *   tick         the feature itself, loaded on demand. Everything a feature
 *                needs arrives as arguments: `ns` to act with, `Context` to
 *                read.
 *
 * Inside a tick, keep the three layers apart:
 *
 *   observe    read game state from `context.snapshot`
 *   plan       turn observations into intent, without calling `ns`
 *   execute    perform the Netscript calls the plan calls for
 *
 * Only execution changes game state, and only the feature that owns a plan
 * changes it. Planning steps that other features depend on (a cash reserve)
 * are published through `context.reserves`.
 * ============================================================================
 */

export interface FeatureMeta {
    /** Stable identifier, used for logging and for `enabled` decisions. */
    readonly id: string;
    /** Human-readable name for the boot log. */
    readonly name: string;
    /** Script path, relative to the orchestrator. */
    readonly path: string;
    /**
     * Lower runs first. Priority decides two things: the order features are
     * ticked, and who gets home RAM first when there is not enough for all.
     *
     * A FUNCTION OF THE BITNODE, not a constant, because the right order genuinely differs
     * between nodes. In BitNode 9 (`Hacktocracy`) cloud servers are disabled
     * (`CloudServerLimit: 0`), script hacking earns a tenth (`ScriptHackMoney: 0.1`) and
     * hacking experience a twentieth (`HackExpGain: 0.05`), while Hacknet is the node's
     * whole point and SF9 makes it cheaper and more productive. Running the default order
     * there spends home RAM — which costs 5× in that node (`HomeComputerRamCost: 5`) — on
     * features that cannot pay it back, and leaves Hacknet last in line for the RAM it
     * needs.
     *
     * Taking the node number rather than a `Capabilities` also keeps this file RAM-free
     * and import-free: it is statically imported by the registry, and a capability object
     * would drag a game call in with it.
     */
    readonly priority: (bitNode: number) => number;
    /**
     * How often the orchestrator offers this feature a tick. This is the
     * maximum rate: a feature may tick less often when it knows nothing can
     * have changed.
     */
    readonly intervalMs: number;
    /** Capabilities this feature needs. The orchestrator refuses to load it otherwise. */
    readonly requires: readonly CapabilityKey[];
    /**
     * The sub-goal kinds this feature can advance.
     *
     * A declaration, not a behaviour: it says what this feature is capable of moving, so
     * the framework can tell which features are contributing to the current goal and mark
     * a sub-goal `blockedBy` when NO loaded feature can move it. A feature never has to
     * know what a goal is, only what it is good at.
     *
     * It lives in the registry, which is statically imported and RAM-free, so it holds
     * only string literals — no game call, no import of a feature. An empty list is
     * honest for a feature with no goal-shaped decision (the stock market follows its own
     * tiers; sharing follows a RAM fraction), not an omission to be filled in later.
     */
    readonly movable: readonly SubGoalKey[];
}

/**
 * A priority that does not depend on the node.
 *
 * The default, and what every feature uses except the few whose value genuinely differs
 * between BitNodes. Written once here so the registry reads as `priority: always(30)`
 * rather than thirty identical closures, and so the constant case stays visibly constant.
 */
export function always(priority: number): (bitNode: number) => number {
    return () => priority;
}

/**
 * The BitNode where the framework reorders itself: `Hacktocracy`.
 *
 * Named rather than repeated as a literal 9 at each use, because it appears in several
 * priorities and the reader has to be able to tell that they are the same node. It is NOT
 * a Source File number — SF9 happens to share the digit, and conflating the two is the
 * mistake `lib/caps.ts` already warns about for SF8.
 */
export const HACKTOCRACY_BITNODE = 9;

/**
 * A priority that is higher in one BitNode than elsewhere.
 *
 * `when` runs at the given node, `otherwise` everywhere else. Both are numbers rather than
 * offsets, so a reader sees the actual order each node gets without doing arithmetic.
 */
export function exceptIn(
    bitNode: number,
    when: number,
    otherwise: number,
): (activeBitNode: number) => number {
    return active => (active === bitNode ? when : otherwise);
}

/** What a loaded feature module must provide. */
export interface FeatureModule {
    tick(ns: NS, context: Context): void | Promise<void>;

    /**
     * Optional override for `meta.intervalMs`, evaluated before each tick.
     *
     * A feature that has finished its work but still has something to do
     * occasionally uses this to ask for a slower tick, rather than burning a
     * tick's worth of Netscript calls to decide there is nothing to do.
     */
    intervalMs?(): number;
}

/**
 * `dynamicImport` returns `any`, and a feature that failed to compile or was
 * never deployed must be reported rather than crashed on.
 */
export function isFeatureModule(value: unknown): value is FeatureModule {
    if (value === null || typeof value !== "object") return false;
    return typeof (value as { tick?: unknown }).tick === "function";
}

/**
 * Why this feature cannot run, or `null` when it can.
 *
 * Re-evaluated every load pass, because capabilities flip as the game changes:
 * the player buys the TIX API, joins a gang, downloads Formulas.exe.
 */
export function unavailableReason(meta: FeatureMeta, context: Context): string | null {
    return unmetRequirement(context.capabilities, meta.requires);
}
