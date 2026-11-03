import type { CompanyName, FactionName, Player } from "@ns";

/*
 * ============================================================================
 * OBJECTIVE
 * ============================================================================
 * What the run is currently trying to achieve, and the sub-goals that get there.
 *
 * Why this exists. Progress thresholds were declared feature by feature, and had
 * already drifted: player.ts trained combat stats to 100, sleeves.ts stopped at
 * 75, and activity.ts used 100 again to decide whether Bladeburner yields the
 * activity slot. The sleeve figure was the wrong one — sleeve experience is shared
 * with the player, so a sleeve that stops at 75 stops contributing to a target the
 * progression feature still wants.
 *
 * The model, in one sentence: the run has ONE goal, the achievement it is closest
 * to, and that goal decomposes into sub-goals a feature can check and advance.
 *
 *   Goal
 *   ├─ goal      the achievement: join a faction, buy an augmentation
 *   └─ subGoals  the requirements that close it, each with current and target
 *
 * Goals are DERIVED from player state rather than configured. A declared target
 * that drifts from the game's actual requirement is the bug this module exists to
 * prevent, so nothing here is a constant a player could set wrong.
 *
 * A sub-goal carries no opinion about who should advance it. Features declare
 * which kinds they can move — sleeves can raise combat stats, charisma and faction
 * reputation; the hacking feature raises money — and score their options against
 * the sub-goals that match. That keeps the goal a statement of fact and the
 * decision in the feature that has to make it.
 * ============================================================================
 */

/**
 * A requirement the game places on the player, as a faction sees it.
 *
 * `karma` is the odd one: it is negative and a ceiling rather than a floor, so
 * "met" means at or below.
 */
export interface GoalRequirement {
    readonly hacking?: number;
    readonly combat?: number;
    readonly cha?: number;
    readonly money?: number;
    readonly kills?: number;
    /** Negative. The player's karma must be at or below this. */
    readonly karma?: number;
    /**
     * A company the player must be EMPLOYED BY, for the megacorp factions.
     *
     * A megacorp faction is not joined by satisfying a stat threshold — the game's own
     * `getFactionInviteRequirements` reports an `employedBy` condition on the company of
     * the same name. So this requirement cannot be expressed as a number, which is why it
     * is the one requirement here that is not a threshold.
     *
     * HOW A FEATURE MOVES IT. Getting hired, which is a different action from training:
     * `applyToCompany` followed by `workForCompany`. That is the change this field exists
     * to make possible — before it, `bestCompany` sat at the end of the progression chain
     * and was never reached, because the training branch above it always had something to
     * do first. The circularity is gone once the goal is "be employed", because the
     * training branch cannot satisfy it and therefore cannot pre-empt it.
     */
    readonly employedBy?: CompanyName;
}

/**
 * Faction requirements, keyed by faction.
 *
 * Duplicated from `player.ts` deliberately, and checked by a test: the alternative
 * is importing the progression feature, which ADR 0001 forbids because a static
 * import between features charges the imported feature's RAM to both.
 */
export const FACTION_REQUIREMENTS: Readonly<Partial<Record<FactionName, GoalRequirement>>> = {
    "Sector-12": { money: 1_000_000 },
    Aevum: { money: 40_000_000 },
    Volhaven: { hacking: 50, money: 50_000_000 },
    Chongqing: { hacking: 100, money: 20_000_000 },
    "New Tokyo": { hacking: 100, money: 30_000_000 },
    Ishima: { hacking: 100, money: 30_000_000 },

    CyberSec: { hacking: 50 },
    NiteSec: { hacking: 200 },
    "The Black Hand": { hacking: 300, combat: 150 },
    BitRunners: { hacking: 500 },
    Daedalus: { hacking: 2500, combat: 1500 },
    "Tian Di Hui": { hacking: 50, money: 1_000_000 },
    Netburners: { hacking: 80 },
    "Slum Snakes": { combat: 30, karma: -9 },
    Tetrads: { combat: 75, kills: 75, karma: -18 },
    Silhouette: { combat: 100, cha: 100, money: 15_000_000, karma: -22 },
    "Speakers for the Dead": { hacking: 100, combat: 100, kills: 100, karma: -45 },
    "The Dark Army": { hacking: 300, combat: 300, kills: 300, karma: -45 },
    "The Syndicate": { hacking: 200, combat: 200, kills: 200, karma: -90 },
};

/**
 * The megacorp factions, which are gated on EMPLOYMENT rather than on a stat.
 *
 * These were absent, and that absence was the bug behind "megacorps are never worked
 * for". The chain was circular: `bestCompany` sat at the end of the progression order,
 * and the training branch above it always had a target first — because that branch
 * derives its targets FROM THIS TABLE, and this table listed no megacorp. So the run
 * trained hacking toward megacorp entry requirements forever without ever applying for a
 * job, which is the one action that would have satisfied them.
 *
 * Listing them here breaks the circle. `employedBy` is not satisfiable by training, so
 * the training branch cannot pre-empt it, and a feature that can hire is the one that
 * moves it.
 *
 * THE `hacking` FIGURE is the entry requirement of the company's software position, which
 * is what `entryHackingReq` reads from the game. It is duplicated here for the same
 * ADR-0001 reason as the rest of the table, and a test keeps the two in step.
 */
export const MEGACORP_REQUIREMENTS: Readonly<Partial<Record<FactionName, GoalRequirement>>> = {
    ECorp: { employedBy: "ECorp" },
    MegaCorp: { employedBy: "MegaCorp" },
    "KuaiGong International": { employedBy: "KuaiGong International" },
    "Four Sigma": { employedBy: "Four Sigma" },
    NWO: { employedBy: "NWO" },
    "Blade Industries": { employedBy: "Blade Industries" },
    "OmniTek Incorporated": { employedBy: "OmniTek Incorporated" },
    "Bachman & Associates": { employedBy: "Bachman & Associates" },
    "Clarke Incorporated": { employedBy: "Clarke Incorporated" },
};

/**
 * Targets the run declares rather than derives, in one place.
 *
 * WHY THESE ARE DECLARED, when every other target in this module is derived from the
 * game. A faction requirement is a fact about the game: the game says Sector-12 wants a
 * million, and the module reads it. These are not facts about the game, they are
 * statements about what this run is trying to do: how much karma to farm, how rich to
 * get. The game has no opinion, so there is nothing to derive from and pretending
 * otherwise would be inventing a number and calling it a requirement.
 *
 * Collected here rather than left in the features that used them, which is where they
 * drifted. `karma` was `-54_000` in `player.ts` (as `KARMA_FALLBACK`) and `-54_000`
 * again in `sleeves.ts` (as `KARMA_TARGET`) — two copies of the same intent, which is
 * the exact drift this module exists to remove, surviving because neither feature read
 * the other. `netWorth` was `WEALTH_TARGET = 100e9` in `hacknet.ts`.
 *
 * A declared target is still a bug when it disagrees with the game, so these are checked
 * against the features that consume them by test. What is checked is that a feature reads
 * the shared figure rather than keeping its own copy — the values themselves are chosen,
 * and choosing differently is a change here, in one place.
 */
export const GOAL_TARGETS = {
    /**
     * Karma to farm toward, negative because karma is a ceiling.
     *
     * Deeper than any single faction requirement, because the point of farming it is to
     * clear the whole late-game set (down to -90) rather than one gate at a time.
     */
    karma: -54_000,
    /**
     * Wealth the run wants on hand before money stops being the point.
     *
     * The same figure hacknet already used to decide when hashes are worth spending on
     * anything but money.
     */
    netWorth: 100_000_000_000,
} as const;

/**
 * A framework goal: one of the run's own ambitions, with its target stated.
 *
 * Unlike a faction goal there is no requirement table to read, so the spec says both what
 * to measure and what to measure it against. Everything else — building the goal,
 * deciding whether it is already met, sorting it — is the builder's, so a new ambition is
 * one entry here and cannot skip a rule.
 */
export interface FrameworkGoalSpec {
    readonly key: SubGoalKey;
    /** The line the dashboard shows. */
    readonly goal: string;
    /**
     * The `faction` field is a `FactionName`, and a framework goal is not a faction. Each
     * spec names the faction most associated with its ambition rather than a shared
     * sentinel the type would not accept.
     */
    readonly faction: FactionName;
    /** The target, from the standing where it can be derived and from `GOAL_TARGETS` otherwise. */
    readonly target: (standing: PlayerStanding) => number;
    /**
     * Whether this goal applies at all. A goal whose measure the player cannot move — gang
     * respect with no gang — must not exist, or it becomes a goal to raise a number
     * nothing can raise. "Already met" is a separate question, decided by the builder.
     */
    readonly applies: (standing: PlayerStanding) => boolean;
}

/**
 * A measurement a feature can act on.
 *
 * `combat` is the LOWEST of the four combat skills, because a requirement applies
 * to all of them: strength 500 with agility 5 does not satisfy a combat 100 gate.
 *
 * `money` and `netWorth` are two different measures, not a duplicate. `money` is the
 * player's cash, which is what a faction requirement asking for money is about. `netWorth`
 * is cash plus what is held in the market, and it is the figure features that gate on
 * wealth actually read (see lib/net-worth.ts). A player with 1b in hand and 4b in a
 * position is worth 5b and has 1b; a goal measured on the wrong one disagrees with the
 * feature acting on it.
 *
 * The rest are the framework's own goals rather than faction requirements — the same KIND
 * of thing as the cash floors the factions ask for, which is why they are here rather than
 * in a second, parallel notion of "what the run wants" (see `frameworkGoals`):
 *
 *   stockAccess    owning the WSE account, the TIX API and the 4S Market Data TIX API
 *   gangRespect    a gang's respect, which gates its size
 *   gangTerritory  a gang's share of the map
 *   rep            a faction's reputation, which gates the augmentations it sells
 *
 * `rep` is the one PER-FACTION key. Reputation is not a single number: the player holds a
 * separate standing with each faction, and the requirement differs per faction and per
 * augmentation. So a rep sub-goal carries its faction in the goal's `faction` field
 * and its own `current`/`target`, and there is one rep goal per faction with something
 * outstanding rather than one for the run.
 */
/**
 * The measurements the framework reasons about, and the vocabulary an operator
 * commands in.
 *
 * DUPLICATED BY DESIGN. This cannot be imported from `src/shared/types.ts`: only
 * `src/game` is synced into Bitburner, so an import across that boundary would not
 * resolve in-game. `src/shared/types.ts` carries the same members for the server
 * and UI. **Keep the two in step** — a value the UI can send that is missing here
 * is a command this silently fails to match.
 */
export type SubGoalKey =
    | "hacking" | "combat" | "cha" | "money" | "kills" | "karma"
    | "netWorth" | "stockAccess" | "gangRespect" | "gangTerritory" | "rep" | "employed";

export interface SubGoal {
    readonly key: SubGoalKey;
    /** What the player has now. */
    readonly current: number;
    /** What the goal needs. For `karma`, a ceiling rather than a floor. */
    readonly target: number;
    readonly done: boolean;
    /** The faction this closes, so a feature can explain itself in the log. */
    readonly forGoal: string;
    /**
     * The company that has to employ the player, for the `employed` key.
     *
     * Carried on the sub-goal because `employed` is the one requirement that is not a
     * threshold: the standing has no single "employment" figure to compare against a
     * target, so the company name has to travel with the requirement that named it. A
     * feature reading a `employed` sub-goal takes the company from here rather than
     * inferring it from `forGoal`, which is prose.
     */
    readonly company?: CompanyName;
    /**
     * The loaded features that can advance this measurement, by id.
     *
     * Filled in by `withParticipation`, because which features are loaded is a fact the
     * goal cannot see from the standing alone. Empty here until then, and empty in
     * the result when no loaded feature can move this — which is what `blockedBy`
     * reports.
     */
    readonly contributors: readonly string[];
}

/** The player's standing, measured the way requirements are. */
export interface PlayerStanding {
    readonly hacking: number;
    /** The LOWEST combat skill. */
    readonly combat: number;
    readonly cha: number;
    readonly money: number;
    readonly kills: number;
    readonly karma: number;
    /**
     * What the next unowned link in the stock access chain costs, or 0 when the
     * chain is complete.
     *
     * Part of the standing rather than passed separately, because the goal machinery
     * (`satisfied`, `currentFor`, `gapFraction`) works on the standing and nothing
     * else. A value threaded in beside it would need every one of those to take an
     * extra argument.
     */
    readonly stockAccess: number;
    /**
     * Money on home, which is the figure the stock access purchase is actually gated on.
     *
     * NOT `money`, and conflating the two is a real bug rather than a nicety. The player's
     * money and home's cash are separate pools in this game, and `home.ts` buys the chain
     * from `homeCash`. A goal measured against `player.money` would therefore report
     * "affordable" while the purchase was still refused — the reported
     * `stockAccess 34408945528→25000000000`, where the goal insisted the player was
     * over target and `home.ts` went on not buying anything.
     *
     * The general `money` sub-goal keeps using `player.money`, because the faction
     * requirements that use it are about the player's net position rather than about what
     * a particular feature can spend.
     */
    readonly homeCash: number;
    /**
     * Home cash the framework is not holding back for something else.
     *
     * This — not `homeCash` — is what "can I afford the next link" means, because it is
     * the figure `home.ts` actually tests: it subtracts progression's augmentation reserve
     * before comparing against the cost. Measuring the goal against raw `homeCash` let the
     * two disagree in a way that was visible and wrong: with 34.4b on home and 10b
     * reserved for an augmentation, the goal read 100% while the purchase was blocked, so
     * the dashboard announced a goal that was affordable and then nothing happened.
     *
     * A goal that says "affordable" and a purchase that says "not yet" is the worst of
     * both: the reader cannot tell which is lying.
     */
    readonly spendable: number;
    /**
     * Cash plus market holdings, which is what the wealth-gated features read.
     *
     * NOT `money`, and the two disagree on exactly the runs that matter. `money` is cash
     * in hand; a player who has invested most of their wealth in the market looks poor by
     * cash and is not. The features that gate on wealth — hacknet's hash spending, the
     * gang's money rule — read the wider figure (see lib/net-worth.ts), so a goal built on
     * cash alone would rank a wealth goal as further away than the feature acting on it
     * believes. Read in the snapshot, where the stock calls belong, and passed in here.
     */
    readonly netWorth: number;
    /**
     * A gang's respect, or 0 when the player has no gang.
     *
     * 0 rather than a sentinel because a standing is a set of measurements and "no gang"
     * reads as "no respect", which is true. The goal built from it is suppressed
     * separately when there is no gang — a measurement of 0 would otherwise invent a
     * goal to raise respect the player cannot have.
     */
    readonly gangRespect: number;
    /** A gang's share of the map, 0 when the player has no gang. */
    readonly gangTerritory: number;
    /**
     * The respect this gang's next recruit needs, which is what "grow the gang" means.
     *
     * Derived from the game rather than declared: a bigger gang needs more respect for the
     * next member, so a fixed figure would be wrong at every size but one. Read from the
     * gang feature's own rule (`respectForNextRecruit * margin`) and passed in, so the goal
     * and the feature agree about when the gang has grown enough.
     */
    readonly gangRespectTarget: number;
    /**
     * The territory share past which taking more is not worth it.
     *
     * Also derived, from the number of rivals left. Holding all of it is the goal, but the
     * last slivers take disproportionately long, so this stops short of 100%.
     */
    readonly gangTerritoryTarget: number;
    /**
     * Whether the player is in a gang at all.
     *
     * Carried in the standing so the framework goals can tell "a gang whose gate is
     * already met" from "no gang", which are different: the first needs no goal and the
     * second would be a goal to raise a number the player has no way to move.
     */
    readonly inGang: boolean;
    /**
     * Each faction's reputation and the reputation its augmentations still need.
     *
     * A LIST, not a single figure, because reputation is per-faction and the requirement
     * differs per faction: the player's standing with NiteSec and with Daedalus are
     * separate numbers with separate targets, and collapsing them would lose the only
     * thing the goal is for. One entry per faction that has an unowned augmentation short
     * on reputation; a faction whose augmentations are all affordable is simply absent.
     *
     * READ FROM THE GAME by the snapshot, because it needs Singularity calls
     * (`getFactionRep`, `getAugmentationRepReq`), and `lib/objective.ts` makes no game
     * calls (ADR 0002).
     */
    readonly reputation: readonly FactionRep[];
    /**
     * Companies the player currently holds a job at.
     *
     * The one part of the standing that is not a measurement. A megacorp faction is
     * gated on being EMPLOYED by the company of the same name rather than on reaching a
     * number, so `satisfied` and `currentFor` cannot answer for it from a threshold —
     * they ask this set instead.
     *
     * A set rather than a single company because `bestCompany` may hold one while the
     * goal wants another, and a boolean would have to be re-derived per goal.
     */
    readonly employed: ReadonlySet<CompanyName>;
}

/** One faction's reputation and what its remaining augmentations require. */
export interface FactionRep {
    readonly faction: FactionName;
    /** The reputation the player currently has with the faction. */
    readonly current: number;
    /**
     * The highest reputation requirement among the faction's unowned augmentations.
     *
     * The HIGHEST, not the next one, because reputation is earned for the faction rather
     * than for a particular augmentation: working until the top requirement is met makes
     * every cheaper augmentation in the faction affordable at the same time. Chasing them
     * one at a time would earn the same reputation in the same order and merely report it
     * differently.
     */
    readonly target: number;
    /**
     * Effective favour with this faction — stored, or what installing the owned
     * augmentations would grant, whichever is higher.
     *
     * Carried because it decides WHETHER reputation can be bought instead of worked for,
     * and that question is asked outside this module (see `share.ts`). Favour is a
     * threshold, not a slope: below it, donations are refused outright at any balance, so
     * the reputation has to be earned by working. Above it, money buys it directly and
     * spending CPU on `ns.share` is a worse trade than earning the money instead.
     */
    readonly favor: number;
}

/** The gang figures a standing carries, read together so they cannot disagree. */
export interface GangStanding {
    readonly respect: number;
    readonly territory: number;
    /** Respect the gang's next recruit needs, from the gang feature's own rule. */
    readonly respectTarget: number;
    /** Territory share past which more is not worth taking. */
    readonly territoryTarget: number;
}

export function standingOf(
    player: Player,
    stockAccessCost = 0,
    homeCash = 0,
    /** Cash already spoken for by another feature, which this may not count as spendable. */
    reservedCash = 0,
    /**
     * The wider wealth figure, read from the game because it needs stock calls. Defaults
     * to the player's cash, which is what `readNetWorth` returns without stock access —
     * so a caller that does not supply it gets the same honourable degradation.
     */
    netWorth?: number,
    /** The player's gang, or null when they have none. */
    gang: GangStanding | null = null,
    /**
     * Each faction's reputation and what its augmentations still need.
     *
     * Read in the snapshot, where the Singularity calls belong. An empty list is the
     * honest reading for "no faction rep outstanding" AND for "could not read it" — both
     * mean no rep goal, which is the safe direction: a goal invented from nothing would
     * send features to work for reputation that is not wanted.
     */
    reputation: readonly FactionRep[] = [],
    /**
     * Companies the player currently holds a job at.
     *
     * Read from `player.jobs`, which the game populates for every company the player is
     * employed by — so this needs no Singularity call and cannot disagree with what
     * `workForCompany` acts on. An empty set means "employed nowhere", which is also the
     * safe reading for a fixture that did not supply it.
     */
    employed: ReadonlySet<CompanyName> = new Set<CompanyName>(),
): PlayerStanding {
    const { skills } = player;
    return {
        hacking: skills.hacking,
        // `Math.min` over four skills is `NaN` if ANY of them is missing, and `NaN`
        // propagates silently: every comparison against it is false, so the requirement
        // reads as unmet forever and the goal can never be closed.
        //
        // A player object always carries all four, so this only fires with an incomplete
        // stand-in — but the failure it produced was worth guarding rather than
        // diagnosing again. `NaN` used to reach `gapFraction` and then `progress`, where
        // it made the goal sort as neither first nor last; once the gap was clamped it
        // instead sorted FIRST, and the dashboard tried to print a sub-goal whose value
        // was undefined. Neither is a good way to find out a fixture is incomplete.
        //
        // 0 is the honest reading: a stat the caller did not supply is one this has not
        // been told the player has.
        combat: finiteMin(skills.strength, skills.defense, skills.dexterity, skills.agility),
        cha: num(skills.charisma),
        money: num(player.money),
        kills: num(player.numPeopleKilled),
        karma: num(player.karma),
        stockAccess: num(stockAccessCost),
        homeCash: num(homeCash),
        spendable: Math.max(0, num(homeCash) - num(reservedCash)),
        // Defaults to cash, matching `readNetWorth` without stock access. Not `num(money)`
        // read a second time: `num` would turn an explicit `0` net worth into `0` anyway,
        // but `??` keeps "the caller said this player is worth 0" distinct from "the caller
        // did not say", which a future caller may want.
        netWorth: num(netWorth ?? player.money),
        gangRespect: num(gang?.respect),
        gangTerritory: num(gang?.territory),
        gangRespectTarget: num(gang?.respectTarget),
        gangTerritoryTarget: num(gang?.territoryTarget),
        inGang: gang !== null,
        reputation,
        employed,
    };
}

/** `value` as a number, with anything unmeasurable read as 0. */
function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The lowest of the given skills, treating any that is missing as 0. */
function finiteMin(...values: readonly (number | undefined)[]): number {
    let lowest = Infinity;
    for (const value of values) lowest = Math.min(lowest, num(value));
    return Number.isFinite(lowest) ? lowest : 0;
}

/** A faction to join, or one of the run's own ambitions, with what is outstanding. */
export interface Goal {
    /** The achievement, named for the log. */
    readonly goal: string;
    /**
     * Whether this is a faction goal or one of the run's own.
     *
     * Needed because a framework goal still carries a `faction` — the field is a
     * `FactionName` and cannot be null — so `faction` alone cannot tell the two apart. The
     * karma goal is associated with Slum Snakes, and a caller asking "is joining Slum Snakes
     * still an goal?" must be able to tell the karma goal from the faction goal that
     * shares its name.
     */
    readonly kind: "faction" | "framework";
    readonly faction: FactionName;
    /** Every unmet requirement, whether or not any feature can move it. */
    readonly subGoals: readonly SubGoal[];
    /** How close the goal is, 0 to 1. Used to pick the nearest. */
    readonly progress: number;
    /**
     * Roughly how long the outstanding requirements would take, in seconds, or
     * null when nothing measurable says.
     *
     * Carried on the goal so it can be REPORTED before it is trusted: this is
     * shown in the console and the log, and does not yet affect ranking. Filled
     * in by `withEstimate`, which is the only caller that has a rate lookup.
     */
    readonly estimateSeconds: number | null;
    /**
     * Requirements no LOADED feature can advance, such as a BitNode quirk or a
     * measurement nothing is built to move. Present so the log can say why a goal cannot
     * be closed rather than leaving a feature's silence to be interpreted.
     *
     * Populated by `withParticipation`, which is the only code that knows which features
     * are loaded. Empty until then, and on a raw `deriveGoals` result.
     */
    readonly blockedBy: readonly SubGoalKey[];
    /**
     * Every loaded feature that can advance any part of this goal, by id.
     *
     * The union of the sub-goals' contributors, so the dashboard can show at a glance who
     * is working on the current goal. Filled in by `withParticipation`.
     */
    readonly contributors: readonly string[];
}

/**
 * Whether a requirement is satisfied. Karma is a ceiling; everything else a floor.
 *
 * `currentFor` decides the value rather than `standing[key]` directly, so `stockAccess`
 * is measured against the SPENDABLE cash the purchase is gated on and not against the
 * cost field of the same name. Reading the field here made a chain goal satisfied the
 * moment it was created — cost equal to cost — so the goal existed for zero ticks.
 *
 * A MARGIN HERE WAS TRIED AND REVERTED. `join Volhaven` needs 50m cash, and the recorded
 * runs show it appearing and vanishing as the balance crossed that line and back — the
 * goal is dropped the moment its only outstanding requirement is met, so it vanished at
 * exactly the moment it became achievable. Requiring a margin above the target looked
 * like the fix, and was measured against three recorded runs rather than assumed.
 *
 * It made things worse in every configuration tried. On run 2026-10-16T05.17.59 the head
 * changed 91 times with a 2% margin against 72 with none; a 10% margin gave 79 and a 20%
 * margin 92, while breaking 2026-10-16T12.36.15 badly (31 -> 67). The reason is that the
 * margin does not remove the boundary, it MOVES it: another threshold for a working
 * balance to oscillate across, and with more of the list flattened onto the same rank,
 * more pairs for the sort to break on nothing.
 *
 * The flicker is real and remains unfixed. It is a property of ranking on a measure the
 * framework is simultaneously spending, and no band around a threshold answers that —
 * see the note on `rank`'s removal in `deriveGoals` for what would.
 */
function satisfied(key: SubGoalKey, target: number, standing: PlayerStanding): boolean {
    const current = currentFor(key, standing);
    return key === "karma" ? current <= target : current >= target;
}

/**
 * Whether a requirement is met, which for `employed` is not a threshold at all.
 *
 * Kept beside `satisfied` rather than folded into it because the two take different
 * inputs: a threshold satisfies from the standing alone, while employment needs the
 * COMPANY the requirement named. Passing that through `satisfied` would mean widening a
 * function the whole module calls in order to serve one requirement.
 */
function requirementMet(req: GoalRequirement, standing: PlayerStanding): boolean {
    if (req.employedBy !== undefined && !standing.employed.has(req.employedBy)) return false;
    for (const [key, target] of Object.entries(req) as [string, unknown][]) {
        if (key === "employedBy") continue;
        if (!satisfied(key as SubGoalKey, target as number, standing)) return false;
    }
    return true;
}

/** The player's current value for a requirement. */
export function currentFor(key: SubGoalKey, standing: PlayerStanding): number {
    // `stockAccess` is the one key whose current value is not the field of the same name.
    // The field is the COST (the target); what the player has toward it is `spendable`,
    // which is the figure `home.ts` compares against the cost. Reading the field would
    // make `current === target` and the goal vanish the moment it existed.
    if (key === "stockAccess") return standing.spendable;
    // `rep` has no single value — it is per faction — so it is not a field of the standing
    // and cannot be read by key. A rep sub-goal carries its own `current` from the faction
    // it belongs to (see `reputationGoals`), and this is never reached for it. Returning 0
    // rather than throwing keeps the signature total for a key that exists in the union.
    if (key === "rep") return 0;
    // `employed` is binary and per company, so it has no scalar value either. Its
    // sub-goal carries `company` and is judged by `requirementMet`; a number here would
    // be a lie in either direction.
    if (key === "employed") return 0;
    return standing[key];
}

/**
 * How far a sub-goal is from done, as a fraction of the target.
 *
 * Relative rather than absolute, so 10 short of 20 ranks above 100 short of 2000:
 * a faction almost reachable is worth more than one that needs thousands more.
 */
function gapFraction(subGoal: SubGoal): number {
    if (subGoal.done) return 0;
    if (subGoal.key === "karma") {
        // Karma moves toward zero from below, so the gap is how far above the
        // ceiling the player is, relative to the ceiling's magnitude.
        const gap = subGoal.current - subGoal.target;
        return clamp01(gap / Math.max(1, Math.abs(subGoal.target)));
    }
    const gap = subGoal.target - subGoal.current;
    return clamp01(gap / Math.max(1, subGoal.target));
}


/**
 * Keep a gap fraction in [0, 1].
 *
 * WHY THIS EXISTS. A sub-goal can be OVER-satisfied — the player has more money than
 * the purchase costs, more reputation than the augmentation needs — and the arithmetic
 * above then produces a NEGATIVE gap, because `target - current` goes below zero.
 * `progress` is `1 - gap`, so a negative gap gives a progress ABOVE 1, which the
 * dashboard printed literally: `buy stock market access (138%)`.
 *
 * A percentage over 100 is nonsense to a reader and it also breaks the ordering that
 * `currentGoal` depends on: `deriveGoals` sorts by progress descending, so an
 * over-satisfied goal outranks everything and becomes "the goal" on the strength of an
 * arithmetic artefact rather than because it is closest to complete.
 *
 * Clamped here rather than at each construction site, because this is the only place the
 * quotient is formed and every caller needs the same guarantee. `done` is checked before
 * this on purpose: a satisfied sub-goal reports 0 gap and is filtered out upstream.
 *
 * A non-finite result reads as 1 (the furthest from done) rather than 0. `NaN` used to
 * propagate into `progress` untouched, where it sorted unpredictably; reading it as a
 * perfect score would be worse still — an unmeasurable requirement would rank as the
 * nearest goal and the run would chase it. Reading it as the WORST case is the safe
 * direction: a requirement this cannot measure is not one to prioritise.
 */
function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(0, value));
}

/**
 * Every faction the player has not joined, as an goal, nearest first.
 *
 * Built from requirements rather than from memory of what the framework did, so a
 * faction that becomes joinable stops being an goal without anything having
 * to notice.
 */
export function deriveGoals(
    standing: PlayerStanding,
    joined: ReadonlySet<FactionName>,
): Goal[] {
    const goals: Goal[] = [];

    for (const [faction, req] of Object.entries({ ...FACTION_REQUIREMENTS, ...MEGACORP_REQUIREMENTS }) as [FactionName, GoalRequirement][]) {
        if (joined.has(faction)) continue;

        const subGoals: SubGoal[] = [];
        for (const [rawKey, target] of Object.entries(req) as [string, unknown][]) {
            if (rawKey === "employedBy") {
                // Not a threshold, so it is judged against the employment SET rather than
                // against a number. `target: 1` is what the UI needs to render `0 → 1`;
                // the truth is the `company` beside it.
                const company = target as CompanyName;
                if (standing.employed.has(company)) continue;
                subGoals.push({
                    key: "employed",
                    current: 0,
                    target: 1,
                    done: false,
                    forGoal: faction,
                    company,
                    contributors: [],
                });
                continue;
            }

            if (satisfied(rawKey as SubGoalKey, target as number, standing)) continue;
            subGoals.push({
                key: rawKey as SubGoalKey,
                current: currentFor(rawKey as SubGoalKey, standing),
                target: target as number,
                done: false,
                forGoal: faction,
                // Filled in by `withParticipation`; empty here because the goal cannot
                // see which features are loaded.
                contributors: [],
            });
        }

        if (subGoals.length === 0) continue;

        // Progress is the mean of the per-requirement gaps, so a faction with one
        // thing left ranks above one with three.
        const progress = 1 - subGoals.reduce((sum, g) => sum + gapFraction(g), 0) / subGoals.length;

        goals.push({
            goal: `join ${faction}`,
            kind: "faction",
            faction,
            subGoals,
            progress,

            // No feature can advance anything in a requirement table this module
            // does not know about, so nothing is blocked outright yet. Filled in by
            // the callers that know what they can move.
            blockedBy: [],
            contributors: [],
            estimateSeconds: null,
        });
    }

    goals.push(...frameworkGoals(standing));
    goals.push(...reputationGoals(standing));

    // Sorted on `progress`, nearest first.
    //
    // TIES ARE BROKEN ON THE GOAL'S NAME. `Array.sort` is stable, so equal goals keep
    // derivation order — which is `Object.entries(FACTION_REQUIREMENTS)` order, an
    // accident of how the table happens to be written and no basis for a decision. Two
    // goals CAN genuinely rank equal: `New Tokyo` and `Ishima` have byte-identical
    // requirements ({hacking 100, money 30m}), so they are equal for as long as both are
    // unjoined, and the head would otherwise depend on which was typed first. A name is
    // arbitrary but it is FIXED, so the same standing always yields the same head.
    //
    // A SEPARATE `rank` FIGURE WAS TRIED AND REVERTED. Ranking on a noise-absorbed gap
    // instead of `progress` was measured against three recorded runs and lost: on
    // 2026-10-16T05.17.59 the head changed 91 times against 72 for plain `progress`, and
    // a wider band was worse still. See the note on `satisfied` for why a margin around
    // a threshold cannot fix a boundary the framework is actively crossing.
    return goals.sort((a, b) => b.progress - a.progress || a.goal.localeCompare(b.goal));
}

/**
 * The run's own ambitions, as goals, derived from the standing.
 *
 * These are not faction goals and are not derived from a requirement table. They exist
 * because the run has ambitions the factions do not express — owning the stock access
 * chain, reaching a wealth target, growing a gang's respect and territory — and without a
 * goal, no feature could score an option against them. The cash a goal needs would then
 * compete with everything else on equal terms, and reaching it would be a matter of which
 * feature happened to spend first.
 *
 * DERIVED from the standing, like every faction goal, so there is no stored flag to drift.
 * A spec states how to READ its target and whether it applies at all; the builder does the
 * rest, so every framework goal sorts, reports and closes the same way.
 *
 * A goal whose measure is already met is OMITTED, not constructed with `done: false`.
 * Without that the goal sits at 100% forever: `progress` is clamped to 1, but an
 * unmarked goal never leaves the list, and because this sorts by progress descending it
 * would outrank every real faction goal and become the current goal permanently —
 * the dashboard showing "buy stock market access (100%)" for the rest of the run. The
 * faction goals handle it by omitting satisfied requirements and skipping a faction with
 * none left; this is that rule for goals with no requirement table.
 */
function frameworkGoals(standing: PlayerStanding): Goal[] {
    const goals: Goal[] = [];

    for (const spec of FRAMEWORK_GOALS) {
        if (!spec.applies(standing)) continue;
        const target = spec.target(standing);
        // A target that cannot be read is not a goal. A non-finite target sorts
        // unpredictably, and a ZERO floor target — the stock chain reports 0 once complete —
        // is "nothing to want" rather than a goal to reach.
        //
        // The zero check is for FLOOR goals only. Karma is a ceiling with a legitimately
        // negative target, and rejecting `target <= 0` outright would have silently dropped
        // the karma goal every run.
        const isCeiling = spec.key === "karma";
        if (!Number.isFinite(target) || (!isCeiling && target <= 0)) continue;

        const current = currentFor(spec.key, standing);
        // Met-ness is decided by the same predicate the faction goals use, so karma's
        // ceiling semantics apply here too: a karma goal is met once the player is at or
        // below the target, which is the opposite direction from every other goal.
        // Testing `current >= target` directly would omit a karma goal the moment it
        // appeared, because the target is negative and any real karma is above it.
        if (satisfied(spec.key, target, standing)) continue;

        const subGoal: SubGoal = {
            key: spec.key,
            current,
            target,
            done: false,
            forGoal: spec.goal,
            contributors: [],
        };

        goals.push({
            goal: spec.goal,
            kind: "framework",
            faction: spec.faction,
            subGoals: [subGoal],
            progress: 1 - gapFraction(subGoal),

            blockedBy: [],
            contributors: [],
            estimateSeconds: null,
        });
    }

    return goals;
}

/**
 * One goal per faction whose reputation still buys something, nearest first.
 *
 * Reputation is the odd measure: it is PER FACTION, so unlike the other framework goals
 * it cannot be one entry in `FRAMEWORK_GOALS` — the list would have to name every faction
 * the player might join, and a faction with nothing left to buy would still appear. This
 * generates them from the standing instead: one goal for each faction that offers an
 * unowned augmentation the player is short on reputation for.
 *
 * WHY THIS IS CENTRAL NOW. Three features independently asked the same question and each
 * answered it by calling the Singularity API: `share.ts` (is any reputation worth the CPU
 * at all), `sleeves.ts` (which faction should a sleeve work for), and `player.ts` (which
 * augmentation is worth working toward). Nothing kept them in step, and the answer is a
 * fact about the player's factions rather than about any one feature. Reading it once here
 * means they cannot disagree about which factions want reputation or by how much.
 *
 * The target is the faction's own `target` from the standing — the highest requirement
 * among its unowned augmentations — so the goal is closed exactly when the faction's
 * augmentations become affordable.
 *
 * The goal is a FLOOR, unlike karma: reputation is earned upward toward a requirement, and
 * `satisfied` treats every key but karma as a floor, so `rep` needs no special case.
 */
function reputationGoals(standing: PlayerStanding): Goal[] {
    const goals: Goal[] = [];

    for (const rep of standing.reputation) {
        // A faction with nothing left to buy, or one already at the requirement, is not a
        // goal. The standing only carries factions with something outstanding, but the
        // check is repeated here because the standing is built elsewhere and a `target <= 0`
        // would otherwise divide by zero in `gapFraction`.
        if (!Number.isFinite(rep.target) || rep.target <= 0) continue;
        if (rep.current >= rep.target) continue;

        const subGoal: SubGoal = {
            key: "rep",
            current: rep.current,
            target: rep.target,
            done: false,
            forGoal: rep.faction,
            contributors: [],
        };

        goals.push({
            goal: `earn ${rep.faction} reputation`,
            kind: "framework",
            faction: rep.faction,
            subGoals: [subGoal],
            progress: 1 - gapFraction(subGoal),

            blockedBy: [],
            contributors: [],
            estimateSeconds: null,
        });
    }

    return goals;
}

/**
 * Every framework goal whose measure is a single number for the whole run, and how to
 * measure it.
 *
 * One list rather than a function per goal, so a new ambition is one entry and cannot
 * quietly skip the "already met" rule or forget to state whether it applies. The specs
 * are pure — each reads only the standing — because `lib/objective.ts` must make no game
 * calls (ADR 0002): the figures a spec reads are gathered in the snapshot.
 *
 * Per-faction goals are NOT here: they need one entry per faction, so `reputationGoals`
 * generates them from the standing instead.
 */
const FRAMEWORK_GOALS: readonly FrameworkGoalSpec[] = [
    {
        key: "stockAccess",
        goal: "buy stock market access",
        // Not a faction. The field is a `FactionName`, so the honest stand-in is the
        // faction that sells the data — Four Sigma — rather than inventing a sentinel
        // the type would not accept.
        faction: "Four Sigma" as FactionName,
        // The cost of the NEXT unowned link rather than the whole chain, so the goal
        // reads as "what is the next thing to buy" and its progress moves as each link is
        // paid for. Pricing it as the full chain would show a distant, unmoving number.
        target: (standing) => standing.stockAccess,
        applies: (standing) => standing.stockAccess > 0,
    },
    {
        key: "netWorth",
        goal: "reach the wealth target",
        faction: "Four Sigma" as FactionName,
        target: () => GOAL_TARGETS.netWorth,
        // Always applicable: every run wants to be rich enough to stop worrying about
        // money, and the goal omits itself once the target is reached.
        applies: () => true,
    },
    {
        key: "karma",
        goal: "farm karma for the late-game factions",
        // The factions that gate on deep karma are the criminal ones; Slum Snakes is the
        // gateway to that whole set, so it is the honest stand-in for "the goal this is for".
        faction: "Slum Snakes",
        target: () => GOAL_TARGETS.karma,
        // Karma is a CEILING, so "already met" is `current <= target`; the builder decides
        // that through `satisfied`, which knows the direction. This only says the goal
        // applies whenever the run farms karma at all, which the target states: a 0 target
        // would mean "do not farm".
        applies: () => GOAL_TARGETS.karma < 0,
    },
    {
        key: "gangRespect",
        goal: "grow the gang",
        faction: "Slum Snakes",
        // Derived, not declared: a gang's respect target is whatever recruits it next, and
        // that is a fact about the gang rather than a figure this run chooses.
        target: (standing) => standing.gangRespectTarget,
        applies: (standing) => standing.inGang,
    },
    {
        key: "gangTerritory",
        goal: "take the map",
        faction: "Slum Snakes",
        target: (standing) => standing.gangTerritoryTarget,
        applies: (standing) => standing.inGang,
    },
];

/**
 * The goal the run is working toward, or null when every faction is joined.
 *
 * Nearest-first means "the achievement closest to complete", which is what makes
 * scattered effort unnecessary: working on the nearest goal finishes something
 * sooner.
 */
export function currentGoal(goals: readonly Goal[]): Goal | null {
    return goals[0] ?? null;
}

/**
 * The sub-goals one feature can advance.
 *
 * The feature declares what it can move; this returns the matching sub-goals, so a
 * feature never has to know what a goal is, only what it is good at.
 */
export function subGoalsFor(
    goal: Goal | null,
    movable: readonly SubGoalKey[],
): readonly SubGoal[] {
    if (goal === null) return [];
    return goal.subGoals.filter(subGoal => movable.includes(subGoal.key));
}

/**
 * The sub-goal kinds a sleeve can advance.
 *
 * WHY THIS LIVES HERE rather than in the sleeves feature. It is a declaration of
 * CAPABILITY, and two places need it: the registry, which publishes who can move what, and
 * the sleeves feature, which uses it to decide what to train. Those two were separate
 * lists — `registry.ts` said `["combat", "cha", "rep"]` while `sleeve-goals.ts` said
 * `["combat", "cha"]` — so the goal credited sleeves with closing reputation goals
 * that the sleeve scoring would never aim at. A goal attributed to a feature that cannot
 * act on it is worse than an unattributed one: `withParticipation` marks a sub-goal
 * `blockedBy` only when NOTHING can move it, so a false declaration removes the warning
 * without supplying the work.
 *
 * `lib/` is the only place both can reach without breaking ADR 0001 (no feature importing
 * another) or ADR 0002 (no feature importing the registry), and this module already owns
 * the `SubGoalKey` union these values are drawn from. `goal.ts` imports no feature and
 * calls no game API, so the registry can read it at boot without charging RAM.
 *
 * WHAT IS AND IS NOT ACHIEVABLE. Combat and charisma are TRAINING targets a sleeve reaches
 * through a gym or a course. Money and net worth are earned by working a crime — a sleeve's
 * own documented fallback — even though no sleeve ever studies toward them, which is why
 * they belong in the capability list and not in the training list. Reputation is moved by
 * faction work and is likewise not a training target; it is here because the registry must
 * say a sleeve can advance a reputation goal, and `SLEEVE_TRAINING_KEYS` below is the
 * narrower list for the scoring.
 *
 * `money` and `netWorth` are declared together, as the five other money-earning features
 * declare them. They are different measures (see `currentFor`), but a sleeve earning cash
 * genuinely moves both, and declaring one without the other would understate the feature.
 */
export const SLEEVE_MOVABLE: readonly SubGoalKey[] = ["combat", "cha", "money", "netWorth", "rep"];

/**
 * The sub-goal kinds a sleeve can TRAIN toward, as opposed to merely advance.
 *
 * A subset of `SLEEVE_MOVABLE`, and the distinction is real rather than an accident of
 * naming. A sleeve advances reputation by working for a faction and money by committing a
 * crime; neither is something it can be sent to study. The scoring only offers a training
 * candidate for a measurement in THIS list, which is why sending a sleeve to a gym for a
 * money goal is not a thing that can happen.
 */
export const SLEEVE_TRAINING_KEYS: readonly SubGoalKey[] = ["combat", "cha"];

/** A feature and the sub-goal kinds it can advance. The `movable` half of `FeatureMeta`. */
export interface Participation {
    readonly id: string;
    readonly movable: readonly SubGoalKey[];
}

/**
 * Annotate goals with who can advance them, and mark what nothing can.
 *
 * This is the piece that lets EVERY feature take part in the goal model rather than only
 * the one the goal happens to belong to. The goal is derived from the standing alone
 * — it knows what is outstanding but not who could close it, because "who" is a fact
 * about which features are loaded. This takes that list and answers, per goal:
 *
 *   contributors  which loaded features can move each sub-goal, and the union per goal
 *   blockedBy     the sub-goals NO loaded feature can move
 *
 * `blockedBy` is the reason the annotation is worth doing at all. Without it a goal whose
 * only requirement is one nothing can raise sits at the top of the list forever — the run
 * works toward something no feature can close and the dashboard cannot say why. With it,
 * the log can — and, because a capability-gated feature is simply absent from the list,
 * "nothing is loaded that can do this" and "no feature could ever do this" are
 * distinguishable by whether a feature with that key is merely unloaded.
 *
 * Pure: it reads the passed goals and declarations, so it is testable without a
 * registry, and the registry itself stays RAM-free (it holds only the declarations).
 */
export function withParticipation(
    goals: readonly Goal[],
    features: readonly Participation[],
): Goal[] {
    // Built once rather than per sub-goal: the same key is looked up for every goal.
    const byKey = new Map<SubGoalKey, string[]>();
    for (const feature of features) {
        for (const key of feature.movable) {
            const list = byKey.get(key);
            if (list === undefined) byKey.set(key, [feature.id]);
            else list.push(feature.id);
        }
    }

    return goals.map(goal => {
        const contributors = new Set<string>();
        const blockedBy: SubGoalKey[] = [];

        const subGoals = goal.subGoals.map(subGoal => {
            const movers = byKey.get(subGoal.key) ?? [];
            if (movers.length === 0) blockedBy.push(subGoal.key);
            for (const id of movers) contributors.add(id);
            return { ...subGoal, contributors: movers };
        });

        return {
            ...goal,
            subGoals,
            blockedBy,
            contributors: [...contributors],
        };
    });
}

/** A value from the current goal, or `fallback` when it is not a sub-goal. */
export function targetFor(
    goal: Goal | null,
    key: SubGoalKey,
    fallback: number,
): number {
    return goal?.subGoals.find(subGoal => subGoal.key === key)?.target ?? fallback;
}

/**
 * Re-rank goals so the one the operator asked for comes first, or hold the head.
 *
 * THIS SITS BETWEEN DERIVATION AND RANKING, and does two things that look unrelated
 * until you see where they sit. Given a measurement, it applies the operator's `goal`
 * command to the derived list. Given none, it hands the `hold` to `rankByTime` instead,
 * so a nearly-finished head survives the noise in the times. They are one function
 * because only one of them can ever apply: honouring a request means the operator has
 * decided what the run works on, and defending the previous head against that decision
 * would make the command look ignored.
 *
 * HOW THE REQUEST IS HONOURED matters. The
 * framework derives goals from game state and never from configuration — see the
 * module header — because a configured target drifts from the game's real
 * requirement. So this does not CREATE a goal: it moves an existing one to the
 * front, and leaves the list untouched when nothing can serve the request.
 *
 * WHAT "SERVES" MEANS. A goal serves a measurement if it has an OUTSTANDING
 * sub-goal on that key. A goal already at its target has nothing left to do on it,
 * so preferring it would park the run on a finished goal; that case returns the
 * list unchanged, which the caller reports as "nothing can advance that" rather
 * than quietly ignoring the command.
 *
 * Pure, so the preference is testable without a registry or a game.
 */
export function preferGoal(
    goals: readonly Goal[],
    key: SubGoalKey | null | undefined,
): Goal[] {
    if (key === null || key === undefined) return [...goals];

    // The first goal with something left to do on the requested measurement. Order
    // among equals is preserved, so the derived ranking still decides between them.
    const index = goals.findIndex(
        goal => goal.subGoals.some(subGoal => subGoal.key === key && !subGoal.done),
    );
    if (index <= 0) return [...goals];

    const preferred = [...goals];
    const [goal] = preferred.splice(index, 1);
    preferred.unshift(goal!);
    return preferred;
}

/* ─── effort, as distinct from progress ─── */

/**
 * Seconds per unit of a measurement, or null when none has been measured.
 *
 * The same shape `activity.ts` uses for its training-rate publisher, so the
 * caller passes the one lookup the framework already maintains rather than this
 * module reaching for a rate it cannot see.
 */
export type RateLookup = (key: SubGoalKey) => number | null;

/**
 * Which rate code measures each sub-goal key.
 *
 * Not every key is measurable: `money`, `kills` and the gang measures move at
 * rates nothing here tracks, and `stockAccess` is a cost rather than a rate. A
 * key absent from this map has no estimate, which is honest — the alternative is
 * inventing one.
 */
const RATE_KEY: Readonly<Partial<Record<SubGoalKey, string>>> = {
    hacking: "hacking",
    combat: "str",
    cha: "cha",
};

/**
 * Roughly how long this goal's outstanding requirements would take, in seconds,
 * or null when no measurement is available to say.
 *
 * WHY THIS IS SEPARATE FROM `progress`. `progress` is a RATIO of levels, and a
 * ratio has no time in it: `join NiteSec` reads 79% for `hacking 158 -> 200`,
 * which is only 2 points ahead of `join The Syndicate` at 77% — while the two
 * could differ by hours. Ranking on the ratio alone therefore commits the run to
 * a goal without knowing whether a much nearer one is waiting behind it. This
 * exists so that comparison is possible at all; it does not change the ranking
 * yet, deliberately, so the estimate can be checked against real goals first.
 *
 * THE SUM IS OVER SUB-GOALS, so it is an upper bound: requirements that can be
 * satisfied at the same time (combat stats trained together at a gym) are counted
 * twice. Erring high is the safe direction for a figure used to decide whether
 * something is reachable — and the alternative, assuming overlap that may not
 * exist, would understate the cost and defeat the purpose.
 *
 * Null rather than Infinity when nothing is measurable: "unknown" and "forever"
 * are different answers, and only the caller can decide what to do with either.
 *
 * REJECTS A GOAL IF ANY REQUIREMENT IS UNMEASURABLE, rather than timing the part it
 * can. A goal needing `hacking 500` and `money 50m` is not "305 seconds" because the
 * hacking half has a rate — the money is still outstanding, and a figure that ignored
 * it would rank that goal as nearer than a goal it is genuinely behind.
 */
export function estimateSeconds(goal: Goal, rate: RateLookup): number | null {
    let total = 0;

    for (const subGoal of goal.subGoals) {
        if (subGoal.done) continue;
        const key = RATE_KEY[subGoal.key];
        // NOT MEASURABLE AT ALL — `gangTerritory`, `rep`, `money`, `karma` have no rate
        // concept here. Null, and no time can be given.
        if (key === undefined) return null;

        const perSecond = rate(subGoal.key);
        // MEASURABLE BUT NOT MOVING. `null` is "no rate", and a zero or absent rate is
        // "not rising right now" — which for a ranking is `Infinity`, not `null`. The
        // distinction matters: conflating them made run 2026-10-16T05.17.59 degenerate,
        // because the player trained only hacking and every combat goal read as
        // unmeasurable, leaving one goal to take the head for 3050 of 3094 frames.
        // `training-budget.ts` makes the same call for the same reason.
        if (perSecond === null || !Number.isFinite(perSecond) || perSecond <= 0) {
            total = Infinity;
            continue;
        }

        // `karma` moves toward a ceiling, so its gap is the other direction; it
        // has no rate mapping and never reaches here.
        const gap = subGoal.target - subGoal.current;
        if (gap <= 0) continue;

        total += gap / perSecond;
    }

    return total;
}

/**
 * Fill in each goal's effort estimate.
 *
 * A separate pass rather than a value computed at construction, for the same
 * reason `withParticipation` is: the derivation has no rate lookup and should not
 * grow one, and this keeps the estimate in exactly one place.
 *
 * Ranking is deliberately NOT changed here — the estimate is published so it can be
 * compared against real goals before anything acts on it. It is not yet fit to rank
 * on: the figure is a SUM over sub-goals, so it double-counts requirements that can
 * be satisfied together, and it says nothing about a goal that is short of a measure
 * no feature is currently moving.
 */
export function withEstimate(
    goals: readonly Goal[],
    rate: RateLookup,
): Goal[] {
    return goals.map(goal => ({
        ...goal,
        estimateSeconds: estimateSeconds(goal, rate),
    }));
}

/**
 * Goals ordered by how long they would take, unmeasurable ones last.
 *
 * THE RANKING, and why it is not `progress`. `progress` is a ratio against each goal's
 * own target, and comparing two of them compares incommensurable things: 60% of a 30m
 * goal and 60% of a 50m goal are different amounts of work, and they fill at different
 * rates from the same income. Goals therefore crossed and re-crossed on the RATE they
 * were being filled at rather than on closeness — measured against the recorded runs,
 * 54 of 74 head changes were exact reversals (A -> B -> A inside a minute). A time
 * answers the question the ranking is actually asking: which of these does the run
 * finish first.
 *
 * A PARTIAL ORDER, which is the honest shape of what is known. Half the goals have no
 * measurable rate at any moment — `gangTerritory`, `rep`, `money` and `karma` are not
 * training stats — so a time exists for some goals and not others. The two are ordered
 * by putting MEASURABLE FIRST: a goal the run can watch itself advance is a better
 * thing to pursue than one it cannot measure, and this stops an unmeasurable goal from
 * taking the head on a `progress` figure that no rate agrees with. Among the
 * measurable, soonest first; among the rest, `progress` descending — the ordering that
 * was there before.
 *
 * Pure, and takes the rates as a parameter for the same reason `withEstimate` does:
 * `deriveGoals` has no rate lookup and should not grow one.
 */
export function rankByTime(
    goals: readonly Goal[],
    rate: RateLookup,
    working: WorkingGoal = {},
): Goal[] {
    // A goal with no usable time — `null` (no rate for the measure) or `Infinity` (the
    // measure has a rate but is not moving) — cannot be ranked by time, so it falls back
    // to `progress`. Both cases are "unknown how long", and the two must be handled
    // together: sorting them separately put `Infinity` goals in arithmetic order, and
    // `Infinity - Infinity` is `NaN`, which makes the comparator return `NaN`. The sort
    // then places them arbitrarily — a goal at 39% became head over one at 97%.
    const timed = (s: number | null): number | null =>
        s === null || !Number.isFinite(s) ? null : s;

    const ordered = goals
        .map(goal => ({ goal, seconds: timed(estimateSeconds(goal, rate)) }))
        .sort((a, b) => {
            if (a.seconds === null && b.seconds === null) {
                return b.goal.progress - a.goal.progress || a.goal.goal.localeCompare(b.goal.goal);
            }
            if (a.seconds === null) return 1;
            if (b.seconds === null) return -1;
            return a.seconds - b.seconds || a.goal.goal.localeCompare(b.goal.goal);
        });

    return keepWorking(ordered, working).map(t => t.goal);
}

/**
 * The goal the features are currently acting on, passed in so the ranking can keep it.
 *
 * WHY THIS EXISTS AT ALL. A goal's `progress` is a ratio of a measurement to a target, and
 * some measurements are things the framework is itself spending or moving. `money` is the
 * worst case: every faction in a city needs a cash balance, all of them are derived from the
 * SAME balance, and a gig, a program, an augmentation or a reserve decision moves it by a
 * million in one tick. The ratios move with it, the ranking re-sorts, and the head changes
 * without anything about the goal having changed.
 *
 * IT IS NOT A TIMING PROBLEM, which is why smoothing the estimates does not answer it. Measured
 * over the recorded runs: of 153 head changes in `runs/2026-10-21T13.15.50.020Z.jsonl`, NONE
 * had a time on either side of the swap — every one was between goals ranked by `progress`.
 * So the protection has to be about progress, and the run has to be able to say which goal it
 * is already on.
 *
 * The hold is deliberately NOT a constant offset, and it does not prefer a goal because it is
 * nearly done. Two things were measured against the recorded runs and rejected:
 *
 *   a progress floor        requiring a candidate to be, say, 75% done before it may take the
 *                           head changed NOTHING on any run tested. The goals that trade places
 *                           were already past every floor tried, because a cash threshold's
 *                           ratio is the same whatever it is measured against — the boundary
 *                           just moves with the floor.
 *   a hysteresis band       faster, but a band on the head's progress means the head is defended
 *                           even when the ranking has genuinely found something better and the
 *                           head is only moderately done. That is the run staying on a goal past
 *                           the point it should have moved, not a flicker being suppressed.
 *
 * What is left is the cheapest and most literal reading: the goal the run is on keeps the
 * head across the exchange with the goal that would displace it, and nothing more. It is not
 * defended against a goal the ranking times as sooner, because a purchase does not move a
 * time and so a timed handover is a real one. It is not defended from further down than 2nd,
 * because a goal the ranking put behind a third has been beaten for a reason. And it is not
 * defended once it is SATISFIED, because a satisfied goal is no longer derived and so is not
 * in the list to keep.
 *
 * Measured on the recorded runs, this removes most of the churn and almost all of the
 * reversals: `runs/2026-10-21T13.15.50.020Z.jsonl` goes from 176 head changes and 101 exact
 * reversals to 62 and 15, and `runs/2026-10-26T05.26.43.876Z.jsonl` from 71/63 to 21/14.
 * What is left is the run moving on, which is the point.
 */
export interface WorkingGoal {
    /**
     * The head of the list the features are acting on, or absent on a fresh run.
     *
     * A `Goal` rather than a name because the caller holds the goal it ranked; the goals are
     * matched by name, since a goal rebuilt from a new snapshot is a different object every
     * pass.
     */
    readonly working?: Goal;
}

/**
 * Keep the working goal at the head when the ranking would only DEMOTE it on a spend.
 *
 * This is a swap between the top two, not a promotion from anywhere in the list. The ranking
 * orders by `progress`, and the goals that trade places on a cash balance are adjacent by
 * construction — they are the same measure against nearby targets — so the flicker is always
 * a 1st/2nd exchange. A goal the ranking has pushed further down than that has been beaten
 * for a reason the ranking can express, and the run follows it; pulling such a goal back up
 * would turn the hold into the veto it is meant not to be.
 *
 * Only the untimed half of the ranking is deferred to. An unmeasurable goal is ranked purely
 * on `progress`, and `progress` is exactly the figure that moves when the framework spends —
 * so honouring a swap between two of them is honouring the spend. Two TIMED goals are
 * compared on how long they take, which no purchase moves; when the ranking says the other
 * is sooner, it is sooner, and the run should move.
 */
function keepWorking(
    ordered: readonly { readonly goal: Goal; readonly seconds: number | null }[],
    working: WorkingGoal,
): readonly { readonly goal: Goal; readonly seconds: number | null }[] {
    const current = working.working;
    if (current === undefined) return ordered;

    const position = ordered.findIndex(entry => entry.goal.goal === current.goal);
    // Already first, or no longer a goal at all. Satisfying a goal REMOVES it, and the next
    // pass ranks without it — which is how a handover is supposed to happen.
    if (position <= 0) return ordered;

    const held = ordered[position]!;
    const best = ordered[0]!;
    // A held goal the ranking can time, beaten by one it can also time, is a real handover.
    if (held.seconds !== null && best.seconds !== null) return ordered;

    // THE HOLD ONLY STOPS A SWAP, it does not FORCE one. A working goal at 2nd exchanges with
    // the goal that took its place; a working goal further down has been beaten for a reason
    // the ranking can express, and pulling it back to the top would undo a real handover as
    // surely as a veto would.
    if (position > 1) return ordered;

    const head = [...ordered];
    const [first] = head.splice(0, 1, held);
    head.splice(position, 1, first!);
    return head;
}

/**
 * How the ranking is currently deciding, so a degenerate ordering is visible.
 *
 * WHY THIS EXISTS. `rankByTime` orders by estimated time and falls back to `progress` for
 * goals it cannot time. That fallback is correct, but when it applies to EVERY goal the
 * ranking is no longer "soonest first" — it is the raw progress ratio, which compares
 * percentages of goals with different targets and units. The function's own doc comment
 * records that this is the comparison the time ranking was introduced to replace.
 *
 * Measured in `runs/2026-11-03T21.24.46.416Z--16`: all ten goals in the queue reported
 * `estimateSeconds: null`, because `estimateSeconds` returns null unless a goal's every
 * requirement is a training stat — and territory, reputation, money and karma have no rate.
 * The ranking had therefore been `progress`-ordered for the entire session while reading as
 * if it were time-ordered, and nothing anywhere said so.
 *
 * NOT A FIX. Teaching the ranker to time a territory campaign needs a model of how fast a
 * gang takes ground, which is a real piece of work and not one to invent from nothing. This
 * reports the gap so a reader knows which ordering they are looking at, and so the next
 * person does not have to derive it from a queue dump.
 */
export type RankingMode =
    /** At least two goals had a time, so the comparison is genuinely soonest-first. */
    | "time"
    /** Exactly one goal was timeable. It wins by default; the rest fall back. */
    | "almost"
    /** Nothing was timeable, so this is `progress` ordering and not a time ranking at all. */
    | "progress";

/** Which of the three orderings `rankByTime` is about to use. */
export function rankingMode(goals: readonly Goal[], rate: RateLookup): RankingMode {
    let timed = 0;
    for (const goal of goals) {
        const seconds = estimateSeconds(goal, rate);
        if (seconds !== null && Number.isFinite(seconds)) timed++;
    }
    if (timed >= 2) return "time";
    return timed === 1 ? "almost" : "progress";
}

/** A sentence naming the ordering, for a status line or a log entry. */
export function describeRanking(goals: readonly Goal[], rate: RateLookup): string {
    const mode = rankingMode(goals, rate);
    const total = goals.length;
    switch (mode) {
        case "time":
            return `ranked by time (${total} goals, ${countTimed(goals, rate)} timed)`;
        case "almost":
            return `ranked by time, but only ${countTimed(goals, rate)} of ${total} goals could be timed`;
        case "progress":
            // Named plainly, because this is the state that reads as correct and is not.
            return `ranked by PROGRESS only: none of ${total} goals has a measurable rate`;
    }
}

/** How many goals could be timed. Small helper so the two messages cannot disagree. */
function countTimed(goals: readonly Goal[], rate: RateLookup): number {
    let n = 0;
    for (const goal of goals) {
        const seconds = estimateSeconds(goal, rate);
        if (seconds !== null && Number.isFinite(seconds)) n++;
    }
    return n;
}
