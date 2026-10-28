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

/**
 * How long the queue may go without growing before the reset is worth performing.
 *
 * THE ONE RULE, and it used to be two. There was a count threshold (five queued installs
 * now) alongside this timer, and the count was the problem: a fixed number cannot be right
 * at both ends of a run. Five is fine for the second run, when five is all there is to buy,
 * and far too eager for a run sitting on forty augmentations and bidding for forty-four —
 * where it resets before the queue has earned the reputation spent on it.
 *
 * So the decision is now purely temporal: if nothing has been bought for `INSTALL_WAIT_MS`
 * and there is more than `MIN_QUEUED` waiting, the queue has stopped being fed and waiting
 * longer only postpones a reset for augmentations that are not coming. A purchase restarts
 * the clock, so a run that is still buying keeps going for as long as it keeps buying.
 *
 * The prose here used to say "an hour" while the constant said thirty minutes — a stale
 * duplicate of the figure, in the same file, that nothing could compile-check. Naming the
 * constant rather than restating its value is the same rule as ADR-0003 applied to comments.
 */
export const INSTALL_WAIT_MS = 30 * 60 * 1000;

/**
 * How much has to be queued before the timer is allowed to fire — STRICTLY more than this.
 *
 * More than two, so three is the smallest installable queue. Two is an ordinary moment on
 * the way to a third, and resetting for it trades a whole run's reputation for almost
 * nothing. Three is the smallest queue where waiting out `INSTALL_WAIT_MS` says something
 * other than "you are two purchases into a run".
 */
export const MIN_QUEUED = 2;

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
    /**
     * Milliseconds since the queue last GREW, or `null` when that is not yet known.
     *
     * Null is not zero, and the difference matters: zero would read as "a purchase just
     * landed", which is the answer that makes the decision wait. Null means the caller
     * has not observed a purchase yet this run — at the very start, and for every tick
     * until the clock arms — and the decision cannot fire on a figure it does not have.
     *
     * Measured from the last purchase rather than from the last install, deliberately: this
     * timer measures the FLOW of augmentations, not the age of the queue. A run that is
     * still buying is still making progress, however long ago it last reset, and
     * interrupting it would cost the reputation the wait was protecting.
     */
    readonly msSincePurchase: number | null;
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
 *   already started      the installer is running. Asking twice would spawn a second
 *                 copy that fights the first for the same augmentations. Checked before
 *                 the timer, so a queue that has waited out `INSTALL_WAIT_MS` cannot start a second
 *                 installer while the first is still deciding what to do.
 *   timer not run / not enough queued
 *                 Fewer than `MIN_QUEUED + 1` augmentations are queued, or nothing has
 *                 been bought for less than `INSTALL_WAIT_MS`. The normal case, and the
 *                 reason a run keeps going.
 *
 * There is exactly ONE way to retire: more than `MIN_QUEUED` is queued and the queue has
 * not grown for `INSTALL_WAIT_MS`. The clock restarts on every purchase, so this never
 * fires while augmentations are still arriving — and never fires early just because a run
 * happens to have accumulated a lot of cheap ones.
 *
 * `factions` is deliberately NOT part of the decision, even though the old abort
 * checked it. A player with queued augmentations and no factions can still install
 * them; the faction count only decides whether there is anything to SPEND on
 * afterwards, which is `worthLiquidating`'s business rather than a reason to refuse.
 *
 * `msSincePurchase` NULL WAITS, and that is the safe direction rather than an oversight.
 * Null means this module instance has not observed a purchase yet, so the wait cannot be
 * measured and must not be assumed to have elapsed. The clock is armed from the first
 * reading of a non-empty queue (see `observeQueue`), so null is a state that lasts one
 * tick rather than the whole run.
 */
export function decideRetirement(facts: RetirementFacts): RetirementVerdict {
    if (!facts.canInstall) {
        return { kind: "wait", reason: "no Singularity API, so nothing can be installed" };
    }

    if (facts.alreadyStarted) {
        return { kind: "wait", reason: "the installer is already running" };
    }

    // The ONLY retirement rule: the queue has earned a reset by going quiet long enough.
    //
    // Strictly greater than `MIN_QUEUED`, so two queued never installs however long it
    // waits — a run that has bought its first two augmentations and stalled is better off
    // with the queue it has than with a reset that spends them for nothing.
    //
    // Null fails the comparison deliberately: an unmeasured wait is not an elapsed one.
    if (
        facts.queued > MIN_QUEUED
        && facts.msSincePurchase !== null
        && facts.msSincePurchase >= INSTALL_WAIT_MS
    ) {
        return {
            kind: "retire",
            reason: `${facts.queued} queued and nothing bought for ${Math.round(facts.msSincePurchase / 60_000)} min`,
        };
    }

    // The wait reason names whichever half is actually blocking, so a stalled-looking run
    // says whether it needs more augmentations or more time. Reporting the same sentence
    // for both is what made the old threshold path unreadable: it said "5 needed" on a run
    // that already had nine and was waiting out `INSTALL_WAIT_MS`.
    if (facts.queued <= MIN_QUEUED) {
        return {
            kind: "wait",
            reason: `${facts.queued} queued, need more than ${MIN_QUEUED} before time counts`,
        };
    }

    if (facts.msSincePurchase === null) {
        return {
            kind: "wait",
            reason: `${facts.queued} queued, waiting on the first purchase to start the clock`,
        };
    }

    const left = Math.max(0, INSTALL_WAIT_MS - facts.msSincePurchase);
    return {
        kind: "wait",
        reason: `${facts.queued} queued, installs in ${Math.ceil(left / 60_000)} min if nothing more is bought`,
    };
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
