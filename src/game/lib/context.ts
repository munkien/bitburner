import type { BitNodeMultipliers, CompanyName, FactionName, NS, Player } from "@ns";

import type { Capabilities } from "./caps.ts";
import { currentGoal, deriveGoals, rankByTime, standingOf, withEstimate, withParticipation, type FactionRep, type GangStanding, type Goal, type Participation, type RateLookup, type WorkingGoal } from "./objective.ts";
import { createRecentLines, type RecentLines } from "./log.ts";
import { respectPhaseEnd, territoryEnableBelow } from "./gang-measures.ts";
import { readNetWorth } from "./net-worth.ts";

/*
 * ============================================================================
 * CONTEXT
 * ============================================================================
 * What every feature is handed on each tick. It carries the three things a
 * feature must not work out for itself:
 *
 *   capabilities  what this BitNode and these Source Files permit
 *   snapshot      this tick's read of game state
 *   reserves      what the framework has decided not to spend
 *
 * Splitting read from plan from execution is the point of this file:
 *
 *   Snapshot   game state. The framework only ever reads it, and reads it once
 *              per tick instead of once per feature.
 *   Reserves   a plan. Whoever knows about a planned purchase writes it down;
 *              every feature that spends money or home RAM reads it.
 *   Execution  features acting on game state. Nothing here.
 * ============================================================================
 */

/**
 * This tick's observations of game state.
 *
 * Two rules keep this honest:
 *   - A snapshot is read, never invented. Anything the framework decides lives
 *     in `Reserves`, not here.
 *   - A snapshot is not a cache. It is replaced every tick, and features must
 *     not hold on to it across ticks.
 */
export interface Snapshot {
    /** `ns.getPlayer()`. Also the source of skills, money and factions. */
    readonly player: Player;
    /** Money on home, the only server the framework spends from. */
    readonly homeCash: number;
    /** Home's total RAM, in GB. */
    readonly homeMaxRam: number;
    /**
     * RAM in use on home, in GB. Includes the orchestrator at its overridden
     * RAM cost, so features do not need to know how the orchestrator accounts
     * for itself.
     */
    readonly homeUsedRam: number;
    /**
     * What the next unowned link in the stock access chain costs, or 0 when the
     * chain is complete.
     *
     * In the snapshot rather than computed where it is used, because it is read from
     * the game (`ns.stock.getConstants`) and `lib/objective.ts` — which consumes it to
     * build the goal — must stay free of game calls (ADR 0002). Reading it here costs
     * one 0 GB call per pass and cannot disagree with what the features see.
     *
     * `deriveGoalFor` is given the snapshot rather than `ns` precisely so a goal
     * cannot be derived from different numbers than the rest of the tick.
     */
    readonly stockAccessCost: number;
    /**
     * What the 4S Market Data TIX API costs, or 0 when buying it is not the next purchase.
     *
     * Separate from `stockAccessCost` above, which reports the NEXT unowned link in the
     * chain. That is the right figure for the "what do I buy next" goal and the wrong one
     * for `hacknet.ts`, which raises cash for this specific purchase and has to know its
     * price before the rest of the chain is paid off. The two agree only once the WSE
     * account and TIX API are owned — see `fourSCost`.
     *
     * 0 ALSO MEANS "NOT YET THE NEXT PURCHASE", which is the common case early in a run:
     * a player who has not bought the TIX API yet is two links away from 4S, and hashes
     * must not be diverted toward it. `fourSCost` owns that rule so no reader has to
     * remember it.
     */
    readonly fourSCost: number;
    /**
     * Cash another feature has reserved and that the goal must not count as
     * spendable.
     *
     * Carried in the snapshot so the goal can be measured against the SAME figure the
     * spending features use: `home.ts` compares `homeCash - reserves.cash` against the
     * chain cost, so a goal measured against raw home cash would report "affordable"
     * while the purchase was still blocked — the reported
     * `buy stock market access (138%)` on a run where nothing was being bought.
     *
     * Read from the previous pass's reserves rather than this one's, because the snapshot
     * is built before the features run. That lag is one pass and is inherent: a reserve
     * written this pass cannot be known to a value read before it.
     */
    readonly reservedCash: number;
    /**
     * Cash plus market holdings, the figure the wealth-gated features read.
     *
     * Read once per pass here, where the stock calls belong (see lib/net-worth.ts), so
     * the goal built from it and the features acting on it cannot disagree. It was
     * previously read independently by hacknet and the gang, each calling `readNetWorth`
     * for itself; that was not wrong, but it meant two readings of the same figure in one
     * pass, and no way for a goal to see it at all.
     */
    readonly netWorth: number;
    /**
     * The player's gang, or null when there is none.
     *
     * Null rather than zeroed figures, because "no gang" and "a gang with no respect"
     * are different: the first must produce no gang goal at all, and a measurement of 0
     * would invent one to raise a number the player cannot move.
     */
    readonly gang: GangStanding | null;
    /**
     * Each faction whose reputation still buys an augmentation, and what it needs.
     *
     * Read once per pass here, because it needs the Singularity API — `getFactionRep` and
     * `getAugmentationRepReq` — and `lib/objective.ts` makes no game calls. This is the
     * central reading that `share`, `sleeves` and `player` used to each take for
     * themselves; publishing it in the snapshot is what lets them agree about which
     * factions want reputation and by how much.
     *
     * Empty when there is nothing to earn AND when the API cannot be read: both mean no rep
     * goal, which is the safe direction. An invented goal would send features to work for
     * reputation nobody wants.
     */
    readonly reputation: readonly FactionRep[];
}

/**
 * Planning output shared between features: what the framework has decided to
 * keep in hand.
 *
 * Each field has exactly one writer, because two features writing the same
 * reserve means neither is in control of it:
 *   - `cash` is written by the feature that knows about a planned purchase:
 *     progression when the Singularity API is available, early game when it is
 *     not. Every feature that spends money reads it.
 *   - `stockAccessCash` is written by `home.ts`, which is the feature that buys the
 *     stock access chain. Kept separate from `cash` rather than merged into it
 *     precisely to preserve the one-writer rule: `cash` belongs to progression's
 *     augmentation planning, and letting a second feature add to it would mean
 *     neither is in control of the figure.
 *   - `homeRamGb` is written by the orchestrator, which is the only place that
 *     knows what unloaded features are still waiting for RAM.
 */
export interface Reserves {
    /** Money the framework will not spend, so a planned purchase stays affordable. */
    cash: number;
    /**
     * Money withheld for the next unowned link in the stock access chain.
     *
     * WHY THIS IS A SEPARATE RESERVE. Before it existed, the cash the chain needs
     * competed with hacknet nodes, cloud servers, home RAM and darkweb programs on
     * equal terms — every one of them spends from `surplus`, and none of them knew the
     * chain was a goal. Reaching the TIX API was therefore a matter of which feature
     * happened to spend first, and in practice the others usually did.
     *
     * Read through `surplus`, which subtracts it, rather than by each spender. Every
     * money-spending feature already routes through that function, so publishing the
     * figure here is enough to make them all respect it — and a feature added later
     * cannot forget to.
     */
    stockAccessCash: number;
    /** RAM withheld on home for the orchestrator and for standalone scripts. */
    homeRamGb: number;
    /**
     * How fast cash is arriving, in dollars per second, or null when nothing is measured.
     *
     * NOT MONEY WITHHELD, unlike the two fields above — it lives here because this is the
     * one structure every money-spending feature already reads, and because the two reserves
     * that need it are written by DIFFERENT features at DIFFERENT priorities: progression
     * (40) decides the augmentation reserve and `home.ts` (20) decides the stock-chain one,
     * so `home.ts` runs before progression and cannot read a figure progression measured.
     * Publishing it here means the first writer of the pass makes it available to the rest,
     * and a second writer cannot disagree about it.
     *
     * The figure itself is measured from home cash over `RATE_WINDOW_MS` by
     * `observeIncome` — see `rate-tracker.ts` for why it is measured rather than assumed.
     * Null means no evidence, and both reserve rules read that as "protect nothing", which
     * is the direction that keeps an early run spending rather than freezing it.
     */
    incomePerSecond: number | null;
}

export interface Context {
    readonly capabilities: Capabilities;
    readonly snapshot: Snapshot;
    readonly reserves: Reserves;
    /**
     * Feature ids the OPERATOR has switched off, from the console.
     *
     * NOT a reserve, despite having lived in `Reserves`. A reserve is a figure
     * the framework withholds from spending; this is an instruction about which
     * features may run at all, it shares no type with them, and it is written by
     * the operator rather than by a feature. It sits here because it is an input
     * to a tick, alongside `capabilities` and `snapshot`.
     *
     * The runtime reads it to refuse to load, and to unload, a disabled feature;
     * a feature itself never sees it, because a disabled feature is not running
     * to read anything.
     */
    readonly disabled: ReadonlySet<string>;
    /**
     * What the run is working toward, and the sub-goals that close it.
     *
     * Derived once per tick from the snapshot's player, so every feature sees the
     * same goal rather than each deriving its own. That was the bug: progression
     * trained combat to 100 while sleeves stopped at 75, because each declared the
     * threshold separately. See lib/objective.ts.
     */
    readonly goal: Goal | null;
    /**
     * Every ranked goal, nearest first, each annotated with who can advance it.
     *
     * `goal` is the first of these, and the two are derived together so they cannot
     * disagree. The full list exists so a feature can ask whether a goal it can advance is
     * outstanding ANYWHERE, not only whether it is the one currently in front — which was
     * impossible while only the nearest goal was published, and is the reason a feature
     * could not take part in a goal that was not its own.
     *
     * Each goal carries `contributors` (the features that can move it) and `blockedBy`
     * (the sub-goals no feature in the framework can move), so the dashboard can say who
     * is working on the goal and when nothing can close it.
     */
    readonly goals: readonly Goal[];
    /**
     * The last few lines features have produced, shown under the orchestrator's
     * dashboard.
     *
     * Features are dynamically imported into the orchestrator's own script, so
     * their `ns.print` lands in the panel that `clearLog` wipes each pass. This is
     * the channel for state worth seeing but not worth keeping; anything worth
     * reading later goes to `ns.tprint` instead. See lib/log.ts.
     */
    readonly recent: RecentLines;
    /**
     * When the retirement stall clock comes due, and how much is queued, or null when it
     * is not counting.
     *
     * A COUNTDOWN, which is why it has to be published rather than left inside the
     * feature. Every other threshold in the framework can be checked against a figure
     * already on screen — five queued augmentations are visible as a queue — but a timer
     * nobody can see is indistinguishable from a timer that never armed, and "it is
     * still waiting" then reads as patience however wrong it is.
     *
     * `dueAt` is an absolute timestamp for the same reason `LogMessage.at` is: the
     * countdown keeps running between orchestrator passes, so a duration would be stale
     * the moment after it was computed.
     */
    readonly stall: { readonly dueAt: number; readonly queued: number } | null;
    /**
     * The current node's multipliers, read on first use.
     *
     * A function rather than a field because reading it costs 4 GB and most
     * features never ask. Handed to features rather than read by each of them so
     * the `multipliers` capability check lives in one place: the call throws
     * without SF5 or BitNode 5 (see docs/adr/0002).
     */
    multipliers(): BitNodeMultipliers | null;
}

/**
 * Read the tick's game state. This is the only place that reads it, so a
 * feature that needs money or the player reads the snapshot instead of calling
 * `ns` again.
 */
export function createSnapshot(ns: NS, reservedCash = 0): Snapshot {
    return {
        player: ns.getPlayer(),
        homeCash: ns.getServerMoneyAvailable("home"),
        homeMaxRam: ns.getServerMaxRam("home"),
        homeUsedRam: ns.getServerUsedRam("home"),
        stockAccessCost: stockAccessCost(ns),
        fourSCost: fourSCost(ns),
        reservedCash,
        // Cash plus holdings, the figure the wealth-gated features read. Read here, where
        // the stock calls belong, so the goal and the features cannot disagree.
        netWorth: readNetWorthSafely(ns),
        gang: readGangStanding(ns),
        reputation: readReputation(ns),
    };
}

/**
 * Net worth, never throwing.
 *
 * `readNetWorth` asks the stock API whether there is access, and on a node without the
 * WSE account those calls are not there to answer. The snapshot is built on every pass
 * for every player, and a snapshot that faulted would take the whole tick down over a
 * figure that degrades honestly to cash — which is exactly what `readNetWorth` returns
 * without access. Guarded here rather than inside `readNetWorth`, whose other callers
 * ask the question where a throw is a bug worth seeing.
 */
function readNetWorthSafely(ns: NS): number {
    try {
        return readNetWorth(ns).netWorth;
    } catch {
        return ns.getPlayer().money;
    }
}

/**
 * The player's gang, or null when there is none.
 *
 * Guarded rather than excepted, because `ns.gang` does not exist at all without SF2 and
 * the snapshot is built on every pass for every player. `inGang` is a 0 GB call and the
 * cheapest way to ask.
 *
 * The two thresholds are the shared ones from `lib/gang-measures.ts`, derived from the
 * gang's own numbers — the same functions the gang feature uses, so "the gang has grown
 * enough" means one thing in the goal and in the feature.
 */
function readGangStanding(ns: NS): GangStanding | null {
    try {
        if (!ns.gang.inGang()) return null;
        const info = ns.gang.getGangInformation();
        const rivals = Object.entries(ns.gang.getAllGangInformation())
            .filter(([name, other]) => name !== info.faction && other.territory > 0)
            .length;

        return {
            respect: info.respect,
            territory: info.territory,
            respectTarget: respectPhaseEnd(info.respectForNextRecruit),
            territoryTarget: territoryEnableBelow(rivals),
        };
    } catch {
        // No gang API, no gang, or a game that refuses the call: all read the same to a
        // goal, which is that there is nothing here to work toward.
        return null;
    }
}

/**
 * Every faction whose reputation still buys an augmentation the player does not have.
 *
 * The central reading of "does reputation still matter", which `share`, `sleeves` and
 * `player` each used to take for themselves through the Singularity API. Doing it once per
 * pass is both cheaper — `getOwnedAugmentations` is the expensive call and is read once
 * here — and, more importantly, means the three cannot disagree about which factions want
 * reputation or by how much.
 *
 * The target per faction is the HIGHEST requirement among its unowned augmentations, not
 * the next one. Reputation is earned for the faction, so meeting the top requirement meets
 * every lower one at the same time; chasing them one at a time earns the same reputation in
 * the same order and merely reports it differently. `NeuroFlux Governor` is skipped because
 * its requirement rises without bound — including it would make every faction permanently
 * short.
 *
 * Returns only factions with something OUTSTANDING: one already at its target is absent,
 * so the goal it would otherwise produce does not exist. Never throws: the Singularity API
 * needs SF4, and an unreadable figure must read as "no reputation wanted" rather than fault
 * the pass.
 *
 * Exported so the decision can be tested directly rather than only through a full tick,
 * which needs the whole network fixture to say anything. `share.ts` reads its RESULT from
 * the snapshot rather than calling it, so this stays the single definition of "is there
 * reputation still to earn".
 */
export function readReputation(ns: NS): FactionRep[] {
    // Faction membership from the player, so this considers exactly the factions the player
    // can work for. A faction not yet joined cannot have reputation earned, so it is not a
    // reputation goal here — joining it is the faction goal's business.
    let factions: readonly FactionName[];
    let owned: readonly string[];
    try {
        factions = ns.getPlayer().factions;
        owned = ns.singularity.getOwnedAugmentations(true);
    } catch {
        return [];
    }

    const out: FactionRep[] = [];
    for (const faction of factions) {
        let current: number;
        let augs: readonly string[];
        try {
            current = ns.singularity.getFactionRep(faction);
            augs = ns.singularity.getAugmentationsFromFaction(faction);
        } catch {
            // A faction the API will not answer about is one this cannot reason about.
            continue;
        }

        let target = 0;
        for (const aug of augs) {
            if (aug === "NeuroFlux Governor" || owned.includes(aug)) continue;
            try {
                target = Math.max(target, ns.singularity.getAugmentationRepReq(aug));
            } catch {
                continue;
            }
        }

        // Nothing to earn, or already earned: not a reputation goal either way.
        if (target <= 0 || current >= target) continue;

        // Effective favour: stored, or what installing the owned augmentations would
        // grant. The game raises favour on install, so a faction the player is about to
        // reset into already counts as favoured for the purpose of "can I donate".
        let favor = 0;
        try {
            favor = Math.max(
                ns.singularity.getFactionFavor(faction),
                projectedFavor(current),
            );
        } catch {
            // Unreadable favour reads as 0, i.e. "cannot donate" — the safe direction for
            // `canBuyReputation`, which would otherwise switch sharing off on a figure it
            // could not read.
            favor = 0;
        }

        out.push({ faction, current, target, favor });
    }
    return out;
}

/**
 * Favour granted by installing, as a function of the reputation held at the time.
 *
 * The game's own formula. Kept here rather than in the feature that spends favour so the
 * projection and the decision cannot drift apart — the class of bug ADR 0003 records.
 */
function projectedFavor(rep: number): number {
    if (rep <= 0) return 0;
    return Math.log(1 + rep / 25000) / Math.log(1.02);
}

/**
 * The favour at which a faction will accept donations at all.
 *
 * Below this the game refuses a donation outright, at any balance — so reputation with
 * such a faction has to be WORKED for, and CPU spent on it is the only route to it.
 * Above it, money buys reputation directly and spending the network on `ns.share` earns
 * a resource the run could simply have bought.
 *
 * The same 150 as `player.ts`'s `DONATION_MIN_FAVOR`. Two copies is one too many, but
 * importing the feature would charge its RAM here (ADR 0001) and this module makes no
 * game calls — so it is a shared constant in spirit only, and `share.ts` is where the
 * decision that reads it lives.
 */
export const DONATION_MIN_FAVOR = 150;

/**
 * Whether reputation with this faction is reachable by MONEY rather than by working.
 *
 * The question `share.ts` has to ask before it deploys a single thread. `ns.share` buys
 * faction reputation with the network's CPU; a donation buys the same reputation with
 * cash. When the faction will take a donation, the two are substitutes and the CPU is
 * the worse one — it could have been earning the money instead.
 *
 * Gated on FAVOUR and not on the current balance, deliberately. Affordability would put
 * a hard edge at the donation price and make sharing switch on and off as cash crossed
 * it, which is the threshold-oscillation that cost `MEASURE_SLACK` a revert. Favour is
 * permanent: once it is there, the donation route exists for good.
 */
export function canBuyReputation(rep: FactionRep): boolean {
    return rep.favor >= DONATION_MIN_FAVOR;
}

/**
 * The cost of the next unowned link in the stock access chain, or 0 when complete.
 *
 * Lives here rather than in `home.ts`, which buys the chain, so the figure the goal is
 * built from and the figure the purchase is gated on are the same arithmetic. Two
 * copies would eventually disagree about which link is next, and the symptom would be a
 * goal that never becomes affordable or a purchase that never happens.
 *
 * Never throws. `ns.stock.getConstants` is available without any account, but this is
 * called on the orchestrator's every pass and a goal is not worth a faulted tick — so a
 * failure reads as "no chain goal", which is the safe direction: nothing reserves cash
 * for a purchase the framework cannot price.
 */
export function stockAccessCost(ns: NS): number {
    try {
        if (!ns.stock.hasWseAccount()) return ns.stock.getConstants().WseAccountCost;
        if (!ns.stock.hasTixApiAccess()) return ns.stock.getConstants().TixApiCost;
        if (!ns.stock.has4SDataTixApi()) return ns.stock.getConstants().MarketDataTixApi4SCost;
        return 0;
    } catch {
        return 0;
    }
}

/**
 * What the 4S Market Data TIX API costs, or 0 when it is already owned OR not yet the
 * next purchase — i.e. 0 unless buying 4S is the very next thing the run would do.
 *
 * NOT `stockAccessCost` WITH A DIFFERENT NAME, which is why it exists separately. That
 * function reports the NEXT unowned link, so on a player who has not yet bought the WSE
 * account it returns the WSE cost — correct for a goal that asks "what do I buy next", and
 * wrong for everything that asks "what would the 4S integration cost". The two questions
 * coincide only once the rest of the chain is complete.
 *
 * `hacknet.ts` needs the second question answered: it converts hashes to cash to fund this
 * one purchase, and the sum to aim at has to be this figure rather than whatever link
 * happens to be next. Reading `stockAccessCost` there would make hacknet stop selling at
 * the wrong number for the whole early game, and the symptom — a run that stops producing
 * the cash it was producing cash for — would look like a decision rather than a bug.
 *
 * THE TIX GATE IS DELIBERATE, and it is inside this function rather than at the call site
 * so that every consumer inherits it. Without it the figure is non-zero on a brand-new run
 * that owns neither the WSE account nor the TIX API, and a feature that funds "the 4S
 * price" then diverts hashes toward ~$25b before the run has any stock access at all —
 * jumping the queue ahead of the two cheaper links `home.ts` actually buys first. The cash
 * is not wasted (it pays for WSE and TIX on the way), but the intent is wrong: the run
 * stops spending hashes on training and Bladeburner to fund a purchase that is two steps
 * away, and does so for most of the early game.
 *
 * `hasTixApiAccess()` rather than `hasWseAccount()` because the WSE account is the first
 * link: a player with the account and no TIX API still has a cheaper purchase queued ahead
 * of 4S. Once both are owned, 4S IS the next link — exactly the condition the caller cares
 * about — so the two questions become the same one and this returns the real price.
 *
 * Never throws, for the reason `stockAccessCost` gives: a figure the framework cannot read
 * must not fault an orchestrator pass. Reading 0 from a throw is the safe direction for the
 * same reason it is safe everywhere else here — nothing diverts hashes toward a purchase
 * the framework cannot price.
 */
export function fourSCost(ns: NS): number {
    try {
        if (!ns.stock.hasTixApiAccess()) return 0;
        return ns.stock.has4SDataTixApi() ? 0 : ns.stock.getConstants().MarketDataTixApi4SCost;
    } catch {
        return 0;
    }
}

/** A fresh ring, owned by whoever builds the Context. */
export function createRecent(ns: NS): RecentLines {
    return createRecentLines(ns);
}

export function createReserves(): Reserves {
    return { cash: 0, stockAccessCash: 0, homeRamGb: 0, incomePerSecond: null };
}

/**
 * Money above the reserves. This is the pool features compete for, and the only
 * thing a money-spending feature should measure itself against.
 *
 * Both cash reserves are subtracted. They are separate fields because they have
 * separate writers (see `Reserves`), but they mean the same thing to a spender — money
 * already spoken for — so this is the one place that has to know there are two. Doing
 * it here rather than at each call site is what makes the reserve hold: every
 * money-spending feature already asks this function, so none of them can be unaware of
 * it, and a feature added later inherits the behaviour.
 */
export function surplus(snapshot: Snapshot, reserves: Reserves): number {
    return Math.max(0, snapshot.homeCash - reserves.cash - reserves.stockAccessCash);
}

/**
 * Build the per-tick context, with the multiplier read memoised.
 *
 * `ns.getBitNodeMultipliers` costs 4 GB and throws without SF5 or BitNode 5, so
 * the capability decides whether it is ever called. Caching the result is safe
 * for the process lifetime: it is a property of the BitNode, and a BitNode
 * change ends the script.
 */
export function createContextReader(ns: NS, capabilities: Capabilities): () => BitNodeMultipliers | null {
    let cached: BitNodeMultipliers | null | undefined;

    return (): BitNodeMultipliers | null => {
        if (cached !== undefined) return cached;
        cached = capabilities.has("multipliers") ? ns.getBitNodeMultipliers() : null;
        return cached;
    };
}

/**
 * Every ranked goal the run is working toward, nearest first.
 *
 * The full list, not just the nearest, because a feature may need to know whether a goal
 * it can advance is outstanding ANYWHERE — not only whether it happens to be the current
 * one. A feature can still read just the nearest via `currentGoal` or
 * `Context.goal`.
 *
 * Reads the snapshot rather than `ns`, so it costs nothing extra and cannot disagree with
 * what the features see. Faction membership comes from the player, so a faction the player
 * joins stops being a goal on the next tick without anything having to notice.
 */
export function deriveGoalsFor(
    snapshot: Snapshot,
    /**
     * What each feature can advance, from the registry.
     *
     * Passed in rather than imported, because the registry is the orchestrator's and this
     * module has no business reaching into it — and because a test can then supply a
     * fixed set. Every feature in the FRAMEWORK is declared here, loaded or not, so a
     * `blockedBy` key means "nothing in the framework moves this" rather than "nothing
     * happened to be loaded this pass".
     */
    features: readonly Participation[] = [],
    /**
     * Seconds per unit for a measurement, or null when none has been measured.
     *
     * Optional, and defaulting to "nothing measurable" so every existing caller
     * keeps working: the estimate is published for comparison, not acted on, and
     * a run that passes no lookup gets `null` estimates rather than wrong ones.
     */
    rate: RateLookup = () => null,
    /**
     * The goal the features are acting on this pass, so the ranking does not trade it away on
     * a spend. See `WorkingGoal` in `objective.ts` — the argument reaches `rankByTime`
     * unchanged, and it is passed in rather than held here because this module derives and
     * does not remember.
     */
    working: WorkingGoal = {},
): Goal[] {
    const player = snapshot.player;
    const estimated = withEstimate(
        withParticipation(
            deriveGoals(
                // Every figure comes from the snapshot rather than from `player`. The stock
                // access purchase is gated on home cash, priced by the stock market, and
                // reduced by whatever another feature has reserved — none of which is a
                // property of the player object, and all of which the goal has to agree with
                // or the dashboard and the purchase contradict each other. Net worth and the
                // gang figures are read from the game, so they are snapshot fields too.
                standingOf(
                    player,
                    snapshot.stockAccessCost,
                    snapshot.homeCash,
                    snapshot.reservedCash,
                    snapshot.netWorth,
                    snapshot.gang,
                    snapshot.reputation,
                    // `player.jobs` is keyed by company name and the game populates it for
                    // every current position, so this needs no extra game call and cannot
                    // disagree with what `workForCompany` acts on.
                    new Set(Object.keys(player.jobs) as CompanyName[]),
                ),
                new Set(player.factions),
            ),
            features,
        ),
        rate,
    );

    // ORDERED BY TIME, not by `progress`. Moving the ratio into second place is the
    // point: `progress` compares a goal's distance to its OWN target, so two of them are
    // incommensurable, and goals crossed and re-crossed on the RATE they happened to be
    // filling at. Measured against the recorded runs, 54 of 74 head changes were exact
    // reversals — A to B to A inside a minute. See `rankByTime`, including why the
    // ordering is only partial and what it does with the goals it cannot time.
    return rankByTime(estimated, rate, working);
}

/**
 * Work out what the run is chasing: the single nearest goal, or null when there is none.
 *
 * The narrow reading of `deriveGoalsFor`, for callers that want only the goal they are
 * working on. A feature that needs the whole list reads `Context.goals`.
 */
export function deriveGoalFor(snapshot: Snapshot): Goal | null {
    return currentGoal(deriveGoalsFor(snapshot));
}
