/*
 * ============================================================================
 * RETIREMENT DECISIONS
 * ============================================================================
 * When a run should end, and what it is worth ending for.
 *
 * Why this exists. The decision was split across two scripts that could not see each
 * other: `player.ts` spawned the installer once five augmentations were queued, and
 * `retire.ts` then re-checked and aborted if none were. Two thresholds, two files, and
 * the second one silently overrode the first — the same shape of drift ADR-0003 exists
 * to prevent.
 *
 * Nothing here calls `ns`, so the arithmetic is testable without a game. That matters
 * more than usual for this module: retirement is the one action that ends a run, so a
 * wrong threshold costs everything the run has accumulated since the last reset.
 * ============================================================================
 */

/** How many queued augmentations make a reset worth performing. */
export const INSTALL_THRESHOLD = 5;

/** What the run has to spend, as retirement sees it. */
export interface RetirementFacts {
    /** Augmentations bought but not yet installed. */
    readonly queued: number;
    /** Augmentations already installed. */
    readonly installed: number;
    /** Factions the player has joined, which is where future augmentations come from. */
    readonly factions: number;
    /** Cash on home. */
    readonly cash: number;
    /** Whether the Singularity API is available, without which nothing can be done. */
    readonly canInstall: boolean;
    /** Whether the installer has already been asked to run, so it is not asked twice. */
    readonly alreadyStarted: boolean;
}

/** Why retirement is or is not happening. */
export type RetirementVerdict =
    | { readonly kind: "retire"; readonly reason: string }
    | { readonly kind: "wait"; readonly reason: string };

/**
 * Whether to begin retirement.
 *
 * Three ways to wait, and they are distinguished because they need different fixes:
 *
 *   no API        the Singularity API is missing, so the install is impossible. Not a
 *                 threshold problem — the run cannot retire on this node at all.
 *   nothing to install   fewer than `INSTALL_THRESHOLD` augmentations are queued. The
 *                 normal case, and the reason a run keeps going.
 *   already started      the installer is running. Asking twice would spawn a second
 *                 copy that fights the first for the same augmentations.
 *
 * `factions` is deliberately NOT part of the decision, even though the old abort
 * checked it. A player with queued augmentations and no factions can still install
 * them; the faction count only decides whether there is anything to SPEND on
 * afterwards, which is `worthLiquidating`'s business rather than a reason to refuse.
 */
export function decideRetirement(facts: RetirementFacts): RetirementVerdict {
    if (!facts.canInstall) {
        return { kind: "wait", reason: "no Singularity API, so nothing can be installed" };
    }

    if (facts.alreadyStarted) {
        return { kind: "wait", reason: "the installer is already running" };
    }

    if (facts.queued < INSTALL_THRESHOLD) {
        return {
            kind: "wait",
            reason: `${facts.queued} augmentation(s) queued, ${INSTALL_THRESHOLD} needed`,
        };
    }

    return { kind: "retire", reason: `${facts.queued} augmentations queued` };
}

/**
 * Whether a reset is worth performing once the liquidations are done.
 *
 * The installer used to abort at this point if nothing was queued, which meant a run
 * that had torn down its own network and spent its cash would then restart having
 * gained nothing. Checking BEFORE the teardown is the point of having this here.
 */
export function worthInstalling(facts: Pick<RetirementFacts, "queued">): boolean {
    return facts.queued > 0;
}

/**
 * Whether liquidating is worth the calls.
 *
 * Both liquidations are best-effort and both announce a skip when they find nothing,
 * so this exists to keep those messages meaningful rather than to gate the work.
 */
export function worthLiquidating(facts: Pick<RetirementFacts, "cash">): boolean {
    return facts.cash > 0;
}

/* ─── escalation ─── */

/**
 * How long a restarted Orchestrator has to appear before retirement worries.
 *
 * The game runs the callback script after the reset, so there is a window where home
 * legitimately has no orchestrator. Reporting during it would cry wolf every reset.
 */
export const RESTART_GRACE_MS = 15_000;

/**
 * Whether a restarted Orchestrator is overdue.
 *
 * This exists because of a real defect: the OLD retirement killed the orchestrator at
 * the start and only restarted it through `installAugmentations`, so any early return
 * or throw in between left the framework dead with nothing to bring it back. Retirement
 * is the one sequence where losing the orchestrator is unrecoverable without the
 * player noticing, so the check is worth having even though the new design restarts
 * through the game rather than by hand.
 */
export function restartOverdue(startedAt: number, now: number, orchestratorRunning: boolean): boolean {
    if (orchestratorRunning) return false;
    return now - startedAt > RESTART_GRACE_MS;
}
