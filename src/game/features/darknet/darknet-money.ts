import type { CacheResult, DarknetResponseCode } from "@ns";

/*
 * ============================================================================
 * DARK NET — EARNING
 * ============================================================================
 * The decisions behind caches and phishing, as pure functions.
 *
 * Why this exists. The Dark Net has a money source the framework was ignoring: the
 * `dnet_money` BitNode multiplier covers "money gained from phishing and caches on
 * darknet servers", and a cache is a one-off find on a host that is already open. Both
 * activities require being ON the host, so they belong to the Worm Worker rather than
 * the Master — but the decisions about WHEN they are worth doing are pure, and live
 * here so they can be tested without a net.
 *
 * The complication is karma. `openCache` returns a `karmaLoss` and phishing is a
 * crime-flavoured action, so both spend a resource the run's goal tracks. Karma
 * is a CEILING rather than a floor — several factions require the player to be at or
 * below a negative value — so dropping it is progress while a target is outstanding
 * and waste once it is met, where "waste" is not neutral: ADR-0003 records a run that
 * reached -240K against a -54K target and closed off content wanting a kinder player.
 *
 * So the rule is the same one `player.ts` already applies to Homicide: spend karma
 * while something needs it, stop when nothing does. See `worthOpening` and
 * `worthPhishing`.
 * ============================================================================
 */

/** What a host offers a worker that is already standing on it. */
export interface HostOpportunity {
    /** `.cache` filenames visible via `ns.ls(host, ".cache")`. */
    readonly caches: readonly string[];
    /** Whether the host is stationary, and so worth more effort than a wanderer. */
    readonly stationary: boolean;
    /** The host's blocked RAM, which a worker competes with. */
    readonly blockedRam: number;
}

/**
 * How many caches a worker should open in one deployment.
 *
 * Each `openCache` is a separate 2 GB call and each carries its own karma loss, so a
 * host with many caches is not a reason to spend all of it at once. Bounded rather
 * than greedy because the karma cost is the part that is hard to undo.
 */
export const MAX_CACHES_PER_DEPLOY = 3;

/**
 * Whether opening a cache is worth its karma.
 *
 * `karmaMatters` is the caller's answer to "is any faction still waiting for the
 * player to be less vicious", and it is passed in rather than computed here: the
 * goal owns that question, and duplicating it is the drift ADR-0003 exists to
 * prevent.
 *
 * When karma no longer matters the cache is still opened — the money is free at that
 * point — but only if the host is stationary. A cache on a server that can move is
 * one the worker may not reach again, and spending a deployment on it when there is
 * nothing to gain but money is not worth the RAM it competes for.
 */
export function worthOpening(
    opportunity: HostOpportunity,
    karmaMatters: boolean,
): { open: true; filenames: string[] } | { open: false; reason: string } {
    if (opportunity.caches.length === 0) {
        return { open: false, reason: "no cache files on this host" };
    }

    if (!karmaMatters && !opportunity.stationary) {
        return {
            open: false,
            reason: "karma is settled and this host may move, so a cache here earns only money",
        };
    }

    // Sorted so the worker opens the same ones in the same order every deployment:
    // `ls` is alphabetical, and a test that depended on hash order would be flaky.
    const filenames = [...opportunity.caches].sort().slice(0, MAX_CACHES_PER_DEPLOY);
    return { open: true, filenames };
}

/* ─── phishing ─── */

/** Phishing builds charisma and lifts money; both scale with charisma and threads. */
export interface PhishingFacts {
    /** The host's required charisma, which gates `heartbleed` but not phishing. */
    readonly hostCharisma: number;
    /** The player's charisma, which scales what phishing is worth. */
    readonly playerCharisma: number;
    /** Threads the host can spare. */
    readonly threads: number;
    /** Whether the run's goal is waiting on charisma. */
    readonly charismaWanted: boolean;
    /** Whether any faction still needs the player to be less vicious. */
    readonly karmaMatters: boolean;
}

/** How many threads phishing needs before it is worth the call. */
export const MIN_PHISHING_THREADS = 4;

/**
 * Whether a worker should phish from its host.
 *
 * Phishing earns money AND builds charisma, which makes it valuable in two different
 * ways, so it is worth doing when EITHER is outstanding. That is why it survives the
 * karma-settled case while a non-stationary cache does not: charisma is a stat the run
 * may still need, and the money comes with it.
 *
 * The thread floor is about the call being worth making at all — `phishingAttack` is a
 * 2 GB call that "very occasionally" produces a cache, so one thread is a waste of the
 * deployment rather than a small win.
 */
export function worthPhishing(facts: PhishingFacts): { phish: true } | { phish: false; reason: string } {
    if (facts.threads < MIN_PHISHING_THREADS) {
        return { phish: false, reason: `host can spare only ${facts.threads} thread(s)` };
    }

    // Worth it while either reward is still wanted.
    if (facts.charismaWanted || facts.karmaMatters) return { phish: true };

    // Neither is outstanding: the money alone does not justify spending karma that
    // nothing needs spent.
    return { phish: false, reason: "charisma is not wanted and karma is settled" };
}

/* ─── reading a result ─── */

/** What a cache open should lead to. */
export type CacheVerdict =
    | { readonly kind: "opened"; readonly karmaLoss: number; readonly message: string }
    | { readonly kind: "gone" }
    | { readonly kind: "stop"; readonly reason: string };

/**
 * Turn an `openCache` result into a decision.
 *
 * `CacheResult` carries no response code, unlike the rest of the dark net API — only
 * `success`, `message` and `karmaLoss`. So a failure is inferred from the message, and
 * the two that matter are distinguished because they need different responses: a cache
 * that has already been taken is not a reason to stop trying others on the host, while
 * an API that refuses means the worker should give up on this host entirely.
 */
export function readCacheResult(result: CacheResult): CacheVerdict {
    if (result.success) {
        return { kind: "opened", karmaLoss: result.karmaLoss, message: result.message };
    }

    const message = result.message.toLowerCase();
    // Already opened, by a previous deployment or another script.
    if (message.includes("no longer") || message.includes("not found") || message.includes("already")) {
        return { kind: "gone" };
    }

    return { kind: "stop", reason: result.message };
}

/**
 * Whether a phishing failure should be retried.
 *
 * Reuses the same code taxonomy as authentication, because the response codes are the
 * game's and mean the same thing here: a timeout is worth another attempt, and a
 * refusal is not. Duplicating the mapping would let the two drift.
 */
export function isRetryablePhish(code: DarknetResponseCode): boolean {
    // RequestTimeOut: the request failed, and the outcome is unknown.
    if (code === 408) return true;
    return false;
}

/* ─── what the Dark Net is worth ─── */

/**
 * The `dnet_money` multiplier, applied to a base earning.
 *
 * Exposed as its own function because the multiplier is easy to forget, and a feature
 * that ignores it reports earnings that do not match what the player sees.
 *
 * It is a PLAYER multiplier (`player.mults.dnet_money`), NOT a BitNode one — the
 * `BitNodeMultipliers` table has no darknet field. That is worth stating because the
 * obvious guess is wrong, and it is also convenient: it needs no SF5, so it is
 * available on every node rather than only where `context.multipliers()` returns
 * something. The null case is kept for a player object that omits `mults`, where the
 * neutral value is 1 rather than 0.
 */
export function scaleEarnings(base: number, dnetMoneyMultiplier: number | null): number {
    if (dnetMoneyMultiplier === null || !Number.isFinite(dnetMoneyMultiplier)) return base;
    return base * dnetMoneyMultiplier;
}
