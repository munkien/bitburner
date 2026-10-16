import type { NS, Player, Server } from "@ns";

/*
 * ============================================================================
 * TARGET FACTS
 * ============================================================================
 * Everything the hacking feature needs to know about one target, read once.
 *
 * Why this exists. `makePlan` made 10 `ns` calls and `prep` 11, interleaved with
 * the arithmetic that turns those numbers into a batch shape. That made the
 * arithmetic untestable without a fake game, and it hid the one thing worth
 * testing: given these facts, what batch results.
 *
 * The split is facts versus arithmetic. This module gathers facts and does no
 * arithmetic beyond the cheapest unit conversion. `plan.ts` does the arithmetic
 * and takes these structs, with no `ns`.
 *
 * Two of these reads are load-bearing rather than incidental:
 *
 *   - `moneyMax` and `minDifficulty` are OPTIONAL in the server API. They are
 *     absent until the player can see the server's details, and building a plan
 *     from `undefined` produced NaN threads rather than an error. That is why
 *     `readTargetFacts` returns null rather than a struct full of holes.
 *   - The `Formulas.exe` question is answered by the caller's capability reading
 *     rather than by `ns.fileExists` here, so it is asked once per refresh
 *     instead of once per target.
 * ============================================================================
 */

/**
 * Timing and outcome facts for one target at a known state.
 *
 * `hackTime`, `growTime` and `weakenTime` are for one thread at the state the
 * target is currently in; the caller decides whether that state is "prepped" or
 * "as found", because both are needed.
 */
export interface TimingFacts {
    /** Seconds for one hack thread. */
    readonly hackTime: number;
    /** Seconds for one grow thread. */
    readonly growTime: number;
    /** Seconds for one weaken thread. */
    readonly weakenTime: number;
    /** Fraction of the target's money one hack thread takes. */
    readonly hackPercent: number;
}

/** Security and thread-count facts, which do not depend on target state. */
export interface CostFacts {
    /** Security added by one hack thread. */
    readonly hackSecurity: number;
    /** Security added by one grow thread. */
    readonly growSecurity: number;
    /** Security removed by one weaken thread. */
    readonly weakenPerThread: number;
}

export interface TargetFacts {
    readonly hostname: string;
    /** Maximum money. Present, because a target without it is not a target. */
    readonly moneyMax: number;
    readonly minDifficulty: number;
    /** Money and security right now, as found. */
    readonly moneyAvailable: number;
    readonly securityLevel: number;
    /** Timing at the target's CURRENT state. */
    readonly now: TimingFacts;
    readonly costs: CostFacts;
}

/**
 * Read a target's facts, or `null` when the server's details are not available.
 *
 * `null` means "cannot plan against this yet", which is different from a failure:
 * the player may simply not own the program that reveals server details, and the
 * caller retries next refresh rather than reporting an error.
 */
export function readTargetFacts(ns: NS, hostname: string, useFormulas: boolean): TargetFacts | null {
    const srv = ns.getServer(hostname);
    if (srv.moneyMax === undefined || srv.minDifficulty === undefined) return null;

    const player = ns.getPlayer();
    const moneyAvailable = srv.moneyAvailable ?? 0;
    const securityLevel = srv.hackDifficulty ?? srv.minDifficulty;

    return {
        hostname,
        moneyMax: srv.moneyMax,
        minDifficulty: srv.minDifficulty,
        moneyAvailable,
        securityLevel,
        now: readTiming(ns, srv, player, hostname, useFormulas),
        costs: readCosts(ns, hostname),
    };
}

/**
 * Timing at the target as the game currently reports it.
 *
 * The Formulas API is only preferred when the caller says it is available; it
 * costs the same and is more accurate, but reading `hackPercent` from the wrong
 * one produces a batch sized for the wrong game state.
 */
function readTiming(
    ns: NS,
    srv: Server,
    player: Player,
    hostname: string,
    useFormulas: boolean,
): TimingFacts {
    if (useFormulas) {
        return {
            hackTime: ns.formulas.hacking.hackTime(srv, player),
            growTime: ns.formulas.hacking.growTime(srv, player),
            weakenTime: ns.formulas.hacking.weakenTime(srv, player),
            hackPercent: ns.formulas.hacking.hackPercent(srv, player),
        };
    }

    return {
        hackTime: ns.getHackTime(hostname),
        growTime: ns.getGrowTime(hostname),
        weakenTime: ns.getWeakenTime(hostname),
        hackPercent: ns.hackAnalyze(hostname),
    };
}

function readCosts(ns: NS, hostname: string): CostFacts {
    return {
        hackSecurity: ns.hackAnalyzeSecurity(1, hostname),
        // One thread's worth; scaled by the caller, because the thread count is
        // what the planner is choosing.
        growSecurity: ns.growthAnalyzeSecurity(1, hostname),
        weakenPerThread: ns.weakenAnalyze(1),
    };
}

/**
 * Timing for a target assumed to be at minimum security and maximum money.
 *
 * Prep exists to reach this state, so a batch plan has to be built against it
 * rather than against whatever the target looks like right now. The Formulas path
 * needs a server whose fields reflect the assumption, which is why this takes a
 * struct rather than re-reading.
 */
export function timingAtPrep(ns: NS, facts: TargetFacts, useFormulas: boolean): TimingFacts {
    if (!useFormulas) {
        // The non-Formulas functions report the target's current state only, so
        // there is nothing to assume: they are what they are.
        return facts.now;
    }

    const srv = ns.getServer(facts.hostname);
    srv.hackDifficulty = facts.minDifficulty;
    srv.moneyAvailable = facts.moneyMax;

    const player = ns.getPlayer();
    return {
        hackTime: ns.formulas.hacking.hackTime(srv, player),
        growTime: ns.formulas.hacking.growTime(srv, player),
        weakenTime: ns.formulas.hacking.weakenTime(srv, player),
        hackPercent: ns.formulas.hacking.hackPercent(srv, player),
    };
}

/**
 * Grow threads needed to restore `moneyAvailable` to `moneyMax`.
 *
 * Two paths because the Formulas API takes a server object it can be told to
 * pretend about, while `growthAnalyze` takes a ratio. Called with the money the
 * caller expects to be there, not necessarily what is there now.
 */
export function growThreadsFor(
    ns: NS,
    facts: TargetFacts,
    moneyAvailable: number,
    useFormulas: boolean,
): number {
    if (useFormulas) {
        const srv = ns.getServer(facts.hostname);
        srv.moneyAvailable = moneyAvailable;
        return ns.formulas.hacking.growThreads(srv, ns.getPlayer(), facts.moneyMax, 1);
    }

    const ratio = facts.moneyMax / Math.max(1, moneyAvailable);
    return ns.growthAnalyze(facts.hostname, ratio, 1);
}
