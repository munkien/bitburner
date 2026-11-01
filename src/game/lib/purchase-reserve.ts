/*
 * ============================================================================
 * PURCHASE RESERVE
 * ============================================================================
 * How much cash to hold back for a purchase the run is saving toward.
 *
 * WHY THIS EXISTS. Two features reserve money — `player.ts` for the next augmentation and
 * `home.ts` for the next link of the stock-access chain — and both used the same rule:
 * hold the money back only once it is within 20% of the price, otherwise reserve NOTHING.
 *
 * That rule is why a run never saves for anything. The reported symptom was three
 * separate complaints that are one defect:
 *
 *   "it does not buy Neuroreceptor Management Implant before very late game"
 *   "it does not buy The Blade's Simulacrum before very late game"
 *   "it spends money on other things even when it could save up easily"
 *
 * With the reserve at zero, every other spender — cloud, hacknet, stocks, home RAM,
 * donations — reads `surplus()` and sees the WHOLE balance as free. So the run spends
 * down, inches back toward 80% of the target, and only then protects the last stretch.
 * A target more than 20% away in cash terms can therefore never be reached, however
 * easily the run could have saved for it: it is outbid on every tick by something else.
 *
 * WHAT REPLACES IT. Reserve against how long the purchase takes to AFFORD, not how close
 * it already is. A target the run can pay for out of the next half hour of income is
 * worth protecting now; one that is hours away is not, because protecting it would freeze
 * the economy for the whole of that time — the concern the old rule was written for, and
 * it is a real one rather than a mistake.
 *
 * The 20% rule and this one agree at the bottom of the range and diverge above it. For a
 * run with 90% of the price both say "reserve everything". For a run with 10% of a price
 * one hour of income away, the old rule says "spend it all" and this says "hold what you
 * have": that gap is precisely the reported bug.
 *
 * WHAT IT DOES NOT DO. It does not stop the run spending — it caps the OTHER spending to
 * a fraction of what is left, so the purchase is approached without the economy stalling.
 * A reserve that blocks every other purchase is how the old rule justified itself, and
 * blocking them entirely for an hour would be the same failure in the other direction.
 * ============================================================================
 */

/**
 * The fraction of remaining income a purchase may be ahead by and still be protected.
 *
 * Half an hour, matching the training budget's `REACH_SEC` — the framework's existing
 * answer to "how long is worth spending on one target". Reusing the number rather than
 * inventing a second one keeps the two decisions consistent: a run that will not spend 30
 * minutes training for a stat should not freeze its economy for longer than that either.
 */
export const RESERVE_HORIZON_SEC = 30 * 60;

/**
 * The most of the remaining cash the reserve may claim.
 *
 * NOT 100%. A reserve that takes everything leaves cloud, hacknet and home RAM with
 * nothing on every tick until the purchase lands, and those features are how the run earns
 * the money in the first place. At 0.8 the target is approached steadily while a fifth of
 * the balance keeps the income features working.
 */
export const RESERVE_CAP = 0.8;

/**
 * How much cash to hold back, given the price and how fast the run is earning.
 *
 * `moneyPerSecond` is the MEASURED rate, or null when none is available. Null means no
 * evidence, and the honest answer is the old behaviour — reserve nothing and let the money
 * work — because reserving on an unknown would freeze spending for a purchase that might
 * be hours away. That is the same reasoning `floorReachable` gives for a null training
 * rate, and the two should not disagree about what an absent measurement means.
 *
 * Returns 0 in three ordinary cases, all of which mean "do not protect this":
 *   - nothing is left to pay;
 *   - the rate is absent, zero or unusable;
 *   - the purchase is further away than the horizon.
 *
 * Otherwise the shortfall, capped, so the money is protected without stopping the run.
 */
export function reserveFor(
    cost: number,
    money: number,
    moneyPerSecond: number | null,
    horizonSeconds: number = RESERVE_HORIZON_SEC,
    /**
     * Whether this purchase must be accumulated toward regardless of how far away it is.
     *
     * THE HORIZON ALONE CANNOT EXPRESS THIS, and a live run showed why. A $25b 4S against a
     * balance of $4b earning 0.5b/hour is 42 hours away, so a 30-minute horizon reserved
     * NOTHING — the run would never save for it, which is the defect this whole module
     * exists to fix. Widening the horizon to cover it would be an arbitrary number that is
     * wrong on most runs, and would freeze the economy for every ordinary augmentation too.
     *
     * So the distance test applies to ORDINARY purchases only, where "is it worth protecting
     * this over the next multiplier" is a real question. A MUST-BUY — the curated list in
     * `MUST_BUY_AUGMENTS` and the stock-access chain — is not competing with anything: it is
     * a mechanic the run needs before anything else it could spend on. Those accumulate from
     * the first coin, capped so the features that earn the money keep working.
     *
     * The measurement is still required. A run with no income measured cannot know whether
     * it is accumulating at all, and reserving on no evidence would freeze an early run —
     * the case where the balance is small and every purchase looks far away.
     */
    accumulate = false,
): number {
    const shortfall = cost - money;
    if (!Number.isFinite(shortfall) || shortfall <= 0) return 0;

    // No usable rate: no evidence the purchase is close. See the note above — this is the
    // direction that keeps the economy running rather than the direction that protects the
    // target, and it is chosen because an unmeasured run is usually an EARLY run, which is
    // exactly the one that must not freeze its spending.
    if (moneyPerSecond === null || !Number.isFinite(moneyPerSecond) || moneyPerSecond <= 0) {
        return 0;
    }

    // A must-buy is protected whatever the distance, because there is nothing it is
    // competing with. See the note on the parameter.
    const secondsAway = shortfall / moneyPerSecond;
    if (!Number.isFinite(secondsAway)) return 0;
    if (!accumulate && secondsAway > horizonSeconds) return 0;

    // THE FIGURE IS CASH TO PROTECT, not cash to add. Every spender subtracts this from the
    // balance (`surplus()`), so returning the price rather than the protected amount would
    // claim money the player does not have and clamp every spender to zero.
    //
    // SCALED BY CLOSENESS, not flat. At the horizon the target is half an hour out and
    // protecting the whole balance would stall the income that pays for it; at one minute
    // out, protecting it is nearly free and is the difference between arriving and being
    // raided on the tick before. `closeness` ramps 0 → 1 across the horizon, so the reserve
    // grows exactly as the purchase approaches.
    //
    // Squared, so the early part of the window stays generous: a linear ramp holds back half
    // the balance for the whole second half-hour, which is a tax on every other feature for
    // the duration. Squaring keeps the reserve small until the purchase is genuinely close.
    // MUST-BUYS DO NOT RAMP WITH CLOSENESS. A ramp is a tax curve: it holds back little
    // while the target is far and most of it as it approaches. That is right for an ordinary
    // augmentation, which is competing with every other purchase, but a must-buy is not —
    // its whole point is that waiting is the failure mode. So it holds back the capped
    // fraction from the start, which is the largest share the income features can tolerate
    // and the most that can be saved without stalling the run.
    //
    // The distinction matters most at the far end: with the ramp, a 42-hour 4S reserved
    // `RESERVE_CAP * 0 * 0` — nothing at all, which is the reported bug reproduced by the
    // fix itself.
    if (accumulate) return Math.ceil(money * RESERVE_CAP);

    const closeness = 1 - secondsAway / horizonSeconds;
    const fraction = RESERVE_CAP * closeness * closeness;

    // BOUNDED BY THE BALANCE ONLY, never by the shortfall.
    //
    // Bounding by the shortfall looked right and was backwards: a distant target has the
    // LARGER gap, so `min(shortfall, ...)` let the furthest purchase protect the most — the
    // exact inversion of the intent. The gap is the wrong quantity here because the reserve
    // is not "the money still needed", it is "the money already in hand that must not be
    // spent", and that is a fraction of the balance ramped by how close the purchase is.
    return Math.ceil(Math.min(money, money * fraction));
}

/* ─── STICKINESS ─── */

/**
 * How long a reserve, once granted for a target, may not be lowered.
 *
 * THE COMPLAINT THIS ANSWERS: "it shouldn't lower its reserve once they're reserved". And it
 * should not — a reserve that is recomputed from the CURRENT balance every tick is not a
 * commitment, it is a tax on whatever happens to be in the account. `reserveFor` returns a
 * fraction of the balance, so any dip in the balance — a purchase by another feature, a
 * stock position, an unlucky minute — silently shrinks what is being held back. Measured in
 * `runs/2026-11-01T12.22.54.797Z`: thirteen collapses, each on the tick a purchase landed,
 * each taking the reserve to zero and making the run rebuild it from nothing.
 *
 * A WINDOW RATHER THAN FOREVER, because a reserve that can only ever rise is the same defect
 * pointing the other way: a run whose income collapses, or whose target was bought but not
 * yet reflected, would keep withholding cash it no longer needs. Past the window the figure
 * is recomputed from scratch, which is what makes the guarantee a floor rather than a ratchet.
 *
 * Five minutes: long enough to outlast every recalibration window in the framework (the rate
 * window is one minute), short enough that a genuinely finished target releases the money
 * promptly. It deliberately does NOT try to detect "the target was bought" — the target
 * changes, and a stale identity check is a second thing to get wrong. Time is enough.
 */
export const RESERVE_HOLD_MS = 5 * 60_000;

/** A reserve in force, and when it stops being enforced. */
export interface HeldReserve {
    /** The cash figure being withheld. Never lowered while held. */
    readonly money: number;
    /** When the hold was granted, so it can expire. */
    readonly at: number;
    /**
     * Which purchase the hold is for, as a stable identity.
     *
     * Needed because the guarantee is per-TARGET: lowering is forbidden while the run is
     * still saving for the same thing, and a different target is a different commitment that
     * starts from nothing. Without this, a run switching targets would keep the old, larger
     * hold and never release it — reserving for an augmentation it had already left behind.
     */
    readonly target: string;
}

/**
 * The reserve to withhold now, given what is already held and when the hold was granted.
 *
 * Raises immediately, lowers only when the hold has expired. Takes `now` rather than reading
 * a clock, for the same reason everything else in this module does: a test can then simulate
 * ten minutes in three lines.
 *
 * A DIFFERENT TARGET RELEASES IMMEDIATELY, for the reason on `target`: the commitment has
 * changed, so the old figure describes a purchase the run is no longer saving for. It is not
 * lowered to the new target's figure, it is replaced by it, which can be lower or higher.
 */
export function heldReserve(
    wanted: number,
    target: string,
    held: HeldReserve | null,
    now: number,
): HeldReserve | null {
    // Nothing wanted and nothing held: the ordinary case for a run with no purchase in view.
    if (wanted <= 0 && held === null) return null;

    // Nothing wanted, but something held. Keep holding until the window expires, then
    // release — the money was withheld for a reason and releasing it on a single pass of
    // "wanted 0" is how a reserve becomes a function of noise.
    if (wanted <= 0 && held !== null) {
        return now - held.at > RESERVE_HOLD_MS ? null : held;
    }

    // A new target is a new commitment. Replace rather than compare, so a switch cannot
    // leave the run reserving for whichever target happened to need more money.
    if (held === null || held.target !== target) {
        return { money: wanted, at: now, target };
    }

    // The same target: raise at once, lower only once the hold has expired.
    if (wanted >= held.money) return { money: wanted, at: now, target };

    return now - held.at > RESERVE_HOLD_MS ? { money: wanted, at: now, target } : held;
}
