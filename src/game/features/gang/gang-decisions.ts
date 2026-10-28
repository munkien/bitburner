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
    //
    // AND AN UNREACHABLE FLOOR IS NOT A FLOOR. See `floorIsReachable`: a gang pinned to money
    // for a figure thirteen thousand times its net worth never earns its way out, so the rule
    // that was meant to trade respect for income trades it for nothing, permanently.
    if (!c.recruitingPhase && floorIsReachable(c.moneyFloor, netWorth) && netWorth < c.moneyFloor * MONEY_PANIC_FRACTION) {
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
    if (!c.recruitingPhase && floorIsReachable(c.moneyFloor, netWorth) && netWorth < c.moneyFloor) {
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
 * How long a cleanup crew keeps its members after the level stops needing them.
 *
 * THE SIZE PROBLEM, in milliseconds. A crew is assigned on one game tick and released on the
 * next, so a crew that works is on for one tick in two — the smallest possible duty cycle —
 * and releasing, however well justified, is immediately followed by re-sending. Measured in
 * `runs/2026-10-28T05.21.21`, deduplicated to real game ticks, for the whole session:
 *
 *   417  cleaners=11  rate=-0.50    crew on, level falling  -> release is CORRECT
 *   560  cleaners=0   rate=+0.51    crew off, level climbs  -> re-send is CORRECT
 *   429  cleaners=11  rate=-0.50
 *   558  cleaners=0   rate=+0.51
 *
 * Every individual decision there is right; the sequence is not. What is missing is a
 * commitment that outlasts one tick, so a crew is kept long enough to be worth the switch in
 * both directions. The level falls about 1.5 per tick with eleven members on it, and climbs
 * back about 0.52 per tick with nobody on it, so a crew held for a few ticks gets the level
 * down and a crew stood down for a few ticks lets it stay down. Without a hold the crew simply
 * pays for its own churn in lost economic work and never nets a fall.
 *
 * THE SAME SHAPE AS `trainingWantedHeld`, for the same reason: a decision whose input the
 * decision itself changes flickers unless the answer is latched for longer than the input's
 * period. Longer than the ~2 s game tick by a wide margin, and short enough that a real
 * reduction of the level is still noticed promptly.
 */
export const WANTED_HOLD_MS = 60_000;

/**
 * Whether the money floor is close enough to be worth trading respect for.
 *
 * A FLOOR YOU CANNOT REACH IS NOT A FLOOR, it is a permanent instruction. The money checks
 * below return MONEY whenever net worth is under `moneyFloor`, on the reasoning that respect
 * is worth less than income at that point. That reasoning holds while the gap is one the gang
 * can close; it does not hold when the gap is three or four orders of magnitude, because the
 * gang then spends the rest of the run working for money it will never have and never returns
 * to the respect phase at all.
 *
 * MEASURED. `runs/2026-10-28T08.14.44` ran a 12-member gang at its size cap with a peak net
 * worth of 7.7e6 against a 1e11 floor — thirteen thousand times short — and the mode log holds
 * exactly one line for the whole session: `MONEY:below-money-floor`. In MONEY the score is
 * `100*log10(money)`, so a task earning no money scores about zero however much respect it
 * brings; TERRORISM earns no money and carries the highest baseRespect of any combat task, and
 * the run never selected it once. The floor did not make the gang richer, it deleted a task.
 *
 * THE BAND IS DELIBERATELY GENEROUS. This is not a tuning knob: it says "the goal is absurd for
 * this gang", not "the goal is a bit far". A gang within `MONEY_FLOOR_REACH` of its floor still
 * earns, so the rule still does its job in every ordinary case — including the one pinned by
 * `recruiting-phase.test.ts` ("a grown gang does enter money mode when poor").
 */
export function floorIsReachable(moneyFloor: number, netWorth: number): boolean {
    if (!Number.isFinite(moneyFloor)) return true;
    if (!(moneyFloor > 0)) return true;
    return netWorth * MONEY_FLOOR_REACH >= moneyFloor;
}

/**
 * How far below the money floor still counts as a reachable target.
 *
 * 100 means a gang must be within two orders of magnitude of its floor to be told to earn.
 * Beyond that the floor is a number nobody chose for this gang — it is the run's wealth goal
 * applied to a gang whose own income cannot approach it — and obeying it costs every productive
 * task that earns no money.
 */
export const MONEY_FLOOR_REACH = 100;

/**
 * How many consecutive readings at the floor it takes to end a commitment.
 *
 * TWO, not one and not a timer. One reading can be the bounce — the recorded loop is
 * 3 -> 1 -> 6 -> 3, and the same game tick is read twice — so a single frame must not release
 * a crew. Two consecutive readings at a level the game clamps means the crew is achieving
 * nothing, and a fixed-duration commitment that ignores it keeps the whole gang on a no-op.
 * Replayed over `runs/2026-10-28T05.44.43`, ignoring it cost 1631 frames of cleanup at a level
 * of 1.
 */
export const FLOOR_RELEASE_READINGS = 2;

/**
 * What the wanted level has been doing over the last few minutes.
 *
 * THE QUESTION THE FLOOR SHOULD HAVE BEEN ASKING. Every rule this replaced asked about a
 * single reading — is the rate positive, did the level fall, has the commitment expired — and
 * all of them are satisfied by a level that oscillates while going nowhere. `runs/2026-10-28T08.14.44`
 * is exactly that: 11 of 12 members on cleanup for 83% of frames, holding a level whose
 * rolling mean is 3.83 -> 3.81 -> 3.80 across the run. Flat to two decimal places.
 *
 * A crew is worth its cost only if the level is actually drifting up. Holding a level where it
 * already is means the crew has succeeded and should be released — the members earn more
 * somewhere else, and the level does not care.
 *
 *   rising   the level over the window is meaningfully above where it started
 *   stable   it has not moved much either way — the crew is doing its job, or need not exist
 *   falling  it is meaningfully below where it started
 *
 * `stable` and `falling` are treated the same by the caller: neither needs a crew.
 */
export type WantedTrend = "rising" | "stable" | "falling";

/**
 * How far the level must drift across the window to count as rising rather than stable.
 *
 * A FRACTION rather than absolute points, because the noise and the level scale together — the
 * recorded swings are ~5.9 points on a level of ~6, and a fixed band would mean opposite things
 * on a gang at 6 and a gang at 600. 25% over the window is well outside the recorded noise,
 * which nets to zero across a window even though it swings hugely within one.
 */
export const WANTED_TREND_MARGIN = 0.25;

/**
 * Classify a series of wanted-level readings, oldest first.
 *
 * COMPARES THE WINDOW'S OWN START AND END rather than fitting a line. A line through a
 * square wave fits zero slope, which is the right answer here and would be reached by both
 * methods; the endpoint comparison is chosen because it is the one a reader can check against
 * the numbers, and because a regression through a bouncing series invites reading precision
 * into the bounce that is not there.
 *
 * The END is the mean of the last few readings, not the single last one, so one reading on the
 * wrong side of the bounce cannot decide the trend — the same lesson as `FLOOR_RELEASE_READINGS`
 * and the commitment before it, applied to the measurement rather than the decision.
 *
 * Fewer than `minSamples` readings returns `stable`: with no history there is no evidence of a
 * rise, and the caller spends members only on evidence.
 */
export function wantedTrend(
    readings: readonly number[],
    margin: number = WANTED_TREND_MARGIN,
    minSamples = 4,
): WantedTrend {
    const usable = readings.filter(r => Number.isFinite(r));
    if (usable.length < minSamples) return "stable";

    // The first and last few, averaged, so the endpoints are not single samples.
    const edge = Math.max(1, Math.floor(usable.length / 4));
    const start = usable.slice(0, edge).reduce((a, b) => a + b, 0) / edge;
    const end = usable.slice(-edge).reduce((a, b) => a + b, 0) / edge;

    // Scale the margin by the level itself, floored at 1 so a gang sitting at the game's
    // bottom cannot produce a band so small that rounding decides the answer.
    const band = Math.max(1, Math.abs(start)) * margin;

    if (end - start > band) return "rising";
    if (start - end > band) return "falling";
    return "stable";
}

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
    /**
     * What the BEST available cleaner removes per cycle, as a positive magnitude.
     *
     * The mean answers "what does the crew currently achieve"; this answers "what does one
     * MORE member buy", which is the question a crew size is derived from. Zero when nobody
     * can clean.
     */
    readonly bestCleanupRate: number;
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
 * What the single best cleaner in the roster removes per cycle, as a magnitude.
 *
 * The counterpart to `averageCleanupRate`, and the two are not interchangeable. The mean
 * describes a crew that has already been chosen; the maximum describes what choosing one
 * more member achieves, which is what sizing a crew is about. Using the mean for the second
 * question understates every member by the size of the gang — nine members with one strong
 * cleaner report one ninth of that cleaner's rate — and a crew sized from it asks for more
 * members than the gang has.
 */
export function bestCleanupRate(rates: readonly number[]): number {
    let best = 0;
    for (const r of rates) {
        if (!Number.isFinite(r) || r >= 0) continue;
        if (-r > best) best = -r;
    }
    return best;
}

/**
 * How many members it takes to HOLD the wanted level, in any mode.
 *
 * `risePerCleaner` is the BEST member's rate, not the mean. The mean over the whole gang is
 * what the pressure line reports, and sizing from it is wrong in a way that hides itself: a
 * gang of nine whose one capable cleaner removes 1.5 per cycle reports 0.17, so holding a
 * rise of 3 appears to need 18 members — more than the gang has — and the level climbs with
 * every member on cleanup. The question "what does one more cleaner buy" is answered by the
 * member that would actually be sent, not by an average that includes members who would not.
 *
 * Zero is returned only when there is no rise to hold. A zero RATE is not zero members: a
 * gang that cannot clean still sends one, because sending nobody is an explicit decision to
 * let the level climb while looking like a considered one.
 */
/**
 * How many members the wanted floor requires, given whether it was already holding.
 *
 * WHY THIS IS A LATCH AND NOT AN ARITHMETIC ANSWER. `wantedRise` adds the current cleaners
 * back to the net rate, so the figure a crew is sized from MOVES WHEN THE CREW IS ASSIGNED.
 * Asking the question fresh every tick therefore chases its own tail:
 *
 *   one cleaner working   net -1.5 from a +1 rise -> rise reads 0 -> floor releases them
 *   nobody working        net +1.0               -> rise reads 1 -> floor re-sends them
 *
 * One member, alternating between Vigilante Justice and their economic task every game tick.
 * That is the reported flicker, and it was introduced by making cleanup a floor rather than a
 * mode: a mode was stable because it was decided from the penalty, which cleanup does not move
 * within a tick.
 *
 * So the requirement LATCHES. Once engaged it stays engaged until the level has actually come
 * down — the only evidence cleanup worked, and the one thing no assignment can fake. The same
 * shape as `trainingWantedHeld`, for the same reason: a handover driven by an input that the
 * handover changes is a handover driven by noise.
 *
 * At the floor there is no requirement at all, whatever the rate says: the game clamps the
 * level at 1, so a member sent to clean up there achieves nothing.
 */
export function holdRequirement(
    p: {
        /** The gang's wanted level, exactly as the game reports it. */
        readonly level: number;
        /** The NET rate, cleaners included. */
        readonly netRate: number;
        readonly cleaners: number;
        readonly bestRate: number;
    },
    /**
     * The level the floor engaged at, or null when it is not holding.
     *
     * The level itself rather than a bare boolean, because releasing needs a comparison and
     * there is nothing else to compare against. `engaged` alone cannot tell "still climbing"
     * from "coming down": both have a positive rate whenever a cleaner is holding the line.
     */
    engagedAt: number | null,
    /**
     * When the crew is committed until, in ms, or 0 when it is not.
     *
     * THE COMMITMENT HALF. Releasing correctly is not enough: a crew assigned on one game tick
     * and released on the next is on for one tick in two, and the re-send follows immediately
     * however right each individual decision was. See `WANTED_HOLD_MS`.
     */
    holdUntil = 0,
    /** The current time in ms. A parameter so this stays pure and testable. */
    now = 0,
    /**
     * The crew size latched when the crew was engaged, or 0 when it is not.
     *
     * Carried separately from `p.cleaners`, which is re-read every tick and follows whoever
     * happens to be on the task. A commitment to a size has to be to a NUMBER, or it changes
     * with the reading it was meant to stabilize.
     */
    committedCrew = 0,
    /**
     * How many CONSECUTIVE readings the level has been at or below the floor, 0 when it is not.
     *
     * The floor needs a voice that survives one bad frame but not two. One reading can be
     * noise — the same game tick is read twice, and the level genuinely bounces — so a single
     * frame at the floor must not tear a commitment down (that is the regression this function
     * already went through once). Two consecutive readings at the bottom of the scale is not
     * noise, it is the situation, and a crew there achieves nothing.
     *
     * Without this the commitment kept the gang on cleanup for its whole span: replayed over
     * `runs/2026-10-28T05.44.43`, cleaning went from 49% of frames to 93% with 1631 of them at
     * a level of 1. A blind timer resolves "don't react to one frame" against "stop when there
     * is nothing to do" the wrong way.
     */
    atFloorReadings = 0,
    /**
     * What the level has been doing over the last few minutes. See `wantedTrend`.
     *
     * `undefined` means "not measured", which keeps the previous behaviour rather than silently
     * switching cleanup off for a caller that has no history.
     */
    trend?: WantedTrend,
): number {
    // NOTHING TO DEFEND: the long-term level is not climbing.
    //
    // AHEAD OF every single-reading test, because all of those are satisfied by a level that
    // oscillates while going nowhere. This is the operator's rule stated plainly — keep the
    // long-term level stable or falling, rather than actively cleaning up — and it is the one
    // question that would have caught `runs/2026-10-28T08.14.44`, where 11 of 12 members held a
    // level whose rolling mean was flat to two decimal places (3.83 -> 3.81 -> 3.80).
    //
    // BUT NOT AHEAD OF THE COMMITMENT, and getting that wrong is this rule's own version of the
    // bug it was written to fix. The trend is a WINDOW measurement, but a short window over a
    // bouncing series still flips: replaying the recorded ticks 3 -> 1 -> 6 -> 3 through the
    // module, the trend went stable, rising, stable, rising on consecutive readings, and each
    // `stable` returned 0 — which the caller reads as "release" and acts on by clearing the
    // latch. A commitment with seventy seconds left was destroyed every third reading.
    //
    // So the commitment outranks the trend, exactly as it outranks the single reading. Once a
    // crew is out it stays out for its span; the trend decides whether to ENGAGE, and what to
    // do when the span expires. That is the whole point of a commitment: it is not a promise
    // that the readings will keep agreeing, it is a promise that this module will stop
    // re-deciding.

    // THE ORDER OF THESE THREE IS THE DESIGN, so it is stated once.
    //
    //   1. the floor streak   the only thing that cuts a commitment short — the crew is at a
    //                         level the game clamps and cannot achieve anything
    //   2. the commitment     holds the size it latched, whatever the readings now say
    //   3. the trend          decides whether to engage, and what to do once the span expires
    //
    // Each of the three has, at some point this session, been placed above the one it now sits
    // below, and each misplacement produced a flicker with a different period: a single frame at
    // the floor tore the latch down (two-second flip), and a short trend window doing the same
    // produced a ten-second one. The rule they share: nothing that can be moved by one reading
    // may release a crew, and only the floor — which is a fact about the game's clamp rather
    // than a trend — may cut one short.

    // 1. At the floor long enough that it is the situation and not the bounce.
    if (atFloorReadings >= FLOOR_RELEASE_READINGS) return 0;

    // 2. Committed: keep the SIZE, not just the decision. Returning `cleaners` here still tracks
    // the reading every tick, and the crew churns 12 -> 11 -> 1 -> 11 because of it.
    if (holdUntil > now) return Math.max(1, committedCrew > 0 ? committedCrew : p.cleaners);

    // 3. Nothing to defend: the long-term level is not climbing.
    if (trend === "stable" || trend === "falling") return 0;

    // At the floor there is nothing to achieve: the game clamps the level, so a member sent to
    // clean up here changes nothing whatever the rate says.
    if (!(p.level > WANTED_LEVEL_FLOOR)) return 0;

    // Not engaged: engage on a genuine rise, sized from what the rest of the gang adds.
    if (engagedAt === null) {
        const rise = Math.max(0, p.netRate + p.cleaners * p.bestRate);
        if (!(rise > 0)) return 0;
        if (!(p.bestRate > 0)) return 1;
        return Math.max(1, Math.ceil(rise / p.bestRate));
    }

    // Engaged, commitment expired: release only on evidence the level is genuinely coming down.
    //
    // "The level is lower than when we engaged" was the first rule, and `runs/2026-10-28T05.21.21`
    // shows what it does: 417 -> 560 -> 429 -> 558, a hundred-point swing as the crew arrived
    // and left. Every release was justified by the level being below where it engaged, which
    // the ASSIGNMENT caused rather than the outcome. The body was measuring the thing it
    // changed.
    //
    // Neither signal is enough alone. `netRate` is measured WITH the crew in place, so a
    // negative rate is equally consistent with "the crew is winning" and "the crew is holding a
    // rise back", and releasing on it alone stands down a crew that is doing its job. A level
    // below the engagement point is equally consistent with real progress and with one tick of
    // noise.
    //
    // Both together is the evidence: the level has come down from where the crew engaged AND it
    // is still falling with them on it. That is cleanup having worked rather than cleanup
    // having happened.
    if (p.level < engagedAt && p.netRate < 0) return 0;
    return Math.max(1, p.cleaners);
}

export function wantedHoldWorkers(risePerCycle: number, risePerCleaner: number, total: number): number {
    if (total <= 0) return 0;
    if (!(risePerCycle > 0)) return 0;
    if (!(risePerCleaner > 0)) return 1;
    return Math.min(total, Math.max(1, Math.ceil(risePerCycle / risePerCleaner)));
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
 * DELETED, and this note is the reason it stays deleted. It was
 * `assigned < wantedWorkersFor(...)` — six parameters, no behaviour of its own. A caller
 * that wants to know whether another member is needed writes the comparison, and learns
 * what it is actually asking. Keeping a name for an operator is what makes an interface
 * look deeper than the implementation behind it.
 *
 * The `Pick<GangGenInfo, ...>` it took was also narrower than its job: it accepted only
 * three fields of the gang, which reads as a promise that those are all that matter.
 */

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
    /**
     * Members the wanted floor needs. Deducted from the budget, because a trainer is never
     * re-assigned during the loop — so a cap sized without this can fill every slot and leave
     * the crew that holds the wanted level with nobody to send. See `wantedHoldWorkers`.
     */
    wantedHoldCrew = 0,
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
        const reservedCap = memberCount - prepWarfareTarget - PREP_EARNERS_RESERVED - wantedHoldCrew;
        return Math.max(0, Math.min(fractionCap, reservedCap));
    }
    // The ordinary cap reserves the wanted floor the same way, for the same reason: the
    // members holding the level are not available to train, so counting them as trainers
    // would over-subscribe the roster.
    const fractionCap = Math.ceil(memberCount * c.trainMaxFraction);
    return Math.max(0, Math.min(fractionCap, memberCount - wantedHoldCrew));
}
