import { deriveGangConfig } from "./gang-config.ts";
import { ChangeLog } from "../../lib/log.ts";
import type { Context } from "../../lib/context.ts";
import { targetFor } from "../../lib/objective.ts";
import {
    GANG_CONFIG_DEFAULT,
    TASK_TERRITORY,
    ascensionRatio,
    averageCleanupRate,
    chooseGear,
    chooseStandingTerritoryMember,
    computeTrainerCap,
    decideMode,
    decideWarfare,
    economicModeByMember,
    economicModeFor,
    isEconomicTask,
    memberPower,
    pickTask,
    scoreTask,
    rawTrainingTask,
    scanEnemies,
    shouldAscend,
    skillScore,
    territoryLockHeld,
    trainingTask,
    wantedRise,
    wantedWorkerNeeded,
    wantedWorkersFor,
    type EnemyScan,
    type EquipmentInfo,
    type GangConfig,
    type GangMode,
    type ScoredTask,
    type Special,
    type WantedPressure,
} from "./gang-decisions.ts";


// ============================================================
// GANG WRAPPER
// ============================================================
class Gang {
    private cachedTasks: GangTaskStats[] | null = null;
    private cachedGear: EquipmentInfo[] | null = null;

    constructor(
        public ns: NS,
        /** Formula APIs are available with SF5, BN5 or Formulas.exe. */
        private hasFormulas: boolean,
    ) {}

    /**
     * The orchestrator hands over a fresh `ns` and a fresh capability reading
     * each tick, because a script that restarts leaves this one holding a dead
     * context.
     */
    update(ns: NS, hasFormulas: boolean): void {
        this.ns = ns;
        this.hasFormulas = hasFormulas;
    }

    info(): GangGenInfo { return this.ns.gang.getGangInformation(); }
    member(name: string): GangMemberInfo { return this.ns.gang.getMemberInformation(name); }
    members(): GangMemberInfo[] {
        return this.ns.gang.getMemberNames().map(n => this.member(n));
    }

    tasks(): GangTaskStats[] {
        if (this.cachedTasks === null) {
            this.cachedTasks = this.ns.gang.getTaskNames()
                .map(n => this.ns.gang.getTaskStats(n));
        }
        return this.cachedTasks;
    }

    gear(): EquipmentInfo[] {
        if (this.cachedGear === null) {
            this.cachedGear = this.ns.gang.getEquipmentNames().map(name => ({
                name,
                cost: this.ns.gang.getEquipmentCost(name),
                stats: this.ns.gang.getEquipmentStats(name),
            }));
        }
        return this.cachedGear;
    }

    moneyGain(g: GangGenInfo, m: GangMemberInfo, t: GangTaskStats): number {
        if (this.hasFormulas) return this.ns.formulas.gang.moneyGain(g, m, t);
        return Math.max(0, (t.baseMoney * skillScore(m, t)) / Math.max(1, t.difficulty));
    }
    respectGain(g: GangGenInfo, m: GangMemberInfo, t: GangTaskStats): number {
        if (this.hasFormulas) return this.ns.formulas.gang.respectGain(g, m, t);
        return Math.max(0, (t.baseRespect * skillScore(m, t)) / Math.max(1, t.difficulty));
    }
    wantedGain(g: GangGenInfo, m: GangMemberInfo, t: GangTaskStats): number {
        if (this.hasFormulas) return this.ns.formulas.gang.wantedLevelGain(g, m, t);
        return (t.baseWanted * skillScore(m, t)) / Math.max(1, t.difficulty);
    }
}

/**
 * The two tasks this gang does not choose by scoring: its wanted-level cleanup and
 * territory work.
 *
 * A function rather than a literal in the tick, because the doctor reports the
 * cleanup crew and has to name the same tasks the feature does. Two copies of
 * "Vigilante Justice" would be two things to keep in step.
 */
export function specialsFor(isHacking: boolean): Special {
    return {
        wanted: isHacking ? "Ethical Hacking" : "Vigilante Justice",
        territory: TASK_TERRITORY,
    };
}

/**
 * A gang wrapper over `ns`, for callers outside the feature's own tick loop.
 *
 * The doctor reports the cleanup crew, and doing so means asking the same questions
 * the feature asks. Handing it a wrapper keeps that from meaning a second reading of
 * the game's task table.
 */
export function createGang(ns: NS, hasFormulas: boolean): Gang {
    return new Gang(ns, hasFormulas);
}

/**
 * How hard the wanted level is pushing the gang, measured from the gang's own state.
 *
 * Shared with the doctor so the number it prints is the number the feature acts on.
 * `cleaners` is read from the members' current tasks because the game's rate is NET:
 * the members already on cleanup are inside it, and `wantedRise` adds their share
 * back to describe the rest of the gang instead. `cleanupRate` averages one cleaner's
 * magnitude over every member, which is what a mixed crew actually achieves.
 */
export function wantedPressureFor(
    gang: Gang,
    g: GangGenInfo,
    members: readonly GangMemberInfo[],
    s: Special,
): WantedPressure {
    const wantedTask = gang.tasks().find(t => t.name === s.wanted);

    return {
        gainRate: g.wantedLevelGainRate,
        cleaners: members.filter(m => m.task === s.wanted).length,
        cleanupRate: wantedTask === undefined
            ? 0
            : averageCleanupRate(members.map(m => gang.wantedGain(g, m, wantedTask))),
    };
}

// ============================================================
// ENEMY POWER SCAN
// ============================================================
// ============================================================
// PURE HELPERS
// ============================================================
function chooseTask(
    gang: Gang, g: GangGenInfo, m: GangMemberInfo, isHacking: boolean,
    tasks: GangTaskStats[], mode: GangMode, s: Special,
): string {
    const scored: ScoredTask[] = [];
    for (const t of tasks) {
        if (!isEconomicTask(t, isHacking, s)) continue;
        scored.push({
            name: t.name,
            score: scoreTask(
                gang.moneyGain(g, m, t),
                gang.respectGain(g, m, t),
                gang.wantedGain(g, m, t),
                mode,
            ),
        });
    }

    // `pickTask` keeps the member on its current task unless a challenger is clearly
    // better, which is what stops two near-equal tasks swapping every tick. The
    // member's own task is the reference: it was decided last tick against almost the
    // same inputs, so it is the stable answer rather than a fresh guess.
    //
    // Falling back to `s.wanted` when there is nothing to score matches what this
    // returned before: no economic task means no economic work, and the wanted task is
    // the game's own "nothing useful" assignment.
    return pickTask(scored, m.task) ?? s.wanted;
}

// ============================================================
// WARFARE DECISION
// ============================================================
interface WarfareDecision {
    action: "ENGAGE" | "DISENGAGE" | "HOLD";
    reason: string;
}

// ============================================================
// TRAINER ROSTER
// ============================================================
function refreshTrainers(
    members: GangMemberInfo[],
    memberByName: Map<string, GangMemberInfo>,
    activeTrainers: Set<string>,
    isHacking: boolean,
    config: GangConfig,
    maxTrainers: number,
    log: ChangeLog,
): void {
    const present = new Set(members.map(m => m.name));

    for (const name of [...activeTrainers]) {
        if (!present.has(name)) {
            activeTrainers.delete(name);
            continue;
        }
        // No `forceTrain` bypass here any more. Prep's trainers are meant to train PAST
        // the ordinary targets, but "still worth training" is a different question from
        // "trained past the target", and only the first one belongs in a release check:
        // `trainingTask` returns null for a member who is done, and a done member should
        // give their slot back to someone who is not. Skipping the check let a prep gang
        // hold its cap full of finished members while younger ones went untrained, which
        // spent the slot on nobody.
        const m = memberByName.get(name);
        if (!m) continue;
        if (trainingTask(m, isHacking, config) === null) {
            activeTrainers.delete(name);
            log.event(`${name} finished training`);
        }
    }

    while (activeTrainers.size > maxTrainers) {
        const name = [...activeTrainers].pop();
        if (name === undefined) break;
        activeTrainers.delete(name);
        log.event(`${name} released from training (cap reduced to ${maxTrainers})`);
    }

    let openSlots = maxTrainers - activeTrainers.size;
    if (openSlots <= 0) return;

    // Weakest-first, and prep fills from the same pool. There is no `forceTrain` bypass
    // on this filter either: prep still wants members who have something left to learn,
    // because a member past every target gains nothing from more of the same task. The
    // pool is therefore everyone not yet done, and `maxTrainers` alone decides how many of
    // them are taken — which is usually more in prep than in any other mode, but is not
    // always: prep owes the map workers and the run an earner too, so on a small gang its
    // cap can land BELOW the ordinary one. That is the budget working, not a fault.
    const candidates = members
        .filter(m => !activeTrainers.has(m.name))
        .filter(m => trainingTask(m, isHacking, config) !== null)
        .sort((a, b) => memberPower(a, isHacking) - memberPower(b, isHacking));

    for (const m of candidates) {
        if (openSlots <= 0) break;
        activeTrainers.add(m.name);
        log.event(`${m.name} → trainer (${activeTrainers.size}/${maxTrainers})`);
        openSlots--;
    }
}

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

/**
 * Format a gang figure for the log.
 *
 * NON-FINITE IS NOT ALWAYS "NaN". `respectPhaseEnd` returns `Infinity` when the
 * game reports a `respectForNextRecruit` that is not finite — a deliberate answer
 * meaning "this phase does not end", not a failed computation. Printing that as
 * "NaN" made a working guard look like a bug, and cost real time chasing it.
 *
 * The two are now distinguished: `Infinity` reads as "never", and a genuine NaN
 * still reads as "NaN" because that one IS a fault.
 */
function fmt(n: number): string {
    if (n === Infinity) return "never";
    if (n === -Infinity) return "never";
    if (Number.isNaN(n)) return "NaN";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
    return n.toFixed(0);
}

/* ─── MODULE STATE (Persists across orchestrator ticks) ─── */
let initialized = false;
let readyForNextTick = true;
let log: ChangeLog | null = null;
let gang: Gang | null = null;
let isHacking = false;
let config: GangConfig = GANG_CONFIG_DEFAULT;
let specials: Special = { wanted: "", territory: TASK_TERRITORY };
const activeTrainers = new Set<string>();
/**
 * The member pinned to territory, held until the gang has full control.
 *
 * Module state rather than a per-tick choice, because the point of the pin is that it
 * does not move: re-picking each tick would hand the task around as the roster and the
 * trainer set shift, which is exactly what pinning is meant to stop. Cleared when
 * territory is complete or the member is gone — see the tick, which is the only place
 * that writes it.
 */
let standingTerritoryMember: string | null = null;

/**
 * Forget everything this feature remembers between ticks.
 *
 * Exported for tests, like the `reset` on the other long-lived features, and it exists
 * for the same reason: this memory is MODULE state, so two tests in one process share
 * it. `readyForNextTick` is the sharp one here — it is cleared at the end of a tick and
 * only restored when the game's `nextUpdate` promise resolves, so a second test in the
 * same file can silently get no work done at all and its assertions pass vacuously.
 *
 * Not called in production: a restart clears the module anyway, and within a run this
 * memory is intentional.
 */
export function reset(): void {
    initialized = false;
    readyForNextTick = true;
    log = null;
    gang = null;
    isHacking = false;
    config = GANG_CONFIG_DEFAULT;
    specials = { wanted: "", territory: TASK_TERRITORY };
    activeTrainers.clear();
    standingTerritoryMember = null;
}

/** Executed sequentially per Nexus orchestrator tick */
export function tick(ns: NS, context: Context): void {
    // 1. Non-blocking event check: wait for gang tick (~2s)
    if (!readyForNextTick) return;

    // The registry gates this feature on the Gang API being available at all,
    // which only means SF2: the player still has to found a gang. Everything
    // below reads gang state, so this has to come first, and it is a return
    // rather than a "not loaded" so the feature starts working the moment the
    // player creates a gang, without a restart.
    if (!context.capabilities.probes.gangMember) return;

    const hasFormulas = context.capabilities.has("formulas");

    // 2. Initial setup pass & NS instance update
    if (!initialized) {
        log = new ChangeLog(ns, "GANG");
        gang = new Gang(ns, hasFormulas);
        isHacking = gang.info().isHacking;
        specials = specialsFor(isHacking);

        log.event(`Online (${isHacking ? "hacking" : "combat"})`);
        initialized = true;
    } else {
        // The orchestrator hands over a live `ns` and a fresh capability reading
        // each tick: after a script restart this one would hold a dead context.
        log!.updateNs(ns);
        gang!.update(ns, hasFormulas);
    }

    if (!gang || !log) return;

    const g = gang.info();
    let members = gang.members();

    while (ns.gang.canRecruitMember()) {
        const name = `Goon-${members.length + 1}`;
        if (!ns.gang.recruitMember(name)) break;
        log.event(`Recruited ${name} (${members.length + 1} total)`);
        members = gang.members();
    }

    if (members.length === 0) {
        resetTickFlag(ns);
        return;
    }

    const memberByName = new Map<string, GangMemberInfo>();
    for (const m of members) memberByName.set(m.name, m);

    const enemies = scanEnemies(ns.gang.getAllGangInformation(), g);
    // Net worth rather than home cash: the money floor is about what the player is
    // WORTH, so a run holding its wealth in stocks or servers is not treated as poor.
    // Read from the snapshot now, which computes it once per pass for the goal too, so
    // the gang and the goal cannot disagree about how rich the player is. `homeCash` is
    // still needed below, for the gear budget, which is genuinely about what can be spent
    // right now.
    const homeCash = context.snapshot.homeCash;
    const netWorth = context.snapshot.netWorth;

    // Re-derived every tick from the gang's own state, because the thresholds
    // that matter move as it grows: the respect phase ends when the gang's next
    // recruit stops being worth chasing, which is a function of its size.
    // `canRecruitMember` rather than a member count: the game decides, and its answer already
    // accounts for respect. While it is true the gang overrides the money floor and grows.
    config = deriveGangConfig(g, members, enemies.enemyCount, ns.gang.canRecruitMember());

    // The money floor is the run's wealth goal, not a gang constant. Below it the gang
    // earns and does nothing else, which is the same question the wealth goal asks, so
    // reading it from the goal means the two cannot disagree about whether the run is
    // poor. The gang's own figure stays as the fallback for an goal that names no
    // wealth target.
    config = { ...config, moneyFloor: targetFor(context.goal, "netWorth", config.moneyFloor) };

    const warfare = decideWarfare(g, isHacking, config, enemies, netWorth);
    log.change(
        "warfare-state", "WARFARE-STATE", `${warfare.action}:${warfare.reason}`,
        `territory=${pct(g.territory)} clash=${pct(enemies.lowestClashChance)} ` +
        `power=${fmt(g.power)} vs ${enemies.strongestName || "—"}=${fmt(enemies.strongestPower)} ` +
        `(need ${pct(config.territoryMinClashChance)})`,
    );

    if (warfare.action === "ENGAGE") {
        ns.gang.setTerritoryWarfare(true);
        log.event(`⚔ Engaging territory warfare vs ${enemies.strongestName}`);
    } else if (warfare.action === "DISENGAGE") {
        ns.gang.setTerritoryWarfare(false);
        log.event(`Disengaging territory warfare (${warfare.reason})`);
    }

    // Whether the gang is already cleaning up, read from who is on the wanted task. This
    // feeds the hysteresis band on the wanted boundary: entering cleanup uses the plain
    // target, but leaving needs the penalty to clear it by a margin, so the mode cannot
    // toggle every tick the penalty sits on the line. Without that, the respect/money split
    // toggles with it and members slam between Terrorism and Human Trafficking.
    const wantedEngaged = members.some(m => m.task === specials.wanted);

    const { mode, reason } = decideMode(g, config, isHacking, enemies, netWorth, wantedEngaged);
    log.change(
        "mode", "MODE", `${mode}:${reason}`,
        `respect=${fmt(g.respect)}/${fmt(config.respectPhaseEnd)} power=${fmt(g.power)} ` +
        `wanted=${pct(g.wantedPenalty)} territory=${pct(g.territory)}`,
    );

    const tasks = gang.tasks();
    const gear = gang.gear();

    // How hard the wanted level is pushing, measured once per tick from the gang's
    // own state rather than from the size of last tick's crew. Shared with the doctor
    // so the reported crew and the assigned crew come from one measurement.
    const wantedPressure = wantedPressureFor(gang, g, members, specials);
    log.change(
        "wanted-pressure", "WANTED-PRESSURE",
        `rise=${fmt(wantedRise(wantedPressure))}/cycle crew=${wantedWorkersFor(g, wantedPressure, members.length, config, wantedEngaged)}`,
        `rate=${fmt(g.wantedLevelGainRate)} cleaners=${wantedPressure.cleaners} ` +
        `each=${fmt(wantedPressure.cleanupRate)}`,
    );

    const forceTrain = mode === "WARFARE_PREP";
    const suppressAscension = mode === "TERRITORY";

    const prepWarfareTarget = mode === "WARFARE_PREP"
        ? Math.max(1, Math.floor(members.length * config.prepWarfareFraction))
        : 0;
    const territoryTarget = Math.max(
        1,
        Math.floor(members.length * config.territoryWorkerFraction),
    );

    const trainerCap = computeTrainerCap(
        members.length,
        mode,
        config,
        prepWarfareTarget,
    );

    refreshTrainers(
        members, memberByName, activeTrainers, isHacking, config,
        trainerCap, log,
    );

    // Keep one member pinned to territory until the gang holds all of it.
    //
    // The pin is remembered rather than re-chosen, so the same member keeps the task
    // while the map is being taken: the member is picked once, and only released when
    // territory is complete or the member is gone. Re-choosing every tick would hand
    // the task around as the roster and the trainer set change, which is the churn the
    // pin exists to remove.
    //
    // The pinned member is dropped from the trainer set so the trainer branch cannot
    // take them back a few lines later. That keeps "one member on territory" true even
    // while the trainer cap has room, which is the whole point of the lock.
    if (!territoryLockHeld(g, members.length, config)) {
        if (standingTerritoryMember !== null) {
            log.event(`Holding all territory — releasing ${standingTerritoryMember}`);
            standingTerritoryMember = null;
        }
    } else if (standingTerritoryMember === null || !memberByName.has(standingTerritoryMember)) {
        standingTerritoryMember = chooseStandingTerritoryMember(members, isHacking, activeTrainers);
        if (standingTerritoryMember !== null) {
            log.event(`Pinned ${standingTerritoryMember} to territory until we hold it all`);
        }
    }
    if (standingTerritoryMember !== null) activeTrainers.delete(standingTerritoryMember);

    const sorted = [...members].sort((a, b) => {
        const pA = memberPower(a, isHacking);
        const pB = memberPower(b, isHacking);
        if (Math.abs(pA - pB) < Math.max(pA, pB) * 0.05) {
            return a.name.localeCompare(b.name);
        }
        return pB - pA;
    });

    // The non-trainers, in assignment order, and each one's economic mode — decided ONCE
    // here from the roster rather than per member inside the loop.
    //
    // The distinction is the whole fix for the Terrorism/Human-Trafficking flicker. Deciding
    // the mode inside the loop from a running count made a member's mode depend on how many
    // members the wanted and territory branches had diverted ahead of them this tick, which
    // moves every update. From the roster, a member's mode is a property of the gang and does
    // not move when somebody else is sent to cleanup.
    const nonTrainers = sorted.filter(m => !activeTrainers.has(m.name));
    const economicMode = economicModeByMember(mode, nonTrainers, config);
    let wantedWorkers = 0;
    let territoryWorkers = 0;
    let prepWarfareAssigned = 0;

    // Reserve the pinned member's place in the territory modes before the loop.
    //
    // Those modes assign up to a target, and the pinned member is one of the workers
    // they are counting. Reserving the slot here means the mode fills one fewer from
    // the rest, instead of the pin landing on top of an already-full target — which
    // would send one more member to territory than the mode asked for and quietly
    // shrink the trainer budget that was sized against it.
    if (standingTerritoryMember !== null) {
        if (mode === "WARFARE_PREP") prepWarfareAssigned++;
        else if (mode === "TERRITORY") territoryWorkers++;
    }

    const assign = (name: string, task: string, taskReason: string): void => {
        ns.gang.setMemberTask(name, task);
        log!.change(`task:${name}`, name, task, taskReason);
    };

    const aggressiveGear = forceTrain;
    let runningCash = homeCash;

    for (let m of sorted) {
        const ascResult = ns.gang.getAscensionResult(m.name);
        if (ascResult && shouldAscend(m, isHacking, config, ascResult, suppressAscension)) {
            const gain = ascensionRatio(m, isHacking, ascResult);
            ns.gang.ascendMember(m.name);
            log.event(`Ascended ${m.name} (×${gain.toFixed(2)})`);
            log.reset(`task:${m.name}`);
            m = gang.member(m.name);
            memberByName.set(m.name, m);

            // A member pinned to territory is not offered a trainer slot on ascension:
            // the trainer branch below would then assign training and skip the pin, and
            // an ascended territory worker would quietly leave the task the pin exists
            // to hold. Ascension itself still happens — a stronger member holds
            // territory better.
            //
            // Nothing needs adjusting for the economic split any more: `economicMode` is
            // built from the roster as it stood at the top of the loop, and a member who
            // becomes a trainer here is diverted by the trainer branch below before the
            // lookup is reached, leaving their entry unused rather than mis-assigned.
            if (m.name !== standingTerritoryMember && activeTrainers.size < trainerCap) {
                activeTrainers.add(m.name);
            }
        }

        if (activeTrainers.has(m.name)) {
            // In `WARFARE_PREP` a trainer keeps training past the ordinary targets, because
            // the mode exists to build power and every point is power. That is the WHOLE of
            // what prep changes about training, and it is deliberately not a licence to
            // train the entire gang: `trainerCap` has already bounded this set to
            // `prepTrainerFraction` of the roster, so the members left over fall through to
            // economic work below. Treating prep as "force everyone to train" was what sent
            // a gang at war to zero income while its territory target also went unfilled.
            if (forceTrain) {
                assign(m.name, rawTrainingTask(isHacking), "prep training");
                continue;
            }
            const task = trainingTask(m, isHacking, config);
            if (task) { assign(m.name, task, "training"); continue; }
        }

        const purchaseable = chooseGear(
            m, gear, runningCash, config, isHacking, aggressiveGear,
        );
        for (const name of purchaseable) {
            if (ns.gang.purchaseEquipment(m.name, name)) {
                const item = gear.find(x => x.name === name);
                if (item) runningCash -= item.cost;
                log.event(`Bought ${name} for ${m.name}`);
            }
        }

        // The pinned member works territory and nothing else until the gang holds it
        // all, so this branch outranks wanted cleanup, the territory modes and ordinary
        // economic work. Kept below the gear purchase so the pin does not also mean
        // "never upgraded" — the one member who is definitely going to fight for
        // territory is the one worth arming.
        //
        // Its place in the territory modes was already reserved before the loop, so
        // this assigns the task without counting it again.
        if (m.name === standingTerritoryMember) {
            assign(m.name, specials.territory, "pinned territory");
            continue;
        }

        if (mode === "WANTED" && wantedWorkerNeeded(wantedWorkers, members.length, g, wantedPressure, config, wantedEngaged)) {
            assign(m.name, specials.wanted, "wanted cleanup");
            wantedWorkers++;
            continue;
        }

        if (mode === "WARFARE_PREP" && prepWarfareAssigned < prepWarfareTarget) {
            assign(m.name, specials.territory, "prep: power");
            prepWarfareAssigned++;
            continue;
        }

        if (mode === "TERRITORY" && territoryWorkers < territoryTarget) {
            assign(m.name, specials.territory, "territory");
            territoryWorkers++;
            continue;
        }

        // The member's mode is a lookup, not a decision, so it cannot move because of who
        // was assigned before them. The fallback is for a member who was a trainer when the
        // map was built and was released during the loop — the map is the roster as it stood,
        // and a mode computed from a count would be the thing we are trying to avoid.
        const econMode = economicMode.get(m.name) ?? economicModeFor(mode, 0, nonTrainers.length, config);
        assign(m.name, chooseTask(gang, g, m, isHacking, tasks, econMode, specials), econMode);
    }

    // 3. Reset tick flag for next game update (~2s)
    resetTickFlag(ns);
}

function resetTickFlag(ns: NS): void {
    readyForNextTick = false;
    ns.gang.nextUpdate()
        .then(() => {
            readyForNextTick = true;
        })
        .catch(() => {
            // Ignored if script context dies during wait
            readyForNextTick = true;
        });
}