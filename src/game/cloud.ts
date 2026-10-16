import { NS } from "@ns";

/*
 * ============================================================================
 * CLOUD FLEET
 * ============================================================================
 * Buys cloud servers and upgrades the smallest ones first, until the fleet is
 * full and maxed. Only money above the cash reserve is spent: the reserve is
 * owned by whichever feature knows about a planned purchase, and read here from
 * the context.
 *
 * This used to read `reserve_money.txt` and fall back to 0 when the file was
 * missing, which silently spent a reserve another feature had set. Shares are
 * gone now (see lib/context.ts).
 * ============================================================================
 */

import { surplus, type Context } from "./lib/context.ts";
import { announce, shortError } from "./lib/log.ts";

interface CloudStats {
    count: number;
    maxed: number;
    totalRam: number;
    usedRam: number;
    usedPercent: number;
}

interface ActionResult {
    spent: number;
    count: number;
    message: string;
}

/* ───────────────────────── Config ───────────────────────── */

const CONFIG = {
    prefix: "cloud-",
    initialRam: 8,
    bootstrapRam: 4,
    expandBelowUsedPercent: 80,
    budgetRatio: 0.1,
};

/* ───────────────────────── Caches ───────────────────────── */

const costCache = new Map<number, number>();
function serverCost(ns: NS, ram: number): number {
    let c = costCache.get(ram);
    if (c === undefined) {
        c = ns.cloud.getServerCost(ram);
        costCache.set(ram, c);
    }
    return c;
}

// Keyed by current RAM too: the cost from 8GB→64GB differs from 16GB→64GB.
const upCostCache = new Map<string, number>();
function upgradeCost(ns: NS, host: string, current: number, targetRam: number): number {
    const key = `${host}|${current}|${targetRam}`;
    let c = upCostCache.get(key);
    if (c === undefined) {
        c = ns.cloud.getServerUpgradeCost(host, targetRam);
        upCostCache.set(key, c);
    }
    return c;
}

function ramTiers(maxRam: number, minRam: number): number[] {
    if (maxRam <= 0) return [];
    const start = Math.min(minRam, maxRam);
    const tiers: number[] = [];
    let r = start;
    while (true) {
        tiers.push(r);
        if (r >= maxRam) break;
        r = Math.min(r * 2, maxRam);
    }
    return tiers;
}

/* ───────────────────────── Module State ───────────────────────── */

let totalSpent = 0;
let totalBought = 0;
let totalUpgraded = 0;

/** Executed sequentially per Nexus orchestrator tick */
export function tick(ns: NS, context: Context): void {
    try {
        const limit = ns.cloud.getServerLimit();
        const maxRam = ns.cloud.getRamLimit();
        const tiers = ramTiers(maxRam, CONFIG.initialRam);
        const bootstrapTiers = [Math.min(CONFIG.bootstrapRam, maxRam)];

        // Only money above the cash reserve is ours to spend.
        const budget = surplus(context.snapshot, context.reserves) * CONFIG.budgetRatio;
        const stats = computeStats(ns, maxRam);

        // 1. Fully maxed out fleet?
        if (limit > 0 && stats.count >= limit && stats.maxed >= limit) {
            return;
        }

        let message = "";

        // 2. Bootstrap: Fill empty slots up to whatever the budget allows.
        //
        // "Unconditionally" until it was not: this fills empty slots whenever the fleet
        // is below the server limit, regardless of utilisation, which is the right
        // behaviour for a bootstrap. It is still bounded by `budget`, and that budget is
        // what stops it spending money another feature has reserved — `surplus` subtracts
        // every cash reserve, so this respects the stock access chain's reserve without
        // knowing the chain exists.
        if (stats.count < limit) {
            const r = purchase(ns, budget, limit, bootstrapTiers, CONFIG.prefix);
            totalSpent += r.spent;
            totalBought += r.count;
            message = r.message;
        }
        // 3. Waiting: Fleet utilization below threshold
        else if (stats.usedPercent <= CONFIG.expandBelowUsedPercent) {
            // Holding expansion
            return;
        }
        // 4. Upgrade: Top up smallest servers first
        else {
            const r = upgrade(ns, budget, maxRam, tiers);
            totalSpent += r.spent;
            totalUpgraded += r.count;
            message = r.message;
        }

        // A purchase or an upgrade is an event: the fleet is permanent, and the
        // money is spent by the time the line is read.
        if (message) {
            announce(ns, "CLOUD", message);
        }

    } catch (err) {
        announce(ns, "CLOUD", `ERROR: ${shortError(err)}`);
    }
}

/* ───────────────────────── Actions ───────────────────────── */

function purchase(
    ns: NS,
    budget: number,
    limit: number,
    tiers: number[],
    prefix: string,
): ActionResult {
    let spent = 0;
    let count = 0;

    try {
        const names = ns.cloud.getServerNames();

        while (names.length < limit) {
            const remaining = budget - spent;
            if (remaining <= 0) break;

            let targetRam = 0;
            for (const t of tiers) {
                if (serverCost(ns, t) <= remaining) targetRam = t;
                else break;
            }
            if (targetRam === 0) break;

            const host = ns.cloud.purchaseServer(`${prefix}${names.length}`, targetRam);
            if (!host) break;

            spent += serverCost(ns, targetRam);
            count++;
            names.push(host);
        }
    } catch (err) {
        return { spent, count, message: `Purchase error: ${String(err)}` };
    }

    if (count > 0) {
        return { spent, count, message: `Bootstrap purchased ${count} server(s)` };
    }
    return { spent: 0, count: 0, message: "" };
}

function upgrade(ns: NS, budget: number, maxRam: number, tiers: number[]): ActionResult {
    let spent = 0;
    let count = 0;

    try {
        const names = [...ns.cloud.getServerNames()].sort(
            (a, b) => ns.getServerMaxRam(a) - ns.getServerMaxRam(b),
        );

        for (const host of names) {
            const remaining = budget - spent;
            if (remaining <= 0) break;

            const current = ns.getServerMaxRam(host);
            if (current >= maxRam) continue;

            let bestRam = 0;
            let bestCost = 0;
            for (const t of tiers) {
                if (t <= current) continue;
                const cost = upgradeCost(ns, host, current, t);
                if (cost <= remaining) { bestRam = t; bestCost = cost; }
                else break;
            }

            if (bestRam === 0) continue;
            if (!ns.cloud.upgradeServer(host, bestRam)) continue;

            spent += bestCost;
            count++;
        }
    } catch (err) {
        return { spent, count, message: `Upgrade error: ${String(err)}` };
    }

    if (count > 0) {
        return { spent, count, message: `Upgraded ${count} server(s)` };
    }
    return { spent: 0, count: 0, message: "" };
}

/* ───────────────────────── Stats ───────────────────────── */

function computeStats(ns: NS, maxRam: number): CloudStats {
    let totalRam = 0;
    let usedRam = 0;
    let maxed = 0;
    let count = 0;

    for (const host of safeServers(ns)) {
        const ram = safeMaxRam(ns, host);
        const used = safeUsedRam(ns, host);
        totalRam += ram;
        usedRam += used;
        if (ram >= maxRam) maxed++;
        count++;
    }

    return {
        count,
        maxed,
        totalRam,
        usedRam,
        usedPercent: totalRam > 0 ? (usedRam / totalRam) * 100 : 0,
    };
}

function safeServers(ns: NS): string[] {
    try { return ns.cloud.getServerNames(); } catch { return []; }
}
function safeMaxRam(ns: NS, host: string): number {
    try { return Math.max(0, ns.getServerMaxRam(host)); } catch { return 0; }
}
function safeUsedRam(ns: NS, host: string): number {
    try { return Math.max(0, ns.getServerUsedRam(host)); } catch { return 0; }
}