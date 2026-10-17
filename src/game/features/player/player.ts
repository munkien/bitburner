import { findScriptOnHome } from "../../lib/scripts.ts";
// The budget rule and the rate measurement live in `lib/` because the sleeves feature needs
// them too and features may not import each other (ADR 0001). Imported DIRECTLY from there
// rather than through a re-export in `progression.ts` or `rate-tracker.ts`: Bitburner's
// syntax checker compiles each file without resolving the whole graph, and a chain of bare
// re-exports is not something it can follow — that is what produced "Progression is deployed
// but would not compile".
import { REACH_SEC, floorEtaSeconds, floorReachable } from "../../lib/training-budget.ts";
import { observe, rateFor, type MeasuredStat, type OpenSample, type RateSample } from "../../lib/rate-tracker.ts";
import {
    belowFloor,
    karmaFarmingWanted as karmaFarmingWantedPure,
    karmaTargets,
    lowestCombatSkill,
    trainingTargets,
    type CombatSkill,
    type FloorTargets,
} from "./progression.ts";
import type { Goal } from "../../lib/objective.ts";
import { GOAL_TARGETS } from "../../lib/objective.ts";
import { GANG_CHOICE_FLAG, GANG_KARMA, chosenGangKind, gangFactionFor, gangKindOf, type GangKind } from "../../lib/gangs.ts";
import { ChangeLog, announce, note, publishStatus, type RecentLines } from "../../lib/log.ts";
import { bladeburnerKeepsSlot, hasActiveBlackOp, hasActiveGraft, publishTrainingRate, trainingRemaining, winnableBlackOp } from "./activity.ts";
import type { Context } from "../../lib/context.ts";
import type {
    CityName,
    CompanyName,
    CrimeType,
    FactionName,
    FactionWorkType,
    GymLocationName,
    JobName,
    NS,
    Player,
    ProgramName,
    UniversityLocationName,
} from "@ns";

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Cash floor. Deliberately well below zero so stat training (which costs
 *  money every tick) doesn't trip it. Only fires when we're genuinely broke. */
const TARGET_CASH = -50_000_000;
/**
 * Fallbacks, used only when the goal names no such target. The live values
 * come from the run's goal (lib/objective.ts), which is what stops this file
 * and sleeves.ts disagreeing about a requirement.
 *
 * `karma` comes from `GOAL_TARGETS` rather than being spelled out here, because the same
 * figure is this fallback AND the karma the run declares it wants. Two copies — one here,
 * one in sleeves.ts — was the drift this module exists to remove, surviving in the one pair
 * of files that did not share a reader.
 */
const KARMA_FALLBACK: { kills: number; karma: number } = { kills: 30, karma: GOAL_TARGETS.karma };
const FLOOR_FALLBACK: FloorTargets = { hacking: 100, combat: 100 };

/** Train every stat (hacking + all four combat stats) to at least this level
 *  before pursuing other goals. */
// Shared with the feature that yields the activity slot while training is
// outstanding, so the two cannot disagree about when training is finished.

/**
 * Favour at which a faction accepts donations at all.
 *
 * EXPORTED so the copy in `lib/context.ts` can be checked against it. That module cannot
 * import this one — a static import between features charges this feature's RAM to
 * whatever imports it (ADR 0001) — so the value is duplicated deliberately, and
 * `reputation-gate.test.ts` compares the two. Two copies of one threshold drifting apart
 * is the bug ADR 0003 records.
 */
export const DONATION_MIN_FAVOR = 150;

// ============================================================================
// TYPES & DATA
// ============================================================================

export type PlayerAction =
    | { kind: "GYM"; gym: GymLocationName; stat: CombatStat; city?: CityName }
    | { kind: "UNI"; university: UniversityLocationName; course: UniversityClassType; city?: CityName }
    | { kind: "FACTION"; faction: FactionName; workType: FactionWorkType }
    | { kind: "COMPANY"; company: CompanyName }
    | { kind: "CRIME"; crime: CrimeType }
    | { kind: "PROGRAM"; program: ProgramName }
    | { kind: "BACKDOOR"; hostname: string }
    | { kind: "TRAVEL"; city: CityName };

type Stat = "hacking" | "str" | "def" | "dex" | "agi" | "cha";
type CombatStat = "str" | "def" | "dex" | "agi";
type Work = Record<string, unknown> & { type: string };

interface FactionRequirement {
    hacking?: number;
    combat?: number;
    cha?: number;
    money?: number;
    kills?: number;
    karma?: number;   // negative; player.karma must be <= this
}

const STAT_KEYS: Record<Stat, "hacking" | "strength" | "defense" | "dexterity" | "agility" | "charisma"> = {
    hacking: "hacking", str: "strength", def: "defense", dex: "dexterity", agi: "agility", cha: "charisma",
};

const COMBAT: CombatStat[] = ["str", "def", "dex", "agi"];

const GYM: GymLocationName = "Powerhouse Gym";
const UNIVERSITY: UniversityLocationName = "Rothman University";
const UNI_HACKING: UniversityClassType = "Computer Science";

/**
 * `getCurrentWork().classType` for a gym class returns the short stat code
 * ("str", "def", "dex", "agi"), not the long form. These must match exactly
 * or `isDoingAction` never recognises the class and every tick restarts it.
 */
const GYM_CLASS: Record<CombatStat, string> = {
    str: "str", def: "def", dex: "dex", agi: "agi",
};

/**
 * `getCurrentWork().classType` for a university class returns the course
 * name exactly as passed to `universityCourse` (e.g. "Computer Science").
 */
const CLASS_STAT: Record<string, Stat> = {
    str: "str", def: "def", dex: "dex", agi: "agi",
    "Computer Science": "hacking",
};

const INTEL_PROGRAMS: readonly { name: ProgramName; req: number }[] = [
    { name: "AutoLink.exe", req: 25 },
    { name: "ServerProfiler.exe", req: 75 },
    { name: "DeepscanV1.exe", req: 75 },
];

const MEGACORPS: readonly CompanyName[] = [
    "ECorp", "MegaCorp", "KuaiGong International", "Four Sigma", "NWO",
    "Blade Industries", "OmniTek Incorporated", "Bachman & Associates",
    "Clarke Incorporated", "Fulcrum Technologies",
];
const ENTRY_JOB = "Software Engineering Intern" as JobName;

/**
 * `player.factions` is typed `FactionName[]`, but candidate names are usually
 * plain strings (object keys, host names). Comparing by string is what the game
 * itself does, so this is the single membership test used everywhere.
 */
function isMemberOf(player: Player, name: string): boolean {
    return (player.factions as readonly string[]).includes(name);
}

/**
 * The megacorps are both companies and company factions: "ECorp" can be worked
 * for *and* joined. `CompanyName` and `FactionName` are separate `@ns` unions
 * whose members coincide here, so this is the one place the two are bridged.
 */
function asFaction(company: CompanyName): FactionName {
    return company as string as FactionName;
}

/** `Object.entries` widens literal keys; faction tables are keyed by faction name. */
function factionEntries<T>(table: Readonly<Partial<Record<FactionName, T>>>): [FactionName, T][] {
    return Object.entries(table) as [FactionName, T][];
}

const CITY_FACTIONS = new Set<FactionName>(["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"]);

const BACKDOOR_FACTIONS: Record<string, FactionName> = {
    CSEC: "CyberSec",
    "avmnite-02h": "NiteSec",
    "I.I.I.I": "The Black Hand",
    run4theh111z: "BitRunners",
};

/**
 * What each faction requires to join. The game states these only inside
 * `checkFactionInvitations`, so a copy is unavoidable.
 *
 * EXPORTED so the copy in `lib/objective.ts` can be checked against it. That module
 * cannot import this one — a static import between features charges this feature's RAM
 * to whatever imports it (ADR 0001) — so the table is duplicated deliberately, and
 * `objective.test.ts` compares the two. Without the export the duplication was
 * unverifiable, and the comment claiming it was checked described a test that did not
 * exist.
 */
export const FACTION_STAT_REQS: Readonly<Partial<Record<FactionName, FactionRequirement>>> = {
    // City factions
    "Sector-12": { money: 1_000_000 },
    Aevum: { money: 40_000_000 },
    Volhaven: { hacking: 50, money: 50_000_000 },
    Chongqing: { hacking: 100, money: 20_000_000 },
    "New Tokyo": { hacking: 100, money: 30_000_000 },
    Ishima: { hacking: 100, money: 30_000_000 },

    // Other factions
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

const FACTION_CITIES: Readonly<Partial<Record<FactionName, readonly CityName[]>>> = {
    "Sector-12": ["Sector-12"],
    Aevum: ["Aevum"],
    Volhaven: ["Volhaven"],
    Chongqing: ["Chongqing"],
    "New Tokyo": ["New Tokyo"],
    Ishima: ["Ishima"],
    "Tian Di Hui": ["Chongqing", "New Tokyo", "Ishima"],
    Tetrads: ["Chongqing", "New Tokyo", "Ishima"],
    "The Dark Army": ["Chongqing"],
    "The Syndicate": ["Aevum", "Sector-12"],
    "Speakers for the Dead": ["Aevum", "Chongqing", "New Tokyo"],
};

/* ─── FEATURE STATE (persists across ticks) ─── */
let initialized = false;
let log: ChangeLog | null = null;
let lastWarn = "";
let lastReserve = -1;
const rates: Partial<Record<MeasuredStat, RateSample>> = {};
let openSample: OpenSample | null = null;

/**
 * Forget everything this feature remembers between ticks.
 *
 * Exported for tests, like the `reset` on the other long-lived features: this memory is
 * MODULE state and two tests in one process share it. `rates` and `openSample` are the ones
 * that bite — they carry a measured XP rate across ticks, so a test that expected an ETA
 * of 0 would silently inherit a rate from an earlier test and get a real estimate
 * instead. `lastWarn` likewise suppresses a warning an earlier test already emitted.
 *
 * Not called in production: a restart clears the module anyway.
 */
export function reset(): void {
    initialized = false;
    log = null;
    lastWarn = "";
    lastReserve = -1;
    openSample = null;
    for (const key of Object.keys(rates)) delete rates[key as MeasuredStat];
}

let lastAugment: AugTarget | null = null;
let targetAugment: AugTarget | null = null;

/**
 * What this feature is doing, or the guard that stopped it.
 *
 * Set at every exit from `tick`, so the reason a run is stalled is readable
 * rather than inferred. It is the answer to the question that took an hour to
 * reach during development: progression reported "active" while returning early
 * from the same branch for 130 log entries, and nothing said which branch.
 *
 * Read through `publishStatus` on change only — the value is stable for as long
 * as the situation is, so this costs one line per transition.
 */
let reason = "starting";

/**
 * The gang kind this run committed to, for the status line.
 *
 * Kept as module state rather than re-read per call because reading it means a file
 * check and possibly a file write (`gangKindFor`), and the status is built on every tick.
 * The value cannot change within a run — the flag is written once — so one read is
 * enough, and `undefined` means "not asked yet" rather than "no gang".
 */
let gangKindLabel: string | undefined;

export function tick(ns: NS, context: Context): void {
    log ??= new ChangeLog(ns, "ACTION");
    log.updateNs(ns);
    joinInvites(ns);

    // Registered once, read by the orchestrator when it builds telemetry. The
    // getter is a closure over the module state above, so the orchestrator sees the
    // value this tick set rather than a copy taken at registration.
    // The getter is called by the orchestrator when it builds telemetry, so it reads the
    // CURRENT `reason` rather than the value at registration — which is also why the gang
    // label can be appended here even though `prioritizeAction` sets it later in the pass.
    publishStatus("progression", () =>
        gangKindLabel === undefined ? reason : `${reason} · ${gangKindLabel}`,
    );

    // BitNode 8 has no augment purchases, only grafting, so the whole purchase
    // pipeline — the reserve, donations, faction rep-farming — is switched off
    // there. The grafting feature takes over instead (see lib/registry.ts).
    const canBuyAugs = context.capabilities.has("augmentPurchase");

    // Progression writes the cash reserve: it is the only feature that knows an
    // augmentation purchase is coming, and every feature that spends money reads
    // this field rather than a shared file.
    context.reserves.cash = plannedReserve(ns, context.snapshot.player, canBuyAugs);

    const { player } = context.snapshot;
    trackRate(ns, player);

    // Publish the rate model so the activity slot's yield signal can apply the same
    // reachability rule the training decision does. Without this the two disagree: this
    // feature declines an unreachable target, while `trainingRemaining` reports training
    // outstanding from the floor alone and Bladeburner yields for training that will not
    // happen.
    publishTrainingRate(stat => measuredRate(stat));

    const owned = ns.singularity.getOwnedAugmentations(true);
    targetAugment = getBestAugmentation(ns, player, owned);
    if (targetAugment?.name !== lastAugment?.name) {
        lastAugment = targetAugment;
        ns.tprint("AUGMENT TARGET: ", targetAugment?.name);
    }

    // Training is faster than anything Bladeburner offers, so progression owns
    // the activity slot and Bladeburner waits for it (see lib/activity.ts).
    //
    // This used to skip assignment entirely whenever a Bladeburner action was
    // running, on the reasoning that starting work would cancel it. That deadlocked
    // the two features: `bladeburner.ts` defers to training while training is
    // outstanding but does not stop an action it has already begun, so with a
    // contract in flight and stats left to train, progression assigned nothing and
    // Bladeburner started nothing. Neither made progress until the contract's
    // counts expired.
    //
    // What the comment always said is the correct rule, and it is what happens now:
    // progression takes the slot, and taking it costs Bladeburner the action it was
    // running. The cost is real and accepted — a gym class or a course is worth more
    // than a contract — but it must not be paid on EVERY tick, or the player would
    // cancel a fresh action every second. `assignAction` already handles that: it
    // compares the running work with the action it wants and returns early when they
    // match (see `isDoingAction`), so an uninterrupted action is only cancelled when
    // progression genuinely wants something different.
    //
    // `passiveTasks` runs on every path, whoever holds the slot: backdoors,
    // augment purchases and donations never touch the activity slot, so gating
    // them on it would starve them whenever any work was running.
    passiveTasks(ns, player, context.recent, canBuyAugs, context.capabilities.has("createGang"));

    // A Bladeburner black op owns the slot. Progression yields in both cases:
    //
    //   - `winnableBlackOp` — a >90% op is *waiting* to be started. Yielding
    //     here (rather than studying and letting Bladeburner cancel it a few
    //     ticks later) is what stops the flap: both features reach the same
    //     predicate, so they agree on who holds the slot before either acts.
    //   - `hasActiveBlackOp` — an op is already running. Bladeburner does not
    //     report through the Singularity API, so `getCurrentWork()` is null and,
    //     without this guard, `assignAction` would study and silently cancel the
    //     op in flight.
    // A graft owns the slot too, for the same reason a running black op does:
    // interrupting it destroys the progress. `grafting.ts` starts a graft once a
    // minute and then yields while any work runs, so this is the other half of
    // the agreement — progression must not start a new action over a graft in
    // flight.
    // A Bladeburner CONTRACT or OPERATION in flight owns the slot as well, and
    // this is the other half of an agreement that was only ever half-wired.
    //
    // `hasBladeburnerAction` was built and tested for exactly this purpose — the
    // header of `lib/activity.ts` says both features ask through it — but no
    // feature ever called it. Bladeburner yielded to training, training did not
    // yield to Bladeburner, and because a Bladeburner action is invisible to
    // `getCurrentWork()` the Singularity API, progression's `isDoingAction`
    // comparison could not see one running either. So `prioritizeAction` returned
    // a gym class, `assignAction` called `gymWorkout`, and the contract in flight
    // was silently cancelled — every tick, since the training target it wanted was
    // still outstanding.
    //
    // The reported symptom is a player who keeps getting pulled back to training
    // while Bladeburner tasks are underway, and it is the source of the "training
    // a lot where the target is far away" complaint: each contract starts, is
    // cancelled by a training assignment, and starts again, so neither path makes
    // progress. Yielding here means whoever holds the slot keeps it.
    //
    // Sticky, not absolute. The guards above still win: `winnableBlackOp` upgrades
    // a contract to a black op, and `hasActiveGraft` protects a graft. And this
    // only yields when a Bladeburner action is genuinely in flight — with none
    // running, training proceeds exactly as before.
    if (winnableBlackOp(ns) || hasActiveBlackOp(ns) || hasActiveGraft(ns)) {
        reason = "yielded: a black op or graft owns the slot";
        return;
    }
    // Yields to Bladeburner only while Bladeburner is KEEPING the slot — a chain
    // running, or training not wanted. Asking "is a Bladeburner action running"
    // was the wrong question: with a chain in flight Bladeburner kept its action
    // while progression stood down, and neither ran for 130 log entries with money
    // and experience frozen. See `bladeburnerKeepsSlot`, whose inverse is exactly
    // the condition Bladeburner uses to hand the slot back.
    if (
        bladeburnerKeepsSlot(
            ns,
            !context.capabilities.has("bladesSimulacrum"),
            trainingRemaining(player, context.goal),
        )
    ) {
        reason = `yielded: Bladeburner keeps the slot${
            trainingRemaining(player, context.goal)
                ? " (chain running)"
                : " (training not wanted)"
        }`;
        return;
    }

    const chosen = prioritizeAction(ns, player, context.goal, context.recent, canBuyAugs, context.capabilities.has("createGang"));
    if (chosen === null) {
        reason = "nothing to do: the priority chain returned no action";
        return;
    }

    // ONE ACTION PER TICK, and travel is an action.
    //
    // A chosen action may need a city the player is not in — the gym and the
    // university are the cases today. Rather than performing it anyway (which is
    // what the old side-effecting `ensureCity` did, and how two branches ended up
    // cancelling each other's travel every tick), the action performed becomes a
    // TRIP to that city. Next tick the player is there, this returns the original
    // action, and `assignAction` needs no city logic of its own.
    //
    // The city is read live, not from the snapshot: the snapshot is one pass old,
    // so after arriving it would still report the previous city and send the
    // player straight back out.
    const action = withTravel(chosen, currentCityOf(ns));
    // The chosen action is the reason, when it was reached at all — so a working
    // tick is as legible as a stalled one.
    reason = action.kind === "TRAVEL"
        ? `travelling to ${action.city} (chose ${chosen.kind})`
        : `acting: ${describeAction(action)}`;
    assignAction(ns, context, action);
}

/** A short label for an action, for the status line. */
function describeAction(action: PlayerAction): string {
    switch (action.kind) {
        case "GYM": return `gym ${action.stat}`;
        case "UNI": return `course ${action.course}`;
        case "CRIME": return `crime ${action.crime}`;
        case "FACTION": return `${action.faction} ${action.workType}`;
        case "COMPANY": return `work ${action.company}`;
        case "PROGRAM": return `program ${action.program}`;
        case "BACKDOOR": return `backdoor ${action.hostname}`;
        case "TRAVEL": return `travel ${action.city}`;
    }
}

/**
 * A chosen action, or a trip to the city it needs.
 *
 * The single place the "I am in the wrong city" case is resolved, so no action
 * handler has to know about travel and none can start one as a side effect.
 */
function withTravel(action: PlayerAction, currentCity: CityName): PlayerAction {
    const needs = action.kind === "GYM" || action.kind === "UNI"
        ? (action.city ?? "Sector-12")
        : null;

    if (needs === null || needs === currentCity) return action;
    return { kind: "TRAVEL", city: needs };
}

// ============================================================================
// FACTION INVITES
// ============================================================================


function joinInvites(ns: NS): void {
    const owned = ns.singularity.getOwnedAugmentations(true);
    for (const f of ns.singularity.checkFactionInvitations()) {
        if (CITY_FACTIONS.has(f) &&
            !ns.singularity.getAugmentationsFromFaction(f).some(a => a !== "NeuroFlux Governor" && !owned.includes(a))) continue;
        ns.singularity.joinFaction(f);
    }
}

// ============================================================================
// FAVOR HELPERS
// ============================================================================

function projectedFavorAfterInstall(currentRep: number): number {
    if (currentRep <= 0) return 0;
    return Math.log(1 + currentRep / 25000) / Math.log(1.02);
}

function effectiveFavor(ns: NS, faction: FactionName): number {
    const stored = ns.singularity.getFactionFavor(faction);
    const projected = projectedFavorAfterInstall(ns.singularity.getFactionRep(faction));
    return Math.max(stored, projected);
}

// ============================================================================
// PRIORITIES
// ============================================================================

/**
 * The action to take, highest priority first.
 *
 * The threshold-dependent steps read the run's goal, so this feature and
 * every other one work toward the same goal. The ORDER is unchanged: this is the
 * chain as it was, with its thresholds sourced rather than declared.
 */
function prioritizeAction(
    ns: NS,
    player: Player,
    goal: Goal | null,
    recent: RecentLines,
    canBuyAugs: boolean,
    canCreateGang: boolean,
): PlayerAction | null {
    // 1. Backdoor faction servers
    const host = findBackdoor(ns, player);
    if (host) return { kind: "BACKDOOR", hostname: host };

    // 3. Broke-state cash floor. Deliberately well below zero so stat
    //    training doesn't trip it — only fires when we're genuinely in the
    //    hole (e.g. right after an augment install).
    if (player.money < TARGET_CASH) {
        return { kind: "CRIME", crime: bestCashCrime(ns) };
    }

    // 4. Stat floor: train what the goal is waiting on before pursuing
    //    anything else. Once those floors are met this returns null and we fall
    //    through.
    const floor = statFloor(ns, player, goal);
    if (floor) return floor;

    // 2. Karma and kill farming, for the factions that need them.
    //
    // The two targets are alternatives, not one condition. `numPeopleKilled < 30`
    // is the Slum Snakes / Tetrads kill gate; `heart.break() > -54000` is karma for
    // the late-game factions. Neither implies the other.
    //
    // They used to be joined by `||`, which meant the branch kept running while
    // EITHER was unsatisfied. Reported as "keeps doing Homicide even at -240K
    // karma": the karma half was long since satisfied, but the kill count was not,
    // so it kept going. The harm is worse than busy-work, because Homicide keeps
    // dropping karma past the target, and very low karma closes off other content.
    if (!getGangFaction(ns) && karmaFarmingWanted(player, goal)) {
        return { kind: "CRIME", crime: "Homicide" };
    }

    // 2b. Work toward the faction the gang needs, once karma is out of the way.
    //
    // AFTER the karma step, not before: every combat gang requires karma and most
    // require kills, so training stats for a faction that would refuse the player anyway
    // spends time against a gate that is not the binding one. A hacking gang needs
    // neither, and its faction is reached by backdoor, which step 1 already does.
    //
    // The JOIN itself needs nothing here. `joinInvites` accepts every invitation the
    // game offers, gang factions included, so membership arrives on its own once the
    // prerequisite is met. What this step contributes is the CHOICE — without it the run
    // would drift toward whichever gang faction it happened to qualify for, and the
    // coin toss in `gangKindFor` would decide nothing.
    const gangWant = gangTarget(ns, player, canCreateGang);
    if (gangWant !== null) {
        // Published so a permanent coin toss is not invisible. The kind cannot be changed
        // once the gang exists, so a run that went the wrong way should be legible in the
        // console rather than only inferable from the gang feature's behaviour later.
        gangKindLabel = `${gangKindOf(gangWant.faction)} gang via ${gangWant.faction}${
            gangWant.haveIt ? "" : " (joining)"
        }`;
    } else {
        gangKindLabel = getGangFaction(ns) !== null ? "founded" : undefined;
    }
    if (gangWant?.haveIt === false) {
        const train = trainForGangFaction(ns, player, gangWant.faction);
        if (train) return train;
    }

    // 5. Buy any affordable augments, then travel if a city faction is
    //    waiting on us, then work toward the next augment target.
    const owned = ns.singularity.getOwnedAugmentations(true);
    if (canBuyAugs) buyAffordableAugments(ns, player, owned, recent);

    const travel = travelForFaction(ns, player, owned);
    if (travel) return travel;

    // 6. Intelligence software
    const program = nextProgram(ns, player.skills.hacking);
    if (program) return { kind: "PROGRAM", program };

    // 7. Stat training for pending factions / megacorps
    const train = factionTraining(ns, player);
    if (train) return train;

    if (canBuyAugs) {
        const target = getBestAugmentation(ns, player, owned);
        if (target) {
            if (target.currentRep < target.repRequired) {
                if (donateForRep(ns, target, player, recent)) return null;

                const favor = effectiveFavor(ns, target.faction);
                if (favor >= DONATION_MIN_FAVOR) {
                    const alt = getBestAugmentation(ns, player, owned, {
                        excludeFaction: target.faction,
                        requireFavorBelow: DONATION_MIN_FAVOR,
                        requireRepGap: true,
                    });
                    if (alt) {
                        return { kind: "FACTION", faction: alt.faction, workType: bestFactionWork(ns, alt.faction) };
                    }
                } else {
                    return { kind: "FACTION", faction: target.faction, workType: bestFactionWork(ns, target.faction) };
                }
            } else if (player.money >= target.price) {
                ns.singularity.purchaseAugmentation(target.faction, target.name);
            } else {
                return { kind: "CRIME", crime: bestCashCrime(ns) };
            }
        }
    }

    // 8. Megacorp rep
    const company = bestCompany(ns, player);
    if (company) return { kind: "COMPANY", company };

    // 9. Nothing to work toward, so keep a stat moving.
    //
    // This is the last resort and it is deliberately unconditional — but it is NOT the
    // same as the floor at step 4, and the difference is the whole point of the budget
    // there. Step 4 trains toward a TARGET the goal is waiting on, and refuses when
    // the measured rate says that target is unreachable; a run could otherwise spend the
    // whole game on one number, which is what "1.5 hours without getting a goal in"
    // means. Step 9 has no target: it is what a run does when it has exhausted every
    // goal-directed option, and abandoning it would mean the player idles instead of
    // slowly improving.
    //
    // Reported once so the reason is visible. A reader seeing training continue should be
    // able to tell "there is a plan" from "there is nothing else to try".
    const lowest = lowestCombatStat(player);
    log?.change(
        "idle-training", "Training", "idle",
        `no reachable goal; training ${lowest} with nothing waiting on it`,
    );
    return { kind: "GYM", gym: GYM, stat: lowest, city: "Sector-12" };
}

/** Things that never touch the player's current action: backdoors, augment
 *  purchases and faction donations. */
function passiveTasks(ns: NS, player: Player, recent: RecentLines, canBuyAugs: boolean, canCreateGang: boolean): void {
    const host = findBackdoor(ns, player);
    if (host) runBackdoor(ns, host);

    tryCreateGang(ns, player, canCreateGang);

    const owned = ns.singularity.getOwnedAugmentations(true);
    if (canBuyAugs) buyAffordableAugments(ns, player, owned, recent);

    if (canBuyAugs) {
        const target = getBestAugmentation(ns, player, owned);
        if (target && target.currentRep < target.repRequired) donateForRep(ns, target, player, recent);
    }
}

/**
 * Create the gang, once every prerequisite is genuinely met.
 *
 * A PASSIVE TASK, like the backdoor above it: it does not start work and does not take
 * the activity slot, so it belongs here rather than in the action chain. It is also not
 * a `PlayerAction` — that union is a set of ONGOING activities, and this is a one-shot
 * that either succeeds or does not.
 *
 * WHY THE PREREQUISITES ARE CHECKED HERE instead of calling and hoping. `createGang`
 * returns `false` for an unmet requirement and ONLY logs the reason; it does not throw.
 * A silent false would leave the run retrying every tick with nothing said, so this
 * decides for itself and the call is the last step rather than the test. It DOES throw
 * on a faction name that is not a real faction, which is why the name comes from the
 * table in `lib/gangs.ts` rather than from anywhere it could be malformed.
 *
 * Announced on success only. A failure that repeats every tick is the "anything that
 * warns fifty times a second is a bug" case that `feature-runtime.ts` handles with
 * cooldowns, and the checks above mean a failure here should be unreachable rather than
 * routine.
 */
function tryCreateGang(ns: NS, player: Player, canCreateGang: boolean): void {
    const want = gangTarget(ns, player, canCreateGang);
    // `gangTarget` already answers "can a gang be created here", "are we in one" and
    // "which faction"; a null or an unheld faction means there is nothing to do yet.
    // `haveIt` false means step 2b is still working toward the membership.
    if (want === null || !want.haveIt) return;

    // Karma is the other gate the game applies, and it is checked rather than assumed
    // because step 2 stops farming it as soon as the goal says so — and the goal targets
    // the same figure for the late-game factions rather than for the gang (see GANG_KARMA).
    if (player.karma > GANG_KARMA) return;

    const kind = gangKindOf(want.faction);
    if (kind === null) return;

    try {
        if (ns.gang.createGang(want.faction)) {
            announce(ns, "PROGRESSION", `Founded a ${kind} gang in ${want.faction}`, "success");
        }
    } catch {
        // `createGang` throws only on a faction name that is not a real faction, which
        // the table rules out, and returns FALSE silently for an unmet requirement. The
        // checks above are therefore the real gate; this catch only stops a surprise
        // faulting the whole pass, and the next tick re-checks.
    }
}

// ============================================================================
// RECONCILIATION
// ============================================================================

function assignAction(ns: NS, context: Context, action: PlayerAction): boolean {
    const current = ns.singularity.getCurrentWork() as unknown as Work | null;

    if (action.kind === "BACKDOOR") return runBackdoor(ns, action.hostname);

    if (action.kind === "TRAVEL") {
        if (context.snapshot.player.city === action.city) return true;
        const ok = ns.singularity.travelToCity(action.city);
        if (ok) {
            announceAction(context, action);
        }
        return ok;
    }

    if (action.kind === "COMPANY") ensureCompanyJob(ns, action.company);

    if (isDoingAction(current, action)) return true;

    let success = false;
    switch (action.kind) {
        case "GYM":
            // Only if already there. Travelling to reach a venue is a decision,
            // and it is made in `prioritizeAction` — see `isInCity`. Doing it
            // here as a side effect is what let two branches fight over the
            // player's location and cancel each other every tick.
            if (isInCity(currentCityOf(ns), action.city ?? "Sector-12"))
                success = ns.singularity.gymWorkout(action.gym, action.stat, false);
            break;
        case "UNI":
            if (isInCity(currentCityOf(ns), action.city ?? "Sector-12"))
                success = ns.singularity.universityCourse(action.university, action.course, false);
            break;
        case "FACTION":
            success = ns.singularity.workForFaction(action.faction, action.workType, false);
            break;
        case "COMPANY":
            success = ns.singularity.workForCompany(action.company, false);
            break;
        case "CRIME":
            success = ns.singularity.commitCrime(action.crime, false) > 0;
            break;
        case "PROGRAM":
            success = ns.singularity.createProgram(action.program, false);
            break;
    }

    if (success) {
        announceAction(context, action);
        ensureFocus(ns);
    }
    return success;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Report a change of active action.
 *
 * Called from the two places that can switch work, which reported it with the
 * same four lines each before this existed. Logging only on change matters
 * here: the orchestrator ticks this once a second and the action usually has
 * not moved.
 */
function announceAction(context: Context, action: PlayerAction): void {
    log!.change("action", "Switched active action", getActionKey(action));
}

function getActionKey(a: PlayerAction): string {
    switch (a.kind) {
        case "GYM": return `GYM:${a.gym}:${a.stat}`;
        case "UNI": return `UNI:${a.university}:${a.course}`;
        case "FACTION": return `FACTION:${a.faction}:${a.workType}`;
        case "COMPANY": return `COMPANY:${a.company}`;
        case "CRIME": return `CRIME:${a.crime}`;
        case "PROGRAM": return `PROGRAM:${a.program}`;
        case "BACKDOOR": return `BACKDOOR:${a.hostname}`;
        case "TRAVEL": return `TRAVEL:${a.city}`;
    }
}

function isDoingAction(w: Work | null, a: PlayerAction): boolean {
    if (!w) return false;
    switch (a.kind) {
        case "GYM": return w.type === "CLASS" && w.classType === GYM_CLASS[a.stat] && w.location === a.gym;
        case "UNI": return w.type === "CLASS" && w.location === a.university;
        case "FACTION": return w.type === "FACTION" && w.factionName === a.faction && w.factionWorkType === a.workType;
        case "COMPANY": return w.type === "COMPANY" && w.companyName === a.company;
        case "CRIME": return w.type === "CRIME" && w.crimeType === a.crime;
        case "PROGRAM": return w.type === "CREATE_PROGRAM" && w.programName === a.program;
        case "BACKDOOR": return false;
        case "TRAVEL": return false;
    }
}

/**
 * Whether the player is already in a city.
 *
 * A PURE PREDICATE, and that is the whole point. This replaced `ensureCity`,
 * which returned `currentCity === city || ns.singularity.travelToCity(city)` —
 * it travelled as a SIDE EFFECT and reported success, so a GYM or UNI action
 * "succeeded" without the player being anywhere near the venue.
 *
 * The damage was not just a wasted tick. `context.snapshot.player.city` is read
 * once per pass, so the tick after `ensureCity` started a trip still saw the OLD
 * city and travelled again — while `travelForFaction` independently moved the
 * player elsewhere. Observed live: four actions per second, each cancelling the
 * last, and nothing trained at all:
 *
 *   UNI:Rothman University:Computer Science
 *   TRAVEL:Chongqing
 *   GYM:Powerhouse Gym:str
 *   TRAVEL:Chongqing
 *
 * It settled only because the player happened to end up in the right city; a
 * different pair of cities would cycle forever. Travel is now CHOSEN at the
 * decision point (`prioritizeAction`) and performed as an ordinary TRAVEL
 * action, so the first choice each tick is the only thing that acts.
 */
function isInCity(currentCity: CityName, city: CityName): boolean {
    return currentCity === city;
}

/**
 * The player's current city, read live.
 *
 * Deliberately NOT `context.snapshot.player.city`. The snapshot is captured once
 * per pass, which is right for planning but wrong for an arrival test: after a
 * travel completes mid-pass, the snapshot still reports the old city, so the
 * next tick would issue another trip. That staleness is half of what made the
 * old side-effecting `ensureCity` loop.
 */
function currentCityOf(ns: NS): CityName {
    return ns.getPlayer().city;
}

function ensureCompanyJob(ns: NS, company: CompanyName): void {
    const fields = ["Software", "IT", "Business", "Security"] as const;
    for (let i = 0; i < 20; i++) {
        let progressed = false;
        for (const field of fields) {
            try {
                if (ns.singularity.applyToCompany(company, field)) {
                    progressed = true;
                    break;
                }
            } catch { }
        }
        if (!progressed) return;
    }
}

/**
 * Keep focus set to whatever the player's augmentations call for.
 *
 * `Neuroreceptor Management Implant` removes the focus penalty, so with it the
 * player should stay unfocused and let everything else run at full speed; without
 * it, focusing is what makes work progress faster.
 *
 * `setFocus` returns whether the focus *changed*, so asking first avoids writing
 * the same value once per tick for the whole run and makes the return value
 * meaningful rather than ignored. `isFocused` costs 0.1 GB and does not throw.
 */
function ensureFocus(ns: NS): void {
    try {
        const hasNeuro = ns.singularity.getOwnedAugmentations(true).includes("Neuroreceptor Management Implant");
        const wanted = !hasNeuro;
        if (ns.singularity.isFocused() === wanted) return;
        ns.singularity.setFocus(wanted);
    } catch { }
}

function findBackdoor(ns: NS, player: Player): string | null {
    for (const [host, faction] of Object.entries(BACKDOOR_FACTIONS)) {
        if (isMemberOf(player, faction)) continue;
        const s = ns.getServer(host);
        if (!s.hasAdminRights || s.backdoorInstalled) continue;
        if ((s.requiredHackingSkill ?? 0) > player.skills.hacking) continue;
        return host;
    }
    return null;
}

// ─── Backdoor ───

/**
 * On home, next to the orchestrator, so a relative run works wherever the
 * game's file sync placed the project.
 */
/**
 * The backdoor worker, resolved at runtime rather than hard-coded.
 *
 * This used to be the literal `"./scripts/backdoor.ts"`, relative to whatever script
 * ran it — the only place in the framework that started a script by a raw path instead
 * of resolving it. `lib/scripts.ts` exists because the game's file sync can place a
 * project at the root or under a subdirectory, so a hard-coded relative path is a
 * silent failure exactly when the layout differs. It became a real one when this
 * feature moved a directory deeper, which is what exposed it.
 */
const BACKDOOR_WORKER = "backdoor.ts";

/**
 * Installs a backdoor by launching the worker, which walks the server path and
 * connects to each hop. Only one runs at a time: a second would fight the first
 * for the player's current server.
 */
function runBackdoor(ns: NS, host: string): boolean {
    const worker = findScriptOnHome(ns, BACKDOOR_WORKER);
    if (worker === null) return false;

    if (ns.scriptRunning(worker, "home")) return true;
    return ns.run(worker, 1, host) > 0;
}

function bestCashCrime(ns: NS): CrimeType {
    let best: CrimeType = "Mug";
    let maxRate = 0;
    for (const c of ["Mug", "Larceny", "Traffick Illegal Arms", "Homicide"] as CrimeType[]) {
        try {
            const s = ns.singularity.getCrimeStats(c);
            const rate = (s.money * ns.singularity.getCrimeChance(c)) / s.time;
            if (rate > maxRate) { maxRate = rate; best = c; }
        } catch { }
    }
    return best;
}

// ─── Augment purchasing ───

type AugTarget = { name: string; faction: FactionName; price: number; repRequired: number; currentRep: number };

interface AugSelectionFilter {
    excludeFaction?: FactionName;
    requireFavorBelow?: number;
    requireRepGap?: boolean;
}

function buyAffordableAugments(ns: NS, player: Player, owned: string[], recent: RecentLines): void {
    const gang = getGangFaction(ns);
    const seen = new Set(owned);
    let bought = true;

    while (bought) {
        bought = false;
        for (const faction of player.factions) {
            if (faction === gang) continue;
            const currentRep = ns.singularity.getFactionRep(faction);

            for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
                if (aug === "NeuroFlux Governor" || seen.has(aug)) continue;
                if (!ns.singularity.getAugmentationPrereq(aug).every(p => seen.has(p))) continue;
                if (currentRep < ns.singularity.getAugmentationRepReq(aug)) continue;

                const price = ns.singularity.getAugmentationPrice(aug);
                if (player.money < price) continue;

                if (ns.singularity.purchaseAugmentation(faction, aug)) {
                    note(recent, "ACTION", `Purchased ${aug} from ${faction} (${ns.format.number(price)})`, "tx");
                    seen.add(aug);
                    owned.push(aug);
                    player.money -= price;
                    bought = true;
                }
            }
        }
    }
}

function getBestAugmentation(
    ns: NS,
    player: Player,
    owned: readonly string[],
    filter: AugSelectionFilter = {},
): AugTarget | null {
    const gang = getGangFaction(ns);

    let donationBest: AugTarget | null = null;
    let normalBest: AugTarget | null = null;

    for (const faction of player.factions) {
        if (faction === gang) continue;
        if (filter.excludeFaction === faction) continue;

        const favor = effectiveFavor(ns, faction);
        if (filter.requireFavorBelow !== undefined && favor >= filter.requireFavorBelow) continue;

        const currentRep = ns.singularity.getFactionRep(faction);

        for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
            if (aug === "NeuroFlux Governor" || owned.includes(aug)) continue;
            if (!ns.singularity.getAugmentationPrereq(aug).every(p => owned.includes(p))) continue;

            const repRequired = ns.singularity.getAugmentationRepReq(aug);
            if (filter.requireRepGap && currentRep >= repRequired) continue;

            const price = ns.singularity.getAugmentationPrice(aug);
            const candidate: AugTarget = { name: aug, faction, price, repRequired, currentRep };

            if (currentRep < repRequired && canDonateToReach(ns, candidate, player, favor)) {
                if (!donationBest || price > donationBest.price) donationBest = candidate;
                continue;
            }

            if (!normalBest || price > normalBest.price) normalBest = candidate;
        }
    }

    return donationBest ?? normalBest;
}

function bestFactionWork(ns: NS, faction: FactionName): FactionWorkType {
    try {
        const types = ns.singularity.getFactionWorkTypes(faction) as FactionWorkType[];
        return types.includes("hacking") ? "hacking" : types.includes("field") ? "field" : types[0] ?? "hacking";
    } catch {
        return "hacking";
    }
}

/** The weakest combat skill, from the shared module that owns the decision. */
function lowestCombatStat(player: Player): CombatStat {
    return toGymStat(lowestCombatSkill(player));
}

/** Long skill name to the short code PlayerAction's gym action expects. */
function toGymStat(skill: CombatSkill): CombatStat {
    switch (skill) {
        case "strength": return "str";
        case "defense": return "def";
        case "dexterity": return "dex";
        case "agility": return "agi";
    }
}

/**
 * A training action for whatever the goal is waiting on, or null.
 *
 * Hacking goes to university and combat stats to the gym; the decision about
 * WHICH measurement to train is in lib/progression.ts, and the targets come from
 * the run's goal. Training can push money negative, which is fine.
 */
function statFloor(ns: NS, player: Player, goal: Goal | null): PlayerAction | null {
    // Which measurement to train is a pure decision; which gym or university is a
    // fact about the game. The targets come from the run's goal, so this
    // feature and sleeves train toward the same number — they used to disagree at
    // 100 and 75, and sleeve experience is shared with the player.
    const targets = trainingTargets(goal, FLOOR_FALLBACK);
    const under = belowFloor(player, targets);
    if (under === null) return null;

    // How long will this actually take?
    //
    // This branch used to return a training action unconditionally, with no view of
    // whether the target was reachable. A run whose floor was far out of range trained
    // forever — the reported case was 1.5 hours on one goal and nothing to show for it.
    //
    // The measurement being trained, and where the player currently stands on it.
    const skill: Stat = under.kind === "hacking" ? "hacking" : toStat(under.skill);
    const current = player.skills[STAT_KEYS[skill]];

    // Reachability is ONE shared decision (`floorReachable`), so this and the feature that
    // yields the activity slot for training reach the same verdict rather than each applying
    // half the rule. Passing the measured rate (null when there is none) is what lets the
    // shared predicate keep the "no baseline yet, keep going" behaviour.
    if (!floorReachable(under, current, measuredRate(skill))) {
        // Reported once per measurement rather than every tick, because the condition is
        // a fact about the run rather than an event: a reader needs to know why training
        // stopped, not to be told repeatedly that it is still stopped.
        const eta = etaSeconds(skill, under.target - current);
        log?.change(
            `floor:${under.kind}`, "Training", "abandoned",
            `${skill} target ${under.target} is ${formatEta(eta)} away at the measured rate ` +
            `(budget ${formatEta(REACH_SEC)}) — working on something reachable instead`,
        );
        return null;
    }

    if (under.kind === "hacking") {
        return { kind: "UNI", university: UNIVERSITY, course: UNI_HACKING, city: "Sector-12" };
    }
    return { kind: "GYM", gym: GYM, stat: toGymStat(under.skill as CombatSkill), city: "Sector-12" };
}

/** The last usable rate for a measurement, or null when there is none. */
function measuredRate(stat: Stat): number | null {
    return rateFor(rates, stat, Date.now())?.rate ?? null;
}

/** `CombatSkill` is the long name; `rates` and `STAT_KEYS` are keyed by the short code. */
function toStat(skill: CombatSkill | null): Stat {
    switch (skill) {
        case "strength": return "str";
        case "defense": return "def";
        case "dexterity": return "dex";
        case "agility": return "agi";
        default: return "hacking";
    }
}

/** A duration a reader can act on, rather than a raw second count. */
function formatEta(seconds: number): string {
    if (!Number.isFinite(seconds)) return "unmeasurable";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

function nextProgram(ns: NS, hacking: number): ProgramName | null {
    return INTEL_PROGRAMS.find(p => hacking >= p.req && !ns.fileExists(p.name, "home"))?.name ?? null;
}

// ─── Donations ───

function canDonateToReach(ns: NS, target: AugTarget, player: Player, favor: number): boolean {
    if (favor < DONATION_MIN_FAVOR) return false;
    const amount = donationAmountFor(ns, target, player, favor);
    if (amount <= 0) return false;
    return player.money >= amount + target.price;
}

function donationAmountFor(_ns: NS, target: AugTarget, player: Player, favor: number): number {
    const repNeeded = target.repRequired - target.currentRep;
    if (repNeeded <= 0) return 0;

    const favorMult = 1 + favor / 100;
    const repMult = player.mults.faction_rep ?? 1;
    return Math.ceil(repNeeded * 1e6 / (favorMult * repMult));
}

function donateForRep(ns: NS, target: AugTarget, player: Player, recent: RecentLines): boolean {
    const favor = effectiveFavor(ns, target.faction);
    if (favor < DONATION_MIN_FAVOR) return false;

    const amount = donationAmountFor(ns, target, player, favor);
    if (amount <= 0) return false;
    if (player.money < amount + target.price) return false;

    const ok = ns.singularity.donateToFaction(target.faction, amount);
    if (ok) {
        // An event: money left the account, which is exactly the kind of spend a
        // reader wants intact later when asking where the cash went.
        note(
            recent,
            "ACTION",
            `Donated ${amount.toLocaleString()} to ${target.faction} ` +
            `for ~${(target.repRequired - target.currentRep).toFixed(0)} rep toward ${target.name}`,
            "tx",
        );
    }
    return ok;
}

// ============================================================================
// CASH RESERVE
// ============================================================================

/**
 * Money to hold back for the next augmentation purchase, including the donation
 * it would need.
 *
 * This is planning output, not a side effect: it is written to the context so
 * every feature that spends money respects it. It used to be published through
 * `reserve_money.txt`, which cloud and hacknet read with a fallback of 0.
 */
function plannedReserve(ns: NS, player: Player, canBuyAugs: boolean): number {
    // No purchases to save for: on BitNode 8 augmentations come from grafting,
    // not from a reserve.
    if (!canBuyAugs) return 0;

    const target = getBestAugmentation(ns, player, ns.singularity.getOwnedAugmentations(true));
    if (target === null) return 0;

    const favor = effectiveFavor(ns, target.faction);
    const donation = target.currentRep < target.repRequired && favor >= DONATION_MIN_FAVOR
        ? donationAmountFor(ns, target, player, favor)
        : 0;
    const need = target.price + donation;

    // Only reserve once the purchase is nearly affordable, otherwise the reserve
    // would freeze every other feature's spending for a far-off target.
    return need - player.money <= need * 0.2 ? Math.ceil(need) : 0;
}

// ─── Companies ───

function corpHackingReq(ns: NS, company: CompanyName): number | null {
    try {
        return ns.singularity.getCompanyPositionInfo(company, ENTRY_JOB).requiredSkills.hacking;
    } catch {
        return null;
    }
}

function bestCompany(ns: NS, player: Player): CompanyName | null {
    return MEGACORPS.find(c => {
        if (isMemberOf(player, c)) return false;
        if (player.jobs[c]) return true;
        const req = corpHackingReq(ns, c);
        return req !== null && player.skills.hacking >= req;
    }) ?? null;
}

// ─── Training ───

function trackRate(ns: NS, player: Player): void {
    const w = ns.singularity.getCurrentWork() as unknown as Work | null;
    const stat = w?.type === "CLASS" ? CLASS_STAT[w.classType as string] : undefined;

    // Not in a class: there is nothing to measure, and the open observation is dropped so
    // that returning to a class starts a fresh window rather than comparing against a
    // reading taken before the interruption.
    if (!stat) { openSample = null; return; }

    // The measurement logic lives in `rate-tracker.ts`, which takes time as an argument
    // rather than reading a clock. That is what makes the training budget testable at all:
    // a test can simulate an hour of training and assert what the framework decides.
    const measured = observe(openSample, stat, player.skills[STAT_KEYS[stat]], Date.now());
    openSample = measured.open;
    if (measured.rate !== null) rates[stat] = measured.rate;
}

/**
 * Seconds to close `gap`, or `Infinity` when that cannot be estimated.
 *
 * `Infinity` rather than `0` for "no usable rate", and the difference is the whole point of
 * this function's shape. It used to return 0, which every consumer read as INSTANT — so a
 * target the framework had no measurement for was reported as `0s away`, and the faction path
 * summed such zeros into an ETA that looked reachable. `formatEta` prints `Infinity` as
 * "unmeasurable", which is what a reader needs to see.
 *
 * A rate of zero is also `Infinity` here, because a stat that is not rising will never close
 * a gap: `floorEtaSeconds` makes the same call for the same reason.
 */
function etaSeconds(stat: Stat, gap: number): number {
    const rate = measuredRate(stat);
    return floorEtaSeconds({ target: gap }, 0, rate ?? Number.NaN);
}

/**
 * Train toward membership of the faction the gang needs, or null when nothing is wanted.
 *
 * A NARROW version of `factionTraining`, for ONE named faction rather than whichever
 * looks cheapest. That difference is the point: `factionTraining` scores every faction by
 * gap and takes the best, which is right when the run is free to choose and wrong here,
 * because the gang's kind was already decided by the coin toss and only one faction can
 * serve it. Without this the run would drift toward whichever gang faction it happened to
 * qualify for, and the toss would decide nothing.
 *
 * Returns null wherever training would not help — already a member, or the outstanding
 * requirement is one training cannot move (kills, karma, money). Those mean the binding
 * constraint is elsewhere, and returning a training action anyway is the "1.5 hours on an
 * unreachable target" failure `training-budget.ts` exists to prevent.
 */
function trainForGangFaction(ns: NS, player: Player, faction: FactionName): PlayerAction | null {
    if (isMemberOf(player, faction)) return null;

    const req = FACTION_STAT_REQS[faction];
    if (req === undefined) return null;

    // The gates training cannot move. Karma is step 2's business and kills come from the
    // crimes there; no gang faction asks for money. If one of these is unmet the run is
    // blocked on something other than stats, and this is not the step that fixes it.
    if (req.karma !== undefined && player.karma > req.karma) return null;
    if (req.kills !== undefined && player.numPeopleKilled < req.kills) return null;
    if (req.money !== undefined && player.money < req.money) return null;

    const missing: { stat: "hacking" | CombatStat; gap: number }[] = [];
    if (req.hacking && player.skills.hacking < req.hacking) {
        missing.push({ stat: "hacking", gap: req.hacking - player.skills.hacking });
    }
    if (req.combat) {
        for (const stat of COMBAT) {
            const have = player.skills[STAT_KEYS[stat]];
            if (have < req.combat) missing.push({ stat, gap: req.combat - have });
        }
    }
    // No charisma branch: none of the seven gang factions asks for it. `FACTION_STAT_REQS`
    // would carry it if one did, and the check is left out rather than stubbed, because a
    // course name guessed here would be a silent failure at runtime.
    if (!missing.length) return null;

    // The same reachability rule the rest of this feature uses. A requirement whose
    // measured rate puts it hours away is not one to commit the run to, and the gang it
    // serves is not worth an unbounded detour — the fork in `factionTraining` applies
    // `REACH_SEC` for exactly this reason.
    const reachable = missing.reduce((sum, m) => sum + etaSeconds(m.stat as Stat, m.gap), 0) <= REACH_SEC;
    if (!reachable) return null;

    // The largest gap first, matching `factionTraining`'s choice of the nearest-to-met
    // requirement. Training the smallest gap closes a requirement without moving the
    // others; the largest is the one that actually gates membership.
    const worst = missing.reduce((a, m) => (m.gap > a.gap ? m : a));
    return worst.stat === "hacking"
        ? { kind: "UNI", university: UNIVERSITY, course: UNI_HACKING, city: "Sector-12" }
        : { kind: "GYM", gym: GYM, stat: worst.stat, city: "Sector-12" };
}

function factionTraining(ns: NS, player: Player): PlayerAction | null {
    const gang = getGangFaction(ns);

    const corpReqs: [FactionName, FactionRequirement][] = [];
    for (const c of MEGACORPS) {
        const hacking = player.jobs[c] ? null : corpHackingReq(ns, c);
        if (hacking) corpReqs.push([asFaction(c), { hacking }]);
    }

    let best: { action: PlayerAction; gap: number } | null = null;

    for (const [name, req] of [...factionEntries(FACTION_STAT_REQS), ...corpReqs]) {
        if (isMemberOf(player, name) || name === gang) continue;
        if (req.money !== undefined && player.money < req.money) continue;
        if (req.kills !== undefined && player.numPeopleKilled < req.kills) continue;
        if (req.karma !== undefined && player.karma > req.karma) continue;

        const missing: { stat: "hacking" | CombatStat; gap: number }[] = [];
        if (req.hacking && player.skills.hacking < req.hacking) {
            missing.push({ stat: "hacking", gap: req.hacking - player.skills.hacking });
        }
        if (req.combat) {
            for (const stat of COMBAT) {
                const have = player.skills[STAT_KEYS[stat]];
                if (have < req.combat) missing.push({ stat, gap: req.combat - have });
            }
        }
        if (!missing.length) continue;

        if (missing.reduce((s, m) => s + etaSeconds(m.stat, m.gap), 0) > REACH_SEC) continue;

        const gap = missing.reduce((s, m) => s + m.gap, 0);
        if (best && gap >= best.gap) continue;

        const m = missing[0];
        best = {
            gap,
            action: m.stat === "hacking"
                ? { kind: "UNI", university: UNIVERSITY, course: UNI_HACKING, city: "Sector-12" }
                : { kind: "GYM", gym: GYM, stat: m.stat, city: "Sector-12" },
        };
    }
    return best?.action ?? null;
}

// ─── Travel / factions ───

function travelForFaction(ns: NS, player: Player, owned: readonly string[]): PlayerAction | null {
    const gang = getGangFaction(ns);

    const qualifies = (faction: FactionName): boolean => {
        if (isMemberOf(player, faction) || faction === gang) return false;
        if (!factionWorthJoining(ns, faction, owned)) return false;

        const req = FACTION_STAT_REQS[faction] ?? {};
        if (req.hacking && player.skills.hacking < req.hacking) return false;
        if (req.combat && COMBAT.some(s => player.skills[STAT_KEYS[s]] < req.combat!)) return false;
        if (req.cha && player.skills.charisma < req.cha) return false;
        if (req.money && player.money < req.money) return false;
        if (req.kills && player.numPeopleKilled < req.kills) return false;
        if (req.karma !== undefined && player.karma > req.karma) return false;
        return true;
    };

    for (const [faction, valid] of factionEntries(FACTION_CITIES)) {
        if (valid.includes(player.city) && qualifies(faction)) return null;
    }

    const cities = new Map<CityName, number>();
    for (const [faction, valid] of factionEntries(FACTION_CITIES)) {
        if (!qualifies(faction)) continue;
        for (const c of valid) cities.set(c, (cities.get(c) ?? 0) + 1);
    }

    let best: { city: CityName; count: number } | null = null;
    for (const [city, count] of cities) {
        if (!best || count > best.count) best = { city, count };
    }
    return best ? { kind: "TRAVEL", city: best.city } : null;
}

function factionWorthJoining(ns: NS, faction: FactionName, owned: readonly string[]): boolean {
    if (!CITY_FACTIONS.has(faction)) return true;
    return ns.singularity
        .getAugmentationsFromFaction(faction)
        .some(a => a !== "NeuroFlux Governor" && !owned.includes(a));
}

// ─── Gang ───

/**
 * The faction of the gang the player is in, or `null`. Progression needs this to
 * avoid competing with the gang feature for the same faction, so the query stays
 * here rather than moving to the gang module: it is 2 GB and cross-cutting.
 */
function getGangFaction(ns: NS): FactionName | null {
    try {
        return ns.gang.inGang() ? ns.gang.getGangInformation().faction : null;
    } catch {
        return null;
    }
}

/**
 * Which kind of gang this run committed to, reading the flag or deciding it.
 *
 * WRITES THE FLAG THE FIRST TIME IT IS ASKED. That is deliberate rather than a caller's
 * job: the choice has to be made exactly once, and the only place that can guarantee
 * "exactly once" is the place that reads it. The draw is RANDOM PER RUN, not seeded by
 * anything, so each BitNode plays a different kind of gang — see `chosenGangKind` for why
 * a reproducible draw was tried first and abandoned.
 *
 * Returns null when the flag cannot be written, because a choice that will not persist
 * is worse than no choice: the next pass would flip again and the run would work toward
 * one kind of gang and then the other.
 */
function gangKindFor(ns: NS): GangKind | null {
    if (ns.fileExists(GANG_CHOICE_FLAG, "home")) {
        const stored = ns.read(GANG_CHOICE_FLAG).trim();
        // A flag holding anything unexpected is treated as absent rather than trusted:
        // an unreadable choice must not silently become a wrong one.
        if (stored === "hacking" || stored === "combat") return stored;
    }

    // Drawn per run, not seeded: this is a coin toss for the whole BitNode.
    const kind = chosenGangKind();
    try {
        ns.write(GANG_CHOICE_FLAG, kind, "w");
    } catch {
        return null;
    }
    announce(ns, "PROGRESSION", `Gang run: going for a ${kind} gang (${GANG_CHOICE_FLAG})`, "info");
    return kind;
}

/**
 * The faction whose membership the run needs for its gang, and whether it has it.
 *
 * Null when no gang can be created here at all — no Source File 2 outside BitNode 2 —
 * because then the whole question is moot and the run should not be detoured by it.
 *
 * `canCreate` is passed rather than probed. The orchestrator already pays for it as the
 * `createGang` capability, and `ns.getResetInfo()` — the call behind that probe — costs
 * 1 GB, which is not a per-tick price this feature should be paying. It is also the same
 * reading the orchestrator admitted the feature under, so the two cannot disagree.
 */
function gangTarget(
    ns: NS,
    player: Player,
    canCreate: boolean,
): { faction: FactionName; haveIt: boolean } | null {
    if (!canCreate) return null;
    if (getGangFaction(ns) !== null) return null;

    const kind = gangKindFor(ns);
    if (kind === null) return null;

    return gangFactionFor(kind, player.factions);
}
/**
 * Whether continuing to farm karma is still worth the player's time.
 *
 * True while **neither** target has been met, because the two are separate
 * goals for separate factions: a kill count for the combat gangs, deep karma
 * for the late-game ones. Farming stops as soon as either lands. Karma and kills
 * both accrue passively from Homicide anyway, so continuing past the first target
 * buys nothing and costs something.
 *
 * The cost is the point. Homicide lowers karma without bound, and karma far past
 * the target is not neutral: it closes off content that wants a less vicious
 * player. This replaced an `||`, which farmed while EITHER target was unmet and so
 * ran on to -240K karma against a -54K target, purely because the kill count had
 * not reached 30.
 *
 * Note `!getGangFaction(ns)` at the call site: being in a gang satisfies the
 * unlock this was farming for, so no further killing is wanted.
 */
function karmaFarmingWanted(player: Player, goal: Goal | null): boolean {
    // Targets from the goal where it names them, so the goal decides rather
    // than a constant. Reading player.karma rather than ns.heart.break() is the
    // same value from the snapshot, which is already in hand.
    return karmaFarmingWantedPure(player, karmaTargets(goal, KARMA_FALLBACK));
}
