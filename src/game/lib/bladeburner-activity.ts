/*
 * ============================================================================
 * BLADEBURNER ACTIVITY, PUBLISHED
 * ============================================================================
 * Whether a Bladeburner action is running, in a form any feature can read.
 *
 * WHY THIS EXISTS. `hacknet.ts` needs to know whether the run is doing Bladeburner work,
 * because "Exchange for Bladeburner Rank" and "Exchange for Bladeburner SP" are the only
 * hash upgrades that speed that work up. But Bladeburner actions are INVISIBLE to the
 * Singularity API — `getCurrentWork()` returns null while one runs, which `activity.ts`
 * documents at the top — so `hacknet.ts` cannot see one through the channel it already
 * watches.
 *
 * WHY NOT JUST CALL `ns.bladeburner.getCurrentAction()` THERE. It costs 1 GB of STATIC
 * RAM, charged to every run that loads the feature whether or not it ever has a division
 * — and hacknet's registry entry requires only `serverIncome`. The bladeburner feature
 * already calls it every tick and pays that cost once; publishing the answer keeps a
 * second copy of it out of a feature that may never need it.
 *
 * WHY A PUBLISHER AND NOT AN IMPORT. `hacknet.ts` importing the bladeburner feature would
 * be a static import between features, which charges one feature's RAM to the other
 * (ADR 0001). It is also the wrong direction: the feature that OWNS the fact writes it
 * down, and every reader gets the same answer — the same one-writer rule `Reserves` uses.
 * `publishTrainingRate` in the player feature is the existing precedent.
 *
 * Defaults are the SAFE direction for every reader. "Not running" means hashes are not
 * spent on Bladeburner, so a run without the API — or a pass before the feature has
 * ticked — spends them on the things it already understood rather than on a guess.
 * ============================================================================
 */

/** What the division is doing, as far as hashes are concerned. */
export interface BladeburnerActivity {
    /** An action is running right now. */
    readonly running: boolean;
    /** The player's Bladeburner rank, or 0 when unknown. */
    readonly rank: number;
}

const NOT_RUNNING: BladeburnerActivity = { running: false, rank: 0 };

let published: BladeburnerActivity = NOT_RUNNING;

/**
 * Record what the division is doing.
 *
 * Called by the bladeburner feature on every tick, including when nothing is running —
 * a stale "running: true" would keep hashes flowing to Bladeburner for the rest of the
 * run after the division went idle.
 */
export function publishBladeburnerActivity(activity: BladeburnerActivity): void {
    published = activity;
}

/** What the division is doing. Never throws, and never null. */
export function bladeburnerActivity(): BladeburnerActivity {
    return published;
}

/**
 * Forget the published state.
 *
 * For tests, and for a feature that has to stop claiming something it can no longer
 * see — the orchestrator drops a feature without warning when its capability goes.
 */
export function resetBladeburnerActivity(): void {
    published = NOT_RUNNING;
}
