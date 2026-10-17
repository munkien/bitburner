import type {
    GangGenInfo,
    GangMemberAscension,
    GangMemberInfo,
    GangOtherInfoObject,
    GangTaskStats,
} from "@ns";

/*
 * ============================================================================
 * GANG DECISIONS
 * ============================================================================
 * Every decision the gang controller makes, as pure functions of plain data.
 *
 * These were private functions inside a 734-line module, reachable only by
 * running the whole tick against a live gang. They take nothing but game
 * objects, so they can be tested directly, and this file exists to make that
 * possible without exporting the controller's internals.
 *
 * The interface is deliberately narrow: the caller does the `ns` work, this file
 * decides what it should do. Nothing here reads or writes game state.
 * ============================================================================
 */

/** What the gang is currently optimising for. */
export type GangMode = "WANTED" | "RESPECT" | "WARFARE_PREP" | "TERRITORY" | "MONEY";

export interface EquipmentInfo {
    name: string;
    cost: number;
    stats: EquipmentStats;
}

/** Task names that are special to this gang, rather than chosen by scoring. */
export interface Special {
    wanted: string;
    territory: string;
}

const UNASSIGNED = "Unassigned";
const TRAIN_HACKING = "Train Hacking";
const TRAIN_COMBAT = "Train Combat";
const TRAIN_PREFIX = "Train ";
export const TASK_TERRITORY = "Territory Warfare";

/**
 * Tunable thresholds.
 *
 * These are derived from the gang's own state where that is possible, so a
 * player never has to set them. See `deriveConfig`.
 */
export interface GangConfig {
    /**
     * Combat stat targets at which a member stops being a trainer.
     *
     * These are the boundary between "investing in this member" and "this member earns",
     * so they are the main lever on how fast the gang's PROGRESS is. 250/150 was chosen
     * as a good-looking stat line rather than from anything the game says, and it is the
     * wrong trade for a progression-driven run: a member sitting on `Train Combat` earns
     * no money and no respect, so every point of target above what the member's work
     * needs is time the gang spent not producing.
     *
     * The combat tasks the gang actually works (`Mug People`, `Human Trafficking`,
     * `Terrorism`) scale with the member's skills, but the returns are sharply
     * diminishing: the first hundred points of strength buy far more than the second
     * hundred, so the last stretch to the old target was the most expensive and least
     * valuable part of training. 150/100 keeps the early, high-yield part and gives up
     * the tail.
     *
     * These are still targets a member can fail, which is the point: below them the
     * member trains, and `minFreshAscensionMultiplier` lets a member ascend cheaply while
     * they do. See `trainMaxFraction` for how much of the gang this may occupy at once.
     */
    trainPrimaryTarget: number;
    trainSecondaryTarget: number;
    hackPrimaryDone: number;
    /**
     * The share of the gang allowed to be training at once, outside `WARFARE_PREP`.
     *
     * The cap exists so the gang cannot train itself into having no income, and it is
     * applied as `ceil(memberCount * this)` — so at 0.40 a twenty-five member gang keeps
     * ten members idle-until-strong for the whole pre-respect era. That is 40% of the
     * gang's EARNING capacity removed rather than 40% of a continuum, because respect and
     * money want opposite tasks (see `scoreTask`) and a trainer works neither.
     *
     * 0.25 is the balance point: enough trainers that the gang's power and its future
     * earning capacity keep rising, few enough that three quarters of the gang are always
     * producing. This is a strategy choice rather than a game fact, so it is declared
     * rather than derived, like `moneyFloor`.
     */
    trainMaxFraction: number;
    prepTrainerFraction: number;
    prepWarfareFraction: number;
    minAscensionMultiplier: number;
    minFreshAscensionMultiplier: number;
    wantedPenaltyTarget: number;
    respectPhaseEnd: number;
    /**
     * Whether the gang is still GROWING, which outranks the money rule.
     *
     * Respect gates `canRecruitMember`, so a gang that stops earning respect stops
     * growing, and a small gang earns less for the rest of the run. That makes growth
     * the one thing worth doing while poor: the money floor exists because a poor run
     * cannot afford a war, but a gang that never grows never becomes worth having.
     *
     * While this is true BOTH `decideMode` and `decideWarfare` ignore `moneyFloor`. They
     * must be told the same thing — this module documents at `decideWarfare` that the two
     * disagreeing sends members to earn in the mode machine while fighting in the field —
     * so the flag is set in one place and read by both, never derived separately.
     *
     * Cleared once the gang cannot recruit again, at which point the ordinary money and
     * respect rules resume and the gang's output is spent on the run instead of on itself.
     */
    recruitingPhase: boolean;
    /**
     * Player net worth below which the gang earns money and nothing else.
     *
     * NET WORTH, not home cash, and the difference is not cosmetic. Cash is only what is
     * spendable this instant; a player who has just bought a server or is holding stocks
     * looks poor by cash and is not. The gang would then chase money it did not need
     * while abandoning the respect that grows it, which is the opposite of the intent.
     * See `lib/net-worth.ts` for what the figure includes and why it is narrow.
     *
     * Respect grows the gang, and a bigger gang earns more — so chasing respect is
     * normally the right long game. It stops being right when the player is poor:
     * respect buys nothing the player can spend, while net worth is what pays for home
     * RAM, augmentations and everything the rest of the framework does. Below this
     * figure the gang stops fighting and stops chasing respect, because a poor run
     * cannot afford a war and cannot use the gang's output.
     *
     * Unlike `respectPhaseEnd` this is not derivable — the game has no opinion about how
     * much money a player needs — so it is a declared figure, and 25e9 is where the
     * late-game augmentations start to be affordable.
     */
    moneyFloor: number;
    respectMoneyShare: number;
    territoryEnableBelow: number;
    territoryDisableAbove: number;
    /**
     * The clash chance the gang insists on before starting a fight for territory.
     *
     * MEASURED AGAINST THE STRONGEST rival, not the weakest. `scanEnemies` reports
     * `lowestClashChance`, the minimum over every gang holding territory, so this is a
     * worst-case bar: clearing it means the gang could take any of them. Asking whether
     * ANY rival were beatable would have the gang commit to a war it loses the moment a
     * stronger gang contests it, and a lost clash costs both respect and power.
     *
     * 0.90 rather than the 0.60 this was. The clash model is
     * `own.power / (own.power + their.power)`, so 0.9 means roughly NINE TIMES the
     * strongest rival's power — an overwhelming margin rather than a favourable one.
     *
     * WHAT IT COSTS, because this is not free. The gang fights less often and stays in
     * `WARFARE_PREP` longer building power, so territory grows more slowly and the
     * `territoryEnableBelow` gate takes longer to clear. The `DISENGAGE` bar moves with
     * it (see `disengageChance`), so a gang already fighting now holds until the chance
     * falls to about 0.63 where it previously let go at about 0.42.
     */
    territoryMinClashChance: number;
    territoryWorkerFraction: number;
    /**
     * Gang size past which one member always works territory.
     *
     * The territory modes (`TERRITORY`, `WARFARE_PREP`) only send members to
     * territory once the gang has decided to fight for it, which needs enough respect
     * banked and a winnable clash. Before that the gang never touches its territory,
     * and territory only grows from members working it. A gang with this many members
     * can spare one to keep the map moving while the rest do the current mode's work,
     * and one member is cheap enough not to distort respect, money or wanted
     * progress.
     *
     * A strategy choice, not a game fact, so it is declared rather than derived —
     * like `moneyFloor`. "Above 8" is the standing: `members.length` must EXCEED
     * this, so 9 members is the first size that qualifies.
     */
    territoryStandingMinMembers: number;
    minHomeCash: number;
    equipmentBudgetFraction: number;
    prepEquipmentBudgetFraction: number;
}

export const GANG_CONFIG_DEFAULT: GangConfig = {
    trainPrimaryTarget: 150,
    trainSecondaryTarget: 100,
    hackPrimaryDone: 1000,
    trainMaxFraction: 0.25,
    /**
     * The share of the gang `WARFARE_PREP` may train, above every other mode's cap.
     *
     * Raised alongside `trainMaxFraction` being cut, and for a reason that is not
     * cosmetic: prep's trainers no longer work past the training targets (see
     * `refreshTrainers`), so the size of the cap is now the entire difference between prep
     * and an ordinary mode. At 0.30 against an ordinary 0.25 the two produced the SAME cap
     * on a ten member gang — `ceil` of both is 3 — so prep had no training policy of its
     * own at all.
     *
     * It is 0.35 rather than the 0.45 this was first raised to because of the budget below:
     * prep's fractions have to leave somebody earning.
     */
    prepTrainerFraction: 0.35,
    /**
     * The share of the gang `WARFARE_PREP` sends to build territory power.
     *
     * READ THIS TOGETHER WITH `prepTrainerFraction`, because the two are a budget that has
     * to sum to LESS THAN 1. Prep is the mode that both trains and fights, and the members
     * left over after those two are the only ones earning — so when the two fractions
     * summed to 1.05 (0.60 + 0.45) the mode consumed the entire gang between them and
     * assigned NOBODY to economic work. `computeTrainerCap`'s clamp hid it by silently
     * shrinking the cap to fit, so the symptom was not an obviously wrong count but a gang
     * with no income at all while it prepared.
     *
     * 0.50 + 0.35 = 0.85 leaves 15% for earning, which at every gang size is at least the
     * one member `PREP_EARNERS_RESERVED` guarantees and usually more. It is deliberately
     * not larger: prep is a short-lived mode entered only when a fight is worth starting
     * but not yet winnable, so the gang can afford to be mostly invested, and the members
     * it holds back are insurance against the arithmetic rather than a strategy.
     *
     * 0.50 rather than the 0.60 this was, because prep's FIRST job is to build the power it
     * cannot win without, and at 0.60 the territory target claimed so much of the roster
     * that the trainer cap was squeezed to the ordinary mode's level on small gangs — the
     * mode stopped being a power build exactly when a small gang needed one. Territory
     * comes second now, which is also the honest order: a gang that cannot win a clash
     * gains nothing from standing on the map.
     */
    prepWarfareFraction: 0.50,
    minAscensionMultiplier: 1.15,
    minFreshAscensionMultiplier: 1.05,
    wantedPenaltyTarget: 0.90,
    respectPhaseEnd: 25e6,
    moneyFloor: 25e9,
    // Derived per tick by `deriveGangConfig`; false here so the default reads as an
    // ordinary grown gang rather than one that overrides the money rule.
    recruitingPhase: false,
    respectMoneyShare: 0.25,
    territoryEnableBelow: 0.90,
    territoryDisableAbove: 0.999995,
    territoryMinClashChance: 0.9,
    territoryWorkerFraction: 1.0,
    territoryStandingMinMembers: 8,
    minHomeCash: 50e6,
    equipmentBudgetFraction: 0.15,
    prepEquipmentBudgetFraction: 0.5,
};

/* ============================================================
 * SCORES
 * ============================================================ */

/** How well a member's stats fit a task. */
export function skillScore(m: GangMemberInfo, t: GangTaskStats): number {
    return (
        m.hack * t.hackWeight + m.str * t.strWeight + m.def * t.defWeight +
        m.dex * t.dexWeight + m.agi * t.agiWeight + m.cha * t.chaWeight
    ) / 100;
}

/** A member's useful power, for ranking who is worth spending on. */
export function memberPower(m: GangMemberInfo, isHacking: boolean): number {
    if (isHacking) return m.hack + m.cha * 0.20 + (m.str + m.def + m.dex + m.agi) * 0.05;
    return m.str + m.def + m.dex + m.agi + m.cha * 0.05;
}

/* ============================================================
 * ENEMY POWER
 * ============================================================ */

export interface EnemyScan {
    strongestName: string;
    strongestPower: number;
    lowestClashChance: number;
    enemyCount: number;
}

/**
 * Summarise every rival gang that still holds territory.
 *
 * Takes `GangOtherInfoObject`s, which is what `getAllGangInformation` returns:
 * only their power and territory are read, so requiring the full `GangGenInfo`
 * would be a false constraint.
 */
export function scanEnemies(
    allGangs: Readonly<Record<string, GangOtherInfoObject>>,
    own: { readonly faction: string; readonly power: number },
): EnemyScan {
    let strongestName = "";
    let strongestPower = 0;
    let lowestClashChance = 1.0;
    let enemyCount = 0;

    for (const [name, info] of Object.entries(allGangs)) {
        if (name === own.faction) continue;
        if (info.territory <= 0) continue;
        enemyCount++;
        // Clash chance is our power against theirs: a gang with no power cannot
        // defend, so it is the easiest to take territory from.
        const chance = info.power === 0 ? 1 : own.power / (own.power + info.power);
        lowestClashChance = Math.min(lowestClashChance, chance);
        if (info.power > strongestPower) {
            strongestPower = info.power;
            strongestName = name;
        }
    }
    return { strongestName, strongestPower, lowestClashChance, enemyCount };
}

/* ============================================================
 * MODE SELECTION
 * ============================================================ */

export type ModeReason =
    | "wanted-cleanup" | "engaged" | "weaker-than-enemy"
    | "respect-phase" | "money-phase"
    /**
     * Home cash is below `moneyFloor`. Distinct from `money-phase`, which means the
     * respect phase ENDED: this one means respect was abandoned because the run cannot
     * afford to wait for it. A reader seeing `money-phase` learns the gang is done
     * growing; seeing this learns it is broke, which is a different problem.
     */
    | "below-money-floor";

export interface ModeDecision { mode: GangMode; reason: ModeReason; }

/**
 * How far below `moneyFloor` the run must be before the gang works for money and
 * absolutely nothing else.
 *
 * The floor alone is a boundary, not a priority: just under it the gang still earns, but
 * it also still cleans up a wanted level first, because at that wealth there is an income
 * for the penalty to multiply and defending it is the money play. This is the point below
 * which that argument stops being true — there is no income left to defend, so every
 * member on cleanup is a member not earning, and earning is the only thing that moves the
 * run forward.
 *
 * A quarter is a judgement rather than a measurement: far enough below the floor that a
 * run only reads as this poor deliberately, close enough that it is reachable. The failure
 * this guards against is not subtle — a gang whose own work keeps its wanted level dancing
 * around the target could otherwise hold `WANTED` forever and never earn once.
 */
export const MONEY_PANIC_FRACTION = 0.25;

/**
 * What the gang should be working toward right now.
 *
 * This answers "what is the gang for", not "should we be at war": engagement is
 * `decideWarfare`'s question, and it reads the same respect total and enemy scan.
 * The two used to disagree, because this function returned WARFARE_PREP in the
 * exact case warfare engages — enough respect banked and a winnable fight — so a
 * gang that should have been taking territory was sent to build power instead.
 *
 * The distinction now: WARFARE_PREP means "we want territory but cannot win
 * yet", and nothing else. Being able to win is not a reason to train.
 */
/**
 * Whether the gang has a war it should be fighting RIGHT NOW.
 *
 * THE SHARED CONDITION, and both `decideMode` and `decideWarfare` consult it so the
 * two cannot disagree about whether the gang is at war. This module has been bitten
 * by that disagreement twice — a mode machine saying MONEY while the warfare
 * decision said ENGAGE, so members were sent to take territory while the tasks were
 * assigned for earning. Stating the test once is what prevents the third time.
 *
 * WHY THIS OUTRANKS THE MONEY FLOOR. Territory is the only thing in the gang that
 * permanently raises its income — every clash won scales what the gang earns for the
 * rest of the run — whereas money is spent once, on equipment. So a winnable fight
 * is worth taking even while the run is poor, and the money floor is a gate on
 * FIGHTING UNABLE TO WIN rather than a gate on fighting at all.
 *
 * The floor still matters, and still holds the rest of the time: below it the gang
 * earns unless it can actually take ground. What it no longer does is make the gang
 * farm money while holding a clash it would win — the reported case was a gang at
 * 22% territory with a 95% clash chance sitting in MONEY, which is the one situation
 * where waiting actively loses value.
 *
 * `territoryEnableBelow` still applies: above it there is no ground worth taking, and
 * the gang goes back to earning or respect as it otherwise would.
 */
export function winnableWar(g: GangGenInfo, c: GangConfig, enemies: EnemyScan): boolean {
    if (enemies.enemyCount === 0) return false;
    if (g.territory >= c.territoryEnableBelow) return false;
    return enemies.lowestClashChance >= c.territoryMinClashChance;
}

export function decideMode(
    g: GangGenInfo,
    c: GangConfig,
    isHacking: boolean,
    enemies: EnemyScan,
    /**
     * The player net worth, which decides whether the gang can afford to do anything
     * but earn. NOT home cash: see `moneyFloor` for why the distinction matters.
     */
    netWorth = Infinity,
    /**
     * Whether cleanup workers are already assigned, so the wanted boundary carries its
     * hysteresis band. Without it the mode toggles every tick the penalty sits on the
     * target, dragging the respect/money split — and a member's task — with it.
     */
    wantedEngaged = false,
): ModeDecision {
    // A WINNABLE WAR comes first, above even the panic gate, because it is the one
    // thing in the gang that permanently raises its income: every clash won scales
    // what the gang earns for the rest of the run, while money is spent once on
    // equipment. Farming money while holding a fight the gang would win is the one
    // situation where waiting actively loses value.
    //
    // Note this is ABOVE the panic gate deliberately. A run poor enough to panic is
    // also a run that most needs a permanent income, and the war is affordable
    // precisely because it is winnable — `winnableWar` requires the overwhelming
    // margin, so the gang is not gambling.
    if (!isHacking && winnableWar(g, c, enemies)) {
        return { mode: "TERRITORY", reason: "engaged" };
    }

    // RECRUITING OUTRANKS POVERTY. Respect gates recruitment, so a gang that stops
    // earning it stops growing — and a small gang earns less for the rest of the run.
    // See `recruitingPhase` for why this is read here AND in `decideWarfare`.
    if (!c.recruitingPhase && netWorth < c.moneyFloor * MONEY_PANIC_FRACTION) {
        return { mode: "MONEY", reason: "below-money-floor" };
    }

    // Wanted cleanup takes priority while the penalty is below target and the level
    // can still come down, or while the level is still climbing.
    //
    // Above the money rule, because an unattended wanted level collapses the gang's
    // income: the penalty multiplies everything it earns, so cleaning it up IS the
    // money play rather than a distraction from it. Below that same rule the gang
    // does not chase a level it can no longer move — see `wantedNeedsAttention`,
    // which is where the floor of the scale is accounted for.
    //
    // But NOT above the panic gate just above, and the ordering of these two is the
    // point. Cleanup is the money play when the gang has an income for the penalty to
    // multiply; a run this far below its wealth goal does not, so there is nothing to
    // make worse and cleaning up is time not spent earning. Left unconditional, a level
    // that drifts down and back up — which is what a gang whose own work keeps raising
    // it does — held the mode on WANTED indefinitely and the gang never worked for money
    // at all. `MONEY_PANIC_FRACTION` is where "there is an income to defend" stops being
    // true.
    // Between the panic gate and the floor: cleanup still wins if it is real cleanup
    // (the level can move and is off target), because at this wealth the gang is
    // earning something and the penalty is worth defending.
    //
    // The RECRUITING override applies here too, not only at the panic gate above: this is
    // the check that actually fires for a run between the two thresholds, and guarding
    // only the panic gate left a growing gang told to earn money anyway.
    if (!c.recruitingPhase && netWorth < c.moneyFloor) {
        if (wantedNeedsAttention(g, c, wantedEngaged)) {
            return { mode: "WANTED", reason: "wanted-cleanup" };
        }
        return { mode: "MONEY", reason: "below-money-floor" };
    }

    if (wantedNeedsAttention(g, c, wantedEngaged)) {
        return { mode: "WANTED", reason: "wanted-cleanup" };
    }

    // Hacking gangs fight nobody, so territory is never the goal. Note that this skips
    // TERRITORY and WARFARE_PREP and nothing else: a hacking gang still works for respect
    // like any other, which is what `decideWarfare` assumes when it gates its own
    // engagement on `respectPhaseEnd` without asking how the gang earns. Returning MONEY
    // here made the two disagree for every hacking gang before its respect was banked —
    // this function said the gang was done growing while the warfare decision said it was
    // still in its respect phase.
    //
    // A fight worth starting keeps the gang on territory work; `decideWarfare`
    // turns the warfare flag on for the same inputs.
    //
    // WINNABLE territory was already returned above, before the money gate, so what
    // reaches here is ground worth having that the gang cannot yet take. That is a
    // power problem, and `WARFARE_PREP` is the mode that builds power — money earned
    // here is what buys the equipment that closes the gap.
    if (!isHacking && g.territory < c.territoryEnableBelow && enemies.enemyCount > 0) {
        return { mode: "WARFARE_PREP", reason: "weaker-than-enemy" };
    }

    if (!isHacking && g.territoryWarfareEngaged && g.territory < c.territoryDisableAbove) {
        return { mode: "TERRITORY", reason: "engaged" };
    }

    if (g.respect < c.respectPhaseEnd) {
        return { mode: "RESPECT", reason: "respect-phase" };
    }

    return { mode: "MONEY", reason: "money-phase" };
}

/* ============================================================
 * PURE HELPERS
 * ============================================================ */

export function trainingTask(m: GangMemberInfo, isHacking: boolean, c: GangConfig): string | null {
    if (isHacking) return m.hack < c.hackPrimaryDone ? TRAIN_HACKING : null;
    const done =
        m.str >= c.trainPrimaryTarget &&
        m.def >= c.trainSecondaryTarget &&
        m.dex >= c.trainSecondaryTarget &&
        m.agi >= c.trainSecondaryTarget;
    return done ? null : TRAIN_COMBAT;
}

export function rawTrainingTask(isHacking: boolean): string {
    return isHacking ? TRAIN_HACKING : TRAIN_COMBAT;
}

export function shouldAscend(
    m: GangMemberInfo,
    isHacking: boolean,
    c: GangConfig,
    result: GangMemberAscension | undefined,
    suppress: boolean,
): boolean {
    if (!result || suppress) return false;

    const ratio = ascensionRatio(m, isHacking, result);
    if (!Number.isFinite(ratio)) return false;

    const stillTraining = trainingTask(m, isHacking, c) !== null;
    const threshold = stillTraining ? c.minFreshAscensionMultiplier : c.minAscensionMultiplier;
    return ratio >= threshold;
}

/**
 * How much better this member would be after ascending: the multiplier they
 * would gain, over the one they have.
 *
 * The combat case takes the worst of the four stat multipliers, because a
 * member is only as good as their weakest stat, and ascending resets all of
 * them. `shouldAscend` and the log line both read this, so the decision and the
 * reported gain cannot disagree.
 */
export function ascensionRatio(
    m: GangMemberInfo,
    isHacking: boolean,
    result: GangMemberAscension,
): number {
    const prev = isHacking
        ? m.hack_asc_mult
        : Math.min(m.str_asc_mult, m.def_asc_mult, m.dex_asc_mult, m.agi_asc_mult);
    const next = isHacking
        ? result.hack
        : Math.min(result.str, result.def, result.dex, result.agi);
    if (!Number.isFinite(prev) || prev <= 0) return 1;
    return next / prev;
}

export function scoreTask(money: number, respect: number, wanted: number, mode: GangMode): number {
    const logVal = (v: number) => (Number.isFinite(v) && v > 0 ? Math.log10(v + 1) : 0);
    const m = logVal(money);
    const r = logVal(respect);
    const w = wanted >= 0 ? logVal(wanted) : -logVal(Math.abs(wanted));

    switch (mode) {
        case "RESPECT": return 0.01 * m + 100.0 * r - 1.0 * w;
        case "MONEY": return 100.0 * m + 0.01 * r - 1.0 * w;
        case "WANTED": return 0.01 * m + 0.10 * r - 100.0 * w;
        case "TERRITORY": return 1.00 * m + 0.10 * r - 0.05 * w;
        case "WARFARE_PREP": return 100.0 * m + 0.01 * r - 1.0 * w;
    }
}

export function isEconomicTask(t: GangTaskStats, isHacking: boolean, s: Special): boolean {
    if (t.name === UNASSIGNED || t.name.startsWith(TRAIN_PREFIX)) return false;
    if (t.name === s.wanted || t.name === s.territory) return false;
    return isHacking ? t.isHacking : t.isCombat;
}

/** A task and the score it earned under the mode in force. */
export interface ScoredTask {
    name: string;
    score: number;
}

/**
 * How much better a challenger must be before a member leaves the task it is on.
 *
 * Fraction of the score it has to beat, not an absolute gap, because the score is
 * built from `log10` terms scaled by weights that range from 0.01 to 100 depending
 * on the mode: a fixed gap would be a hair-trigger in MONEY and a dead zone in
 * TERRITORY. Relative to the score in hand, it means the same thing in every mode.
 *
 * Two per cent is chosen to sit just above the noise. The economic tasks for a
 * given member score within a few per cent of each other, and the score is
 * recomputed from live stats every tick, so without a margin the winner is decided
 * by the last digit of a stat and the member swaps back and forth. The cost of the
 * margin is that the gang occasionally works a task that is very slightly worse;
 * the cost of not having it is that every member re-decides every tick.
 */
export const TASK_STABILITY_MARGIN = 0.02;

/**
 * The task a member should work, holding the one it has unless a challenger is
 * clearly better.
 *
 * The plain argmax this replaces re-answered the question from scratch every tick
 * with no memory of the answer it gave last time, so a member whose two best tasks
 * were within a rounding error of each other swapped between them on every update.
 * That is the flapping: not a wrong choice, but a choice that was never still.
 *
 * `current` is whatever the member is on now, which may be a task this mode would
 * not pick, a special task, or nothing this function was given — the caller passes
 * a name, not a promise that it is a candidate. If it is not among `candidates` the
 * member is moved, because a task that is not on offer cannot be the right one; and
 * if it is, it is kept unless the best of the rest clears it by the margin.
 *
 * Ties among challengers are broken by name so the answer does not depend on the
 * order the caller happened to score them in. Two tasks that score exactly alike
 * would otherwise alternate with the ordering of `getTaskNames`, which is a flap
 * with no decision behind it at all.
 */
export function pickTask(
    candidates: readonly ScoredTask[],
    current: string,
    margin: number = TASK_STABILITY_MARGIN,
): string | null {
    if (candidates.length === 0) return null;

    let best = candidates[0]!;
    for (const c of candidates) {
        if (c.score > best.score || (c.score === best.score && c.name < best.name)) best = c;
    }

    const held = candidates.find(c => c.name === current);
    if (held === undefined) return best.name;

    // Relative margin, floored so a score at or near zero still has a usable band:
    // `|best|` can be 0 when every candidate scored nothing, and a zero band would
    // make the tie-break above the only stability there is.
    const band = Math.max(Math.abs(best.score), Math.abs(held.score), 1) * margin;
    return best.score - held.score <= band ? held.name : best.name;
}

export function chooseGear(
    m: GangMemberInfo,
    gear: readonly EquipmentInfo[],
    cash: number,
    c: GangConfig,
    isHacking: boolean,
    aggressive: boolean,
): string[] {
    if (cash < c.minHomeCash) return [];
    const fraction = aggressive ? c.prepEquipmentBudgetFraction : c.equipmentBudgetFraction;
    const budget = cash * fraction;

    const candidates = gear
        .filter(x => !m.upgrades.includes(x.name) && !m.augmentations.includes(x.name))
        .map(x => {
            const value = isHacking
                ? (x.stats.hack ?? 0) + (x.stats.cha ?? 0) * 0.25
                : (x.stats.str ?? 0) + ((x.stats.def ?? 0) + (x.stats.dex ?? 0) + (x.stats.agi ?? 0)) * 0.5;
            return { name: x.name, cost: x.cost, eff: x.cost > 0 ? value / x.cost : 0 };
        })
        .filter(x => x.cost > 0 && x.eff > 0)
        .sort((a, b) => b.eff - a.eff);

    const out: string[] = [];
    let spent = 0;
    for (const item of candidates) {
        // `continue`, not `break`, and the difference is the whole bug: candidates are
        // sorted by value PER DOLLAR, not by cost, so an item that does not fit tells
        // you nothing about the ones after it. Breaking here skipped every augmentation
        // whenever cheaper gear happened to sort first — and augmentations are always
        // the most expensive things a gang can buy, so in practice they were never
        // reached at all.
        if (spent + item.cost > budget) continue;

        // `break` IS right for this one. `minHomeCash` is a floor on the gang's own
        // funds, so once a purchase would breach it, every later purchase is paid from
        // the same shrunken cash and breaches it too.
        if (cash - item.cost < c.minHomeCash) break;

        out.push(item.name);
        spent += item.cost;
        cash -= item.cost;
    }
    return out;
}

/**
 * The lowest wanted level the game will ever report.
 *
 * `wantedLevel` is clamped to this floor by the game itself: an update that would
 * take it below 1 resets it to exactly 1, and a fresh gang starts there. So this
 * is not a target of ours, it is the bottom of the scale.
 */
export const WANTED_LEVEL_FLOOR = 1;

/**
 * Whether the wanted level needs attention at all.
 *
 * True while the penalty is below target AND the level can still come down, or
 * while the level is climbing. The second half matters: `wantedLevelGainRate > 0`
 * means losing ground, and it is cheaper to hold a rising level than to let the
 * penalty collapse and then stop most of the gang to recover.
 *
 * The first half carries a condition that has nothing to do with the penalty on
 * its face, and omitting it is why the gang used to park members on cleanup
 * forever. `wantedLevel` cannot fall below `WANTED_LEVEL_FLOOR`: the game resets
 * it to 1 whenever an update would take it lower. At that floor, cleanup work
 * cannot achieve anything — the level has nowhere left to go — so no member
 * should ever be sent to do it, however bad the penalty looks.
 *
 * The penalty is not a signal that cleanup is useful. It is
 * `respect / (respect + wantedLevel)`, which for a gang sitting at the floor is
 * `respect / (respect + 1)` — below target whenever respect is under 9, and
 * unaffected by anything cleanup could do. Reading it alone kept a small gang in
 * WANTED mode with a slice of itself on a no-op task for the whole run.
 *
 * The rising case still needs handling at the floor, because the game only skips
 * its update when the level is at the floor AND the gain is non-positive: with a
 * positive rate the level climbs away from 1 again, so a gang sitting at the
 * floor with a rising rate must still respond. That is why the floor test guards
 * the penalty half and not the whole condition.
 *
 * HYSTERESIS, and it is the same fix `decideWarfare` already carries. Without it the
 * penalty crossing `wantedPenaltyTarget` toggles the mode every tick it sits on the
 * boundary: cleanup lifts the penalty just over the target, the gang leaves WANTED, the
 * level climbs back and the penalty drops under it, and the gang re-enters. A member on
 * the respect/money split is dragged with it, and because respect and money want opposite
 * tasks that member slams between Terrorism and Human Trafficking every update.
 *
 * `engaged` says whether the gang is ALREADY cleaning up, which the caller knows from
 * members' current tasks. While engaged the bar is raised, so leaving costs a clear margin
 * rather than a single tick on the line. Entering still uses the plain target, so the gang
 * responds to a falling penalty as promptly as before.
 */
export function wantedNeedsAttention(
    g: Pick<GangGenInfo, "wantedLevel" | "wantedLevelGainRate" | "wantedPenalty">,
    c: GangConfig,
    /** Whether cleanup workers are already assigned, for the hysteresis band. */
    engaged = false,
): boolean {
    const canStillFall = g.wantedLevel > WANTED_LEVEL_FLOOR;
    const penaltyBar = engaged
        ? c.wantedPenaltyTarget + WANTED_RELEASE_MARGIN
        : c.wantedPenaltyTarget;
    return (canStillFall && g.wantedPenalty < penaltyBar) || g.wantedLevelGainRate > 0;
}

/**
 * How far ABOVE the penalty target the gang must climb before it stops cleaning up.
 *
 * The release half of the hysteresis band, matched to the entry bar so the two do not sit on
 * top of each other. Large enough that ordinary tick-to-tick noise in the penalty cannot
 * cross it, small enough that the gang still stops once the level is genuinely healthy.
 */
export const WANTED_RELEASE_MARGIN = 0.05;

/**
 * What the gang knows about its own wanted pressure, as plain numbers.
 *
 * Three quantities rather than a member list, because they are what the decision
 * actually needs and each one has a different source: the rate comes from the game
 * directly, the cleaner count from who is on the task, and the magnitude from the
 * members' stats. Keeping them separate means the size decision can be tested without
 * a gang, and the caller — which owns the `ns` work — decides how each is measured.
 */
export interface WantedPressure {
    /** Net wanted level per cycle, exactly as the game reports it. */
    gainRate: number;
    /** How many members are working the wanted task right now. */
    cleaners: number;
    /** Mean cleanup one cleaner performs, as a POSITIVE magnitude. 0 if none can. */
    cleanupRate: number;
}

/**
 * The wanted level's rise per cycle if nobody were working cleanup.
 *
 * This is the quantity worth matching against, and reconstructing it is the whole
 * trick. `gainRate` is the NET rate, so it already has the current cleaners'
 * negative contribution baked in — read it directly and the answer depends on how
 * many members happen to be cleaning, which is the number being decided. Add the
 * cleaners' contribution back and the result describes the rest of the gang alone:
 * a property of what everyone else is doing, not of the crew size. That is what
 * makes the answer below stable instead of a feedback loop that chases its own tail.
 *
 * Clamped at zero: a gang whose non-cleanup work does not raise the level at all
 * has no rise to match, whatever the arithmetic says.
 */
export function wantedRise(p: WantedPressure): number {
    return Math.max(0, p.gainRate + p.cleaners * p.cleanupRate);
}

/**
 * Mean cleanup per cleaner, as a positive magnitude, from each member's own rate.
 *
 * The mean rather than the best, because the crew is not chosen for cleanup speed:
 * the assignment loop sends whichever members it reaches first, so the gang's actual
 * cleanup is the average of that rabble and not the strongest member repeated. Sizing
 * the crew to the best cleaner would under-staff it every time.
 *
 * The members' rates come in as the raw `wantedGain` for the wanted task — negative,
 * since cleanup removes wanted level — and are taken as magnitudes here so the sign
 * lives in one place. Non-finite and non-negative entries are dropped: a task that
 * adds wanted level is not a cleanup, and including it would corrupt the mean. Zero
 * when nothing usable is left, which the caller reads as "no cleaner can help".
 */
export function averageCleanupRate(rates: readonly number[]): number {
    let sum = 0;
    let count = 0;
    for (const r of rates) {
        if (!Number.isFinite(r) || r >= 0) continue;
        sum += -r;
        count++;
    }
    return count === 0 ? 0 : sum / count;
}

/**
 * How many members should work the wanted level, sized to the rise.
 *
 * This replaces two fixed fractions of the gang (25% and 80%) chosen by which
 * penalty band the gang was in. Those were a proxy for the real question and a bad
 * one: they ignored how fast the level was actually moving, so the same crew was
 * sent whether the level was climbing hard or barely drifting, and a gang whose
 * non-cleanup work barely touched the level still spent a quarter of itself on it.
 *
 * The real question is a rate comparison, and "matches or exceeds the rise" is
 * literally it: enough cleaners that their combined cleanup covers the rise, so the
 * net rate reaches zero and the level stops climbing. One cleaner removes
 * `cleanupRate` per cycle, so the rise is covered by `rise / cleanupRate` of them,
 * rounded up because a fraction of a member is still a member.
 *
 * The bounds are structural rather than strategic. At least one whenever the level
 * needs attention, because rounding a small rise down to no workers would leave the
 * level to climb unattended — the exact case the old fixed tiers were meant to
 * catch and the floor argument in this function's history is about. And never more
 * than the gang, because there is no one else to assign. A gang with no cleaner able
 * to make progress (`cleanupRate` 0) falls back to one member, since the rise cannot
 * be matched at any size and a wasted member is cheaper than an ignored level.
 */
export function wantedWorkersFor(
    g: Pick<GangGenInfo, "wantedLevel" | "wantedLevelGainRate" | "wantedPenalty">,
    p: WantedPressure,
    total: number,
    c: GangConfig,
    /** Already cleaning, so the boundary uses its hysteresis band. See `wantedNeedsAttention`. */
    engaged = false,
): number {
    if (total <= 0 || !wantedNeedsAttention(g, c, engaged)) return 0;

    const rise = wantedRise(p);
    if (p.cleanupRate <= 0) return 1;
    if (rise <= 0) return 0;

    return Math.min(total, Math.max(1, Math.ceil(rise / p.cleanupRate)));
}

/**
 * Whether another member should be put on wanted cleanup.
 *
 * Takes the gang's info and size rather than a bare penalty, because the decision
 * depends on which way the level is moving, not only on how bad it is.
 */
export function wantedWorkerNeeded(
    assigned: number,
    total: number,
    g: Pick<GangGenInfo, "wantedLevel" | "wantedLevelGainRate" | "wantedPenalty">,
    p: WantedPressure,
    c: GangConfig,
    engaged = false,
): boolean {
    return assigned < wantedWorkersFor(g, p, total, c, engaged);
}

/**
 * Whether the gang should keep a member pinned to territory at all.
 *
 * The territory modes only staff territory once the gang has chosen to fight for it,
 * and that choice waits on respect and on a winnable clash. Until then nobody touches
 * territory, and territory only ever grows from members working it — so a gang that
 * has the members to spare keeps one on the map regardless of what the rest are doing.
 *
 * This is the LOCK condition, which is why it takes no mode. The member it pins is
 * held until the gang has full control, and "full control" does not depend on what the
 * mode machine happens to be doing this tick: a pin that released whenever the mode
 * changed would hand the member back and forth, and the whole point of pinning is that
 * territory keeps moving without being re-decided. The mode still decides how the
 * pinned member is COUNTED — as one of the territory workers in the territory modes,
 * and as the lone standing worker otherwise — but not whether the pin exists.
 *
 * `territoryDisableAbove` is the same ceiling `decideWarfare` uses to stop fighting,
 * so "we have the maximum" means one thing in this module rather than two, and the pin
 * releases exactly when there is no more territory worth taking.
 */
export function territoryLockHeld(
    g: Pick<GangGenInfo, "territory">,
    total: number,
    c: GangConfig,
): boolean {
    if (total <= c.territoryStandingMinMembers) return false;
    return g.territory < c.territoryDisableAbove;
}

/**
 * Which member to pin to territory, or null if there is nobody free to pin.
 *
 * The strongest member who is not training, so the pin does the most good, with the
 * same name tie-break the rest of the module uses so an exact power tie does not pick
 * a different member on alternate ticks. Returns null for an empty gang rather than
 * guessing, so the caller keeps no pin and simply tries again next tick.
 *
 * The choice is made ONCE and remembered by the caller, not recomputed each tick: a
 * member re-chosen every tick is a member who changes whenever the roster or the
 * trainer set shifts, which is the flapping the lock exists to remove.
 */
export function chooseStandingTerritoryMember(
    members: readonly GangMemberInfo[],
    isHacking: boolean,
    trainers: ReadonlySet<string>,
): string | null {
    let best: GangMemberInfo | null = null;
    for (const m of members) {
        if (trainers.has(m.name)) continue;
        if (best === null) { best = m; continue; }
        const a = memberPower(m, isHacking);
        const b = memberPower(best, isHacking);
        if (a > b || (a === b && m.name < best.name)) best = m;
    }
    return best === null ? null : best.name;
}

export function economicModeFor(
    mode: GangMode,
    economicAssigned: number,
    nonTrainerTotal: number,
    c: GangConfig,
): GangMode {
    if (mode === "RESPECT" || mode === "WARFARE_PREP") {
        const moneySlots = Math.floor(nonTrainerTotal * c.respectMoneyShare);
        if (economicAssigned >= nonTrainerTotal - moneySlots) return "MONEY";
        return "RESPECT";
    }
    if (mode === "WANTED") return "RESPECT";
    return "MONEY";
}

/**
 * Each member's economic mode, decided ONCE for the tick from the gang's roster.
 *
 * WHY THIS EXISTS, and it is a reported flicker rather than a tidy-up. `economicModeFor`
 * decides a member's mode from a RUNNING COUNT of who has been assigned so far, which makes
 * the answer depend on how many members the wanted and territory branches happened to divert
 * ahead of them THIS TICK. Those branches are staffed from live game state that moves every
 * update — the wanted level rises and falls, the territory fight gains and loses members — so
 * the count shifts, and a member sitting on the respect/money boundary flips between the two
 * from one tick to the next.
 *
 * The symptom is specific and loud. Respect and money want OPPOSITE tasks: Terrorism earns no
 * money and 0.01 respect, Human Trafficking earns 360 money and 0.004 respect, and `scoreTask`
 * weights the two so heavily (100x against 0.01x) that each is the runaway winner of its own
 * mode. So a member flipping mode does not drift to a slightly different task, it slams
 * between Terrorism and Human Trafficking on every update — the reported flicker.
 *
 * The fix is to stop deciding from a running count. The division is "a share of the gang
 * works money while the rest work respect", which is a fact about the ROSTER, so it is
 * computed from the roster: the non-trainers in the order they will be assigned, the last
 * `respectMoneyShare` of them on money. Every member's mode is then a property of the gang
 * rather than of the assignment order, so diverting one member to cleanup no longer moves
 * anyone else's mode.
 *
 * The modes that do not split still get an entry, so a caller can look every member up
 * without a fallback.
 */
export function economicModeByMember(
    mode: GangMode,
    /** The non-trainers, in the order they will be assigned. */
    nonTrainers: readonly { readonly name: string }[],
    c: GangConfig,
): Map<string, GangMode> {
    const byMember = new Map<string, GangMode>();

    // A mode with no respect/money split takes everyone the same way.
    if (mode !== "RESPECT" && mode !== "WARFARE_PREP") {
        const uniform = economicModeFor(mode, 0, nonTrainers.length, c);
        for (const m of nonTrainers) byMember.set(m.name, uniform);
        return byMember;
    }

    // The WEAKEST `moneySlots` work money, keeping the existing division: strongest first,
    // so the tail of the list is the money end.
    const moneySlots = Math.floor(nonTrainers.length * c.respectMoneyShare);
    const respectCount = nonTrainers.length - moneySlots;
    nonTrainers.forEach((m, i) => {
        byMember.set(m.name, i < respectCount ? "RESPECT" : "MONEY");
    });
    return byMember;
}

/* ============================================================
 * WARFARE DECISION
 * ============================================================ */

export interface WarfareDecision {
    action: "ENGAGE" | "DISENGAGE" | "HOLD";
    reason: string;
}

export function decideWarfare(
    g: GangGenInfo,
    isHacking: boolean,
    c: GangConfig,
    enemies: EnemyScan,
    /** The player net worth, matching `decideMode`'s parameter so the two cannot disagree. */
    netWorth = Infinity,
): WarfareDecision {
    if (isHacking) {
        return {
            action: g.territoryWarfareEngaged ? "DISENGAGE" : "HOLD",
            reason: "hacking",
        };
    }

    // Below the money floor the gang does not fight, and the reason says so rather than
    // reusing "respect-phase". These two decisions MUST agree: `decideMode` returns
    // MONEY below the floor, and a warfare decision that still said ENGAGE would have
    // the gang earning in the mode machine while its members were sent to take
    // territory — the exact disagreement this module already documents once.
    //
    // A WINNABLE WAR is the exception, and it is the same exception `decideMode` makes:
    // territory permanently raises the gang's income, so a fight the gang would win is
    // worth taking while poor. Both sides ask `winnableWar`, so the agreement above is
    // preserved rather than merely restated.
    // The same override as `decideMode`: while the gang is still growing, the floor does
    // not stop it fighting. The two decisions must agree, which is why both read the flag
    // rather than one deriving the exception for itself.
    if (!c.recruitingPhase && netWorth < c.moneyFloor && !winnableWar(g, c, enemies)) {
        return g.territoryWarfareEngaged
            ? { action: "DISENGAGE", reason: "below-money-floor" }
            : { action: "HOLD", reason: "below-money-floor" };
    }

    // Same exception as the money floor above: a winnable war outranks the respect
    // phase, because taking ground is what makes the respect worth having — a gang
    // earning respect on a fraction of the map is growing a smaller number.
    if (g.respect < c.respectPhaseEnd && !winnableWar(g, c, enemies)) {
        return g.territoryWarfareEngaged
            ? { action: "DISENGAGE", reason: "respect-phase" }
            : { action: "HOLD", reason: "respect-phase" };
    }

    // Hysteresis: start fighting at the required clash chance, stop only once it
    // has fallen well below, so the gang does not toggle warfare every tick.
    //
    // A RATIO of the engage bar rather than a figure of its own, so retuning the bar
    // cannot leave the disengage chance above it — which would make the gang drop out
    // of a war it had just decided to start, every tick. At the current 0.90 this puts
    // the exit at about 0.63.
    const disengageChance = c.territoryMinClashChance * 0.7;

    if (!g.territoryWarfareEngaged) {
        if (g.territory >= c.territoryDisableAbove) return { action: "HOLD", reason: "territory-maxed" };
        if (enemies.enemyCount === 0) return { action: "HOLD", reason: "no-enemies" };
        if (enemies.lowestClashChance >= c.territoryMinClashChance) {
            return { action: "ENGAGE", reason: "ready" };
        }
        return { action: "HOLD", reason: "too-weak" };
    }

    if (g.territory >= c.territoryDisableAbove) return { action: "DISENGAGE", reason: "territory-maxed" };
    if (enemies.enemyCount === 0) return { action: "DISENGAGE", reason: "no-enemies" };
    if (enemies.lowestClashChance < disengageChance) return { action: "DISENGAGE", reason: "losing" };
    return { action: "HOLD", reason: "engaged" };
}

/**
 * How many members `WARFARE_PREP` keeps back for economic work.
 *
 * Prep's two shares are a budget and the members they leave are the only ones earning, so
 * this is the floor that makes "leaving somebody earning" true by construction rather than
 * by arithmetic that happens to work out. It exists because the arithmetic did not: see
 * `computeTrainerCap` for the twelve-member gang where the territory target and the trainer
 * cap met exactly and left nobody at all.
 *
 * One member, not a fraction. A fraction of a twenty-member gang would be five members the
 * power build did not get, and prep is a mode whose purpose is to end quickly — so it should
 * spend nearly everything on ending itself, with earning as the guaranteed remainder rather
 * than a share.
 */
export const PREP_EARNERS_RESERVED = 1;

export function computeTrainerCap(
    memberCount: number,
    mode: GangMode,
    c: GangConfig,
    prepWarfareTarget: number,
): number {
    if (mode === "WARFARE_PREP") {
        // Prep trains harder than any other mode, and this is the ONLY place that is
        // expressed: the cap is larger than `trainMaxFraction` allows, and the trainers it
        // admits still obey the ordinary training targets.
        //
        // The cap is then clamped so the mode cannot consume the whole gang. That clamp is
        // the whole subtlety, and getting it wrong twice is why it is spelled out here.
        //
        // `prepTrainerFraction` and `prepWarfareFraction` are a BUDGET, and the members
        // neither takes are the only ones earning. Reserving `memberCount -
        // prepWarfareTarget` covers the territory half of that and nothing else, and that
        // alone is not sufficient even though the two fractions sum to under 1: the
        // territory target is a FLOOR and the trainer cap a CEILING, so on some gang sizes
        // they meet. With the fractions at 0.60 and 0.45 they did so at twelve members —
        // `floor(12 * 0.60)` is 7 and `ceil(12 * 0.45)` is 6, one more than the roster had
        // left — and the gang prepared to fight with no income at all.
        //
        // So prep reserves one member for economic work outright, in addition to the
        // territory reservation. One is enough: it is the difference between a gang that
        // earns while it prepares and one that does not, and prep is a short-lived mode that
        // should be spending nearly everything on ending itself.
        const fractionCap = Math.ceil(memberCount * c.prepTrainerFraction);
        const reservedCap = memberCount - prepWarfareTarget - PREP_EARNERS_RESERVED;
        return Math.max(0, Math.min(fractionCap, reservedCap));
    }
    return Math.max(0, Math.ceil(memberCount * c.trainMaxFraction));
}
