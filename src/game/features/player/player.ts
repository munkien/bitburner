import { findScriptOnHome } from "../../lib/scripts.ts";
// The budget rule and the rate measurement live in `lib/` because the sleeves feature needs
// them too and features may not import each other (ADR 0001). Imported DIRECTLY from there
// rather than through a re-export in `progression.ts` or `rate-tracker.ts`: Bitburner's
// syntax checker compiles each file without resolving the whole graph, and a chain of bare
// re-exports is not something it can follow — that is what produced "Progression is deployed
// but would not compile".
import { REACH_SEC, floorEtaSeconds, floorReachable } from "../../lib/training-budget.ts";
import { TRAIN_CAP_MS, TRAIN_COOLDOWN_MS, capApplies, noteTraining, releaseIfTrainingStopped, trainCapVerdict } from "../../lib/training-cap.ts";
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
import { bladeburnerKeepsSlot, hasActiveBlackOp, hasActiveGraft, publishTrainingRate, trainingRemaining, trainingWantedHeld, winnableBlackOp } from "./activity.ts";
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
    // The promotion cadence is per company and outlives a tick. Clearing it on reset means
    // a test (or a reintroduced feature) does not inherit another's timers — the same
    // reason `rates` is cleared here rather than left to rot.
    lastPromotionAttempt.clear();
    for (const key of Object.keys(rates)) delete rates[key as MeasuredStat];
    // THE REST OF THE MEMORY, and its absence here was a real defect rather than a tidiness
    // one: `reset` is what a test calls to promise itself a clean slate, and it used to leave
    // four fields set. An augmented target from an earlier test, a stale `reason` string read
    // by the status line, and a gang-kind label all survived into the next scenario — the
    // kind of leak that makes a later test fail for a reason nothing in it explains.
    lastAugment = null;
    targetAugment = null;
    reason = "starting";
    gangKindLabel = undefined;
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
    //
    // THE BLACK OP HALF IS SKIPPED WITH THE BLADE'S SIMULACRUM, and it used not to be.
    // The augment means a Bladeburner action does not occupy the activity slot, so
    // standing down for one is giving away something the division never took — the same
    // argument the yield below already made for contracts, applied to the one branch that
    // still ignored it. Without this, a run holding the augment STILL stopped training
    // while a black op ran, which is most of the point of owning it.
    //
    // A GRAFT IS DIFFERENT and still yields unconditionally: Simulacrum frees the slot
    // from BLADEBURNER actions, not from grafting, and interrupting a graft destroys its
    // progress rather than pausing it.
    const slotsShared = !context.capabilities.has("bladesSimulacrum");
    if (yieldsForBlackOpOrGraft(ns, slotsShared)) {
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
            trainingWantedHeld(trainingRemaining(player, context.goal)),
        )
    ) {
        // THE TRAINING CAP IS ENFORCED EVEN WHEN YIELDING, and that is the fix for a gym
        // class that ran for seventeen minutes.
        //
        // Yielding means "assign nothing"; it does NOT stop what is already running. So a
        // class started earlier keeps running in the game's slot while progression returns
        // here every tick and never reaches the cap below, which sits after this return.
        // Measured: `progression: yielded ... (training not wanted)` alongside
        // `work: CLASS agi at Powerhouse Gym`, for as long as the run lasted.
        //
        // THERE IS NO API TO CANCEL THE PLAYER'S WORK — no `stopCurrentAction`, and
        // `stopBladeburnerAction` is Bladeburner's. The only way to take someone out of a
        // class is to START SOMETHING ELSE, which replaces it. A one-second crime is the
        // cheapest such action: it touches the slot, costs nothing to speak of, and leaves
        // the run free to pick its real next action on the following tick.
        //
        // Only fires when the budget is spent AND a class is actually running, so a normal
        // yield is untouched and a non-training activity is never interrupted.
        const inClass = ((): boolean => {
            try {
                return ns.singularity.getCurrentWork()?.type === "CLASS";
            } catch {
                return false;
            }
        })();
        // `noteTraining` BEFORE asking, because the player is demonstrably in a class and that
        // is what the clock measures. `trainCapVerdict` no longer starts a stretch as a side
        // effect of being asked — it used to, which meant this branch armed the timer without
        // meaning to, and a run that yielded for fifteen minutes had the cap fire against
        // training it never did. Reporting the sighting explicitly says what is true: the
        // player is in a class right now, so patience is being spent.
        if (inClass) noteTraining();
        if (inClass && trainCapVerdict() === "capped") {
            const crime = bestCashCrime(ns);
            // `commitCrime` returns the time it will take, not a success flag; a throw is
            // the only failure.
            const stopped = ((): boolean => {
                try {
                    ns.singularity.commitCrime(crime, false);
                    return true;
                } catch {
                    return false;
                }
            })();
            reason = stopped
                ? `yielded: Bladeburner keeps the slot (training capped, released the class)`
                : `yielded: Bladeburner keeps the slot (training capped, but the class could not be released)`;
            return;
        }

        reason = `yielded: Bladeburner keeps the slot${
            trainingWantedHeld(trainingRemaining(player, context.goal))
                ? " (chain running)"
                : " (training not wanted)"
        }`;
        return;
    }

    const chosen = prioritizeAction(ns, player, context.goal, context.goals, context.recent, canBuyAugs, context.capabilities.has("createGang"));
    if (chosen === null) {
        reason = "nothing to do: the priority chain returned no action";
        return;
    }

    // The training cap measures the run's PATIENCE with training, not any one action.
    //
    // Releasing it whenever the run chose something else was too eager and defeated the
    // cap: backdoors, the cash floor, travel and augment purchases all sit AHEAD of
    // training in the chain, so a mostly-training run takes a non-training action every so
    // often — and each one reset fourteen minutes of patience. Measured consequence: four
    // hours of training with the fifteen-minute cap never firing.
    //
    // Patience is now ended by ABSENCE. A sighting within `TRAIN_INTERRUPTION_MS` of the
    // last one continues the same stretch; a longer gap starts a fresh one.
    if (capApplies(chosen.kind)) {
        noteTraining();
        if (trainCapVerdict() === "capped") {
            // THE CAP IS APPLIED HERE, AT THE ONE PLACE EVERY ACTION PASSES THROUGH.
            //
            // It used to live inside `statFloor`, which is only ONE of five places that
            // produce gym or university actions — the others being `factionTraining`,
            // `trainForGangFaction`, and the idle fallback that trains "something" when no
            // goal is reachable. A run that stopped reaching the goal model went to the
            // fallback and trained for hours with the cap never consulted.
            //
            // Refusing here covers every producer without each of them having to remember.
            const stalled = `training capped after ${formatEta(TRAIN_CAP_MS / 1000)} — ` +
                `cooling down for ${formatEta(TRAIN_COOLDOWN_MS / 1000)} before it can start again`;
            log?.change("training-cap", "Training", "paused", stalled);
            reason = stalled;
            return;
        }
    } else {
        // Not training this tick. End the stretch only if the absence is real; a single
        // backdoor between two gym sessions must not reset the budget.
        releaseIfTrainingStopped();
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
/**
 * Choose the next action, in priority order, or null when nothing is worth doing.
 *
 * Exported for tests, because the ORDER is the fix for "megacorps are never worked for"
 * and nothing else pins it. `hireForGoal` can be perfectly correct and still never run if
 * it is placed after the training branch — which is precisely the state this shipped in:
 * every recorded run had zero COMPANY actions while the function that would have produced
 * one sat behind a branch that always had something to return.
 *
 * A test of `hireForGoal` alone cannot catch that. Only a test of this function can.
 */
export function prioritizeAction(
    ns: NS,
    player: Player,
    goal: Goal | null,
    /**
     * Every ranked goal, nearest first. `goal` is the head of this list.
     *
     * Both are passed because they answer different questions. The head decides what to
     * TRAIN toward; the full list decides whether an action the head cannot express — a
     * job application — is outstanding anywhere. Reading only the head was the bug that
     * left megacorps unworked: the head is a gang territory goal on a real run, so hiring
     * saw nothing to do on every tick of an entire session.
     */
    goals: readonly Goal[],
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

    // 4. A job at the megacorp the current goal names.
    //
    // HERE, ABOVE the stat floor, and the placement is the fix rather than a detail.
    //
    // The stat floor is not a fallible branch that sometimes has nothing to do: with no
    // measured rate yet — which is the state of every run until it has trained once —
    // `floorReachable` returns true by design ("no baseline yet, keep going"), so
    // `statFloor` answers every tick from the first one. Anything below it is dead code
    // on a fresh run.
    //
    // So "megacorps are never worked for" was not one ordering mistake but two: the
    // application sat at step 8 where the training branch pre-empted it, and even moving
    // it up one branch would have put it behind a floor that never declines. Employment
    // cannot be reached by training, so it has to be ahead of the branch that can only
    // train.
    //
    // Below the broke-state floor, deliberately: being unable to afford anything is a
    // more urgent fact than a job application.
    const hire = hireForGoal(ns, player, goals);
    if (hire) return hire;

    // 5. Stat floor: train what the goal is waiting on before pursuing
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

    // 7. Stat training for pending factions.
    //
    // Megacorps are NOT here: they are employment goals, handled above the stat floor.
    // This branch used to synthesize a `hacking` requirement for every megacorp the
    // player was not employed by, so it trained toward a job application it would never
    // make — qualified forever, employed never.
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

    // 9. Any megacorp job the player can hold, whether or not a goal names it.
    //
    // NO LONGER THE MAIN PATH, and the comment here used to imply it was. Hiring for a
    // GOAL is step 4, above the stat floor, because that is the only placement where it
    // is reachable at all. What is left for this step is the case a goal cannot express:
    // a player already employed somewhere, who should keep working there while no
    // employment goal is in front. `bestCompany` returns an existing employer first, so
    // that is what this does.
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

    // A CLASS THE PLAYER IS ALREADY TAKING IS LEFT ALONE.
    //
    // `universityCourse`/`gymWorkout` are not "start if not started": each call is a NEW
    // action, and the game finishes the running one to make room. Re-issuing them every
    // tick therefore tears the class down and rebuilds it once a second, forever — the
    // recorded flicker in `runs/2026-10-28T04.50.35`, one transition per second for ten
    // minutes with progression reporting "acting: course Computer Science" on both sides.
    //
    // The comment above `CLASS_STAT` has warned about this since the file was written
    // ("or `isDoingAction` never recognises the class and every tick restarts it"), but
    // the check was only ever wired into the COMPANY promotion path, so the guard the
    // comment described did not exist. This is that guard.
    //
    // Applied INSIDE each class branch, next to the city test it has to agree with. Hoisting
    // it above the `TRAVEL` branch would let it answer for a player who is in another city:
    // the slot still holds the old class until the trip completes, so "already studying"
    // would be true and the trip would never be issued.
    if (action.kind === "TRAVEL") {
        if (context.snapshot.player.city === action.city) return true;
        const ok = ns.singularity.travelToCity(action.city);
        if (ok) {
            announceAction(context, action);
        }
        return ok;
    }

    // PROMOTION HAPPENS ON THE PATH WHERE THE PLAYER IS ALREADY DOING THE ACTION.
    //
    // This used to sit BEFORE the `isDoingAction` check below, which is the placement that
    // made promotion impossible: an employed player working at the company hits that
    // return every tick, so the call above it was reached only on the FIRST tick — the one
    // that hires — and never again. The run held its entry-level position for the rest of
    // its life.
    //
    // So the two calls are split by state rather than by order: hiring is for a player who
    // is not working there yet, promotion for one who already is.
    if (action.kind === "COMPANY" && isDoingAction(current, action)) {
        maybePromote(ns, action.company, Date.now());
        return true;
    }

    if (action.kind === "COMPANY") ensureCompanyJob(ns, action.company, Date.now());

    let success = false;
    switch (action.kind) {
        case "GYM":
            // Only if already there. Travelling to reach a venue is a decision,
            // and it is made in `prioritizeAction` — see `isInCity`. Doing it
            // here as a side effect is what let two branches fight over the
            // player's location and cancel each other every tick.
            //
            // And only if the player is not already in THAT class — see `alreadyDoing`.
            if (isInCity(currentCityOf(ns), action.city ?? "Sector-12")) {
                success = alreadyDoing(ns, action) || ns.singularity.gymWorkout(action.gym, action.stat, false);
            }
            break;
        case "UNI":
            if (isInCity(currentCityOf(ns), action.city ?? "Sector-12")) {
                success = alreadyDoing(ns, action) || ns.singularity.universityCourse(action.university, action.course, false);
            }
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

/**
 * Whether the player is already in the class this action names.
 *
 * THE GUARD `assignAction` WAS MISSING, and the reason a class was restarted every
 * second. `universityCourse` and `gymWorkout` each begin a new action and finish whatever
 * was running, so issuing one for the class already in progress is not a no-op: it is a
 * tear-down. Only issuing it for a DIFFERENT class is a decision.
 *
 * Reads the slot LIVE rather than from the snapshot, for the same reason `currentCityOf`
 * does: the snapshot is captured once per pass, and the question here is about the state
 * the game is in when the call is made, not when the pass began.
 *
 * A failed read returns false — "not already doing it" — so the action is issued. The
 * alternative silences the run for the rest of its life, because the slot would look
 * occupied by something indistinguishable from what was wanted.
 *
 * Exported for `class-restart.test.ts`. It is the whole fix, and it is a comparison of one
 * game call against an action; reaching it through a full `tick` would mean standing up
 * every other feature to observe a single string comparison.
 */
export function alreadyDoing(ns: NS, a: PlayerAction): boolean {
    if (a.kind !== "UNI" && a.kind !== "GYM") return false;
    let current: Work | null;
    try {
        current = ns.singularity.getCurrentWork() as unknown as Work | null;
    } catch {
        return false;
    }
    return isDoingAction(current, a);
}

function isDoingAction(w: Work | null, a: PlayerAction): boolean {
    if (!w) return false;
    switch (a.kind) {
        case "GYM": return w.type === "CLASS" && w.classType === GYM_CLASS[a.stat] && w.location === a.gym;
        // The COURSE is compared as well as the university. Comparing only the university
        // would treat a switch from Computer Science to Algorithms as a class already in
        // progress and never issue it, stranding the run on the first course it chose.
        case "UNI": return w.type === "CLASS" && w.location === a.university && w.classType === a.course;
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

/**
 * Every field the game will hire into.
 *
 * THE LIST USED TO BE FOUR, and the four it kept were the software/business ones. The
 * game has more, and two of them are the only route in for a combat character: `Agent` is
 * the combat entry position, and a run built on strength could never be hired at all —
 * `ensureCompanyJob` tried Software, IT, Business and Security, every one of which wants
 * hacking, and returned having achieved nothing.
 *
 * The consultant and engineer variants are separate fields rather than promotions of the
 * base ones: `applyToCompany` takes a field and returns the highest position in it the
 * player qualifies for, so trying all of them is how a qualified player reaches the top.
 */
const COMPANY_FIELDS = [
    "Software", "Software Consultant",
    "IT", "Network Engineer",
    "Security", "Security Engineer",
    "Business", "Business Consultant",
    "Agent",
] as const;

/**
 * How often to apply for a promotion, in milliseconds.
 *
 * NOT every tick. `applyToCompany` costs 3 GB × 16/4/1 of static RAM and is a game call
 * per field, and promotion is gated on reputation and skills — neither of which moves
 * meaningfully between one tick and the next. A minute is frequent enough to catch a
 * promotion as it becomes available and rare enough that the call does not dominate the
 * pass.
 */
const PROMOTION_INTERVAL_MS = 60_000;

/** When each company was last asked for a promotion, so the cadence is per company. */
const lastPromotionAttempt = new Map<CompanyName, number>();

/**
 * Apply at a company, hiring if unemployed and asking for a promotion if not.
 *
 * WHY THIS EXISTS AT ALL. `applyToCompany` promotes — the game's own documentation says
 * so — but the old code only ever called it for an UNEMPLOYED player, because `assignAction`
 * returned early on `isDoingAction` before reaching here. So a run got its entry-level job
 * at all nine megacorps, worked one tick at each, settled on one, and stayed an intern
 * forever: rep accruing at the entry rate, which is the slowest in the game, for the whole
 * run. The augmentations those factions sell are gated on that rep.
 *
 * The two cases are the same call with a different field set, so they share the path:
 *   - unemployed   try every field, because the right one depends on the stats the run has.
 *   - employed     ask again in the field the player already holds, which is a promotion
 *                  application. Trying other fields would be applying for a parallel job,
 *                  which the game refuses while employed.
 *
 * Returns the position name on a successful hire or promotion, or null. The caller uses it
 * for the log line; the state change is the game's.
 */
export function ensureCompanyJob(ns: NS, company: CompanyName, now: number): JobName | null {
    const current = ns.getPlayer().jobs[company];
    const fields = current === undefined ? COMPANY_FIELDS : [FIELD_OF_JOB(current)];

    for (const field of fields) {
        if (field === null) continue;
        try {
            const got = ns.singularity.applyToCompany(company, field);
            if (got !== null) return got;
        } catch {
            // A refused application is ordinary; a thrown call means the API is not
            // answering, which is not worth propagating into the pass.
        }
    }
    return null;
}

/**
 * The field a held position belongs to, or null when it is not one this applies for.
 *
 * `applyToCompany` takes a FIELD and returns the best position in it, so a promotion has
 * to name the field the player is already in. The game gives no reverse lookup, so this
 * maps by the position's own name — the positions are the game's fixed strings and each
 * belongs to exactly one field.
 *
 * Null rather than a guess for a position this does not recognise: applying in the wrong
 * field is a rejected call, and a rejected call every minute for the life of the run is
 * worse than doing nothing.
 */
function FIELD_OF_JOB(job: JobName): (typeof COMPANY_FIELDS)[number] | null {
    const name = String(job).toLowerCase();
    if (name.includes("software")) return name.includes("consultant") ? "Software Consultant" : "Software";
    if (name.includes("network")) return "Network Engineer";
    if (name.includes("security engineer")) return "Security Engineer";
    if (name.includes("security")) return "Security";
    if (name.includes("business")) return name.includes("consultant") ? "Business Consultant" : "Business";
    if (name.includes("agent")) return "Agent";
    // `IT` LAST, and matched on a WORD BOUNDARY rather than as a substring.
    //
    // `includes("it")` is true for "Waiter", "Part-time Waiter", "Fitness Trainer",
    // "Accountant" and half the game's unrelated positions — so the earlier version
    // treated a waiter's job as an IT position and applied for a promotion in a field the
    // player does not hold. A refused call every minute, for the life of the run.
    //
    // Every other branch above is checked first, so by here the only positions left are
    // ones this feature does not promote. The `IT` match is therefore narrow on purpose.
    if (/\bit\b/.test(name)) return "IT";
    return null;
}

/**
 * Ask for a promotion at the company being worked for, at most once a minute.
 *
 * Separated from `ensureCompanyJob` so the cadence is explicit rather than implied by a
 * caller. Called from the work path, which runs every tick; the guard inside is what keeps
 * the game call to one a minute per company.
 *
 * Exported for tests. The cadence is the part that cannot be verified by reading
 * `tick` — it only shows as a count of `applyToCompany` calls over simulated time — and
 * getting it wrong is either a cost per tick or a promotion that never happens.
 */
export function maybePromote(ns: NS, company: CompanyName, now: number): void {
    const before = ns.getPlayer().jobs[company];
    // Not employed there: nothing to promote, and the check comes BEFORE the cadence clock
    // so a company the player does not work at never claims a slot in it.
    if (before === undefined) return;

    // `?? null` rather than `?? 0`, and the difference is a real bug rather than a style
    // choice. `Date.now()` is never 0, so defaulting to 0 looked harmless — but it makes
    // the FIRST attempt depend on the absolute clock: at any moment within the first
    // minute of epoch time, `now - 0` is below the interval and the promotion is skipped.
    // A test that drives `now` from 0 sees no attempt at all, which is how this was found.
    //
    // Null means "never attempted", which is not a time and must not be compared as one.
    const last = lastPromotionAttempt.get(company) ?? null;
    if (last !== null && now - last < PROMOTION_INTERVAL_MS) return;
    lastPromotionAttempt.set(company, now);

    const got = ensureCompanyJob(ns, company, now);
    if (got !== null && got !== before) {
        announce(ns, "PROGRESSION", `Promoted at ${company}: ${before} → ${got}`, "success");
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

/**
 * Buy every unowned augmentation the player can already afford, cheapest check first.
 *
 * NO NEUROFLUX GOVERNOR, and it is the only augmentation excluded here. It is skipped
 * because it is the one augmentation with no ceiling: its reputation requirement and its
 * price both rise with every copy bought, so it can absorb an unbounded share of a run's
 * cash. Buying it during the run competes directly with the finite augmentations whose
 * reputation the run is still farming, and it buys multipliers that are the weakest per
 * dollar in the game. It is worth buying only at the END, with money that has nowhere
 * else to go — which is exactly what `retire.ts:buyNeuroFlux` does once a reset is
 * decided and the queue is about to be installed.
 *
 * `neuroflux.test.ts` pins that split. The skip looks like a detail and is not: this loop
 * is the ONLY path that buys augmentations during a run, so removing the line below
 * silently turns every run into a NeuroFlux farm.
 *
 * Exported for that test alone — nothing else calls it, and `passiveTasks` passes the
 * locked `owned` list whose mutation-on-purchase the caller relies on.
 */
export function buyAffordableAugments(ns: NS, player: Player, owned: string[], recent: RecentLines): void {
    // THE GANG FACTION IS INCLUDED, deliberately.
    //
    // This loop used to skip it, and nothing else bought gang augmentations either — the
    // gang feature purchases EQUIPMENT, never augments — so a player leading a gang could
    // never buy what that gang offered.
    //
    // The skip looks like it was guarding the reputation check below: you cannot work for
    // a gang faction ("you are managing a gang for it"), and passive reputation is skipped
    // for it too, so its reputation only grows through other unlocks. But the game gates
    // gang augmentations on faction reputation exactly like any other faction, through the
    // same `purchaseAugmentation` path — so the check below is the right gate, and the
    // skip simply removed the only route to those augments.
    const seen = new Set(owned);
    let bought = true;

    while (bought) {
        bought = false;
        for (const faction of player.factions) {
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

/**
 * The next augmentation worth working toward, or null when none is left.
 *
 * NO NEUROFLUX GOVERNOR, for the reason `buyAffordableAugments` gives: it is unbounded
 * and buys the least per dollar, so it is not a target — it is what a run spends its
 * leftover cash on once retirement is decided. This function is what `prioritizeAction`
 * aims at and what `plannedReserve` sets money aside for, so including it here would
 * make EVERY run farm it: the target would always exist, the reserve would always be
 * held, and the finite augmentations would never be the thing the run was saving for.
 *
 * Exported for `neuroflux.test.ts`, which pins the exclusion at both purchase paths.
 */
export function getBestAugmentation(
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

    // The cap is applied in `tick`, at the point every action passes through, rather
    // than here. This function is only ONE of five producers of gym/university actions —
    // `factionTraining`, `trainForGangFaction` and the idle fallback all bypass it — so a
    // check here left the other four free to train indefinitely. That was the reported
    // four-hour stretch.

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

/**
 * Whether progression must stand down because something else owns the activity slot.
 *
 * A BLACK OP owns the slot only when it is SHARED — that is, when the run does not hold
 * The Blade's Simulacrum. The augment exists to let Bladeburner and the player's own work
 * proceed at once, so standing down for an op while holding it gives away something the
 * division never took. This branch used to do exactly that: the augment relaxed the
 * contract yield below it, and nothing relaxed this one, so a run with the augment still
 * stopped training during every black op.
 *
 * A GRAFT owns the slot unconditionally, augment or not. Simulacrum frees the slot from
 * BLADEBURNER actions, and grafting is not one; interrupting a graft destroys progress
 * that cannot be recovered by waiting.
 *
 * A FUNCTION RATHER THAN AN INLINE CONDITION, because the composed expression is where
 * the defect lived: three correct predicates joined by a flag that had been threaded into
 * one half and not the other. Naming it makes both halves assertable without a whole
 * `tick` fixture, and makes the asymmetry — `slotsShared` on one side, not the other —
 * something a reader has to see rather than something buried in an `||` chain.
 */
export function yieldsForBlackOpOrGraft(ns: NS, slotsShared: boolean): boolean {
    if (hasActiveGraft(ns)) return true;
    return slotsShared && (winnableBlackOp(ns) || hasActiveBlackOp(ns));
}

/**
 * Take a job at the megacorp ANY outstanding goal is waiting on, or null.
 *
 * WHY IT TAKES THE WHOLE GOAL LIST, which is the difference between this working and
 * this looking like it works. The first version read only `context.goal` — the head —
 * and that made the branch dead in practice for the same reason `bestCompany` was: the
 * head is almost never a megacorp. Recorded runs show it on gang territory, on a faction
 * stat race, on anything nearer than a join. An employment goal exists the whole time,
 * sitting in the queue, and nothing ever looked at it.
 *
 * `context.goals` exists precisely for this. Its own comment says it is there "so a
 * feature can ask whether a goal it can advance is outstanding ANYWHERE, not only whether
 * it is the one currently in front" — and hiring is exactly such a feature: it can only
 * move employment, and employment cannot be moved by the head's business.
 *
 * ORDERED BY THE LIST, which is already ranked nearest-first, so the megacorp the run is
 * closest to is the one applied for. The loop is bounded by the goal list, which is small
 * and already materialised.
 *
 * Returns null in three ordinary cases, all of which mean "not this function's job":
 *   - no goal in the list is about employment;
 *   - the player is already employed at every company that is (nothing to do, and
 *     re-applying is a no-op);
 *   - the entry bar is not met yet (`factionTraining` handles the skill gap, and applying
 *     without the skill is an action the game will refuse anyway).
 *
 * Exported for tests. It is the one branch that can close a megacorp goal, and its
 * failure mode — returning an action it should not, or none when it should — is a silent
 * regression no recording would show, because the run simply goes back to training.
 */
export function hireForGoal(ns: NS, player: Player, goals: readonly Goal[]): PlayerAction | null {
    for (const goal of goals) {
        if (goal.kind !== "faction") continue;

        const company = goal.subGoals.find(sub => sub.key === "employed")?.company;
        if (company === undefined) continue;
        if (player.jobs[company]) continue;

        // Whether the entry requirement is met. Read from the game rather than assumed:
        // the goal says "be employed", not "be qualified", and the two are different
        // states. An unreadable bar is null, which does NOT disqualify — blocking on a
        // figure that could not be read would mean never applying anywhere.
        const req = corpHackingReq(ns, company);
        if (req !== null && player.skills.hacking < req) continue;

        return { kind: "COMPANY", company };
    }

    return null;
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

/**
 * Train toward whichever faction is closest, or null when nothing is worth training for.
 *
 * Exported for tests, because its relationship with `hireForGoal` is the whole fix for
 * "megacorps are never worked for": this function must not claim a megacorp entry bar as
 * a training target, or it pre-empts the branch that can actually hire. That is a
 * property of the pair, and it is silent when wrong.
 */
export function factionTraining(ns: NS, player: Player): PlayerAction | null {
    const gang = getGangFaction(ns);

    // THE MEGACORP ENTRIES ARE GONE, and their absence is the fix.
    //
    // They used to be synthesized here as pure `hacking` requirements, which made the
    // chain circular: this function would train hacking toward a megacorp's entry bar,
    // return a UNI action, and so never reach step 8 where `bestCompany` would actually
    // APPLY for the job. Qualified forever, employed never.
    //
    // Megacorp goals now come from `MEGACORP_REQUIREMENTS` in the objective layer, gated
    // on `employedBy` rather than on a number. Training cannot satisfy employment, so it
    // also cannot pre-empt it, and the branch that CAN move it — `hireForGoal`, called
    // before this — gets its turn.
    void MEGACORPS;

    let best: { action: PlayerAction; gap: number } | null = null;

    for (const [name, req] of factionEntries(FACTION_STAT_REQS)) {
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
