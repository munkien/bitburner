/*
 * ============================================================================
 * GANG MEASURES
 * ============================================================================
 * The two gang thresholds the game lets us derive, as pure functions of plain numbers.
 *
 * WHY THESE LIVE IN `lib/`. They used to live in `features/gang/gang-config.ts`, which
 * was fine while only the gang feature read them. They are now also needed to build the
 * run's goal for the gang — "grow the gang", "take the map" — and `lib/objective.ts`
 * may not import a feature (ADR 0002), nor a feature import another feature (ADR 0001).
 * A shared definition in `lib/` is the only place both can reach without one charging
 * RAM to the other or a threshold being copied.
 *
 * WHY THEY ARE SHARED AT ALL. ADR 0003 exists because a threshold two features each
 * declared drifted apart — one trained to 100, the other stopped at 75. A goal that
 * announced "the gang has grown enough" while the gang feature still thought it had
 * respect to gain would be the same bug wearing gang clothes. So there is one definition
 * of each threshold and both callers reach it.
 *
 * These take raw numbers rather than a `GangGenInfo`, so this module needs no game types
 * and stays callable from anywhere. The gang feature adapts its own object to these.
 * ============================================================================
 */

/**
 * How many more recruits' worth of respect to bank before further respect is worth less
 * than money.
 *
 * A strategy choice rather than a game fact, so it is declared here rather than read
 * from the game.
 *
 * WHY THIS IS NOT 2 ANY MORE. The margin is meant to cover the NEXT recruit: the gang is
 * already holding enough respect for the recruit it can see, and the margin is the
 * buffer that keeps it recruiting after that. At 2 the gang banked the cost of TWO more
 * recruits before it would consider money, and on a real run the second recruit is the
 * expensive one — `respectForNextRecruit` grows superlinearly with gang size, so the
 * second recruit's worth of respect is more than all the earlier ones together.
 *
 * That is a long time to work for respect the gang does not need yet, and it is the
 * second half of why progression felt stalled: even after the training share was cut,
 * the respect phase itself ran to roughly twice the respect the gang could spend. 1
 * keeps the buffer that the name promises — "enough for the next recruit" — without
 * pre-banking the one after it.
 */
export const RESPECT_MARGIN = 1;

/**
 * Respect past which the gang works for money rather than growing.
 *
 * The game reports the respect cost of the gang's next recruit, which is a function of
 * its size, so this tracks the gang rather than being a fixed number: a larger gang keeps
 * working for respect longer, because recruits keep getting more expensive and each is
 * worth having.
 *
 * `Infinity` once the gang is at its size cap, which the game reports as an infinite
 * `respectForNextRecruit` and which is the honest signal to stop chasing respect: there
 * is nothing left to grow.
 */
export function respectPhaseEnd(respectForNextRecruit: number): number {
    if (!Number.isFinite(respectForNextRecruit)) return Infinity;
    return respectForNextRecruit * RESPECT_MARGIN;
}

/**
 * Territory share below which more is worth taking.
 *
 * Holding all of it is the goal, but the last slivers take disproportionately long as
 * rivals are eliminated, so this stops short of requiring 100%. Scaled so that a gang
 * facing more rivals keeps taking territory for longer: with four rivals, giving up at
 * 95% would abandon a quarter of the map.
 */
export function territoryEnableBelow(enemyCount: number): number {
    if (enemyCount <= 0) return 1;
    return Math.min(0.999, 1 - 0.5 / enemyCount);
}
