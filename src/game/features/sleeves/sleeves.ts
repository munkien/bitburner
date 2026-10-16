// Type-only: every one of these is used as a type, and a value import makes the
// bare "@ns" specifier survive transpilation, which stops Node importing this
// file for tests. gang.ts already imports its types this way.
import type {
    NS,
    SleeveTask,
    FactionName,
    CompanyName,
    FactionWorkType,
    CityName,
} from "@ns";

import type { Context } from "../../lib/context.ts";
import { SLEEVE_MOVABLE, sleeveTrainingTarget } from "./sleeve-goals.ts";
// Rate measurement is shared with the player feature through `lib/`, not imported from it:
// a feature importing a feature would charge one's RAM to the other (ADR 0001). The module
// holding the rules that consume the rate is in `lib/` for the same reason.
import { observe, rateFor, type OpenSample, type RateSample } from "../../lib/rate-tracker.ts";
import { announce, shortError, type RecentLines } from "../../lib/log.ts";
import { rank, type Candidate } from "./score.ts";
import type { Goal, SubGoalKey } from "../../lib/objective.ts";
import { GOAL_TARGETS, type FactionRep } from "../../lib/objective.ts";

const CONFIG = {
    REQUIRE_SYNC: 100,
    REQUIRE_SHOCK: 0,

    COMBAT_BASELINE: 50,
    /**
     * Fallback only, used when the goal names no measurement a sleeve can
     * train. The live target comes from the run's goal, so this is not a
     * second source of truth: it used to be 75 while progression trained to 100,
     * and sleeve experience is shared with the player, so sleeves stopped short.
     */
    COMBAT_TARGET_FALLBACK: 100,
    TRAINING_LOCK_MS: 45_000,
    SWITCH_TOLERANCE: 3,

    AUG_BUDGET_PCT: 0.10,
    CASH_RESERVE: 1_000_000,
    MAX_SINGLE_AUG_PCT: 0.05,
    MIN_AUG_COST: 100_000,

    FACTION_WORK_ENABLED: true,
    COMPANY_WORK_ENABLED: true,
    COMPANY_WORK_ANY_JOB: true,

    WORK_LOCK_MS: 90_000,
    BLOCK_MS: 10 * 60_000,

    // `CASH_SLEEVE_COUNT` used to live here, reserving the last N sleeves for earning. It
    // was inert: it produced `cashSleeveStart`, which was passed to `manageSleeve` and never
    // read, so at its default of 0 it did nothing at all and no value of it would have
    // changed any assignment. Removing it rather than wiring it up, because the scoring is
    // where earning now belongs: a crime scores against a money goal, so a sleeve earns when
    // the run needs cash and trains when it does not. A second, index-based mechanism for
    // the same thing would be another list to keep in step with the goal.

    // ─── Bladeburner ───
    BB_MIN_CONTRACT_CHANCE: 0.75,
    BB_MAX_CHAOS: 1.5,

    // ─── Karma ───
    // The run's declared karma target, not a figure of this feature's own. It was -54_000
    // here and -54_000 in player.ts, two copies of one intent that nothing kept in step.
    // `GOAL_TARGETS.karma` is now the single definition.
    //
    // Widened to `number`: `GOAL_TARGETS` is `as const`, so this would otherwise be the
    // literal type -54000, and the `=== 0` sentinel check below would be a comparison with
    // no overlap — a compile error that would also make setting the target to 0 to disable
    // farming impossible to express.
    KARMA_TARGET: GOAL_TARGETS.karma as number,
    // Not a literal: KARMA_TARGET doubles as an on/off sentinel, and a literal
    // type would make the `KARMA_TARGET === 0` check in shouldFarmKarma()
    // provably false.
} satisfies Record<string, number | boolean>;

// ─── Bladeburner action strings (exact casing matters) ───

const BB_ACTION_CONTRACTS = "Take on contracts";
const BB_ACTION_SUPPORT_MAIN = "Support main sleeve";
const BB_ACTION_INFILTRATE = "Infiltrate Synthoids";
const BB_ACTION_DIPLOMACY = "Diplomacy";
const BB_ACTION_TRAINING = "Training";
const BB_ACTION_FIELD_ANALYSIS = "Field Analysis";
const BB_ACTION_RECRUITMENT = "Recruitment";

type BBRole =
    | "CONTRACT"
    | "SUPPORT_MAIN"
    | "INFILTRATE"
    | "CHAOS"
    | "TRAINING"
    | "FIELD_ANALYSIS"
    | "RECRUITMENT"
    /**
     * Retired as an assignable role, and deliberately kept.
     *
     * Karma farming is no longer something a sleeve is ASSIGNED — every sleeve except the
     * support one does it while the run is below the karma target, before any scored work
     * (see `manageSleeve`). No entry in `BB_ROLES_BY_INDEX` is ever this.
     *
     * The member stays because three call sites still test for it, and they are correct
     * guards rather than dead branches: if karma farming is ever made a per-sleeve choice
     * again, `tryBladeburnerSleeve` must not drag a karma sleeve into a contract, and the
     * candidate list must not offer one. Removing them would silently break that.
     */
    | "KARMA";

const BB_ROLES_BY_INDEX: readonly (BBRole | null)[] = [
    "SUPPORT_MAIN",  // sleeve 0
    "CONTRACT",      // sleeve 1
    "CONTRACT",      // sleeve 2
    "FIELD_ANALYSIS",            // sleeve 3 — faction / company work
    "CHAOS",         // sleeve 4
    "TRAINING",      // sleeve 5
    null,         // sleeve 6
];

const bbRoleFor = (i: number): BBRole | null => BB_ROLES_BY_INDEX[i] ?? null;

// ─── Static tables ───

type CombatSkill = "strength" | "defense" | "dexterity" | "agility";
type GymType = "str" | "def" | "dex" | "agi";

interface CombatStat {
    skill: CombatSkill;
    gym: GymType;
}

/** Whether a combat skill is one of the four, as opposed to charisma. */
function isCombatSkill(skill: CombatSkill): boolean {
    return COMBAT_STATS.some(stat => stat.skill === skill);
}

const COMBAT_STATS: readonly CombatStat[] = [
    { skill: "strength", gym: "str" },
    { skill: "defense", gym: "def" },
    { skill: "dexterity", gym: "dex" },
    { skill: "agility", gym: "agi" },
];

/**
 * What a sleeve does when nothing else applies.
 *
 * Homicide, for the same reason the player's own cash fallback picks it: it is the
 * highest-yielding crime by money per unit of time. It also drops karma, which is
 * worth having for the factions that gate on it and harmless otherwise, since
 * nothing in the framework avoids low karma.
 */
const FALLBACK_CRIME: CrimeType = "Homicide";

const GYM_BY_CITY: Record<CityName, GymLocationName> = {
    "Sector-12": "Powerhouse Gym",
    Aevum: "Snap Fitness Gym",
    Volhaven: "Millenium Fitness Gym",
    Chongqing: "Powerhouse Gym",
    "New Tokyo": "Powerhouse Gym",
    Ishima: "Powerhouse Gym",
};

const COMPANY_FACTIONS: Partial<Record<CompanyName, FactionName>> = {
    ECorp: "ECorp",
    MegaCorp: "MegaCorp",
    "KuaiGong International": "KuaiGong International",
    "Four Sigma": "Four Sigma",
    NWO: "NWO",
    "Blade Industries": "Blade Industries",
    "OmniTek Incorporated": "OmniTek Incorporated",
    "Bachman & Associates": "Bachman & Associates",
    "Clarke Incorporated": "Clarke Incorporated",
    "Fulcrum Technologies": "Fulcrum Secret Technologies",
};

// ─── Internal state ───

interface TrainingLock {
    gym: GymType;
    startedAt: number;
}

/**
 * Where a sleeve has been told to work.
 *
 * A discriminated union rather than `{ kind: "FACTION" | "COMPANY"; name: string }`,
 * because the two variants carry DIFFERENT name types and a bare `string` cannot say so.
 * The old shape forced casts at every point of use — `name as FactionName`,
 * `name as CompanyName`, `crime as CrimeType` — and a cast is exactly where a wrong
 * name stops being a compile error and becomes a silent no-op: the game refuses
 * `setToFactionWork` for a value that is not a faction, and the sleeve simply stays
 * idle. The union narrows on `kind`, so the casts are gone rather than suppressed.
 *
 * Narrowing on `kind` now gives the right type for free, so the casts are gone rather
 * than suppressed.
 */
type WorkTarget =
    | { readonly kind: "FACTION"; readonly name: FactionName; readonly workType: FactionWorkType; readonly selectedAt: number }
    | { readonly kind: "COMPANY"; readonly name: CompanyName; readonly selectedAt: number };

interface TickContext {
    sleeveCount: number;
    tasks: (SleeveTask | null)[];
    playerFactions: ReadonlySet<FactionName>;
    playerJobs: Record<string, unknown>;
    gym: GymLocationName;
    now: number;
    bladeburnerActive: boolean;
    playerKarma: number;
    /**
     * What the run is working toward, from the shared context rather than derived
     * here. Every feature reads the same goal, which is what stops a sleeve
     * and the progression feature disagreeing about a target.
     */
    goal: Goal | null;
    /**
     * Factions whose reputation still buys an augmentation, and what each needs.
     *
     * The snapshot's central reading (see `readReputation`) rather than a per-faction
     * recomputation here. Sleeve faction work and company work both exist to close these
     * gaps, so which faction to work for is a question about this list.
     */
    reputation: readonly FactionRep[];
}

/* ─── FEATURE STATE (persists across ticks) ─── */
/**
 * The orchestrator's recent-lines ring, for the tick in progress.
 *
 * Module state rather than a parameter because `assign` is called from thirteen
 * places and threading it through each would touch every one for no gain. The
 * alternative -- reading it from the context at each call site -- is the same
 * value written thirteen times.
 */
let currentRecent: RecentLines = { add: () => undefined, read: () => [] };

const trainingLocks: TrainingLock[] = [];
const workTargets: (WorkTarget | null)[] = [];
const blocked = new Map<string, number>();

/**
 * Each sleeve's training rate, and the reading it is being measured from.
 *
 * WHY SLEEVES MEASURE A RATE AT ALL. The scoring refuses a target that cannot be closed
 * within the training budget, which is the rule `lib/training-budget.ts` states and the
 * player feature applies to its own training. Applying it to a sleeve needs a rate, and
 * the game exposes none: `getSleeve` returns the sleeve's SKILLS, not how fast they rise.
 * Inventing a number would have meant guessing the one quantity the rule turns on, so the
 * rate is measured from the sleeve's own skills between ticks by `observe`, which is pure
 * and already built for exactly this.
 *
 * `open` holds the first reading of the window and `rates` the last measured result. Both
 * are per sleeve, because a sleeve sent to a different gym is a different measurement and
 * `observe` discards a window whose stat changed rather than blending the two.
 *
 * An absent or stale rate reads as "not measured" and the scoring treats that as a reason
 * to PROCEED, not to refuse — see `floorReachable`. A fresh run therefore trains normally
 * for the first minute or so, then starts declining targets it cannot reach.
 */
const sleeveRates: (RateSample | null)[] = [];
const sleeveOpenSamples: (OpenSample | null)[] = [];

/**
 * The last "no contract" diagnostic emitted per sleeve index.
 *
 * WHY THIS EXISTS. The diagnostic below describes a CONDITION — "this sleeve currently
 * holds no contract, and here is why" — but it was written to the ring unconditionally,
 * and the sleeves feature ticks every 5 seconds. Two sleeves therefore pushed two lines
 * into a 20-slot ring ten times a minute, so the ring held nothing but this message and
 * every other feature's output was pushed out of sight within seconds.
 *
 * That is the exact failure `lib/log.ts` documents at the top of its CHANGE LOGGING
 * section: "Every feature that runs on a two-second game tick logs state it re-reads
 * each time, and printing unconditionally fills the tail window with the same line
 * repeated." The file provides `ChangeLog`/`ChangeOnce` for it; this needed the plain
 * per-key form because the line is assembled from several sources rather than being one
 * label and one value.
 *
 * Keyed by sleeve and holding the full line, so a change in ANY part — which contracts
 * are taken, blocked or offered — is reported, while an unchanged condition is silent.
 * A condition that persists is not news; a condition that CHANGES is.
 */
const lastNoContractLine = new Map<number, string>();

const isBlocked = (key: string): boolean => (blocked.get(key) ?? 0) > Date.now();
const block = (key: string): void => { blocked.set(key, Date.now() + CONFIG.BLOCK_MS); };

/**
 * Forget everything this feature remembers between ticks.
 *
 * Exported for tests, and it exists because that memory is MODULE state: it lives for
 * the life of the process, so two tests in one run share it. `blocked` is the sharp
 * one — a refusal in one test silences the same target in the next, and a test that
 * expected a contract to be taken would see a crime instead, with no clue why. The
 * same bleed affects `workTargets` and `trainingLocks`, which is why
 * `sleeve-tasks.test.ts` had to invent a unique faction name per test.
 *
 * Not called in production: a restart clears the module anyway, and within a run this
 * memory is intentional.
 */
export function reset(): void {
    trainingLocks.length = 0;
    workTargets.length = 0;
    // The rate windows have to go with the rest. A test that measures a rate and then
    // starts a new scenario would otherwise have the next sleeve inherit a window taken
    // against a different sleeve's skills, which `observe` would happily turn into a rate.
    sleeveRates.length = 0;
    sleeveOpenSamples.length = 0;
    blocked.clear();
    lastNoContractLine.clear();
    currentRecent = { add: () => undefined, read: () => [] };
}

function describeTask(task: SleeveTask | null): string {
    if (!task) return "none";
    // Logging helper: reads whichever fields the current task variant carries.
    const t = task as unknown as Record<string, unknown>;
    const parts: string[] = [String(t.type ?? "?")];
    for (const key of [
        "actionType", "actionName", "classType", "crimeType",
        "factionName", "factionWorkType", "companyName",
    ]) {
        if (t[key] !== undefined) parts.push(`${key}=${JSON.stringify(t[key])}`);
    }
    return parts.join(" ");
}

export function tick(ns: NS, context: Context): void {
    currentRecent = context.recent;

    // The registry gates this feature on SF10/BN10, and getNumSleeves costs 4 GB,
    // so it is read here rather than in the orchestrator's capability probes.
    const sleeveCount = ns.sleeve.getNumSleeves();
    if (sleeveCount === 0) return;

    const ctx = buildContext(ns, context, sleeveCount, Date.now());

    refreshWorkTargets(ns, ctx);

    const bbClaimed = collectBladeburnerClaims(ns, ctx);

    for (let i = 0; i < sleeveCount; i++) {
        if (!trainingLocks[i]) trainingLocks[i] = { gym: "str", startedAt: 0 };
        if (workTargets[i] === undefined) workTargets[i] = null;
        // Before the choice, so the rate this tick's decision uses includes this tick's
        // reading. Measuring after would make the scoring act on the previous tick's sample
        // and lag the sleeve by one interval.
        measureSleeveRate(i, ns.sleeve.getSleeve(i));
        manageSleeve(ns, ctx, i, bbClaimed);
    }

    buySleeveAugs(ns, ctx);
}

/* ========================================================================== */
/* Per-tick context                                                           */
/* ========================================================================== */

function buildContext(ns: NS, context: Context, sleeveCount: number, now: number): TickContext {
    const tasks: (SleeveTask | null)[] = new Array(sleeveCount);
    for (let i = 0; i < sleeveCount; i++) {
        try { tasks[i] = ns.sleeve.getTask(i); } catch { tasks[i] = null; }
    }

    const { player } = context.snapshot;

    // Sleeves can only take Bladeburner actions once the division is available,
    // either from inside it or via the augmentation that grants access. Both are
    // capability facts, so neither is probed here.
    //
    // The augment half is now the shared `bladesSimulacrum` capability rather
    // than a local string comparison. Besides removing a second place to spell
    // the name, the local version compared against "Blade's Simulacrum" while the
    // game's own name is "The Blade's Simulacrum" — a check that would never have
    // matched, silently leaving sleeves unable to take Bladeburner tasks.
    const bladeburnerActive =
        context.capabilities.has("bladeburner") ||
        context.capabilities.has("bladesSimulacrum");

    return {
        sleeveCount,
        tasks,
        playerFactions: new Set(player.factions),
        playerJobs: player.jobs,
        gym: GYM_BY_CITY[player.city] ?? "Powerhouse Gym",
        now,
        bladeburnerActive,
        playerKarma: player.karma,
        goal: context.goal,
        // The central reading of which factions still want reputation, from the snapshot.
        // This used to be recomputed here through the Singularity API, separately from
        // `player.ts` and `share.ts`; reading the snapshot means all three see the same
        // factions with the same targets.
        reputation: context.snapshot.reputation,
    };
}

function collectBladeburnerClaims(ns: NS, ctx: TickContext): Set<string> {
    const claimed = new Set<string>();

    try {
        const playerAction = ns.bladeburner.getCurrentAction();
        // "Contracts" is the action type the game reports; "Contract" is not a
        // valid BladeburnerActionType and silently matches nothing.
        if (playerAction?.type === "Contracts") claimed.add(playerAction.name);
    } catch { }

    // Every BLADEBURNER action, not only contracts. "Support main sleeve" is shared
    // in exactly the same way — one sleeve can hold it — so leaving it out meant a
    // second sleeve asked for it and was refused on every tick.
    for (const t of ctx.tasks) {
        if (!t || t.type !== "BLADEBURNER") continue;
        const bb = t as { actionType?: string; actionName?: string };
        if (bb.actionType === "Contracts" && bb.actionName) claimed.add(bb.actionName);
    }

    // Sleeve 0's Support action, which its role assigns without consulting `claimed`
    // at all (it is the first branch in `tryBladeburnerSleeve`). Recording it here is
    // what lets the CONTRACT fallback see that the action is taken.
    for (let i = 0; i < ctx.tasks.length; i++) {
        if (bbRoleFor(i) === "SUPPORT_MAIN") claimed.add(BB_ACTION_SUPPORT_MAIN);
    }

    return claimed;
}

/**
 * What OTHER sleeves hold, which is the question a picker actually needs answered.
 *
 * `claimed` as built above includes every sleeve's own holding, so asking it "does
 * someone have this contract" is true for the sleeve that has it. That is what made
 * each contract sleeve abandon its own contract and take its neighbour's — and
 * `claimed` is also MUTATED as the tick assigns, so it doubles as the running record
 * of what has been given out this pass. This returns a view with `self` removed,
 * leaving the mutation semantics intact for everything else.
 */
function claimedByOthers(claimed: Set<string>, self: SleeveTask | null): Set<string> {
    const held = heldContract(self);
    if (held === null || !claimed.has(held)) return claimed;
    const other = new Set(claimed);
    other.delete(held);
    return other;
}

/* ========================================================================== */
/* Sleeve management                                                          */
/* ========================================================================== */

function manageSleeve(
    ns: NS,
    ctx: TickContext,
    i: number,
    bbClaimed: Set<string>,
): void {
    const sleeve = ns.sleeve.getSleeve(i);
    const task = ctx.tasks[i];

    if (sleeve.shock > CONFIG.REQUIRE_SHOCK) {
        assign(ns, i, task, "RECOVERY",
            () => ns.sleeve.setToShockRecovery(i),
            `Shock recovery (${sleeve.shock.toFixed(1)}%)`);
        return;
    }

    if (sleeve.sync < CONFIG.REQUIRE_SYNC) {
        assign(ns, i, task, "SYNCHRO",
            () => ns.sleeve.setToSynchronize(i),
            `Synchronizing (${sleeve.sync.toFixed(1)}%)`);
        return;
    }

    // Karma first, before any scored work, and for every sleeve except the one
    // supporting the main sleeve.
    //
    // WHY THIS IS AHEAD OF THE SCORING. Several factions gate on the PLAYER's karma —
    // Slum Snakes, Tetrads, Silhouette, Speakers for the Dead, The Dark Army, The
    // Syndicate — and karma is shared, so a sleeve committing Homicide lowers it for the
    // whole run. Nothing else a sleeve can do opens those factions, and a sleeve that
    // spends its early life on faction rep for a faction already joinable is not making
    // progress the run is waiting on.
    //
    // WHY NOT THE SUPPORT SLEEVE. Sleeve 0's whole job is multiplying the MAIN player's
    // output, and its value compounds over the run rather than arriving at a fixed point.
    // Grinding it would trade a permanent multiplier for a karma target the other sleeves
    // reach on their own, only slightly later.
    //
    // This used to be gated on `bbRoleFor(i) === "KARMA"`, which made it DEAD CODE: no
    // index in BB_ROLES_BY_INDEX is ever assigned that role, so the branch could not be
    // reached and no sleeve ever farmed. `shouldFarmKarma` was written, documented, and
    // never called from a reachable path — which is also why the karma target went unmet
    // in runs where it was clearly needed.
    if (shouldFarmKarma(ctx) && bbRoleFor(i) !== "SUPPORT_MAIN") {
        assign(ns, i, task, "CRIME",
            () => ns.sleeve.setToCommitCrime(i, "Homicide"),
            `Karma: Homicide (${ctx.playerKarma.toFixed(0)} / ${CONFIG.KARMA_TARGET})`,
            "Homicide");
        return;
    }

    // Score what this sleeve could do and take the best, rather than walking a
    // fixed chain of ifs. See lib/sleeve-score.ts for the weights and why they
    // order the way they do.
    //
    // The chain this replaced had two faults that scoring removes. Training ran
    // first and returned, so a sleeve under the training target never reached the work
    // path that produces the reputation sleeve augmentations are gated on. And
    // which task a sleeve got was decided by its index in BB_ROLES_BY_INDEX, so a
    // sleeve's job depended on its position rather than on what the run needed.
    //
    // The role table survives as candidate ORDER, which breaks ties. That keeps
    // its useful knowledge — "one sleeve supports your main, two run contracts" —
    // as a preference rather than an override.
    const candidates = sleeveCandidates(ns, ctx, i);

    for (const { candidate } of rank(candidates, ctx.goal, SLEEVE_MOVABLE)) {
        if (executeCandidate(ns, ctx, i, task, candidate, bbClaimed)) return;
    }

    // Nothing scored. This is unreachable while sleeveCandidates always offers a
    // crime, which is deliberate: a sleeve earns money and experience that it
    // shares with the player whatever else is unavailable, so there is no state in
    // which doing nothing is the better choice.
    //
    // Left as an idle rather than removed, because a sleeve that cannot be
    // assigned anything must not be left running a stale task from a role it no
    // longer has. The candidate list is asserted non-empty in tests.
}

/* ========================================================================== */
/* Karma                                                                      */
/* ========================================================================== */

function shouldFarmKarma(ctx: TickContext): boolean {
    if (CONFIG.KARMA_TARGET === 0) return false;
    return ctx.playerKarma > CONFIG.KARMA_TARGET;
}

/* ========================================================================== */
/* Bladeburner                                                                */
/* ========================================================================== */

function tryBladeburnerSleeve(
    ns: NS,
    ctx: TickContext,
    i: number,
    task: SleeveTask | null,
    claimed: Set<string>,
): boolean {
    const role = bbRoleFor(i);
    if (!role) return false;
    if (role === "KARMA") return false;

    const sleeve = ns.sleeve.getSleeve(i);

    if (role === "CONTRACT" && combatAverage(sleeve) < CONFIG.COMBAT_BASELINE) {
        return false;
    }

    if (role === "SUPPORT_MAIN") {
        return assign(ns, i, task, "BLADEBURNER",
            () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_SUPPORT_MAIN),
            "BB: Support main sleeve", BB_ACTION_SUPPORT_MAIN);
    }

    if (role === "INFILTRATE") {
        return assign(ns, i, task, "BLADEBURNER",
            () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_INFILTRATE),
            "BB: Infiltrate Synthoids", BB_ACTION_INFILTRATE);
    }

    if (role === "CHAOS") {
        if (shouldDoDiplomacy(ns)) {
            return assign(ns, i, task, "BLADEBURNER",
                () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_DIPLOMACY),
                "BB: Diplomacy", BB_ACTION_DIPLOMACY);
        }
    }

    if (role === "TRAINING") {
        return assign(ns, i, task, "BLADEBURNER",
            () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_TRAINING),
            "BB: Training", BB_ACTION_TRAINING);
    }

    if (role === "FIELD_ANALYSIS") {
        return assign(ns, i, task, "BLADEBURNER",
            () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_FIELD_ANALYSIS),
            "BB: Field Analysis", BB_ACTION_FIELD_ANALYSIS);
    }

    if (role === "RECRUITMENT") {
        return assign(ns, i, task, "BLADEBURNER",
            () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_RECRUITMENT),
            "BB: Recruitment", BB_ACTION_RECRUITMENT);
    }

    if (role === "CONTRACT" || role === "CHAOS") {
        // What OTHER sleeves hold. Passing `claimed` whole would tell this sleeve
        // that its own contract is taken, which is what made it look for a better
        // one and evict its neighbour — see the note on `pickContractForSleeve`.
        const others = claimedByOthers(claimed, task);
        const contract = pickContractForSleeve(ns, i, task, others);

        // Diagnose the case that is otherwise invisible: a sleeve that keeps coming
        // back to this branch while holding nothing. The ring shows the ATTEMPT and its
        // outcome, but not WHY the picker chose nothing, which left a live loop
        // (`REJECTED none → BB: Tracking` repeating) with no way to tell whether the
        // hold had been lost, the contract was blocked, or the sweep was returning the
        // same name every tick.
        //
        // Emitted on CHANGE rather than every tick, because the condition persists for
        // as long as it takes the blocking cooldown to expire — minutes, against a
        // 5-second tick and a 20-line ring. Printed unconditionally this was the only
        // thing the ring ever held. The line is remembered whole, so any change in what
        // is taken, blocked or offered still reports, and the first occurrence after
        // the condition clears reports again.
        if (contract === null && heldContract(task) === null) {
            const line =
                `Sleeve ${i}: no contract — held=none taken=[${[...others].join("|")}] ` +
                `blocked=[${blockedContracts()}] offered=[${contractNames(ns).join("|")}]`;
            if (lastNoContractLine.get(i) !== line) {
                lastNoContractLine.set(i, line);
                currentRecent.add("SLEEVES", line);
            }
        } else {
            // The condition cleared: forget it, so a recurrence is reported rather than
            // suppressed by a stale comparison.
            lastNoContractLine.delete(i);
        }

        if (contract) {
            claimed.add(contract);
            // The return value matters here. The game can refuse a contract for
            // reasons the framework cannot predict — it knows only the count and the
            // estimated chance, not every precondition the division applies — and a
            // refusal used to be reported as handled. That left the sleeve with no
            // task and the SAME request repeating every tick, which is the
            // `REJECTED none → BB: Tracking` seen live. Declining lets the caller try
            // its next candidate instead.
            if (assign(ns, i, task, "BLADEBURNER",
                () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_CONTRACTS, contract),
                `BB: ${contract}`, contract)) {
                return true;
            }
            // Remember the refusal, using the same cooldown the faction and company
            // paths already use. Without it the sleeve retries the refused contract on
            // every tick forever, which is not progress even once the fallback works:
            // the panel fills with the same rejection and each attempt costs a call.
            block(`BB:${contract}`);
            claimed.delete(contract);
        }
        // No contract available, or the one offered was refused. The fallback is
        // Support main sleeve — but that is a shared action too, and asking for it
        // when another sleeve already holds it is refused as well, so it is offered
        // only when it is genuinely free.
        if (!claimed.has(BB_ACTION_SUPPORT_MAIN)) {
            claimed.add(BB_ACTION_SUPPORT_MAIN);
            if (assign(ns, i, task, "BLADEBURNER",
                () => ns.sleeve.setToBladeburnerAction(i, BB_ACTION_SUPPORT_MAIN),
                "BB: Support main sleeve", BB_ACTION_SUPPORT_MAIN)) {
                return true;
            }
            claimed.delete(BB_ACTION_SUPPORT_MAIN);
        }
        return false;
    }

    return false;
}

/**
 * Everything this sleeve could do, best-scoring first once ranked.
 *
 * Candidate order matters: `rank` breaks ties by it, so the order here IS the
 * old role table, kept as a preference rather than an override. Sleeve 0 leads
 * with supporting the main sleeve, 1 and 2 with contracts, and so on down
 * BB_ROLES_BY_INDEX, with the generic options after.
 *
 * Only candidates that are actually available are offered. A work target that was
 * not assigned this tick is not a candidate, and neither is training a stat that
 * is already at target, so the list reflects what is possible rather than what is
 * conceivable.
 */
function sleeveCandidates(ns: NS, ctx: TickContext, i: number): Candidate[] {
    const sleeve = ns.sleeve.getSleeve(i);
    const role = bbRoleFor(i);
    const candidates: Candidate[] = [];

    // Repair first when it applies: shock and sync multiply what everything else
    // earns, so they are the rate at which work converts rather than work itself.
    // The tick already handles them before reaching the choice, so they are not
    // offered here.

    if (ctx.bladeburnerActive && role !== null && role !== "KARMA") {
        const contract = role === "CONTRACT" || role === "CHAOS" ? "Contracts" : role;
        candidates.push({
            kind: "BLADEBURNER",
            // Described rather than specified: `tryBladeburnerSleeve` takes the action
            // from `bbRoleFor(i)` and ignores this entirely. It exists so the log says
            // why the sleeve is on a Bladeburner task.
            what: contract,
            why: `role slot ${i}`,
        });
    }

    // Faction work: the only route to the reputation sleeve augmentations need.
    const target = workTargets[i];
    if (target !== null && target !== undefined && i < ctx.sleeveCount) {
        if (target.kind === "FACTION") {
            candidates.push({
                kind: "FACTION_WORK",
                faction: target.name,
                missingRep: 0,
            });
        } else {
            candidates.push({ kind: "COMPANY_WORK", company: target.name, missingRep: 0 });
        }
    }

    // Training, offered for the stat the goal needs when it can name one, and for the
    // weakest combat stat otherwise. See `getTrainingStat` for why the goal wins.
    // The target comes from the run's goal, not from a constant here. That
    // is the fix for sleeves stopping at 75 while progression wanted 100.
    const wanted = sleeveTrainingTarget(ctx.goal);
    const trainingTarget = wanted?.target ?? CONFIG.COMBAT_TARGET_FALLBACK;
    const trainingStat = getTrainingStat(i, sleeve, trainingTarget, preferredCombatStat(wanted?.key));
    if (trainingStat !== null) {
        candidates.push({
            kind: "TRAIN",
            stat: isCombatSkill(trainingStat.skill) ? "combat" : "cha",
            current: sleeve.skills[trainingStat.skill],
            target: trainingTarget,
            // The measured rate, so the scoring can refuse a target this sleeve cannot
            // close within the budget. Null until a window has been observed, and the
            // scoring treats null as "proceed".
            ratePerSecond: sleeveRate(i),
        });
    }

    // A crime is always available: it needs no faction, no job, no stat floor and
    // no division, and a sleeve earns money and experience from it either way. It
    // is offered last so it loses on score to anything that advances the goal,
    // and it is what makes the candidate list never empty.
    candidates.push({ kind: "CRIME", crime: FALLBACK_CRIME });

    return candidates;
}

/**
 * Perform a scored candidate, returning whether it took.
 *
 * Execution is unchanged from the fixed chain this replaced: the same calls with
 * the same arguments. What changed is which one is reached, not what it does.
 */
function executeCandidate(
    ns: NS,
    ctx: TickContext,
    i: number,
    task: SleeveTask | null,
    candidate: Candidate,
    bbClaimed: Set<string>,
): boolean {
    switch (candidate.kind) {
        case "BLADEBURNER":
            return tryBladeburnerSleeve(ns, ctx, i, task, bbClaimed);

        case "FACTION_WORK": {
            const target = workTargets[i];
            if (target === null || target === undefined) return false;
            return assignWorkTarget(ns, ctx, i, task, target);
        }

        case "COMPANY_WORK": {
            const target = workTargets[i];
            if (target === null || target === undefined) return false;
            return assignWorkTarget(ns, ctx, i, task, target);
        }

        case "TRAIN": {
            const sleeve = ns.sleeve.getSleeve(i);
            const wanted = sleeveTrainingTarget(ctx.goal);
            const trainingStat = getTrainingStat(
                i, sleeve,
                wanted?.target ?? CONFIG.COMBAT_TARGET_FALLBACK,
                preferredCombatStat(wanted?.key),
            );
            if (trainingStat === null) return false;
            return assign(ns, i, task, "CLASS",
                () => ns.sleeve.setToGymWorkout(i, ctx.gym, trainingStat.gym),
                `Training ${trainingStat.skill}`, trainingStat.gym);
        }

        case "CRIME": {
            return assign(ns, i, task, "CRIME",
                () => ns.sleeve.setToCommitCrime(i, candidate.crime),
                `Crime: ${candidate.crime} (nothing else to do)`, candidate.crime);
        }

        case "SYNC":
        case "SHOCK_RECOVERY":
            // Handled before the choice, so they never reach here.
            return false;
    }
}

function combatAverage(sleeve: ReturnType<NS["sleeve"]["getSleeve"]>): number {
    return (sleeve.skills.strength + sleeve.skills.defense +
        sleeve.skills.dexterity + sleeve.skills.agility) / 4;
}

function shouldDoDiplomacy(ns: NS): boolean {
    try {
        const city = ns.bladeburner.getCity();
        return ns.bladeburner.getCityChaos(city) > CONFIG.BB_MAX_CHAOS;
    } catch {
        return false;
    }
}

/**
 * The contract this sleeve should run, preferring the one it already holds.
 *
 * The stability rule, and the reason this function has a comment this long: a
 * Bladeburner contract is shared state. Two sleeves cannot run the same one, so
 * choosing is a mutual-exclusion problem, and the first version of this got it
 * wrong in a way that thrashed forever:
 *
 *   Sleeve 1 held Tracking, sleeve 2 held Retirement.
 *   The picker skipped names in `claimed` — which included BOTH sleeves' own
 *   holdings — then took the highest-level contract still free. Since neither
 *   sleeve recognised its own name as "mine", each looked for a better one, took
 *   the one the other was holding, and was in turn evicted. Two switches per
 *   tick, indefinitely.
 *
 * `claimed` is therefore split into two questions rather than one:
 *
 *   "is this MINE?"        -> keep it, regardless of level
 *   "does someone else have it?" -> leave it alone
 *
 * The first question has to be asked with the sleeve's own current task, because
 * that is the only place the answer is recorded.
 */
function pickContractForSleeve(
    ns: NS,
    i: number,
    currentTask: SleeveTask | null,
    /** Contracts held by OTHER sleeves and the player. Never contains this sleeve's own. */
    claimed: Set<string>,
): BladeburnerContractName | null {
    // Keep what we have if it is still runnable. This is the branch that stops the
    // swap: a sleeve holding a valid contract never looks for a better one.
    const held = heldContract(currentTask);
    if (held !== null && isContractValid(ns, i, held)) {
        return held;
    }

    let best: { name: BladeburnerContractName; level: number } | null = null;

    for (const name of ns.bladeburner.getContractNames()) {
        try {
            if (claimed.has(name)) continue;
            // A contract the game has already refused for this sleeve is not offered
            // again until the cooldown expires. The refusal reasons are not documented,
            // so this is the only way to learn them: try, and if refused, stop trying
            // for a while. Without it the sleeve re-attempts on every tick.
            if (isBlocked(`BB:${name}`)) continue;
            if (ns.bladeburner.getActionCountRemaining("Contracts", name) <= 0) continue;

            const [minChance] = ns.bladeburner.getActionEstimatedSuccessChance(
                "Contracts", name, i,
            );
            if (minChance < CONFIG.BB_MIN_CONTRACT_CHANCE) continue;

            const level = ns.bladeburner.getActionCurrentLevel("Contracts", name);
            if (!best || level > best.level) best = { name, level };
        } catch { }
    }

    return best?.name ?? null;
}

/**
 * Every contract name the division currently offers, for diagnostics.
 *
 * Wrapped because `getContractNames` throws when the player is not in the division,
 * and a diagnostic must not be the thing that breaks the tick.
 */
function contractNames(ns: NS): string[] {
    try {
        return [...ns.bladeburner.getContractNames()];
    } catch {
        return [];
    }
}

/**
 * Which contract names are currently under a refusal cooldown.
 *
 * Reports the whole set rather than a caller's subset, because the question a loop
 * raises is "why is nothing being chosen" and a filtered view answers a narrower one.
 */
function blockedContracts(): string {
    return [...blocked.keys()]
        .filter(key => key.startsWith("BB:") && isBlocked(key))
        .map(key => key.slice("BB:".length))
        .join("|");
}

/** The contract this sleeve is running, or null when it is running something else. */
function heldContract(task: SleeveTask | null): BladeburnerContractName | null {
    if (!task || task.type !== "BLADEBURNER") return null;
    const bb = task as { actionType?: string; actionName?: string };
    if (bb.actionType !== "Contracts" || !bb.actionName) return null;
    // The task reports its action name untyped; it is a contract name.
    return bb.actionName as BladeburnerContractName;
}

/**
 * Whether this sleeve can still run `name`.
 *
 * Deliberately identical to the sweep's own filters, and it has to STAY identical:
 * the keep-what-we-have branch returns early on this answer, so anything the sweep
 * refuses but this accepts means a sleeve holds a contract the picker would not have
 * chosen — and the two disagree about the same contract. The `isBlocked` check was
 * missing here and present in the sweep, which is exactly that mismatch.
 *
 * `claimed` is NOT checked: the caller passes a set with this sleeve's own holding
 * removed, and a contract this sleeve already runs is not contested with itself.
 */
function isContractValid(ns: NS, i: number, name: BladeburnerContractName): boolean {
    if (isBlocked(`BB:${name}`)) return false;

    try {
        if (ns.bladeburner.getActionCountRemaining("Contracts", name) <= 0) return false;
        const [minChance] = ns.bladeburner.getActionEstimatedSuccessChance(
            "Contracts", name, i,
        );
        return minChance >= CONFIG.BB_MIN_CONTRACT_CHANCE;
    } catch {
        return false;
    }
}

/* ========================================================================== */
/* Combat training                                                            */
/* ========================================================================== */

/**
 * Which combat stat this sleeve should train, or null when none needs it.
 *
 * Pure apart from the training lock, which exists so the sleeve does not switch
 * gym class every tick. It used to take `ns` and `ctx` and use neither, which made
 * the ordering it sat in look more entangled than it was.
 */
/**
 * A sleeve's measured training rate, updated from this tick's reading.
 *
 * Returns the rate in points per second, or null when none is known yet. Null is the
 * honest answer for a fresh sleeve and the scoring reads it as "proceed": the budget rule
 * only refuses a target once a rate EXISTS and says the gap cannot be closed in time.
 *
 * `observe` is called on every tick, even while the sleeve is on a faction job or a crime,
 * because the sleeve's skills rise from those too and a window that is allowed to go stale
 * measures nothing. It is passed the LOWEST combat stat's value, so the measurement
 * describes the sleeve's general combat progress rather than one gym class — the scoring
 * applies it to whichever stat it is considering, and a per-stat rate would need four
 * windows per sleeve for a distinction the game does not expose anyway.
 */
function measureSleeveRate(sleeveIndex: number, sleeve: ReturnType<NS["sleeve"]["getSleeve"]>): void {
    const lowest = [...COMBAT_STATS]
        .map(stat => sleeve.skills[stat.skill])
        .sort((a, b) => a - b)[0] ?? 0;

    // `MeasuredStat` is keyed by the short codes the player feature uses; "str" is the
    // combat code, and using ONE code for all four stats is deliberate — `observe` discards
    // a window whose stat changed, so per-stat codes would reset the window every time the
    // lowest stat moved and no rate would ever be produced.
    const measured = observe(sleeveOpenSamples[sleeveIndex] ?? null, "str", lowest, Date.now());
    sleeveOpenSamples[sleeveIndex] = measured.open;
    if (measured.rate !== null) sleeveRates[sleeveIndex] = measured.rate;
}

/** The last usable rate for a sleeve, or null when there is none. */
function sleeveRate(sleeveIndex: number): number | null {
    return rateFor({ str: sleeveRates[sleeveIndex] ?? undefined }, "str", Date.now())?.rate ?? null;
}

/**
 * The combat stat the goal's key corresponds to, or null when it names none.
 *
 * ALWAYS NULL FOR `combat`, and that is a finding rather than an unfinished branch. The
 * goal's `combat` gate is a single combined number, measured as the LOWEST of the four
 * combat skills (`currentFor` in `lib/objective.ts`), so no individual stat is "the one the
 * goal wants": all four must clear the bar, and the way to close that gate is to raise
 * whichever is lowest. Returning a stat here would name an arbitrary one and send the sleeve
 * to a gym for a stat that is not what is holding the gate shut.
 *
 * That means the weakest-first rule inside `getTrainingStat` is not merely the fallback for
 * a combat goal — it is the CORRECT rule for one, and the goal-preference mechanism
 * only has work to do when a future goal names a single stat. Keeping the parameter and this
 * translation is what makes that a one-line change rather than a redesign.
 *
 * `cha` returns null for a different reason: charisma is trained at a university course
 * rather than a gym and is not in `COMBAT_STATS`, so it is not a `CombatStat` and cannot be
 * expressed here at all. The candidate's target is already the goal's, so a charisma
 * goal still sets the BAR correctly; only the choice of gym stat is unaffected by it.
 */
function preferredCombatStat(_key: SubGoalKey | undefined): CombatStat | null {
    return null;
}

function getTrainingStat(
    sleeveIndex: number,
    sleeve: ReturnType<NS["sleeve"]["getSleeve"]>,
    target: number,
    /**
     * The stat the goal is waiting on, when it is one this sleeve can train.
     *
     * Null when the goal wants nothing trainable, which is the common case and the one the
     * old behaviour was written for.
     */
    preferred: CombatStat | null,
): CombatStat | null {
    const values = COMBAT_STATS.map((stat) => ({
        ...stat,
        value: sleeve.skills[stat.skill],
    }));

    // The goal's stat wins when it is still short, and the weakest otherwise.
    //
    // WHY THE GOAL WINS, given that "train the weakest" is a reasonable default. The two
    // disagree whenever the goal wants a stat that is not the lowest, and the goal is the
    // run's actual need: a sleeve raising strength toward a faction's combat gate is
    // contributing, whereas one evening out dexterity because it happens to be three points
    // lower is not. The weakest-first rule survives as the FALLBACK rather than being
    // removed, because with nothing on-goal to train, evening out the stats is as good a use
    // of a sleeve as any and better than a crime for the run's long game.
    //
    // Note that "short" is measured against `target` for BOTH choices, so the two are
    // compared on the same bar and the preference cannot smuggle in a lower one.
    const onGoal = preferred === null
        ? undefined
        : values.find(stat => stat.skill === preferred.skill);
    if (onGoal !== undefined && onGoal.value < target) {
        return selectWithLock(sleeveIndex, onGoal, values);
    }

    const weakest = [...values].sort((a, b) => a.value - b.value)[0]!;

    if (weakest.value < target) {
        return selectWithLock(sleeveIndex, weakest, values);
    }

    trainingLocks[sleeveIndex].startedAt = 0;
    return null;
}

function selectWithLock(
    sleeveIndex: number,
    ideal: CombatStat & { value: number },
    all: (CombatStat & { value: number })[],
): CombatStat {
    const lock = trainingLocks[sleeveIndex];
    const now = Date.now();

    if (now - lock.startedAt >= CONFIG.TRAINING_LOCK_MS) {
        lock.gym = ideal.gym;
        lock.startedAt = now;
        return ideal;
    }

    const lockedStat = all.find((s) => s.gym === lock.gym);
    if (!lockedStat) {
        lock.gym = ideal.gym;
        lock.startedAt = now;
        return ideal;
    }

    const gap = lockedStat.value - ideal.value;
    if (gap <= CONFIG.SWITCH_TOLERANCE) return lockedStat;

    lock.gym = ideal.gym;
    lock.startedAt = now;
    return ideal;
}

/* ========================================================================== */
/* Faction / company work selection                                           */
/* ========================================================================== */

function refreshWorkTargets(ns: NS, ctx: TickContext): void {
    while (workTargets.length < ctx.sleeveCount) workTargets.push(null);

    const reservedFactions = new Set<string>();
    const reservedCompanies = new Set<string>();

    const factionInUse = new Set<string>();
    const companyInUse = new Set<string>();
    for (const t of ctx.tasks) {
        if (!t) continue;
        if (t.type === "FACTION") factionInUse.add((t as { factionName?: string }).factionName ?? "");
        if (t.type === "COMPANY") companyInUse.add((t as { companyName?: string }).companyName ?? "");
    }

    for (let i = 0; i < ctx.sleeveCount; i++) {
        const target = workTargets[i];
        if (!target) continue;

        if (ctx.now - target.selectedAt >= CONFIG.WORK_LOCK_MS) {
            workTargets[i] = null;
            continue;
        }

        if (target.kind === "FACTION") {
            const key = `F:${target.name}`;
            if (reservedFactions.has(key) || factionInUse.has(target.name)) {
                workTargets[i] = null;
                continue;
            }
            reservedFactions.add(key);
        } else {
            const key = `C:${target.name}`;
            if (reservedCompanies.has(key) || companyInUse.has(target.name)) {
                workTargets[i] = null;
                continue;
            }
            reservedCompanies.add(key);
        }
    }

    for (let i = 0; i < ctx.sleeveCount; i++) {
        if (workTargets[i] !== null) continue;

        const target = pickBestWorkTarget(ns, ctx, reservedFactions, reservedCompanies);
        if (!target) continue;

        workTargets[i] = target;
        if (target.kind === "FACTION") reservedFactions.add(`F:${target.name}`);
        else reservedCompanies.add(`C:${target.name}`);
    }
}

function pickBestWorkTarget(
    ns: NS,
    ctx: TickContext,
    reservedFactions: Set<string>,
    reservedCompanies: Set<string>,
): WorkTarget | null {
    const tryFaction = (): WorkTarget | null => {
        if (!CONFIG.FACTION_WORK_ENABLED) return null;
        const f = pickFactionTarget(ns, ctx, reservedFactions);
        return f
            ? { kind: "FACTION", name: f.name, workType: f.workType, selectedAt: Date.now() }
            : null;
    };

    const tryCompany = (): WorkTarget | null => {
        if (!CONFIG.COMPANY_WORK_ENABLED) return null;
        const c = pickCompanyTarget(ns, ctx, reservedCompanies, reservedFactions);
        return c ? { kind: "COMPANY", name: c, selectedAt: Date.now() } : null;
    };

    const factionFirst = reservedFactions.size <= reservedCompanies.size;
    return factionFirst
        ? (tryFaction() ?? tryCompany())
        : (tryCompany() ?? tryFaction());
}

function pickFactionTarget(
    ns: NS,
    ctx: TickContext,
    reservedFactions: Set<string>,
): { name: FactionName; workType: FactionWorkType } | null {
    if (ctx.playerFactions.size === 0) return null;

    const forbidden = getForbiddenFactionWork(ns);
    let bestName: FactionName | null = null;
    let bestMissing = 0;

    // The factions that still want reputation come from the snapshot's central reading,
    // which has already skipped owned augmentations, NeuroFlux and factions already at
    // their requirement. `target - current` is the gap to the faction's highest remaining
    // requirement, which is what working for it would close.
    for (const rep of ctx.reputation) {
        const faction = rep.faction;
        if (forbidden.has(faction) ||
            reservedFactions.has(`F:${faction}`) ||
            isBlocked(`F:${faction}`)) continue;

        const missingRep = rep.target - rep.current;
        if (missingRep > bestMissing) {
            bestMissing = missingRep;
            bestName = faction;
        }
    }

    if (!bestName) return null;
    const workType = pickWorkTypeFor(ns, bestName);
    if (!workType) return null;
    return { name: bestName, workType };
}

function getForbiddenFactionWork(ns: NS): Set<FactionName> {
    const forbidden = new Set<FactionName>();
    try {
        if (ns.gang.inGang()) {
            const gang = ns.gang.getGangInformation();
            // Already `FactionName` from the game, so no assertion is needed here.
            if (gang?.faction) forbidden.add(gang.faction);
        }
    } catch { }
    return forbidden;
}

function pickCompanyTarget(
    ns: NS,
    ctx: TickContext,
    reservedCompanies: Set<string>,
    reservedFactions: Set<string>,
): CompanyName | null {
    const companies = Object.keys(ctx.playerJobs) as CompanyName[];
    if (companies.length === 0) return null;

    const forbidden = getForbiddenFactionWork(ns);
    let bestName: CompanyName | null = null;
    let bestMissingRep = 0;
    let fallback: CompanyName | null = null;

    // Indexed by faction so a company can be scored against the central reading: a company
    // raises the reputation of its associated faction, so the gap that matters is that
    // faction's.
    const repGap = new Map<FactionName, number>();
    for (const rep of ctx.reputation) repGap.set(rep.faction, rep.target - rep.current);

    for (const company of companies) {
        if (reservedCompanies.has(`C:${company}`) || isBlocked(`C:${company}`)) continue;

        const faction = COMPANY_FACTIONS[company];
        if (!faction || forbidden.has(faction) || reservedFactions.has(`F:${faction}`)) continue;

        if (!fallback) fallback = company;

        // Absent from the central reading means nothing left to earn for that faction, so
        // there is no gap to close.
        const missingRep = repGap.get(faction) ?? 0;
        const hasUsefulAug = missingRep > 0;

        if (!CONFIG.COMPANY_WORK_ANY_JOB && (!hasUsefulAug || missingRep <= 0)) continue;

        if (missingRep > bestMissingRep) {
            bestMissingRep = missingRep;
            bestName = company;
        }
    }

    if (!bestName && CONFIG.COMPANY_WORK_ANY_JOB) bestName = fallback;
    return bestName;
}

function pickWorkTypeFor(ns: NS, faction: FactionName): FactionWorkType | null {
    try {
        const types = ns.singularity.getFactionWorkTypes(faction);
        if (types.includes("security")) return "security";
        if (types.includes("field")) return "field";
        if (types.includes("hacking")) return "hacking";
    } catch { }
    return null;
}

/* ========================================================================== */
/* Work assignment                                                             */
/* ========================================================================== */

function assignWorkTarget(
    ns: NS,
    ctx: TickContext,
    i: number,
    task: SleeveTask | null,
    target: WorkTarget,
): boolean {
    if (target.kind === "FACTION") {
        const workType = target.workType;
        if (!workType) { workTargets[i] = null; return false; }

        const faction = target.name;

        if (task && task.type === "FACTION" &&
            (task as { factionName?: string }).factionName === faction &&
            (task as { factionWorkType?: string }).factionWorkType === workType) {
            return true;
        }

        if (isFactionUsedByOtherSleeve(ctx, i, faction)) {
            workTargets[i] = null;
            return false;
        }

        if (!ctx.playerFactions.has(faction)) {
            block(`F:${faction}`);
            workTargets[i] = null;
            return false;
        }

        try {
            if (!ns.sleeve.setToFactionWork(i, faction, workType)) {
                block(`F:${faction}`);
                workTargets[i] = null;
                return false;
            }
            announce(ns, "SLEEVES", `Sleeve ${i}: Faction work → ${faction} (${workType})`, "success");
            return true;
        } catch (error) {
            block(`F:${faction}`);
            announce(ns, "SLEEVES", `Sleeve ${i}: Faction work failed (${faction}, ${workType}): ${shortError(error)}`, "error");
            workTargets[i] = null;
            return false;
        }
    }

    if (target.kind === "COMPANY") {
        const company = target.name;

        if (task && task.type === "COMPANY" &&
            (task as { companyName?: string }).companyName === company) {
            return true;
        }

        if (isCompanyUsedByOtherSleeve(ctx, i, company)) {
            workTargets[i] = null;
            return false;
        }

        if (!ctx.playerJobs[company]) {
            block(`C:${company}`);
            workTargets[i] = null;
            return false;
        }

        try {
            if (!ns.sleeve.setToCompanyWork(i, company)) {
                block(`C:${company}`);
                workTargets[i] = null;
                return false;
            }
            announce(ns, "SLEEVES", `Sleeve ${i}: Company work → ${company}`, "success");
            return true;
        } catch (error) {
            block(`C:${company}`);
            announce(ns, "SLEEVES", `Sleeve ${i}: Company work failed (${company}): ${shortError(error)}`, "error");
            workTargets[i] = null;
            return false;
        }
    }

    return false;
}

function isFactionUsedByOtherSleeve(ctx: TickContext, sleeveIndex: number, faction: string): boolean {
    for (let i = 0; i < ctx.tasks.length; i++) {
        if (i === sleeveIndex) continue;
        const task = ctx.tasks[i];
        if (task?.type === "FACTION" &&
            (task as { factionName?: string }).factionName === faction) return true;
    }
    return false;
}

function isCompanyUsedByOtherSleeve(ctx: TickContext, sleeveIndex: number, company: string): boolean {
    for (let i = 0; i < ctx.tasks.length; i++) {
        if (i === sleeveIndex) continue;
        const task = ctx.tasks[i];
        if (task?.type === "COMPANY" &&
            (task as { companyName?: string }).companyName === company) return true;
    }
    return false;
}

/* ========================================================================== */
/* Generic task assignment                                                     */
/* ========================================================================== */

function assign(
    ns: NS,
    i: number,
    currentTask: SleeveTask | null,
    expectedType: string,
    action: () => boolean | void,
    description: string,
    expectedDetail?: string,
): boolean {
    if (taskMatches(currentTask, expectedType, expectedDetail)) return true;

    const was = describeTask(currentTask);

    let ok = true;
    try {
        const result = action();
        if (result === false) ok = false;
    } catch (error) {
        announce(ns, "SLEEVES", `Sleeve ${i}: FAILED (${was} → ${description}): ${shortError(error)}`, "error");
        return false;
    }

    // A switch happens often, so it is current state rather than an event: the
    // recent ring shows it and ages it out, where tprint would flood the Terminal.
    currentRecent.add("SLEEVES", `Sleeve ${i}: ${ok ? "" : "REJECTED "}${was} → ${description}`);

    // The refusal is reported rather than swallowed, and this is the whole point of
    // the return value. A rejected assignment used to be indistinguishable from a
    // successful one, so the caller returned "handled" anyway and the sleeve was left
    // with no task — asking for the same refused action on every tick, forever. The
    // live symptom was `REJECTED none → BB: Tracking` repeating with no progress and no
    // fallback ever tried.
    return ok;
}

/**
 * Bladeburner sleeve actions don't all share the same task type:
 *   Infiltrate Synthoids → type "INFILTRATE"
 *   Support main sleeve  → type "SUPPORT"
 *   everything else      → type "BLADEBURNER" + actionName
 *
 * Both of the oddballs are routed through "BLADEBURNER" as the expectedType
 * by their callers, and this function special-cases them.
 */
function taskMatches(
    task: SleeveTask | null,
    expectedType: string,
    expectedDetail?: string,
): boolean {
    if (!task) return false;

    if (expectedType === "BLADEBURNER" && expectedDetail === BB_ACTION_SUPPORT_MAIN) {
        return task.type === "SUPPORT";
    }
    if (expectedType === "BLADEBURNER" && expectedDetail === BB_ACTION_INFILTRATE) {
        return task.type === "INFILTRATE";
    }

    if (task.type !== expectedType) return false;
    if (expectedDetail === undefined) return true;

    switch (expectedType) {
        case "CLASS":
            return (task as { classType?: string }).classType === expectedDetail;
        case "CRIME":
            return (task as { crimeType?: string }).crimeType === expectedDetail;
        case "BLADEBURNER":
            return (task as { actionName?: string }).actionName === expectedDetail;
        case "FACTION":
            return (task as { factionName?: string }).factionName === expectedDetail;
        case "COMPANY":
            return (task as { companyName?: string }).companyName === expectedDetail;
        default:
            return true;
    }
}

/* ========================================================================== */
/* Sleeve augmentations                                                       */
/* ========================================================================== */

function buySleeveAugs(ns: NS, ctx: TickContext): void {
    const cash = ns.getServerMoneyAvailable("home");
    const disposableCash = Math.max(0, cash - CONFIG.CASH_RESERVE);
    const maxBudget = disposableCash * CONFIG.AUG_BUDGET_PCT;

    if (maxBudget <= 0) return;

    let spent = 0;
    const candidates: { sleeve: number; name: string; cost: number }[] = [];

    for (let i = 0; i < ctx.sleeveCount; i++) {
        try {
            for (const aug of ns.sleeve.getSleevePurchasableAugs(i)) {
                candidates.push({ sleeve: i, name: aug.name, cost: aug.cost });
            }
        } catch { }
    }

    candidates.sort((a, b) => a.cost - b.cost);

    for (const aug of candidates) {
        const currentCash = ns.getServerMoneyAvailable("home");

        if (spent + aug.cost > maxBudget) continue;
        if (currentCash - aug.cost < CONFIG.CASH_RESERVE) continue;
        if (aug.cost < CONFIG.MIN_AUG_COST) continue;
        if (aug.cost > currentCash * CONFIG.MAX_SINGLE_AUG_PCT) continue;

        try {
            const purchased = ns.sleeve.purchaseSleeveAug(aug.sleeve, aug.name);
            if (!purchased) continue;
            spent += aug.cost;
            announce(ns, "SLEEVES", `Sleeve ${aug.sleeve}: Purchased ${aug.name} (${formatMoney(aug.cost)})`, "tx");
        } catch (error) {
            announce(ns, "SLEEVES", `Sleeve ${aug.sleeve}: Aug purchase failed (${aug.name}): ${shortError(error)}`, "error");
        }
    }
}

/* ========================================================================== */
/* Formatting                                                                 */
/* ========================================================================== */

function formatMoney(value: number): string {
    if (value >= 1e15) return `${(value / 1e15).toFixed(2)} q`;
    if (value >= 1e12) return `${(value / 1e12).toFixed(2)} t`;
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)} b`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)} m`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(2)} k`;
    return value.toFixed(0);
}