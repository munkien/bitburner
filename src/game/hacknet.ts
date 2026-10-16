import type { HacknetServerHashUpgrade, NS } from "@ns";
import { surplus, type Context } from "./lib/context.ts";
import { ChangeLog, announce, shortError } from "./lib/log.ts";
import { readNetWorth } from "./lib/net-worth.ts";
import { targetFor } from "./lib/objective.ts";

var BUDGET_RATIO = 0.05;

/**
 * How much spendable wealth the framework wants on hand before hashes are worth
 * spending on anything else. While the player is below this, "Sell for Money"
 * takes priority (when the player is not actively working); above it, the
 * work/Bladeburner/dump upgrades apply instead.
 *
 * Measured as cash PLUS stock holdings (see lib/net-worth.ts), not cash alone.
 * A player with 1b in hand and 4b in the market is at target: the choice this
 * gates is "inject cash" versus "spend hashes on something else", and money
 * parked in a position can be sold to cover a bill. Counting only cash made the
 * feature keep converting hashes into money that was not needed, on a player who
 * was not short of it. They had simply already invested it.
 *
 * Without a WSE account and TIX API `readNetWorth` degrades to cash alone, so
 * on a node with no stock access this reads exactly as it did before.
 *
 * This is now only the FALLBACK. The wealth target belongs to the run, not to hacknet, and
 * it lives in the run's goals (`GOAL_TARGETS.netWorth` in lib/objective.ts); `wealthTarget`
 * reads it from there and reaches this figure only when the goal names no wealth goal.
 * Kept rather than deleted because that case is real — an goal that is entirely about
 * something else still leaves hashes to spend sensibly.
 */
const WEALTH_TARGET = 100_000_000_000;

interface Action {
    type: "NODE" | "LEVEL" | "RAM" | "CORE" | "CACHE";
    nodeIndex?: number;
    cost: number;
}

interface HashChoice {
    upgrade: HacknetServerHashUpgrade;
    target?: string;
}

/* ─── MODULE STATE (Persists across orchestrator ticks) ─── */
let isMaxed = false;
let log: ChangeLog | null = null;

/**
 * A maxed-out Hacknet has nothing left to buy, so the only reason to keep
 * ticking is to spend hashes, and those accumulate over minutes.
 *
 * Set when the fleet maxes out and never cleared, because it does not un-max
 * within a run. The orchestrator reads this when it schedules the next tick.
 */
export function intervalMs(): number {
    return isMaxed ? 60_000 : 1_000;
}

/** Hacknet Servers report a hash cache; plain Hacknet Nodes have only hashes. */
function isHacknetServer(ns: NS, index: number): boolean {
    return ns.hacknet.getNodeStats(index).hashCapacity !== undefined;
}

/** Executed sequentially per Nexus orchestrator tick */
export function tick(ns: NS, context: Context): void {
    log ??= new ChangeLog(ns, "HACKNET");
    log.updateNs(ns);

    try {
        // ── Per-tick setup ──
        const nodeCount = ns.hacknet.numNodes();
        const isServer = nodeCount > 0 && isHacknetServer(ns, 0);
        const targetNodes = isServer ? 30 : 10;
        let actionTaken = false;
        let purchasesThisTick = 0;

        let remaining = surplus(context.snapshot, context.reserves) * BUDGET_RATIO;

        // Evaluate global hash cache status ONCE per tick
        let canUpgradeProduction = true;
        let canUpgradeCache = false;

        if (isServer) {
            const capacity = ns.hacknet.hashCapacity();
            if (capacity > 0) {
                const currentHashes = ns.hacknet.numHashes();
                // Nodes, Level, RAM, Core are ONLY bought if cache is < 50%
                canUpgradeProduction = currentHashes < (capacity * 0.5);
                // Cache is ONLY bought if cache is >= 75%
                canUpgradeCache = currentHashes >= (capacity * 0.75);
            }
        }

        // ── Multi-purchase loop (capped to keep tick time synchronous) ──
        do {
            actionTaken = false;
            const currentNodes = ns.hacknet.numNodes();
            const actions: Action[] = [];

            // ── Priority 1: expand toward target node count if affordable ──
            let bestAction: Action | null = null;
            if (canUpgradeProduction && currentNodes < targetNodes) {
                const nodeCost = ns.hacknet.getPurchaseNodeCost();
                if (isFinite(nodeCost) && nodeCost <= remaining) {
                    bestAction = { type: "NODE", cost: nodeCost };
                }
            }

            // ── Priority 2: otherwise take the cheapest affordable upgrade ──
            if (!bestAction) {
                for (let i = 0; i < currentNodes; i++) {
                    if (canUpgradeProduction) {
                        const levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
                        if (isFinite(levelCost)) actions.push({ type: "LEVEL", nodeIndex: i, cost: levelCost });

                        const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
                        if (isFinite(ramCost)) actions.push({ type: "RAM", nodeIndex: i, cost: ramCost });

                        const coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);
                        if (isFinite(coreCost)) actions.push({ type: "CORE", nodeIndex: i, cost: coreCost });
                    }

                    if (canUpgradeCache) {
                        const cacheCost = ns.hacknet.getCacheUpgradeCost(i, 1);
                        if (isFinite(cacheCost)) actions.push({ type: "CACHE", nodeIndex: i, cost: cacheCost });
                    }
                }

                actions.sort((a, b) => a.cost - b.cost);
                bestAction = actions.find(a => a.cost <= remaining) ?? null;

                if (actions.length === 0) {
                    isMaxed = true;
                    break;
                }
            }

            // Stop buying this tick if we can't afford the cheapest action
            if (!bestAction) {
                break;
            }

            let bought = false;
            switch (bestAction.type) {
                case "NODE":
                    bought = ns.hacknet.purchaseNode() >= 0;
                    if (bought) announce(ns, "HACKNET", `Purchased Node ${currentNodes}`, "tx");
                    break;
                case "LEVEL":
                    bought = ns.hacknet.upgradeLevel(bestAction.nodeIndex!, 1);
                    break;
                case "RAM":
                    bought = ns.hacknet.upgradeRam(bestAction.nodeIndex!, 1);
                    break;
                case "CORE":
                    bought = ns.hacknet.upgradeCore(bestAction.nodeIndex!, 1);
                    break;
                case "CACHE":
                    bought = ns.hacknet.upgradeCache(bestAction.nodeIndex!, 1);
                    break;
            }

            if (!bought) break;

            remaining -= bestAction.cost;
            actionTaken = true;
            purchasesThisTick++;
        } while (actionTaken);

        // ── Hash spending ──
        if (isServer && nodeCount > 0) {
            spendHashes(ns, context);
        }

        // ── Status and summary reporting ──
        if (nodeCount > 0) {
            let totalLevel = 0, totalRam = 0, totalCores = 0, totalCache = 0, production = 0;

            for (let i = 0; i < nodeCount; i++) {
                const stats = ns.hacknet.getNodeStats(i);
                totalLevel += stats.level;
                totalRam += stats.ram;
                totalCores += stats.cores;
                totalCache += (stats.cache || 0);
                production += stats.production;
            }

            const cacheStr = isServer ? ` | Cache: ${totalCache}` : "";
            const prodStr = isServer
                ? `${ns.format.number(production)} H/s`
                : `${ns.format.number(production)}$/s`;

            if (!isMaxed) {
                const statusState = nodeCount < targetNodes ? "EXPANDING" : "UPGRADING";
                log!.change("status", "Status", statusState, `${prodStr}${cacheStr}`);
            } else {
                const hashStr = isServer
                    ? ` | Hashes: ${ns.format.number(ns.hacknet.numHashes())}/${ns.format.number(ns.hacknet.hashCapacity())}`
                    : "";
                log!.change("status", "Status", "MAXED", `${prodStr}${cacheStr}${hashStr}`);
            }
        }
    } catch (error) {
        announce(ns, "HACKNET", `ERROR: ${shortError(error)}`, "error");
    }
}

/* ─── HASH MANAGEMENT ─── */

/**
 * Whether a `CLASS` work's `classType` is a gym workout rather than a
 * university course.
 *
 * `getCurrentWork` reports a gym class as one of the four short GymTypes
 * ("str" | "def" | "dex" | "agi") and a course as a title-cased
 * UniversityClassType ("Computer Science", …). The two are disjoint, so the
 * short-string test is exact and cannot misclassify either.
 *
 * Exported so the one decision is pinned by a test rather than re-derived at
 * the call site.
 */
export const GYM_CLASS_TYPES: ReadonlySet<string> = new Set(["str", "def", "dex", "agi"]);

export function isGymClass(classType: string): boolean {
    return GYM_CLASS_TYPES.has(classType);
}

/**
 * The figure `WEALTH_TARGET` is compared against: cash plus stock holdings.
 *
 * Deliberately NOT `context.snapshot.homeCash`, even though the snapshot is
 * otherwise the right place to read money from. The snapshot is captured once per
 * tick and carries only cash, and this rule is the one place that wants a wider
 * figure; `readNetWorth` is the codebase's single definition of it (see
 * lib/net-worth.ts) and is already what the doctor and the gang feature gate on.
 *
 * Costs nothing without stock access: `readNetWorth` short-circuits on the two
 * 0 GB access checks and returns cash alone.
 */
function wealthOf(ns: NS, context: Context): number {
    const { netWorth } = readNetWorth(ns);
    // `readNetWorth` reads `ns.getPlayer().money`, which can differ from the
    // tick's snapshot by a few ms of income. Both are "cash"; taking the larger
    // means a sale already in flight never makes the gap look bigger than it is.
    return Math.max(netWorth, context.snapshot.homeCash);
}

/**
 * The wealth the run wants before hashes stop being spent on money.
 *
 * Read from the run's goal rather than from the constant that used to declare it here.
 * The wealth target is the run's own ambition, not a hacknet fact, and it now has one
 * definition: the same goal the gang's money rule and the dashboard read. `WEALTH_TARGET`
 * remains as the fallback for the case where the goal names no wealth target — which
 * happens on a run whose goal is something else entirely, where the old figure is
 * still the right answer.
 */
function wealthTarget(context: Context): number {
    return targetFor(context.goal, "netWorth", WEALTH_TARGET);
}

function spendHashes(ns: NS, context: Context): void {
    const capacity = ns.hacknet.hashCapacity();
    if (capacity <= 0) return;

    const hashes = ns.hacknet.numHashes();
    const wealth = wealthOf(ns, context);
    const chosen = chooseHashUpgrade(ns, context, hashes, wealth);
    if (chosen === null) return;

    // ── 1. PRECISE CASH INJECTION ──
    // Only buy exactly enough to reach WEALTH_TARGET so we don't waste hashes.
    //
    // The sales themselves are against `homeCash`, deliberately: "Sell for Money"
    // credits home cash, so the gap closed per sale is a cash gap. The target is
    // measured in total wealth, but the spend is measured in the currency it pays
    // out in.
    const money = context.snapshot.homeCash;
    if (chosen.upgrade === "Sell for Money" && money < wealthTarget(context)) {
        const needCash = wealthTarget(context) - money;
        const needUpgrades = Math.ceil(needCash / 1_000_000); // $1m per sale
        const costPer = ns.hacknet.hashCost("Sell for Money");

        if (!isFinite(costPer) || costPer <= 0) return;

        let sold = 0;
        while (sold < needUpgrades && ns.hacknet.numHashes() >= costPer) {
            if (!ns.hacknet.spendHashes("Sell for Money")) break;
            sold++;
        }

        if (sold > 0) {
            ns.toast(
                `HACKNET: Sold ${sold * costPer} hashes for $${ns.format.number(sold * 1_000_000)}`,
                "success",
            );
        }
        return;
    }

    // ── 2. DUMPING & SCALING UPGRADES ──
    // spendHashes() buys exactly ONE upgrade per call. Loop until we can't
    // afford another, hit the loop safeguard, or the purchase fails.
    const overageTarget = capacity * 0.70;
    const isDumpUpgrade =
        chosen.upgrade === "Sell for Money" ||
        chosen.upgrade === "Sell for Corporation Funds";

    let totalBought = 0;
    let loopSafeguard = 1000;

    while (loopSafeguard-- > 0) {
        const currentCost = ns.hacknet.hashCost(chosen.upgrade);
        if (!isFinite(currentCost) || currentCost <= 0) break;
        if (ns.hacknet.numHashes() < currentCost) break;

        if (!ns.hacknet.spendHashes(chosen.upgrade, chosen.target)) break;
        totalBought += 1;

        // For dump upgrades, stop once we've dropped down to the overage target
        if (isDumpUpgrade && ns.hacknet.numHashes() <= overageTarget) break;
    }

    if (totalBought > 0) {
        const targetStr = chosen.target ? ` (${chosen.target})` : "";
        ns.toast(`HACKNET: Bought ${totalBought}x "${chosen.upgrade}"${targetStr}`, "success");
    }
}

function chooseHashUpgrade(ns: NS, context: Context, hashes: number, wealth: number): HashChoice | null {
    const candidates: HashChoice[] = [];

    /*
     * ── 0. The upgrade for what the player is DOING, first ──
     *
     * While the player is actively at a gym, studying, or working a company, the
     * hash that speeds that specific work up is the best use of a hash: it makes
     * the very thing the framework chose to spend time on go faster.
     *
     * This used to sit behind the cash-target rule below, which returned
     * before it was ever read — so training dex bought "Sell for Money" (or
     * nothing) and never "Improve Gym Training", which is the reported bug. The
     * work upgrade now leads, and the cash rule only applies when the player is
     * idle.
     */
    if (context.capabilities.has("singularity")) {
        const work = ns.singularity.getCurrentWork();
        if (work !== null) {
            if (work.type === "CLASS") {
                // Distinguish a gym workout from a university course by its
                // `classType`, not its location: `getCurrentWork` reports a gym
                // class as one of the four GymTypes ("str" | "def" | "dex" |
                // "agi") and a course as a UniversityClassType ("Computer
                // Science", …). The two are disjoint, so this cannot misclassify.
                const upgrade = isGymClass(work.classType)
                    ? "Improve Gym Training"
                    : "Improve Studying";
                const cost = ns.hacknet.hashCost(upgrade);
                if (isFinite(cost) && cost > 0 && hashes >= cost) return { upgrade };
            } else if (work.type === "COMPANY") {
                // Company Favor requires the company name as the target.
                const cost = ns.hacknet.hashCost("Company Favor");
                if (isFinite(cost) && cost > 0 && hashes >= cost) {
                    return { upgrade: "Company Favor", target: work.companyName };
                }
            }
        }
    }

    // ── 1. Cash injection up to WEALTH_TARGET, when not working ──
    // Only when idle: with no work to accelerate, hashes are best spent closing
    // the gap to the wealth target and then dumped.
    if (wealth < wealthTarget(context)) {
        const cost = ns.hacknet.hashCost("Sell for Money");
        if (isFinite(cost) && cost > 0 && hashes >= cost) {
            return { upgrade: "Sell for Money" };
        }
        return null;
    }

    // ── 2. Bladeburner ──
    if (context.capabilities.has("bladeburner")) {
        candidates.push({ upgrade: "Exchange for Bladeburner Rank" });
        candidates.push({ upgrade: "Exchange for Bladeburner SP" });
    }

    // ── 4. Dump hashes if cache is getting full ──
    if (hashes >= ns.hacknet.hashCapacity() * 0.75) {
        candidates.push({ upgrade: "Sell for Money" });
    }

    // Return the first affordable candidate
    for (const c of candidates) {
        const cost = ns.hacknet.hashCost(c.upgrade);
        if (!isFinite(cost) || cost <= 0) continue;
        if (hashes >= cost) return c;
    }

    return null;
}