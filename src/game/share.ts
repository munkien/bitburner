import type { NS } from "@ns";

import { canBuyReputation, type Context } from "./lib/context.ts";
import { announce } from "./lib/log.ts";
import { maxRam as hostMaxRam, rootedHosts, scanNetwork, usedRam as hostUsedRam } from "./lib/network.ts";

/*
 * ============================================================================
 * SHARE
 * ============================================================================
 * Deploys `ns.share` workers, which trade the network's CPU for faction
 * reputation. The share of each host's RAM to give up scales with how rich and
 * how large the network is, so it stays off early and ramps up later.
 *
 * Two gates, and BOTH must open before a single thread is deployed:
 *
 *   want    is there reputation still to gain? (see `readReputation` in
 *          lib/context.ts, read from the snapshot)
 *   afford  is the network rich and large enough for the ramp to clear off?
 *          (see `dynamicPercent`)
 *
 * The `want` gate is the important one and was missing. `ns.share` trades real
 * CPU — the same RAM the hacking feature would otherwise spend earning money —
 * for faction reputation, and it does nothing at all once every faction's
 * augmentations are affordable. Deploying anyway burned the network for no gain.
 *
 * SCOPE: `ns.share` boosts **faction work rep only**. The game applies the boost
 * to "all faction work of all factions" and to nothing else, so company
 * reputation is deliberately NOT part of the `want` gate: sharing does not raise
 * it, and counting it would keep threads deployed for a gain that never arrives.
 *
 * Two things this feature learned the hard way:
 *
 *   - Home RAM is off limits. The old version read a home RAM reserve out of
 *     `reserve_ram.txt`, a number the orchestrator published for a different
 *     purpose entirely. The reserve now arrives in the context, and it is
 *     excluded before any host is considered.
 *   - The network walk lives in lib/network.ts. This file had its own copy.
 * ============================================================================
 */

const CONFIG = {
    MAX_PERCENT: 0.30,
    MIN_PERCENT: 0.02,   // below this → off
    STEP: 0.025,         // quantization, avoids respawn thrash
    MONEY_LOW: 1e9,      // factor 0 at/below
    MONEY_HIGH: 1e12,    // factor 1 at/above
    RAM_LOW: 512,        // GB, network total
    RAM_HIGH: 32768,
    SCAN_INTERVAL_MS: 60_000,
};

const PAYLOAD_NAME = "bin/share.js";

/* ─── FEATURE STATE (persists across ticks) ─── */
let lastScanAt = 0;
let lastPercent = -1;
let initialized = false;
let hosts: string[] = [];
let totalRam = 0;
let scriptRam = 0;

export async function tick(ns: NS, context: Context): Promise<void> {
    const now = Date.now();

    if (!initialized) {
        ensurePayload(ns);
        scriptRam = ns.getScriptRam(PAYLOAD_NAME, "home");
        ns.atExit(() => killAllPayloads(ns), "share-cleanup");
        initialized = true;
    }
    if (scriptRam <= 0) return;

    if (now - lastScanAt > CONFIG.SCAN_INTERVAL_MS || hosts.length === 0) {
        hosts = shareHosts(ns);
        totalRam = hosts.reduce((sum, host) => sum + hostMaxRam(ns, host), 0);
        lastScanAt = now;
    }

    // Whether the ramp is open at all.
    //
    // Whether sharing can gain ANYTHING, which is not the same question as whether
    // reputation is outstanding.
    //
    // `ns.share` buys faction reputation with the network's CPU. A donation buys the same
    // reputation with money, and `player.ts` donates whenever the faction's favour allows
    // it. So for a faction that will take a donation the two are substitutes, and the CPU
    // is the worse one — it could have been earning the money instead.
    //
    // The old gate was `reputation.length > 0`, which opened whenever any faction was
    // short of anything. On the recorded run at runs/2026-10-14T16.59.28.825Z.jsonl that
    // was true for 900 frames, and the player held over 1b — orders of magnitude past the
    // ~1e6-per-point donation cost — for **749 of them**. Sharing was burning the network
    // to earn reputation it could have bought.
    //
    // Gated on FAVOUR rather than the current balance: affordability would put a hard
    // edge at the donation price and make sharing switch on and off as cash crossed it.
    // Favour is permanent, so it decides whether the donation route exists at all.
    //
    // Zero rather than "skip this tick" when nothing is wanted. A nonzero
    // `percentOfRam` with no rep to gain would leave last tick's threads running
    // untouched, because `running === target` reads as "already correct" — so the
    // gate has to produce a target of zero to actually unwind them.
    const worthWorking = context.snapshot.reputation.filter(rep => !canBuyReputation(rep));
    const percentOfRam = worthWorking.length > 0
        ? dynamicPercent(context.snapshot.homeCash, totalRam)
        : 0;

    if (percentOfRam !== lastPercent) {
        // Current state, not an event: this is the setting being applied right now,
        // and it is stale the moment the network grows.
        const why = percentOfRam === 0
            ? (context.snapshot.reputation.length > 0
                ? " — every faction wants rep it can buy with money"
                : " — no faction rep left to gain")
            : "";
        context.recent.add("SHARE", `percentOfRam = ${(percentOfRam * 100).toFixed(1)}%${why}`);
        lastPercent = percentOfRam;
    }

    for (const host of hosts) {
        const maxRam = hostMaxRam(ns, host);
        if (maxRam === 0) continue;

        const processes = ns.ps(host).filter(process => process.filename === PAYLOAD_NAME);
        const running = processes.reduce((sum, process) => sum + process.threads, 0);
        const target = targetThreads(maxRam, hostUsedRam(ns, host), running, percentOfRam);

        if (running === target && processes.length <= 1) continue;

        if (running > 0) ns.scriptKill(PAYLOAD_NAME, host);
        if (target <= 0) continue;

        // Recompute after the kill: other scripts will have claimed the freed RAM.
        const fresh = targetThreads(maxRam, hostUsedRam(ns, host), 0, percentOfRam);
        if (fresh <= 0) continue;

        await ns.scp(PAYLOAD_NAME, host, "home");
        const pid = ns.exec(PAYLOAD_NAME, host, fresh);
        if (pid > 0) {
            // Current state: the ramp recomputes this every scan, so the line is
            // about where the network stands now rather than about one deployment.
            context.recent.add("SHARE", `Deployed ${fresh} threads on ${host}`);
        } else {
            // A deployment that failed is an event: it does not resolve itself, and
            // the next scan may well report the same host working.
            announce(ns, "SHARE", `Failed to exec on ${host} (target=${fresh})`, "error");
        }
    }
}

/* ─── HELPERS ─── */

/**
 * Hosts that can take share workers.
 *
 * `rootedHosts` from lib/network excludes home, which is right here: home runs
 * the orchestrator, the managed scripts and every feature, so sharing there would
 * starve the framework. Note the hacking feature wants the opposite and uses
 * `workerHosts`, which includes home.
 */
function shareHosts(ns: NS): string[] {
    return rootedHosts(ns).filter(host => hostMaxRam(ns, host) > 0);
}

/** Kill every share payload on the network, from a fresh scan rather than the cache. */
function killAllPayloads(ns: NS): void {
    for (const host of scanNetwork(ns)) {
        ns.scriptKill(PAYLOAD_NAME, host);
    }
}

/* ─── HELPERS ─── */

function logFactor(value: number, low: number, high: number): number {
    if (value <= low) return 0;
    if (value >= high) return 1;
    return Math.log(value / low) / Math.log(high / low);
}

function dynamicPercent(money: number, ram: number): number {
    const factor = Math.min(
        logFactor(money, CONFIG.MONEY_LOW, CONFIG.MONEY_HIGH),
        logFactor(ram, CONFIG.RAM_LOW, CONFIG.RAM_HIGH),
    );
    const raw = factor * CONFIG.MAX_PERCENT;
    if (raw < CONFIG.MIN_PERCENT) return 0;
    // Quantized so the target does not change by one thread every tick.
    return Math.min(CONFIG.MAX_PERCENT, Math.round(raw / CONFIG.STEP) * CONFIG.STEP);
}

function ensurePayload(ns: NS): void {
    if (ns.fileExists(PAYLOAD_NAME, "home")) return;
    ns.write(PAYLOAD_NAME, `export async function main(ns){while(true){await ns.share();}}`, "w");
}

function targetThreads(
    maxRam: number,
    usedRam: number,
    runningThreads: number,
    percentOfRam: number,
): number {
    if (percentOfRam <= 0) return 0;
    // RAM this feature already holds is available to it, so subtract only the rest.
    const freeRam = maxRam - (usedRam - runningThreads * scriptRam);
    return Math.max(0, Math.min(
        Math.floor((maxRam * percentOfRam) / scriptRam),
        Math.floor(freeRam / scriptRam),
    ));
}
