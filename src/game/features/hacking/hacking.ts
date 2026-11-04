import type { NS } from "@ns";

import type { Context } from "../../lib/context.ts";
import { ACTION, ensureActionScripts } from "./actions.ts";
import { announce } from "../../lib/log.ts";
import { chooseBatch, isDisturbed, shouldReplan, type BatchPlan, type PlannerConfig } from "./plan.ts";
import { growThreadsFor, readTargetFacts, timingAtPrep } from "./target-facts.ts";
import { crackReachable, maxRam, syncScript, usedRam, workerHosts } from "../../lib/network.ts";

const CFG = {
    MAX_TARGETS: 8,
    SPACING_MS: 40,
    HACK_FRACTION: 0.8,
    GROW_BUFFER: 1.05,
    REFRESH_MS: 5000,
    POOL_SHARE: 0.7,
    MAX_DEPTH: 50,
    RETRY_MS: 1000,
    REPLAN_LEVEL: 1.1,
    REPLAN_POOL: 1.25,
    REPLAN_RETRY_MS: 30_000,
};
const F = { h: ACTION.hack, g: ACTION.grow, w: ACTION.weaken };

/** The planner's own tuning, taken from this feature's config. */
const PLANNER: PlannerConfig = {
    spacingMs: CFG.SPACING_MS,
    hackFraction: CFG.HACK_FRACTION,
    growBuffer: CFG.GROW_BUFFER,
    maxDepth: CFG.MAX_DEPTH,
};

/** Slack on top of the orchestrator's home RAM reserve, for this feature's own threads. */
const HOME_RESERVE_MARGIN_GB = 0.1;

type Job = { file: string; threads: number; delay: number };
type State = {
    mode: string; prepEnd: number; landEnd: number; nextLaunch: number; retryAt: number;
    /** Earliest time another replan attempt may be made, so a failure does not spin. */
    replanAt: number;
    halt: boolean; plan: BatchPlan | null; next: BatchPlan | null;
};

/* ─── FEATURE STATE (persists across ticks) ─── */
let initialized = false;
let nextRefresh = 0;
/** Home RAM the orchestrator is holding back, plus a margin for the workers we launch here. */
let homeReserveGb = 0;
let poolThreads = 0;

const states = new Map<string, State>();
const ramCache = new Map<string, number>();
let hosts: string[] = [];
let targets: string[] = [];

/** Free RAM per host, biggest first. Rebuilt lazily (once per tick), decremented as we launch. */
let free: Map<string, number> | null = null;

/* ─── TICK ─── */
export function tick(ns: NS, context: Context): void {
    const now = Date.now();
    free = null;

    if (!initialized) {
        ensureActionScripts(ns);
        initialized = true;
    }

    if (now >= nextRefresh) {
        nextRefresh = now + CFG.REFRESH_MS;
        refresh(ns, context, now);
    }

    const lvl = context.snapshot.player.skills.hacking;

    for (const t of targets) {
        let s = states.get(t);
        if (!s) {
            s = {
                mode: "idle", prepEnd: 0, landEnd: 0, nextLaunch: 0, retryAt: 0, replanAt: 0,
                halt: false, plan: null, next: null,
            };
            states.set(t, s);
        }

        if (now < s.prepEnd) continue;

        const minSec = ns.getServerMinSecurityLevel(t);
        const sec = ns.getServerSecurityLevel(t);

        if (now < s.landEnd) {
            if (s.plan && sec > minSec + s.plan.swing + 1) s.halt = true;
            if (s.halt) continue;

            // Stale plan: build the replacement once, adopt it as soon as its first landing
            // (launch + wt - SPACING) falls after the old pipeline's last landing.
            if (s.plan && !s.next && shouldReplan(s.plan, lvl, poolThreads, {
                levelRatio: CFG.REPLAN_LEVEL,
                poolRatio: CFG.REPLAN_POOL,
            }) && now >= s.replanAt) {
                // A failed replan must not retry on every tick. This used to write
                // the current level and pool into the old plan so the trigger stopped
                // firing, which meant mutating a record of a decision already taken. A
                // timestamp says the same thing without lying about what the plan was.
                s.replanAt = now + CFG.REPLAN_RETRY_MS;
                s.next = makePlan(ns, context, t, lvl);
            }
            if (s.next) {
                if (now + s.next.timeToWeaken - CFG.SPACING_MS <= s.landEnd) continue;
                s.plan = s.next;
                s.next = null;
            }
        } else {
            // Batch phase just ended. `wasHalted` tells us WHY: if halt was set, security
            // genuinely spiked and we need prep. If not, we exited because launches were
            // failing (RAM pressure) and the target is likely mid-pipeline — prepping on
            // that transient is what causes the BATCH ↔ PREP thrash.
            const wasHalted = s.halt;
            s.halt = false;
            s.next = null;
            if (now < s.retryAt) continue;

            const secOver = sec - minSec;
            const money = ns.getServerMoneyAvailable(t);
            const maxMoney = ns.getServerMaxMoney(t);

            // Genuinely off: security well above min, or money badly depleted.
            // These thresholds are deliberately loose — during pipelined batching the
            // target transiently deviates (hack lands → 20% money for ~80ms before grow
            // lands), and tighter thresholds would fire on that. See foodnstuff thrash.
            const genuinelyOff = secOver > 1 || money < maxMoney * 0.5;

            if (wasHalted || genuinelyOff) {
                changeMode(ns, t, s, "prep");
                const ms = prep(ns, context, t);
                if (ms > 0) s.prepEnd = now + ms + 200;
                else s.retryAt = now + CFG.RETRY_MS;
                continue;
            }

            s.plan = makePlan(ns, context, t, lvl) ?? s.plan;
            if (!s.plan) { s.retryAt = now + CFG.RETRY_MS; continue; }
        }

        const p = s.plan;
        if (!p || now < s.nextLaunch) continue;

        const ok = launch(ns, t, [
            { file: F.h, threads: p.h, delay: p.dH },
            { file: F.w, threads: p.w1, delay: 0 },
            { file: F.g, threads: p.g, delay: p.dG },
            { file: F.w, threads: p.w2, delay: p.dW2 },
        ]);
        if (!ok) continue;

        changeMode(ns, t, s, "batch");
        s.landEnd = now + p.span;
        s.nextLaunch = now + p.gap;
    }
}

function changeMode(ns: NS, target: string, s: State, mode: string): void {
    if (s.mode === mode) return;
    // An event: BATCH ↔ PREP is the transition worth reading back, and the
    // previous guard is what stops it repeating every tick.
    announce(ns, "BATCHER", `${target}: ${s.mode.toUpperCase()} → ${mode.toUpperCase()}`, "tx");
    s.mode = mode;
}

/* ─── NETWORK REFRESH ─── */

/**
 * Earning power of a target, used to rank them. Higher is better.
 *
 * The formula is money per unit of effort: what the server holds, scaled by how
 * likely a hack is to land, divided by the RAM cost of the batch that has to be
 * spent to get it. Weaken time and security both drive that cost, so a server
 * with low minimum security and a low hacking-level requirement wins.
 *
 * `mults.ServerMaxMoney` is applied even though `ns.getServerMaxMoney` already
 * reflects the same BitNode, because the multiplier is what separates a target
 * that is rich *in this node* from one that is rich in BitNode 1. Without it the
 * ranking is the same on every node, which is exactly wrong on the nodes whose
 * whole point is that hacking pays differently.
 */
function score(ns: NS, host: string, serverMaxMoneyMultiplier: number): number {
    const minSecurity = ns.getServerMinSecurityLevel(host);
    const chance = ns.hackAnalyzeChance(host)
        * (100 - minSecurity) / Math.max(1, 100 - ns.getServerSecurityLevel(host));

    return ns.getServerMaxMoney(host)
        * serverMaxMoneyMultiplier
        * chance
        / (2.5 * ns.getServerRequiredHackingLevel(host) * minSecurity + 500);
}

function refresh(ns: NS, context: Context, now: number): void {
    // Home RAM is withheld for the orchestrator, the managed scripts and the
    // features that have not loaded yet. It arrives in the context: this used to
    // read reserve_ram.txt, a number the orchestrator published for a different
    // purpose and which this feature then added 0.1 GB to.
    homeReserveGb = context.reserves.homeRamGb + HOME_RESERVE_MARGIN_GB;

    // Take root first, then ask which hosts can run workers. The two are
    // separate questions and conflating them is what dropped home from the pool:
    // crackReachable skips home because you do not nuke your own machine, but home
    // is where most of the RAM is.
    crackReachable(ns);
    hosts = workerHosts(ns);

    // Home already has the workers, since they are written here; scp to the rest.
    syncScript(ns, F.h, hosts.filter(h => h !== "home"));
    syncScript(ns, F.g, hosts.filter(h => h !== "home"));
    syncScript(ns, F.w, hosts.filter(h => h !== "home"));

    poolThreads = Math.floor(
        threadPool(ns, hosts, homeReserveGb, threadRam(ns)) * CFG.POOL_SHARE,
    );

    const lvl = context.snapshot.player.skills.hacking;
    targets = scanTargets(ns, hosts, lvl, serverMaxMoneyMultiplier(context));

    for (const [t, s] of states) {
        if (targets.includes(t) || now < Math.max(s.landEnd, s.prepEnd)) continue;
        if (s.mode !== "idle") {
            // An event: the panel's own line already lists the live targets, so a
            // reader wants the disappearance recorded rather than redrawn.
            announce(ns, "BATCHER", `${t}: Removed from ${s.mode.toUpperCase()} (no longer active target)`, "warn");
        }
        states.delete(t);
    }
}

/**
 * Hosts worth hacking: they have money, the player can hack them, and they are
 * not home. Capped to the best few, because a longer list only spreads the same
 * thread pool across targets that can never finish a batch.
 */
/**
 * The current node's `ServerMaxMoney` multiplier, or 1 when it cannot be read.
 *
 * `ns.getBitNodeMultipliers()` costs 4 GB and requires SF5 or BitNode 5: it
 * throws otherwise. Calling it unconditionally left the hacking feature throwing
 * during its refresh on every node without SF5, which is most of them, so the
 * call is gated on the capability and the fallback keeps the ranking working.
 */
function serverMaxMoneyMultiplier(context: Context): number {
    // The context owns the capability check and the memoisation, so this does not
    // repeat either. `?? 1` is the fallback for the nodes with no SF5, where the
    // API cannot answer at all.
    return context.multipliers()?.ServerMaxMoney ?? 1;
}

function scanTargets(ns: NS, hosts: readonly string[], level: number, serverMaxMoneyMultiplier: number): string[] {
    // `hosts` is already filtered by `workerHosts`, which excludes Hacknet Servers
    // (they throw on `getServerMaxMoney` and must not run tasks anyway), so this
    // only has to ask which of the remaining hosts are worth hacking.
    return hosts
        .filter(h => h !== "home"
            && ns.getServerMaxMoney(h) > 0
            && ns.getServerRequiredHackingLevel(h) <= level)
        .map(h => [h, score(ns, h, serverMaxMoneyMultiplier)] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, CFG.MAX_TARGETS)
        .map(([h]) => h);
}

/* ─── PLANNING & PREP ─── */

/**
 * Plan a batch against one target. Pure: it reads game state and returns
 * intents, without launching anything. `launch` is the only thing that runs.
 *
 * The player and the `Formulas.exe` answer come from the context, so a replan
 * does not re-query either once per candidate target.
 */
function makePlan(ns: NS, context: Context, t: string, lvl: number): BatchPlan | null {
    const slots = capacity(ns);
    if (slots < 2) return null;

    const useFormulas = context.capabilities.has("formulas");

    // Facts first, then arithmetic: the modules split here so the arithmetic can
    // be tested without a game. This function is the adapter between them, which
    // is why it is mostly argument assembly.
    const facts = readTargetFacts(ns, t, useFormulas);
    if (facts === null) return null;

    // A batch is built against the target at minimum security and maximum money,
    // because that is what prep reaches and what the pipeline has to hold.
    const prepTiming = timingAtPrep(ns, facts, useFormulas);

    return chooseBatch(
        {
            prep: prepTiming,
            costs: facts.costs,
            poolThreads,
            // Giving one target a fair share keeps a greedy target from starving
            // the others; the planner tries this before falling back to all slots.
            slots: Math.min(slots, Math.floor(poolThreads / Math.max(1, targets.length))),
            level: lvl,
            growThreadsFor: (remaining) =>
                growThreadsFor(ns, facts, facts.moneyMax * remaining, useFormulas),
        },
        PLANNER,
    );
}

function prep(ns: NS, context: Context, t: string): number {
    const slots = capacity(ns);
    if (slots <= 0) return 0;

    const useFormulas = context.capabilities.has("formulas");

    // The same facts the planner reads, so the two cannot disagree about the
    // game's growth formula or how much security one thread adds.
    const facts = readTargetFacts(ns, t, useFormulas);
    if (facts === null) return 0;

    const secOver = Math.max(0, facts.securityLevel - facts.minDifficulty);
    const money = Math.max(1, facts.moneyAvailable);

    let g = 0;
    if (money < facts.moneyMax * 0.99) {
        g = Math.max(1, Math.ceil(growThreadsFor(ns, facts, money, useFormulas)));
    }

    const growSecurity = g > 0 ? g * facts.costs.growSecurity : 0;
    let w = Math.ceil((secOver + growSecurity) / facts.costs.weakenPerThread);

    w = Math.min(w, slots);
    g = Math.min(g, slots - w);

    const ok = launch(ns, t, [
        { file: F.w, threads: w, delay: 0 },
        { file: F.g, threads: g, delay: 0 },
    ]);
    if (!ok) return 0;
    return w > 0 ? ns.getWeakenTime(t) : ns.getGrowTime(t);
}

/* ─── RAM & ATOMIC LAUNCH ─── */
/**
 * Threads the pool can run, across every host, at the given thread cost.
 *
 * Exported and pure apart from reading each host's RAM, so the thing that went
 * wrong once is testable: home contributes, and its reserve is withheld. The bug
 * was not in this arithmetic but in `hosts` never containing home, so this is
 * tested together with the host list that feeds it.
 */
export function threadPool(
    ns: NS,
    hosts: readonly string[],
    homeReserveGb: number,
    ramPerThread: number,
): number {
    if (ramPerThread <= 0) return 0;

    let pool = 0;
    for (const host of hosts) {
        const reserved = host === "home" ? homeReserveGb : 0;
        // `maxRam` READS 0 FOR A VANISHED HOST rather than throwing. `hosts` is cached from
        // an earlier scan in the same pass and read again here, so a cloud server can be gone
        // in between — `getServerMaxRam: Invalid host: 'cloud-0'` killed this feature in
        // `runs/2026-11-04T09.37.53.447Z--33`. A host with no RAM contributes no threads,
        // which is the correct answer rather than a failure.
        pool += Math.floor(Math.max(0, maxRam(ns, host) - reserved) / ramPerThread);
    }
    return pool;
}

function workerRam(ns: NS, file: string): number {
    let r = ramCache.get(file);
    if (r === undefined) {
        r = ns.getScriptRam(file, "home");
        // A worker that is not deployed yet reports 0; assume one thread of a
        // grow-style script so the pool maths does not divide by zero.
        if (r <= 0) return 1.75;
        ramCache.set(file, r);
    }
    return r;
}

function threadRam(ns: NS): number {
    return Math.max(workerRam(ns, F.h), workerRam(ns, F.g), workerRam(ns, F.w));
}

function freeRam(ns: NS, h: string): number {
    const reserved = h === "home" ? homeReserveGb : 0;
    // Guarded for the same reason as the pool above: `h` comes from a list taken earlier in
    // the pass, and the server may have been removed since. Zero free RAM is the honest
    // answer for a machine that no longer exists.
    return Math.max(0, maxRam(ns, h) - usedRam(ns, h) - reserved);
}

function getFree(ns: NS): Map<string, number> {
    if (free) return free;
    const list: [string, number][] = [];
    for (const h of hosts) {
        const f = freeRam(ns, h);
        if (f > 0) list.push([h, f]);
    }
    list.sort((a, b) => b[1] - a[1]);
    return (free = new Map(list));
}

function capacity(ns: NS): number {
    const per = threadRam(ns);
    let n = 0;
    for (const f of getFree(ns).values()) n += Math.floor(f / per);
    return n;
}

function launch(ns: NS, target: string, jobs: Job[]): boolean {
    const todo = jobs.filter(j => j.threads > 0).sort((a, b) => workerRam(ns, b.file) - workerRam(ns, a.file));
    if (todo.length === 0) return false;

    const map = getFree(ns);
    const left = new Map<string, number>();
    const plan: [string, string, number, number][] = [];

    for (const j of todo) {
        const ram = workerRam(ns, j.file);
        let need = j.threads;
        for (const [host, f] of map) {
            const avail = left.get(host) ?? f;
            const n = Math.min(need, Math.floor(avail / ram));
            if (n <= 0) continue;
            plan.push([host, j.file, n, j.delay]);
            left.set(host, avail - n * ram);
            if ((need -= n) <= 0) break;
        }
        if (need > 0) return false;
    }

    const pids: number[] = [];
    for (const [host, file, n, delay] of plan) {
        const pid = ns.exec(file, host, n, target, Math.max(0, delay), Math.random());
        if (pid <= 0) {
            for (const p of pids) ns.kill(p);
            free = null;
            return false;
        }
        pids.push(pid);
    }

    for (const [host, rem] of left) map.set(host, rem);
    return true;
}
