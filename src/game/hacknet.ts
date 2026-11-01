import type { HacknetServerHashUpgrade, NS } from "@ns";
import { bladeburnerActivity } from "./lib/bladeburner-activity.ts";
import { surplus, type Context } from "./lib/context.ts";
import { ChangeLog, announce, publishStatus, shortError } from "./lib/log.ts";
import { readNetWorth } from "./lib/net-worth.ts";

/**
 * The share of the run's free money one pass may spend on the fleet.
 *
 * IT USED TO BE 5%, AND THAT WAS THE MAIN REASON THE FLEET LOOKED IDLE. Two things went wrong
 * at once at that figure. The budget was a fraction of `surplus` — cash above the reserves —
 * rather than of anything hacknet-scale, so it stayed tiny even as the fleet's prices grew
 * with it; and ADR-0004 means an unaffordable best buys NOTHING, so a budget that only
 * occasionally covered the best upgrade produced long runs of passes that bought nothing.
 * The two rules are individually right and together starve: "wait for the best" is only a
 * good rule if the waiting actually ends.
 *
 * A QUARTER, not all of it. The rest of `surplus` is not hacknet's: `cloud.ts` and `home.ts`
 * bid for the same pool, and taking it all would let one feature price the others out. A
 * quarter spends several times faster than before while still leaving the majority on the
 * table, and the budget is re-derived from live cash every pass, so a fleet that spends fast
 * simply re-earns before the next one.
 *
 * THE OTHER HALF OF BEING AGGRESSIVE IS `PURCHASES_PER_PASS`. Raising this ratio without that
 * would only make the one purchase per pass more expensive; see there.
 */
var BUDGET_RATIO = 0.25;

/**
 * How many upgrades one pass may buy, in value order, until the budget runs out.
 *
 * ADR-0004 is right that a SECOND-CHOICE purchase is a waste, and it is still enforced: the
 * ranking is asked without a budget filter, and if the best is unaffordable the pass buys
 * nothing. What the ADR's "one purchase per pass" additionally assumed was that the rest of
 * the best upgrade's value could not be captured — but that only holds when the alternatives
 * are worse per dollar, not when they are the SAME purchase waiting for the next tick.
 *
 * At 1 purchase per 1s tick a fleet cannot spend its budget at all: one level upgrade, then
 * wait a second, so the pass rate — not the money — is what limits the fleet. Buying the
 * ranking's top few in one pass keeps every purchase the best available AT THAT MOMENT and
 * only removes the artificial rate limit. A level the ranking already chose does not become a
 * worse buy because the tick bought its neighbour first.
 *
 * Bounded, and it buys only while the budget covers the best remaining choice, so the last
 * purchase in a pass is still a purchase the ranking wanted rather than a substitute.
 */
var PURCHASES_PER_PASS = 4;



interface Action {
    type: "NODE" | "LEVEL" | "RAM" | "CORE" | "CACHE";
    nodeIndex?: number;
    cost: number;
}

/**
 * A candidate upgrade, with what the node's hash rate would BE after buying it.
 *
 * The `rateAfter` is carried rather than recomputed, because the caller is the only thing that
 * can ask the game what a node would produce at numbers it does not have yet. Ranking needs
 * that figure and nothing else about how it was obtained.
 */
export interface UpgradeCandidate {
    readonly type: "NODE" | "LEVEL" | "RAM" | "CORE" | "CACHE";
    readonly nodeIndex: number;
    readonly cost: number;
    /** Hash rate per second the NODE would produce after this upgrade. */
    readonly rateAfter: number;
}

/**
 * What a brand-new node produces per second, at the numbers the game starts one at.
 *
 * A NEW SERVER IS ALMOST WORTHLESS AT FIRST, and that is the fact the old node-first ordering
 * ignored. A server begins at level 1, RAM 1 and no cores, which is well under one hash per
 * second, while an established one is in the hundreds. So a new node is only a good buy while
 * it is CHEAP — early in a fleet's life — and becomes a bad one exactly when its price has run
 * up, which is when the old rule was still buying it.
 *
 * Ranked against the upgrades rather than assumed, so the fleet buys nodes when they are worth
 * it and stops when they are not. See `bestUpgrade`.
 */
function newNodeRate(ns: NS, isServer: boolean): number {
    try {
        if (isServer) return ns.formulas.hacknetServers.hashGainRate(1, 0, 1, 0);
        return ns.formulas.hacknetNodes.moneyGainRate(1, 1, 0);
    } catch {
        // No Formulas API: a new node's value is unknown, so it cannot win a value contest on
        // invented numbers. Zero means "no measured gain", which `bestUpgrade` rejects — the
        // fleet keeps upgrading what it has, which is the safe answer.
        return 0;
    }
}

/**
 * The fleet's current production per second, in whatever currency the node type earns in.
 *
 * Used only as the baseline the marginal gain is measured against. Every candidate shares it,
 * so subtracting it changes no ratio — but it is what makes the comparison MARGINAL, and a
 * node already producing a great deal should not have a small step look large.
 */

/**
 * The fleet's REAL hash rate, computed the same way the candidates are.
 *
 * WHY THIS IS NOT `stats.production`. That field was assumed to be the same number
 * `formulas.hacknetServers.hashGainRate` returns, and the assumption was written into the
 * comment below this function. The diagnostic proved it false: a BitNode-9 fleet reported
 * `fleet=0.1` — a tenth of a hash per second across every server — while an established server
 * really produces hundreds. So `rateOf` was measuring something else, and every upgrade's gain
 * came out as `0.1 - nodeBefore + after`, dominated by a large negative `nodeBefore`. Every
 * upgrade was rejected, the new node's `+0.00` was the only non-negative score, and the fleet
 * bought nodes forever.
 *
 * Comparing a node's formula rate against a fleet total from another field is the units bug in
 * its second form: not "one node against the fleet", but "one formula against another measure".
 * Both sides of the comparison now come from the same call.
 */
function hashRateOf(ns: NS, isServer: boolean, nodeCount: number): number {
    let total = 0;
    for (let i = 0; i < nodeCount; i++) {
        const s = ns.hacknet.getNodeStats(i);
        total += nodeRate(ns, isServer, s);
    }
    return total;
}

/** One node's current production, from the same formula the candidates use. */
function nodeRate(
    ns: NS,
    isServer: boolean,
    s: { level: number; ram: number; ramUsed?: number; cores: number; production: number },
): number {
    try {
        if (isServer) {
            return ns.formulas.hacknetServers.hashGainRate(s.level, s.ramUsed ?? 0, s.ram, s.cores);
        }
        return ns.formulas.hacknetNodes.moneyGainRate(s.level, s.ram, s.cores);
    } catch {
        return s.production;
    }
}

/**
 * What a node would produce per second at the numbers a given upgrade would leave it with.
 *
 * ASKS THE GAME, when it can. `formulas.hacknetServers.hashGainRate` and
 * `formulas.hacknetNodes.moneyGainRate` are the same functions the game uses to fill in
 * `stats.production`, so this is the node's real future production rather than a copy of a
 * formula that a patch would leave behind. The shape of the three upgrades — linear level,
 * `1.07^log2(ram)`, `cores/5` — is exactly what makes "cheapest" the wrong rule, and it is
 * also the part most likely to be rebalanced, which is why it is not restated here.
 *
 * Falls back to the node's CURRENT production when the Formulas API is unavailable. That is
 * deliberate and it degrades safely: every candidate scores a gain of zero, `bestUpgrade`
 * rejects them all, and the caller falls back to buying cache or stops — rather than acting on
 * invented numbers. A run without the API simply keeps the fleet it has.
 */
/**
 * What ONE node would produce per second at the numbers an upgrade would leave it with.
 *
 * ONE NODE, and that word is the whole bug this comment exists to prevent. It returns a
 * single node's rate, while the baseline every candidate is measured against is the FLEET
 * total. Comparing the two directly subtracts a whole fleet from one node, which comes out
 * hugely negative — so every upgrade scored as a catastrophic loss and was discarded, leaving
 * the new-node candidate (which was correctly built as `fleet + newNode`) as the only one that
 * ever survived. The fleet therefore bought nodes forever, however bad the price.
 *
 * Callers must convert this to a fleet figure by subtracting the node's CURRENT contribution
 * and adding this one. See the candidate construction in `tick`.
 *
 * ASKS THE GAME, when it can. `formulas.hacknetServers.hashGainRate` and
 * `formulas.hacknetNodes.moneyGainRate` are the same functions the game uses to fill in
 * `stats.production`, so this is the node's real future production rather than a copy of a
 * formula that a patch would leave behind. The shape of the three upgrades — linear level,
 * `1.07^log2(ram)`, `cores/5` — is exactly what makes "cheapest" the wrong rule, and it is
 * also the part most likely to be rebalanced, which is why it is not restated here.
 *
 * Falls back to the node's CURRENT production when the Formulas API is unavailable. That is
 * deliberate and it degrades safely: every candidate scores a gain of zero, `bestUpgrade`
 * rejects them all, and the caller falls back to buying cache or stops — rather than acting on
 * invented numbers.
 */
function productionAfter(
    ns: NS,
    isServer: boolean,
    stats: { ramUsed?: number; production: number },
    next: { level: number; ram: number; cores: number },
): number {
    try {
        if (isServer) {
            // A server's hash rate depends on how much RAM is already consumed, and its
            // "maxRam" is the upgraded figure — `ramUsed` is unchanged by buying RAM.
            const used = stats.ramUsed ?? 0;
            return ns.formulas.hacknetServers.hashGainRate(next.level, used, next.ram, next.cores);
        }
        return ns.formulas.hacknetNodes.moneyGainRate(next.level, next.ram, next.cores);
    } catch {
        return stats.production;
    }
}

/**
 * The fleet rate after a single node changes from `before` to `after`.
 *
 * THE CONVERSION THAT WAS MISSING. `productionAfter` answers for one node; every candidate is
 * ranked against the fleet. This is the one place the two are reconciled, so a caller cannot
 * forget it — which is precisely what happened when the ranking was first written.
 */
function fleetRateAfter(currentFleetRate: number, nodeBefore: number, nodeAfter: number): number {
    return currentFleetRate - nodeBefore + nodeAfter;
}

/**
 * The upgrade with the best hash rate per dollar, or null when none is affordable.
 *
 * WHY NOT CHEAPEST. The loop sorted by cost and took the first affordable entry. On a hacknet
 * node the three production upgrades buy very different amounts of hash rate, because the game
 * combines them differently — level linearly, RAM as 1.07^log2(ram), cores as 1 + (cores-1)/5.
 * A level upgrade is therefore often both cheaper AND better early on, while a core upgrade at
 * twice the price is a flat 20%; past a certain level that inverts. Price cannot see any of
 * that, which is why the run was reported as buying the wrong upgrades.
 *
 * MARGINAL, not total. The node already produces `currentRate`, which every candidate shares,
 * so subtracting it changes no ratio and is skipped. What matters is the STEP each purchase
 * buys, divided by what it costs.
 *
 * AFFORDABILITY IS A FILTER, not a tiebreak: an upgrade you cannot pay for is not a decision,
 * however good its ratio. The caller passes what it can spend.
 *
 * CACHE IS EXCLUDED FROM THE CONTEST. It raises the hash cap and produces nothing, so scoring
 * it by hash rate would rank it last always or (with a zero-gain guard) first never — either
 * way the comparison would be meaningless. The caller decides when cache is worth buying, from
 * the fill level, and this function refuses to express an opinion it cannot have.
 *
 * Ties go to the CHEAPER upgrade, so a per-dollar tie does not leave the choice to sort order.
 */
export function bestUpgrade(
    candidates: readonly UpgradeCandidate[],
    currentRate: number,
    budget: number,
): UpgradeCandidate | null {
    let best: UpgradeCandidate | null = null;
    let bestRatio = -Infinity;

    for (const candidate of candidates) {
        if (candidate.type === "CACHE") continue;
        if (!(candidate.cost <= budget)) continue;
        if (!Number.isFinite(candidate.cost) || candidate.cost <= 0) continue;

        // A purchase that reduces the rate is never worth making, whatever it costs — the
        // guard also keeps a 0/0 from scoring as a ratio of zero and beating nothing.
        const gain = candidate.rateAfter - currentRate;
        if (!(gain > 0)) continue;

        const ratio = gain / candidate.cost;
        if (ratio > bestRatio || (ratio === bestRatio && best !== null && candidate.cost < best.cost)) {
            best = candidate;
            bestRatio = ratio;
        }
    }

    return best;
}

/** One chosen upgrade, which is what `chooseHashUpgrade` decides between. */
export interface HashChoice {
    upgrade: HacknetServerHashUpgrade;
    target?: string;
}

/* ─── MODULE STATE (Persists across orchestrator ticks) ─── */
let isMaxed = false;
let log: ChangeLog | null = null;

/**
 * What the run is currently saving toward, for the console.
 *
 * THE QUESTION THIS ANSWERS. Hacknet buys several times a second in bursts and announces only
 * what it has already bought (`Purchased Node 9`), so the panel said what had happened and
 * never what was coming. "What is it aiming for, and how far off is it" was unanswerable
 * without reading the arithmetic in this file.
 *
 * Kept as the chosen ACTION rather than a formatted string, because the string has to be built
 * when it is read: the price of the next upgrade moves as the fleet grows, and a sentence
 * captured at purchase time would report a cost the run had already moved past.
 */
let target: { label: string; cost: number } | null = null;

/** Why production purchases are paused, or null. Set each tick from the hash cache. */
let blockedReason: string | null = null;

/** A short name for one upgrade, as the console shows it. */
function upgradeLabel(type: "NODE" | "LEVEL" | "RAM" | "CORE" | "CACHE", nodeIndex?: number): string {
    switch (type) {
        case "NODE": return "new node";
        case "LEVEL": return `node ${nodeIndex} level`;
        case "RAM": return `node ${nodeIndex} RAM`;
        case "CORE": return `node ${nodeIndex} core`;
        case "CACHE": return `node ${nodeIndex} cache`;
    }
}

/**
 * The line the console shows: what the next purchase is, and what it costs.
 *
 * WHY THE COST AND NOT JUST THE NAME. "node 3 ram" cannot be told apart from a run that has
 * stalled; the figure is what lets a reader judge whether the fleet is seconds from buying or
 * waiting on something it will never afford.
 *
 * A PURE FUNCTION OF ITS INPUTS, so the three states can be tested without a fleet. `ns` is
 * passed only for `format.number`, which keeps the line in the same units as the rest of the
 * console rather than inventing a second notation for billions.
 */
export function statusLine(
    ns: { format: Pick<NS["format"], "number"> },
    next: { label: string; cost: number } | null,
    maxed: boolean,
    /** Set when the hash cache is holding production purchases back. */
    blocked: string | null = null,
): string {
    if (maxed) return "maxed — nothing left to buy";
    // THE CACHE BLOCK IS A DIFFERENT ANSWER, and the one a reader is most often looking for.
    // A fleet that has stopped buying nodes because its hash cache filled up looks identical,
    // from the outside, to one that is simply saving — and the fix is different: spend hashes
    // rather than wait. Naming the reason turns a mysterious stall into an instruction.
    if (blocked !== null) return `${blocked} — spending hashes first`;
    if (next === null) return "choosing next upgrade";
    return `${next.label} next · ${ns.format.number(next.cost)}`;
}

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

/**
 * Every purchasable option right now, with the fleet baseline they are ranked against.
 *
 * BUILT FROM THE LIVE FLEET, and that is why it is a function rather than a value captured
 * once: every hacknet price and every node's rate depends on the current state, so a list built
 * before a purchase is stale for the next one. `tick` calls this before its first buy and again
 * after each buy, which is what makes a multi-purchase pass spend on the best option AT THE
 * MOMENT of each purchase rather than on a plan drawn up for a fleet that no longer exists.
 *
 * `currentRate` travels with the candidates rather than being recomputed by the caller, because
 * the node candidate and the upgrade candidates must share one baseline — a gain measured against
 * one total and ranked against another is the units bug this file has already paid for twice.
 *
 * Cache entries are included when `canUpgradeCache`, with `rateAfter: 0`. `bestUpgrade` excludes
 * them from the value contest, so that field is never consulted; they are here so the cache
 * decision is made in the same place as everything else.
 */
function rankAgain(
    ns: NS,
    isServer: boolean,
    nodeCount: number,
    targetNodes: number,
    canUpgradeProduction: boolean,
    canUpgradeCache: boolean,
): { candidates: UpgradeCandidate[]; currentRate: number } {
    const currentRate = hashRateOf(ns, isServer, nodeCount);
    const candidates: UpgradeCandidate[] = [];

    // THE NODE JOINS THE CONTEST. Only when production spending is allowed, which is the same
    // cache rule that gates the upgrades — a fleet full of hashes is not buying anything that
    // produces more of them.
    if (canUpgradeProduction && nodeCount < targetNodes) {
        const nodeCost = ns.hacknet.getPurchaseNodeCost();
        if (isFinite(nodeCost)) {
            // A fresh node's own starting production. It is not zero, so it can win on value
            // when nodes are still cheap — which is exactly when buying them is right.
            candidates.push({
                type: "NODE",
                nodeIndex: nodeCount,
                cost: nodeCost,
                rateAfter: currentRate + newNodeRate(ns, isServer),
            });
        }
    }

    for (let i = 0; i < nodeCount; i++) {
        if (canUpgradeProduction) {
            const stats = ns.hacknet.getNodeStats(i);
            const before = nodeRate(ns, isServer, stats);

            const levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
            if (isFinite(levelCost)) {
                const after = productionAfter(ns, isServer, stats, {
                    level: stats.level + 1,
                    ram: stats.ram,
                    cores: stats.cores,
                });
                candidates.push({
                    type: "LEVEL",
                    nodeIndex: i,
                    cost: levelCost,
                    rateAfter: fleetRateAfter(currentRate, before, after),
                });
            }

            const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
            if (isFinite(ramCost)) {
                const after = productionAfter(ns, isServer, stats, {
                    level: stats.level,
                    ram: stats.ram * 2,
                    cores: stats.cores,
                });
                candidates.push({
                    type: "RAM",
                    nodeIndex: i,
                    cost: ramCost,
                    rateAfter: fleetRateAfter(currentRate, before, after),
                });
            }

            const coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);
            if (isFinite(coreCost)) {
                const after = productionAfter(ns, isServer, stats, {
                    level: stats.level,
                    ram: stats.ram,
                    cores: stats.cores + 1,
                });
                candidates.push({
                    type: "CORE",
                    nodeIndex: i,
                    cost: coreCost,
                    rateAfter: fleetRateAfter(currentRate, before, after),
                });
            }
        }

        if (canUpgradeCache) {
            const cacheCost = ns.hacknet.getCacheUpgradeCost(i, 1);
            if (isFinite(cacheCost)) {
                // Cache has no production of its own; `bestUpgrade` excludes it from the value
                // contest, so its `rateAfter` is never consulted.
                candidates.push({ type: "CACHE", nodeIndex: i, cost: cacheCost, rateAfter: 0 });
            }
        }
    }

    return { candidates, currentRate };
}

/** Executed sequentially per Nexus orchestrator tick */
export function tick(ns: NS, context: Context): void {
    log ??= new ChangeLog(ns, "HACKNET");
    log.updateNs(ns);

    // The getter is registered once and reads `target` when the console asks, so the line
    // tracks the fleet as it grows rather than reporting the state at registration.
    publishStatus("hacknet", () => statusLine(ns, target, isMaxed, blockedReason));

    try {
        // ── Per-tick setup ──
        const nodeCount = ns.hacknet.numNodes();
        const isServer = nodeCount > 0 && isHacknetServer(ns, 0);
        const targetNodes = isServer ? 30 : 10;
        let actionTaken = false;
        let purchasesThisTick = 0;
        /** The last purchase this pass, for the status line. Null when nothing was bought. */
        let lastBought: Action | null = null;
        /** The best-value candidate the final iteration ranked, affordable or not. */
        let lastBest: UpgradeCandidate | null = null;

        let remaining = surplus(context.snapshot, context.reserves) * BUDGET_RATIO;

        // Evaluate global hash cache status ONCE per tick
        let canUpgradeProduction = true;
        let canUpgradeCache = false;

        if (isServer) {
            const capacity = ns.hacknet.hashCapacity();
            if (capacity > 0) {
                const currentHashes = ns.hacknet.numHashes();
                // Nodes, Level, RAM, Core are ONLY bought if cache is < 90%
                //
                // IT USED TO STOP AT 50%, AND THAT GATE, NOT THE BUDGET, IS WHAT MADE THE
                // FLEET LOOK IDLE MOST OFTEN. A hacknet fleet's whole job is producing hashes,
                // so a pool that is half full is the NORMAL state rather than a warning: the
                // fleet spends long stretches above half capacity with hashes being spent
                // steadily, and every one of those ticks bought nothing. The status line read
                // "hash cache 52% full — spending hashes first" while the fleet sat still.
                //
                // THE REASON FOR A GATE AT ALL IS SOUND and is kept: hashes that overflow the
                // pool are income lost, so a fleet that cannot spend them should stop making
                // them. But the danger is at the CAP, not at half of it, and
                // `HASH_CAPACITY_RELEASE` (90%) is already the point where the hash-spending
                // side treats the pool as nearly full and sells or dumps. Sharing one figure
                // means the two halves cannot disagree, and leaves the top tenth as the only
                // window where production waits — and the spending side is already working to
                // empty it.
                canUpgradeProduction = currentHashes < (capacity * HASH_CAPACITY_RELEASE);
                // Cache is ONLY bought if cache is >= 75%
                canUpgradeCache = currentHashes >= (capacity * 0.75);
            }
        }

        // WHY PRODUCTION SPENDING IS OFF, when it is off for a reason worth naming. The cache
        // rule above stops every node and upgrade purchase once hashes nearly fill the cap, so
        // the fleet buys nothing until enough hashes are spent. That is deliberate, but from
        // the console it is indistinguishable from saving for something it cannot afford, and
        // the run looks stuck. Named here so the status line can say which it is.
        blockedReason = isServer && !canUpgradeProduction
            ? `hash cache ${ns.format.percent(ns.hacknet.numHashes() / Math.max(1, ns.hacknet.hashCapacity()))} full`
            : null;

        // ── UP TO `PURCHASES_PER_PASS` OF THE BEST, ONCE ──
        //
        // This was a `do/while` that bought until nothing was affordable, capped at eight; then
        // a single decision, because buying a second thing in the same pass can only be the
        // second-best purchase. The second-best half of that is still true and still enforced —
        // every buy here is the ranking's top choice for the money that is left — but the
        // "single" half was rate-limiting the fleet rather than protecting it. See
        // `PURCHASES_PER_PASS`.
        {
            const currentNodes = ns.hacknet.numNodes();

            // ── A NEW NODE IS A CANDIDATE, NOT A PRIORITY ──
            //
            // It used to be bought unconditionally, ahead of every upgrade, whenever the fleet
            // was under its node cap. That is wrong once the cheap nodes are gone, and the
            // recorded run shows the cost: a BitNode-9 fleet with ~7 of a target 10 servers had
            // a next-server price of 78m, then 391m, then 1.95b, against 52m of cash. It spent
            // the whole session "saving" for a server that was never affordable while the
            // upgrades it COULD afford went unbought.
            //
            // The arithmetic is not close. A new server starts at level 1 / RAM 1 and produces
            // well under 1 H/s; doubling the RAM of an existing level-100 server multiplies
            // hundreds of H/s for a fraction of the price. So a node is ranked on the same
            // hash-rate-per-dollar rule as everything else, and it simply loses when it is
            // worth less — which it usually is.
            let bestAction: Action | null = null;

            // ── Priority 2: the upgrade with the best hash rate per dollar ──
            //
            // THIS USED TO SORT BY COST and take the first affordable entry. Reported as "not
            // buying the most effective of level/ram/cores measured in hashes generated per
            // second", and price cannot answer that: the three upgrades buy very different
            // steps of production per dollar. See `bestUpgrade`.
            //
            // The rates come from the game's own formulas rather than a copied constant, so a
            // patch that changes the shape of an upgrade changes this with it. Without the
            // Formulas API there is nothing to compare, and the run falls back to cheapest —
            // the old behaviour — rather than guessing at production it cannot measure.
            if (!bestAction) {
                const { candidates, currentRate } = rankAgain(
                    ns, isServer, currentNodes, targetNodes, canUpgradeProduction, canUpgradeCache,
                );

                if (candidates.length === 0) {
                    // EMPTY IS NOT THE SAME AS MAXED, and conflating the two latched the fleet
                    // off permanently.
                    //
                    // `candidates` is empty for two very different reasons: every node is at
                    // its ceiling (genuinely maxed, never recovers), OR this particular tick is
                    // not allowed to buy anything — the hash cache is at the release threshold
                    // and the cache is not yet full enough to upgrade. The second is a few
                    // seconds of waiting, not the end of the run.
                    //
                    // `isMaxed` is sticky and drives `intervalMs`, so setting it on a busy tick
                    // dropped the fleet to one purchase attempt per MINUTE, forever. It is only
                    // maxed when production was actually ALLOWED and there was still nothing to
                    // buy; otherwise the fleet keeps its normal tick and tries again shortly.
                    if (canUpgradeProduction || canUpgradeCache) {
                        isMaxed = true;
                    }
                }

                // ONE RULE: BUY WHAT `bestUpgrade` SAYS, OR BUY NOTHING.
                //
                // The operator's instruction, and it is stricter than what was here. The ranking
                // is the whole decision; everything that softened it afterwards was a way of
                // buying something the ranking had NOT chosen:
                //
                //   - falling through to the next-best AFFORDABLE upgrade, which spent the
                //     budget on levels when the core did not fit — eight in one pass, 18.4m for
                //     +19.2 H/s against +240 H/s the same money could have bought;
                //   - a cache fallback that bought whenever production had nothing to offer,
                //     which is a different purchase chosen by a different rule.
                //
                // Both are gone. The best-value candidate is computed WITHOUT a budget filter,
                // and then one question decides: can this pass pay for it?
                //
                //   yes -> buy it
                //   no  -> buy nothing and let the budget carry over
                //
                // The second half is the point of the rule, not a side effect: spending on a
                // worse upgrade does not capture any of the value the better one had, because
                // the comparison is a RATIO. Money kept is money available next pass, and the
                // best upgrade is reached sooner by waiting for it than by substituting for it.
                //
                // IT IS THE FIRST OF UP TO `PURCHASES_PER_PASS` BUYS rather than the only one.
                // The substitute is still refused — every purchase below is the ranking's top
                // choice for the money that is actually left, and the loop stops the moment the
                // best remaining choice no longer fits — but a fleet that could afford four
                // good upgrades no longer has to spend four ticks buying them one at a time.
                const best = bestUpgrade(candidates, currentRate, Infinity);
                lastBest = best;

                // ONLY IF THE RANKING PRODUCED SOMETHING AND THE BUDGET COVERS IT. Both are
                // "buy nothing and wait" — the difference is only in what the status line says.
                if (best !== null && best.cost <= remaining) {
                    bestAction = { type: best.type, nodeIndex: best.nodeIndex, cost: best.cost };
                }
            }

            // NOTHING TO BUY: no purchase this pass, and the budget carries over untouched.
            // Everything below runs only when the ranking chose something this pass could pay
            // for, so there is no path from here that buys a substitute.
            //
            // `retried` allows ONE re-rank per refused purchase, so a stale price cannot turn a
            // burst of four buys into a burst of zero — but a genuine refusal still ends the
            // pass rather than looping.
            let retried = false;
            //
            // THE LOOP RE-RANKS AFTER EACH BUY, rather than walking the list it started with.
            // Every hacknet price depends on the current state, so the candidate list is stale
            // the instant anything is bought: a level upgrade's cost grows, the next server's
            // price grows, and a node's own rate changes. Re-ranking costs one `bestUpgrade`
            // over the already-built list and keeps each purchase the best value AT THE MOMENT
            // IT IS MADE — which is the guarantee ADR-0004 actually cares about, and the reason
            // this can repeat without ever buying a second choice.
            for (let buy = 0; bestAction !== null && buy < PURCHASES_PER_PASS; buy++) {
                const action: Action = bestAction;
                let bought = false;
                switch (action.type) {
                    case "NODE":
                        // Announced by the shared line below, like every other purchase.
                        bought = ns.hacknet.purchaseNode() >= 0;
                        break;
                    case "LEVEL":
                        bought = ns.hacknet.upgradeLevel(action.nodeIndex!, 1);
                        break;
                    case "RAM":
                        bought = ns.hacknet.upgradeRam(action.nodeIndex!, 1);
                        break;
                    case "CORE":
                        bought = ns.hacknet.upgradeCore(action.nodeIndex!, 1);
                        break;
                    case "CACHE":
                        bought = ns.hacknet.upgradeCache(action.nodeIndex!, 1);
                        break;
                }

                // A REFUSED PURCHASE RE-RANKS ONCE, THEN ENDS THE PASS.
                //
                // The game refuses for reasons that are already stale by the time it answers:
                // a hacknet price rises with every level and every new node, so a rank taken
                // microseconds before the call can name a figure that no longer holds. That is
                // a race, not a signal that nothing is worth buying — and ending the pass on it
                // made a burst of four buys silently become a burst of zero.
                //
                // One retry against re-read prices separates the two cases. A genuine refusal
                // (the thing is genuinely unaffordable, or the node is gone) refuses again and
                // the pass ends with the budget untouched, as before.
                if (!bought) {
                    if (retried) break;
                    retried = true;

                    const fresh = rankAgain(ns, isServer, ns.hacknet.numNodes(), targetNodes, canUpgradeProduction, canUpgradeCache);
                    const freshBest = bestUpgrade(fresh.candidates, fresh.currentRate, Infinity);
                    lastBest = freshBest;
                    bestAction = freshBest !== null && freshBest.cost <= remaining
                        ? { type: freshBest.type, nodeIndex: freshBest.nodeIndex, cost: freshBest.cost }
                        : null;
                    if (bestAction === null) break;
                    continue;
                }
                retried = false;

                actionTaken = true;
                purchasesThisTick++;
                remaining -= action.cost;
                lastBought = action;

                // EVERY PURCHASE IS ANNOUNCED, not just nodes.
                //
                // Only `NODE` was announced, so level, RAM and core upgrades appeared with no log
                // line at all: the console named one thing while the fleet silently bought another,
                // and there was no record to check it against. The reported symptom — "it says
                // 'node 0 core next' but is happily buying random levels" — was exactly this.
                // Naming each one costs a line whenever something is bought, and a run that buys
                // nothing pays nothing.
                // "Bought" for a new node, "Upgraded" for the rest — a node is not an upgrade of
                // anything, and the label for one reads "new node", which would otherwise log as
                // "Upgraded new node".
                const what = action.type === "NODE"
                    ? `new node ${currentNodes}`
                    : upgradeLabel(action.type, action.nodeIndex);
                announce(ns, "HACKNET", `${action.type === "NODE" ? "Bought" : "Upgraded"} ${what} (${ns.format.number(action.cost)})`, "tx");

                // ── Re-rank for the next buy ──
                //
                // The node and each upgrade's current price and yield are read again, so the
                // ranking is never spending against figures from before the purchase. The
                // remaining budget moves unchanged, so the next buy has to fit what is left.
                //
                // THE NODE COUNT IS RE-READ rather than reused: buying a node is the one
                // purchase that changes how many of them there are, and ranking the next buy
                // against the old count would price a second server at the first one's index.
                const after = ns.hacknet.numNodes();
                const next = rankAgain(ns, isServer, after, targetNodes, canUpgradeProduction, canUpgradeCache);
                const bestNext = bestUpgrade(next.candidates, next.currentRate, Infinity);
                lastBest = bestNext;
                bestAction = bestNext !== null && bestNext.cost <= remaining
                    ? { type: bestNext.type, nodeIndex: bestNext.nodeIndex, cost: bestNext.cost }
                    : null;
            }
        }

        // THE STATUS LINE IS SET ONCE, AFTER THE LOOP, FROM WHAT ACTUALLY HAPPENED.
        //
        // It used to be assigned inside the loop, which meant the LAST iteration won: after a
        // pass that bought eight levels, the final evaluation found the core unaffordable and
        // the line read "node 0 core when affordable · 140k" — describing a purchase that was
        // never made, while eight levels had just been bought. Reported as "still happily
        // buying levels instead of waiting for the best upgrade", and the report was right.
        //
        // Three states, and the reader needs to tell them apart:
        //   bought something     -> name the last thing bought
        //   nothing affordable   -> name the best value and the gap, so waiting is legible
        //   nothing worth buying -> clear, and let the cache/spend branch explain
        //
        // Assigning here also stops the line from flickering between prices as the loop
        // shrinks `remaining`, which is what made the gap read 140k then 3.45m then 258k.
        if (lastBought !== null) {
            target = { label: upgradeLabel(lastBought.type, lastBought.nodeIndex), cost: lastBought.cost };
        } else {
            // Nothing was bought. Name the best value and the gap, so a pass that deliberately
            // waits is distinguishable from one that found nothing worth buying at all — the
            // two look identical otherwise, and only one of them is healthy. `lastBest` is the
            // figure the final iteration ranked, kept for exactly this.
            target = lastBest === null
                ? null
                : {
                    label: `${upgradeLabel(lastBest.type, lastBest.nodeIndex)} when affordable`,
                    cost: Math.max(0, lastBest.cost - Math.max(0, remaining)),
                };
        }

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


/** The cash figure below which hashes are spent on money and nothing else. */
export const HASH_CASH_FLOOR = 250_000_000;

/** How full the hash pool must be before holding hashes back starts wasting them. */
export const HASH_CAPACITY_RELEASE = 0.90;

/**
 * How many seconds of production an overflow sale may convert.
 *
 * A FULL POOL IS NOT A REASON TO SELL EVERYTHING, and the old dump did exactly that: it sold
 * until the pool was back down to 70% of capacity, whatever that was worth. On a big fleet
 * that is a large quantity of hashes spent on cash the run did not ask for, when the only
 * thing that needed doing was making enough room to keep producing.
 *
 * The amount at risk is the amount that would otherwise be LOST — the overflow — and the
 * cheapest way to express "enough room" is time: sell what ten seconds of production would
 * overflow. That scales with the fleet automatically, so a fast fleet makes a bigger hole for
 * itself and a slow one sells almost nothing, without either needing a tuned constant.
 *
 * TEN SECONDS is deliberately generous relative to one tick. The orchestrator ticks hacknet
 * roughly once a second while not maxed, so ten seconds is ~10 ticks of headroom — long enough
 * that the pool does not re-fill on the very next pass and re-sell immediately, which is what
 * turns an overflow sale into a per-tick drain.
 */
export const OVERFLOW_SALE_SECONDS = 10;

/**
 * How many hashes an overflow sale should convert, given the fleet's rate.
 *
 * THE OVERFLOW, NOT THE POOL. Only hashes that cannot fit are being lost, so only that many
 * need converting; everything above the free space is hashes the run chose to keep, and
 * selling them spends them on cash by default rather than on whatever the run was saving for.
 *
 * `costPerSale` IS THE FLOOR, because the game sells in whole units. A pool with 40 hashes of
 * overflow but a 100-hash sale price cannot make a partial sale — the choice is one sale or
 * none, and one sale is correct when the alternative is losing the overflow outright.
 *
 * Returns 0 when there is nothing overflowing and nothing to gain, so a caller can tell
 * "sell nothing" from "sell one unit".
 */
export function overflowSaleHashes(
    hashes: number,
    capacity: number,
    ratePerSecond: number,
    costPerSale: number,
): number {
    if (!(costPerSale > 0)) return 0;
    if (!(capacity > 0)) return 0;

    // Hashes over the cap. Nothing over the cap means nothing is being lost.
    const overflow = hashes - capacity;
    if (!(overflow > 0)) return 0;

    // Ten seconds of production is what we expect to LOSE if the pool sits at the ceiling for
    // the next few ticks, and that is the quantity worth converting. It is a CAP, not a
    // floor: `min(overflow, horizon)` never sells more than is actually overflowing, and never
    // more than ten seconds' worth even when far more is over the line.
    //
    // MIN RATHER THAN MAX, and getting this backwards is the whole bug. `max` made a fast
    // fleet sell TEN SECONDS OF ITS ENTIRE OUTPUT — 2,000 hashes at 200 H/s — to solve a
    // 300-hash overflow, which is the "sell everything" behaviour this function exists to
    // replace, arrived at by a different route.
    //
    // Zero rate is the case where the fleet produces nothing, so a ceiling with hashes at it
    // is not losing anything new — but `overflow` is still real, and selling it is the only
    // way to make room. Hence the floor of one sale below, not a zero horizon here.
    const horizon = ratePerSecond > 0
        ? Math.min(overflow, ratePerSecond * OVERFLOW_SALE_SECONDS)
        : overflow;

    // Whole sale units, rounded up: a partial sale is not possible, and rounding down would
    // leave the overflow still overflowing.
    const sales = Math.ceil(horizon / costPerSale);
    return sales * costPerSale;
}

/**
 * How many times to sell, given the pool and rate. At most what is held, at least one.
 *
 * The count rather than the hash quantity, because every caller sells by repeatedly calling
 * `spendHashes("Sell for Money")` and needs to know when to stop.
 */
export function overflowSaleCount(
    hashes: number,
    capacity: number,
    ratePerSecond: number,
    costPerSale: number,
): number {
    const wanted = overflowSaleHashes(hashes, capacity, ratePerSecond, costPerSale);
    if (!(wanted > 0) || !(costPerSale > 0)) return 0;
    // NEVER MORE SALES THAN THE POOL CAN PAY FOR. `wanted` is the quantity to convert and the
    // pool may hold more than that; the bound is the pool, not the ceiling.
    const affordable = Math.floor(hashes / costPerSale);
    return Math.max(0, Math.min(Math.ceil(wanted / costPerSale), affordable));
}

/**
 * Whether the pool is COMPLETELY full, so hashes must be sold before anything else.
 *
 * SEPARATE FROM `hashSpendIsCashOnly`, and the difference is permission versus obligation.
 * That one says "above the cash floor, the restriction lifts" — which leaves the ordinary
 * chain free to pick Bladeburner rank and let the pool overflow anyway. The operator's rule is
 * stronger: when the pool would otherwise be completely full, selling for money wins outright,
 * because the alternative is losing hashes to the cap.
 *
 * COMPLETELY FULL, not "nearly". `HASH_CAPACITY_RELEASE` is the softer threshold used to lift
 * the cash-only restriction — at 90% the run may spend on something productive rather than
 * wait. This one only fires when there is genuinely no room left, so it does not turn the
 * overflow guard into a licence to sell constantly.
 *
 * A non-positive capacity means a fleet with no servers yet: it cannot overflow, and `0/0` must
 * not read as full and force a sale there is nowhere to make.
 */
export function mustSellForCapacity(hashes: number, capacity: number): boolean {
    if (!(capacity > 0)) return false;
    return hashes >= capacity;
}

/**
 * Whether the pool is too small to ever hold the dearest hash upgrade.
 *
 * A REACHABILITY RULE rather than a value one. Every hash spend is priced in hashes, so a
 * capacity below the highest price means that option is permanently out of reach however long
 * the run waits: the pool caps before the price can be met. Nothing about saving hashes changes
 * it, so raising capacity is the only move that does.
 *
 * THE DEAREST PRICE, not the price of whatever is being considered. Capacity is a ceiling on
 * every option at once, so the question is whether ANY of them fit — comparing against the
 * cheapest would call a pool adequate when it can afford exactly one thing.
 *
 * Zero capacity is a fleet that has no servers yet, and "too small" is not actionable there:
 * there is no cache to upgrade. A zero price means no upgrades were available to price, which
 * must not read as an infinitely small pool.
 */
export function cacheTooSmallForAnyUpgrade(capacity: number, dearestUpgradeHashes: number): boolean {
    if (!(capacity > 0)) return false;
    if (!(dearestUpgradeHashes > 0)) return false;
    return capacity < dearestUpgradeHashes;
}

/**
 * What the pool needs done to it, given its currently held hashes.
 *
 * NAME IT RATHER THAN ORDER IT IN PLACE, because the two rules can both apply on one tick and
 * the order between them is a decision rather than an incidental. Cache used to be checked
 * first and returned, so a full pool on a small cache bought cache forever and never sold a
 * hash — the opposite of what either rule was for.
 *
 *   cash    the pool is completely full: sell NOW. Hashes are being lost this instant, and a
 *           sale produces the cash that pays for a cache upgrade. It cannot wait a tick.
 *   cache   the pool is not at risk, but cannot ever hold the dearest upgrade, so capacity is
 *           the thing to raise.
 *   spend   neither applies; the ordinary chain decides what the hashes are for.
 *
 * A full pool therefore sells first even when the cache is too small, which is the operator's
 * instruction and also the only order that makes sense: the urgent thing first, the improvement
 * second.
 */
export type HashPoolAction = "sell" | "sell-then-cache" | "cache" | "spend";

export function hashActionAt(hashes: number, capacity: number, dearestUpgradeHashes: number): HashPoolAction {
    const full = mustSellForCapacity(hashes, capacity);
    const tooSmall = cacheTooSmallForAnyUpgrade(capacity, dearestUpgradeHashes);

    // BOTH, WHEN BOTH ARE TRUE, and that combination is the one that was missing.
    //
    // A sale is urgent and must happen first: hashes are being lost this instant. But a sale
    // that refills the pool leaves the ceiling exactly as it was, so the next tick sells again
    // — and the tick after that. Selling alone never fixes a pool too small to hold anything:
    // it just keeps emptying a pool that keeps overflowing.
    //
    // Ordering the two could not express this. Whichever came first swallowed the other; the
    // answer is that the pass does both, sale first because it is the urgent half.
    if (full && tooSmall) return "sell-then-cache";
    if (full) return "sell";
    if (tooSmall) return "cache";
    return "spend";
}

/**
 * The hash price of the most expensive upgrade available, or 0 when none can be priced.
 *
 * ASKED OF THE GAME rather than from a table here: the prices move with Source Files and
 * BitNode multipliers, so a copied list would be wrong on most runs. `getHashUpgrades()` is
 * the game's own list of what may be bought, and `hashCost` its own price for each — the same
 * pair `chooseHashUpgrade` spends through, so the ceiling and the prices cannot disagree.
 *
 * Returns 0 rather than Infinity when nothing can be priced, so a caller comparing against it
 * does not conclude the pool is infinitely too small and buy cache forever.
 */
function dearestUpgradeHashes(ns: NS): number {
    let dearest = 0;
    try {
        for (const upgrade of ns.hacknet.getHashUpgrades()) {
            const cost = ns.hacknet.hashCost(upgrade);
            if (isFinite(cost) && cost > dearest) dearest = cost;
        }
    } catch {
        return 0;
    }
    return dearest;
}

/**
 * Whether hashes may ONLY be sold for money right now.
 *
 * THE OPERATOR'S RULE, in two halves and one exception:
 *
 *   cash below the floor  -> money only. Rank, gym boosts and studying are all worth having,
 *                            but they are bought with cash the run does not have yet, and
 *                            converting hashes to money is what gets it there.
 *   cash at or above it   -> the restriction lifts and the ordinary priority chain applies.
 *   pool nearly full      -> the restriction lifts anyway.
 *
 * THE EXCEPTION IS NOT A CONVENIENCE. The game caps the hash pool, so once it is nearly full
 * every further hash is income that never arrives — waiting for the cash floor then destroys
 * the very thing the floor was protecting. Past `HASH_CAPACITY_RELEASE` any productive spend
 * beats holding.
 *
 * An empty pool has no meaningful ratio: `0/0` must not read as full and switch the rule off,
 * so a non-positive capacity leaves the cash floor in charge.
 */
export function hashSpendIsCashOnly(cash: number, hashes: number, capacity: number): boolean {
    if (cash >= HASH_CASH_FLOOR) return false;
    if (!(capacity > 0)) return true;
    return hashes / capacity < HASH_CAPACITY_RELEASE;
}

/**
 * The cash figure hashes are sold toward when buying the 4S Market Data TIX API is the
 * run's next purchase, or 0 when it is not.
 *
 * WHY THE 4S API IS SPECIAL ENOUGH TO OVERRIDE THE WEALTH TARGET. It is the one purchase
 * the framework cannot pay for out of net worth: `readNetWorth` counts money parked in
 * stock positions, and that money is exactly what a position is holding — it cannot be
 * spent on an API without selling the position first, which the stock feature is
 * deliberately reluctant to do. So a player at the wealth target with most of it in
 * positions is "rich enough" and still cannot buy the API, and this file would go on
 * declining to sell hashes because the wealth figure says the run already has money.
 * Cash is the only currency `home.ts` can pay with, so cash is what has to be raised.
 *
 * THE INSTRUCTION THIS IMPLEMENTS: while 4S is unfunded, "Sell for Money" outranks every
 * other hash upgrade, and keeps doing so until home cash covers the API's own price. It is
 * a priority rather than a preference because of what the alternative costs: without 4S
 * the stock feature runs degraded, so hashes spent on Bladeburner rank or gym training are
 * spent to accelerate a run whose main income source is still switched off.
 *
 * 0 MEANS "NOT THIS ONE", in three cases, and the caller only has to know that much:
 * the API is bought; the run does not yet own the TIX API, so 4S is two links away and
 * buying it is not what the money is for; or the figure was unreadable. The TIX gate lives
 * in `fourSCost` so this cannot disagree with anyone else about it — without it, a
 * brand-new run would divert every hash toward ~$25b for a purchase queued behind two
 * cheaper ones, for most of the early game.
 *
 * Reads the snapshot rather than calling `ns.stock`: the orchestrator already pays for
 * that read once per pass, and the goal, `home.ts` and this rule must not be able to
 * disagree about what the API costs.
 */
function fourSFundTarget(context: Context): number {
    return context.snapshot.fourSCost;
}

/**
 * How far above current cash the 4S price may sit before the rule stops waiting for it.
 *
 * 10x, so the rule engages while the run has at least a tenth of the price in hand. The
 * number is chosen against how the money actually arrives: at 10x, a run earning steadily
 * reaches the API without the rule ever standing down, and a run whose target is more than
 * an order of magnitude away is not going to close the gap through hash sales anyway —
 * each "Sell for Money" is $1m, so a $250b API would need 250,000 sales.
 *
 * WHY A MULTIPLE RATHER THAN AN ABSOLUTE FLOOR. The base price is ~$25b, so an absolute
 * floor would have to be enormous to matter and would then be wrong on the nodes whose
 * multiplier shrinks the price. A ratio asks the question that actually decides the
 * behaviour — "is this purchase within reach of this run" — and reads the same at every
 * multiplier.
 *
 * Too high and the stand-down never happens, which is the bug this bounds. Too low and the
 * rule releases the moment the run is poor, which is ordinary and harmless: the cash is
 * still spent on the API by `home.ts` whenever it arrives, and the rule re-engages as soon
 * as cash re-enters the band. Erring low is therefore the safe direction.
 */
const FOUR_S_REACHABLE_BUDGET = 10;

/**
 * Whether a target is close enough in cash terms to be worth saving toward.
 *
 * Extracted rather than inlined into the branch above because "is this worth chasing" is
 * the question the rule's whole risk turns on, and it is the piece a test can point at.
 * `cash` of 0 is reachable by definition: an empty wallet has spent nothing yet, and
 * refusing to start saving because the run begins at zero would disable the rule entirely
 * for one tick at every reset.
 */
function reachable(target: number, cash: number): boolean {
    if (cash <= 0) return true;
    return target <= cash * FOUR_S_REACHABLE_BUDGET;
}

function spendHashes(ns: NS, context: Context): void {
    const capacity = ns.hacknet.hashCapacity();

    // NO CAPACITY YET IS NOT "NOTHING TO DO". `dearestUpgradeHashes` does not need a pool of
    // its own, and the cache branch is reached only when a pool exists — but returning here
    // meant a fleet whose servers had no cache yet never bought one. The guards that actually
    // matter are inside the branches.
    const hashes = capacity > 0 ? ns.hacknet.numHashes() : 0;
    const action = hashActionAt(hashes, capacity, dearestUpgradeHashes(ns));

    /*
     * ── A FULL POOL SELLS FIRST ──
     *
     * The order is a decision, not an incidental: see `hashActionAt`. A full pool is losing
     * hashes this instant and a sale is what produces the cash that pays for a cache upgrade,
     * so the urgent thing goes first.
     *
     * `sell-then-cache` is the case that was missing. Selling alone leaves the ceiling exactly
     * where it was, so the pool refills and the next tick sells again — the reported "den køber
     * ikke cache level når der ikke kan være flere hashes". One sale makes room; the cache
     * purchase on the same pass stops the next hundred ticks being identical.
     */
    if (action === "sell" || action === "sell-then-cache") {
        // ONE SALE IS NOT ALWAYS ENOUGH ANY MORE — see below. The full-pool case still sells
        // first and urgently, because hashes are being lost this instant, but it sells the
        // OVERFLOW rather than one arbitrary unit or the whole pool.
        const cost = ns.hacknet.hashCost("Sell for Money");
        if (isFinite(cost) && cost > 0) {
            const rate = hashRateOf(ns, true, ns.hacknet.numNodes());
            const sales = overflowSaleCount(hashes, capacity, rate, cost);
            let sold = 0;
            for (let i = 0; i < sales; i++) {
                if (!ns.hacknet.spendHashes("Sell for Money")) break;
                sold++;
            }
            if (sold > 0) {
                announce(ns, "HACKNET", `Sold ${sold * cost} hashes — pool full (${ns.format.number(hashes)}/${ns.format.number(capacity)})`, "tx");
                if (action === "sell") return;
                // Room made; fall through to raise the ceiling that caused the overflow.
            } else if (action === "sell") {
                return;
            }
        } else if (action === "sell") {
            return;
        }
    }

    /*
     * ── A POOL TOO SMALL FOR ANY UPGRADE IS A CACHE PROBLEM, not a spending one ──
     *
     * Every hash spend is priced in hashes, so a pool that caps below the dearest price can
     * never afford it however long the run waits. No spending decision fixes that; only a
     * larger cache does.
     *
     * `upgradeCache` is a CASH purchase, not a hash spend — a different action with a
     * different currency — which is why this lives here rather than in `chooseHashUpgrade`.
     * That function answers "which hash upgrade", and cache is not one.
     */
    if (action === "cache" || action === "sell-then-cache") {
        // The node whose cache is cheapest to raise, by the same value logic as production:
        // any node's cache raises the fleet's ceiling, so the cheapest one is the right buy.
        let best = -1;
        let bestCost = Infinity;
        for (let i = 0; i < ns.hacknet.numNodes(); i++) {
            if (!isHacknetServer(ns, i)) continue;
            const cost = ns.hacknet.getCacheUpgradeCost(i, 1);
            if (!isFinite(cost) || cost <= 0) continue;
            if (cost >= bestCost) continue;
            const remaining = surplus(context.snapshot, context.reserves);
            if (cost > remaining) continue;
            best = i;
            bestCost = cost;
        }
        if (best >= 0 && ns.hacknet.upgradeCache(best, 1)) {
            announce(ns, "HACKNET", `Bought node ${best} cache (${ns.format.number(bestCost)}) — pool cannot hold any upgrade`, "tx");
            return;
        }
        // Cannot afford cache either. Spending hashes now would not help, so stop here rather
        // than falling through to a spend the pool will never be able to repeat.
        return;
    }

    // `wealth` is no longer a parameter of the decision: the rule is a cash FLOOR, not a
    // wealth target, so the only figure it reads is home cash.
    const chosen = chooseHashUpgrade(ns, context, hashes);
    if (chosen === null) return;

    // ── 1. PRECISE CASH INJECTION ──
    // Only buy exactly enough to reach the target so we don't waste hashes.
    //
    // WHICH TARGET DEPENDS ON THE 4S API, and this is the half of the priority rule that
    // does the selling. `chooseHashUpgrade` decided that hashes become cash; this decides
    // how much cash. While the 4S API is unowned the figure is its price (see
    // `fourSFundTarget`); once owned it is the run's wealth target as before.
    //
    // The sales themselves are against `homeCash`, deliberately: "Sell for Money" credits
    // home cash, so the gap closed per sale is a cash gap. That is true for BOTH targets —
    // the 4S price is a cash price, and the wealth target is reached by holding cash.
    const money = context.snapshot.homeCash;
    const fourS = fourSFundTarget(context);

    // HOW MUCH CASH TO CHASE, and it is now bounded by the floor rather than by a wealth goal.
    //
    // The target used to be `wealthTarget`, which defaults to 100 BILLION. That is not a
    // stopping point a run ever reaches, so `needUpgrades` was enormous and the loop below sold
    // until the pool was empty — on every tick, forever. That is the whole of "we have +600M
    // cash and plenty of space for more hashes, why would it sell?".
    //
    // A sale is now sized to close the gap to whichever applies:
    //   4S unowned and reachable -> its price, as before
    //   below the cash floor     -> the floor, and no further
    //   above it                 -> nothing to chase; any sale here is the overflow dump, and
    //                               one sale is enough to make room
    const belowFloor = money < HASH_CASH_FLOOR;
    const saleTarget = fourS > 0 ? fourS : belowFloor ? HASH_CASH_FLOOR : money + 1_000_000;

    if (chosen.upgrade === "Sell for Money" && money < saleTarget) {
        const needCash = saleTarget - money;
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
    const isDumpUpgrade =
        chosen.upgrade === "Sell for Money" ||
        chosen.upgrade === "Sell for Corporation Funds";

    // HOW MANY TIMES TO DUMP, when this upgrade is a dump.
    //
    // THIS USED TO BE "SELL UNTIL THE POOL IS DOWN TO 70%", which on a large fleet converts an
    // enormous quantity of hashes to cash to solve a problem whose size was the overflow. The
    // pool only has to come back under the ceiling far enough to keep producing; anything
    // beyond that is hashes spent on money nobody asked for, at the opportunity cost of
    // whatever the run was otherwise saving them for.
    //
    // Sized as ten seconds of production — see `overflowSaleHashes` — so the hole scales with
    // the fleet. Non-dump upgrades (Bladeburner rank, gym training, a course) are unaffected
    // and still buy as many as the pool affords, because those are the hashes' actual purpose.
    let dumpRemaining = 0;
    if (isDumpUpgrade) {
        const cost = ns.hacknet.hashCost(chosen.upgrade);
        if (isFinite(cost) && cost > 0) {
            const rate = hashRateOf(ns, true, ns.hacknet.numNodes());
            dumpRemaining = overflowSaleCount(hashes, capacity, rate, cost);
        }
    }

    let totalBought = 0;
    let loopSafeguard = 1000;

    while (loopSafeguard-- > 0) {
        const currentCost = ns.hacknet.hashCost(chosen.upgrade);
        if (!isFinite(currentCost) || currentCost <= 0) break;
        if (ns.hacknet.numHashes() < currentCost) break;

        if (!ns.hacknet.spendHashes(chosen.upgrade, chosen.target)) break;
        totalBought += 1;

        // For dump upgrades, stop once the overflow is paid for rather than once the pool is
        // empty of overage. `dumpRemaining` is 0 both when nothing needs dumping and when
        // there is no overflow, and in either case a dump must not run at all.
        if (isDumpUpgrade && --dumpRemaining <= 0) break;
    }

    if (totalBought > 0) {
        const targetStr = chosen.target ? ` (${chosen.target})` : "";
        ns.toast(`HACKNET: Bought ${totalBought}x "${chosen.upgrade}"${targetStr}`, "success");
    }
}

/**
 * Which hash upgrade to spend on, or null.
 *
 * THE ORDER IS THE WHOLE DECISION and it is not readable from the call sites, so this is
 * exported for `hacknet.test.ts`. Twice already a branch that should have led was placed
 * behind one that returns, and the symptom both times was a rule that never fired — a run
 * that trained with hashes and never bought the upgrade for it, and the earlier version of
 * that same mistake with the cash rule leading. Ordering bugs here are silent: every
 * branch looks present and correct in isolation.
 */
export function chooseHashUpgrade(ns: NS, context: Context, hashes: number): HashChoice | null {
    const candidates: HashChoice[] = [];

    /*
     * ── THE CASH FLOOR, ahead of every other use ──
     *
     * THE OPERATOR'S RULE: until cash reaches `HASH_CASH_FLOOR`, hashes become money and
     * nothing else — no 4S funding, no Bladeburner rank, no gym boost, no studying. Those are
     * all worth having, but they are bought with cash the run does not have yet, and selling
     * hashes is the only spend that ever PRODUCES cash. A run that spends them elsewhere while
     * poor therefore has no path back to the floor.
     *
     * THE ONE EXCEPTION IS LOSING THEM. The game caps the hash pool, so past
     * `HASH_CAPACITY_RELEASE` full, every further hash is income that never arrives. Waiting
     * for the floor then destroys the thing the floor was protecting, so the restriction lifts
     * and any productive spend beats holding. Both halves live in `hashSpendIsCashOnly`, so
     * neither can be half-remembered here.
     *
     * FIRST, and that placement is the point. A rule behind a branch that returns never fires,
     * which is the mistake recorded three times below. This one is where it matters most,
     * because the floor is meant to outrank every branch under it while it is in force.
     */
    if (hashSpendIsCashOnly(context.snapshot.homeCash, hashes, ns.hacknet.hashCapacity())) {
        const cost = ns.hacknet.hashCost("Sell for Money");
        if (isFinite(cost) && cost > 0 && hashes >= cost) return { upgrade: "Sell for Money" };
        return null;
    }

    /*
     * ── A COMPLETELY FULL POOL ALSO SELLS, above the floor or not ──
     *
     * The operator's exception: everything else is governed by the cash floor, except the case
     * where the pool would otherwise be completely full. Then selling for money wins outright.
     *
     * OUTRIGHT, not merely "is allowed" — and that is why this is a second rule rather than a
     * condition inside the one above. Lifting the restriction only returns control to the chain
     * below, which could pick Bladeburner rank and let the pool overflow regardless. When the
     * alternative is losing hashes to a cap, cash is the answer and nothing else competes.
     *
     * Completely full, not `HASH_CAPACITY_RELEASE`. That softer threshold exists so a run past
     * 90% may spend on something productive instead of waiting; reusing it here would turn the
     * overflow guard into a licence to sell at 90% on every tick, which is the behaviour this
     * whole rule was written to stop.
     */
    const capacity = ns.hacknet.hashCapacity();
    if (mustSellForCapacity(hashes, capacity)) {
        const cost = ns.hacknet.hashCost("Sell for Money");
        if (isFinite(cost) && cost > 0 && hashes >= cost) return { upgrade: "Sell for Money" };
    }

    /*
     * ── 0. FUND THE 4S MARKET DATA API, before anything else ──
     *
     * While the API is unowned and home cash has not reached its price, hashes become
     * cash and nothing else. This LEADS, for the reason the Bladeburner and work branches
     * below record about each other: a rule that sits behind another that returns never
     * fires, and the whole point of this one is that it wins.
     *
     * The comparison is against `context.snapshot.homeCash`, not the `wealth` argument.
     * Home cash is what `home.ts` spends and what "Sell for Money" credits, whereas
     * `wealth` counts positions the run cannot spend from. Using `wealth` here would
     * declare the API funded while the wallet that pays for it was still empty — the
     * exact confusion `fourSFundTarget` exists to avoid.
     *
     * BOUNDED BY REACHABILITY, which is not a nicety. The price is a BitNode multiplier
     * (`FourSigmaMarketDataApiCost`) applied to a ~$25b base, so on a node that inflates it
     * the API can cost more than the run will ever earn. An unbounded rule then converts
     * every hash into cash for a purchase that never happens — the run stops training,
     * stops buying Bladeburner rank, and stops dumping, permanently, because a branch that
     * always returns keeps every other branch unreachable. That is strictly worse than the
     * problem the rule solves: it trades a degraded stock market for a run with no hash
     * income at all.
     *
     * So the rule only wins while the target is within `FOUR_S_REACHABLE_BUDGET` of what
     * the run has. Past that it stands down and ordinary hash spending resumes, and it
     * re-engages on its own if cash later reaches the band — the check is against current
     * cash rather than a latched decision, so nothing has to be reset.
     *
     * Returns `null` rather than falling through when hashes are short: with the API
     * unowned AND reachable, spending them on anything else would contradict the priority.
     */
    const fourS = fourSFundTarget(context);
    if (fourS > 0 && context.snapshot.homeCash < fourS && reachable(fourS, context.snapshot.homeCash)) {
        const cost = ns.hacknet.hashCost("Sell for Money");
        if (isFinite(cost) && cost > 0 && hashes >= cost) {
            return { upgrade: "Sell for Money" };
        }
        return null;
    }

    /*
     * ── 0a. Bladeburner rank and SP, while the division is working ──
     *
     * The two upgrades that speed up Bladeburner are "Exchange for Bladeburner Rank" and
     * "Exchange for Bladeburner SP", and they are worth buying ONLY while an action is
     * running — that is when rank accrues and when skills compound. Buying them while the
     * division sits idle spends hashes on a number nothing is using.
     *
     * THIS MUST LEAD, for the reason the training branch below records: a rule that sits
     * behind the cash-target rule never fires, because that rule returns first.
     *
     * IT CANNOT USE `getCurrentWork()`. Bladeburner actions are invisible to the
     * Singularity API — it reports null while one runs — so the answer arrives from the
     * bladeburner feature, which already pays for `getCurrentAction()` and publishes the
     * result (see lib/bladeburner-activity.ts).
     *
     * RANK BEFORE SP, but only up to the faction gate. Rank is spent on nothing; it
     * unlocks (the faction at 25, and the higher-tier actions) and otherwise accrues from
     * the actions themselves. Skill points are the scarce, compounding resource, so once
     * the gate is cleared SP is the better buy. At 250 hashes for 100 rank versus 250 for
     * 10 SP, that is a real choice rather than a rounding difference.
     */
    const bb = bladeburnerActivity();
    if (bb.running) {
        const upgrade: HacknetServerHashUpgrade =
            bb.rank < 25 ? "Exchange for Bladeburner Rank" : "Exchange for Bladeburner SP";
        const cost = ns.hacknet.hashCost(upgrade);
        if (isFinite(cost) && cost > 0 && hashes >= cost) return { upgrade };
    }

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

    // ── 1. CASH, but only below the floor ──
    //
    // THIS USED TO SELL TOWARD `wealthTarget`, which defaults to 100 BILLION. At 600M cash a
    // run is 0.6% of the way there, so the branch fired on every tick and converted every hash
    // to money permanently — reported as "we have +600M cash and plenty of space for more
    // hashes, why would it sell?".
    //
    // The operator's rule is a CEILING, not a target: money is worth selling for while the run
    // is short of it, and above `HASH_CASH_FLOOR` more cash is worth less than the upgrade the
    // hashes could buy instead. So this branch no longer names a wealth figure at all. Below
    // the floor, the gate at the top of this function has already returned; reaching here means
    // the pool is nearly full and selling is the way to stop losing hashes. Nothing else sells.
    //
    // The `wealthTarget` function is kept for the sale-SIZING path in `spendHashes`, which is
    // reached only when something has already decided to sell.

    // ── 2. Bladeburner ──
    if (context.capabilities.has("bladeburner")) {
        candidates.push({ upgrade: "Exchange for Bladeburner Rank" });
        candidates.push({ upgrade: "Exchange for Bladeburner SP" });
    }

    // ── 4. Dump hashes if the pool is about to overflow ──
    //
    // Same threshold as the cash-floor gate's escape, and deliberately not a second number:
    // this branch and `HASH_CAPACITY_RELEASE` answer the same question — "are we about to lose
    // hashes?" — so two figures would mean the run could reach one and not the other. It used
    // to dump at 75%, which sold well before the escape and quietly defeated the operator's
    // rule: above the cash floor the run is meant to HOLD hashes for other upgrades.
    if (hashes >= ns.hacknet.hashCapacity() * HASH_CAPACITY_RELEASE) {
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