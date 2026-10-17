import type { NS } from "@ns";

import { detectCapabilities, CAPABILITY_KEYS, type Capabilities } from "./lib/caps.ts";
import { FEATURES, featurePaths, featureParticipation } from "./lib/registry.ts";
import { unavailableReason } from "./lib/features.ts";
import { decideMode, decideWarfare, scanEnemies, wantedRise, wantedWorkersFor } from "./features/gang/gang-decisions.ts";
import { deriveGangConfig } from "./features/gang/gang-config.ts";
import { createGang, specialsFor, wantedPressureFor } from "./features/gang/gang.ts";
import { createContextReader, createRecent, createReserves, createSnapshot, deriveGoalsFor, type Context, type Snapshot } from "./lib/context.ts";
import { announce } from "./lib/log.ts";
import { subGoalsFor, currentGoal, targetFor, type SubGoalKey } from "./lib/objective.ts";
import { basename, findScriptOnHome } from "./lib/scripts.ts";
/*
 * ============================================================================
 * DOCTOR
 * ============================================================================
 * Checks the framework's assumptions against the live game and prints a report.
 *
 * Why this exists. Every defect in this framework so far has been an assumption
 * about Bitburner that turned out to be false in some BitNode or Source File
 * combination:
 *
 *   - Singularity functions were called on a node without SF4
 *   - `ramOverride()` with no argument returns the assigned limit, not the
 *     script's own cost, so a 6 GB feature was refused on a 3 TB home
 *   - `getBitNodeMultipliers()` throws without SF5 and was called unconditionally
 *
 * Unit tests use a fake `NS`, and a fake can model the game incorrectly, which
 * is how the RAM bug shipped. This script closes that gap: it reads the real
 * game and reports what it finds, in the same order the orchestrator would.
 *
 * A Standalone Entry. It changes nothing, so it is safe to run at any time.
 * ============================================================================
 */

/** Width of the left-hand column, so the report lines up. */
const LABEL = 26;

export function main(ns: NS): void {
    ns.disableLog("ALL");
    // No `openTail`: the report goes to a file (see the REPORTING section), and a tail
    // window that stays empty reads as a script that failed to produce anything.

    const capabilities = detectCapabilities(ns);

    section(ns, "Environment");
    line(ns, "BitNode", String(capabilities.bitNode));
    const owned = [...capabilities.sourceFiles.entries()]
        .filter(([, level]) => level > 0)
        .sort(([a], [b]) => a - b)
        .map(([n, level]) => `${n}.${level}`);
    line(ns, "Source Files", owned.length > 0 ? owned.join(", ") : "none");

    section(ns, "Capabilities");
    for (const key of CAPABILITY_KEYS) {
        const reason = capabilities.unavailableReason(key);
        line(ns, key, reason === null ? "yes" : `no (${reason})`);
    }

    section(ns, "Probes");
    for (const [name, value] of Object.entries(capabilities.probes)) {
        line(ns, name, value ? "yes" : "no");
    }

    section(ns, "Deployment");
    // A feature whose script is not on home can never load, and a wrong path is
    // silent otherwise: the orchestrator only reports it as "not deployed".
    //
    // Presence is not the same as loadability. `getScriptRam` returns 0 for a file
    // that exists but will not compile, so checking only for the file would report
    // a broken deployment as healthy. Both are checked, and they are the same
    // condition the orchestrator's load gate uses.
    const deployment = featurePaths();
    let broken = 0;
    for (const path of deployment) {
        const resolved = resolve(ns, path);
        if (resolved === null) {
            broken += 1;
            line(ns, basename(path), "MISSING");
            continue;
        }
        if (ns.getScriptRam(resolved, "home") <= 0) {
            broken += 1;
            line(ns, basename(path), "PRESENT BUT WILL NOT COMPILE");
        }
    }
    line(ns, "scripts usable", `${deployment.length - broken}/${deployment.length}`);

    // ── Staleness ──
    //
    // PRESENCE AND COMPILABILITY ARE NOT ENOUGH. A file can be on home, compile, and
    // still be an old version — which is what a run that never reloaded looks like from
    // every other angle. Five fixes were committed against a run whose build stamp was
    // two days older than the code, and nothing in the framework could say so.
    //
    // THE COMPARISON THAT WORKS is the RUNNING SCRIPT's age against the files' mtimes. A
    // script keeps executing the copy it started with, so a file modified after the
    // process started is not the code that process is running. An earlier version of this
    // check compared feature mtimes against `nexus.ts`'s mtime instead, which is useless:
    // file sync pushes everything in one pass, so every mtime is similar and it reported
    // "current" on exactly the runs that were not.
    const orchestrator = findScriptOnHome(ns, "nexus.ts");
    const running = orchestrator === null ? null : findRunning(ns, orchestrator);

    if (running === null) {
        line(ns, "code freshness", "UNKNOWN (nexus.ts is not running)");
    } else {
        // Milliseconds since the process started, from the game rather than from a clock
        // this script would have to keep.
        const startedAt = Date.now() - running.onlineRunningTime * 1000;
        const stale: string[] = [];
        for (const path of deployment) {
            const resolved = resolve(ns, path);
            if (resolved === null) continue;
            const modified = ns.getFileMetadata(resolved)?.mtime ?? 0;
            // A file written after the process started is newer than the code it is
            // running. Unreadable metadata reads as 0 and is never "newer", so a file this
            // cannot see is not reported as stale.
            if (modified > startedAt) stale.push(basename(path));
        }
        line(ns, "nexus running for", `${Math.round(running.onlineRunningTime / 60)} min`);
        line(
            ns,
            "code freshness",
            stale.length === 0
                ? "current (nothing changed since the orchestrator started)"
                : `STALE — ${stale.length} changed since it started: ${stale.slice(0, 4).join(", ")}${stale.length > 4 ? ", …" : ""}`,
        );
        if (stale.length > 0) {
            line(ns, "", "restart with `run /nexus.ts` to load them");
        }
    }

    // One context for the rest of the report: the goal and the feature
    // decisions both read it, and deriving it twice would be two answers.
    const snapshot = createSnapshot(ns);
    const goals = deriveGoalsFor(snapshot, featureParticipation());
    const context = {
        capabilities,
        snapshot,
        reserves: createReserves(),
        // The doctor reports on a run, it does not drive one: nothing is disabled
        // by operator command, and there is no console attached to send one.
        disabled: new Set<string>(),
        goals,
        goal: currentGoal(goals),
        recent: createRecent(ns),
        multipliers: createContextReader(ns, capabilities),
    };

    section(ns, "Home RAM");
    const ownRam = ramOf(ns, "nexus.ts");
    line(ns, "home", `${ns.format.ram(snapshot.homeMaxRam, 2)} (${ns.format.ram(snapshot.homeUsedRam, 2)} used)`);
    line(ns, "orchestrator needs", ns.format.ram(ownRam, 2));
    line(ns, "free", ns.format.ram(Math.max(0, snapshot.homeMaxRam - snapshot.homeUsedRam), 2));

    section(ns, "Goal");
    // What the run is working toward, and what closes it. Every threshold the
    // framework applies -- the training floors, the karma and kill targets -- comes
    // from here rather than from a constant, so this is the answer to "why is it
    // doing that?".
    const goal = context.goal;
    if (goal === null) {
        line(ns, "goal", "none (every faction joined)");
    } else {
        line(ns, "goal", `${goal.goal} (${(goal.progress * 100).toFixed(0)}%)`);
        line(ns, "faction", goal.faction);
        for (const subGoal of goal.subGoals) {
            // Karma is negative and a ceiling, so the arrow reads the other way for
            // it: the player is moving DOWN toward the target.
            const direction = subGoal.key === "karma" ? "↓" : "→";
            // The contributors are shown beside each requirement, because "who can close
            // this" is the question the readers of this report actually have, and it is
            // now answerable: a requirement with no contributors cannot be closed by
            // anything running.
            const who = subGoal.contributors.length === 0
                ? " (nothing can advance this)"
                : ` (${subGoal.contributors.join(", ")})`;
            line(ns, subGoal.key, `${formatValue(ns, subGoal.key, subGoal.current)} ${direction} ${formatValue(ns, subGoal.key, subGoal.target)}${who}`);
        }
        // Every goal, not only the current one, so a reader can see what is queued behind
        // it and whether anything is working on it. The current goal is the first.
        if (context.goals.length > 1) {
            const rest = context.goals.slice(1).map(goal => {
                const blocked = goal.blockedBy.length > 0 ? ` BLOCKED:${goal.blockedBy.join("/")}` : "";
                return `${goal.goal} (${(goal.progress * 100).toFixed(0)}%)${blocked}`;
            });
            line(ns, "queued", rest.join(" | "));
        }
        if (goal.blockedBy.length > 0) {
            line(ns, "blocked by", goal.blockedBy.join(", "));
        }
    }

    let wouldLoad = 0;
    let totalRam = ownRam;

    for (const feature of [...FEATURES].sort((a, b) => a.priority - b.priority)) {
        const reason = unavailableReason(feature, context);
        if (reason !== null) {
            line(ns, feature.name, `skip: ${reason}`);
            continue;
        }

        const cost = ramOf(ns, feature.path);
        if (cost <= 0) {
            line(ns, feature.name, `skip: not deployed (${feature.path})`);
            continue;
        }

        // Each feature is charged to the orchestrator's thread, so the running
        // total is what has to fit, not the feature alone.
        const after = totalRam + cost;
        const fits = after <= snapshot.homeMaxRam;
        if (fits) {
            wouldLoad += 1;
            totalRam = after;
        }
        line(
            ns,
            feature.name,
            fits
                ? `ok (${ns.format.ram(cost, 2)}, ${ns.format.ram(after, 2)} total)`
                : `too big: needs ${ns.format.ram(after, 2)} of ${ns.format.ram(snapshot.homeMaxRam, 2)}`,
        );
    }
    line(ns, "would load", `${wouldLoad}/${FEATURES.length}`);

    section(ns, "Multipliers");
    // Read through the context, which is how features get them and which is what
    // applies the capability gate. Reading `ns.getBitNodeMultipliers()` directly
    // here would crash on exactly the node this script exists to diagnose.
    const mults = context.multipliers();
    if (mults === null) {
        line(ns, "available", `no (${capabilities.unavailableReason("multipliers")})`);
    } else {
        // The multipliers the framework's tuning reads, so the effect of a node
        // on target ranking and hash strategy is visible rather than inferred.
        for (const name of [
            "ServerMaxMoney",
            "HackingLevelMultiplier",
            "HackExpGain",
            "ScriptHackMoneyGain",
            "HacknetNodeMoney",
            "CloudServerCost",
            "CrimeMoney",
            "FactionWorkRepGain",
        ]) {
            line(ns, name, String(mults[name as keyof typeof mults]));
        }
    }

    section(ns, "Gang");
    // The gang's own tuning, which is derived from its state rather than
    // configured. A hard-coded threshold and a derived one look the same in a
    // single run; they only differ as the gang grows, so the inputs are shown
    // alongside the outputs.
    if (!capabilities.probes.gangMember) {
        line(ns, "available", "no (not currently in a gang)");
    } else {
        const info = ns.gang.getGangInformation();
        const members = ns.gang.getMemberNames().map(name => ns.gang.getMemberInformation(name));
        const enemyCount = Object.entries(ns.gang.getAllGangInformation())
            .filter(([name, other]) => name !== info.faction && other.territory > 0)
            .length;
        // The doctor reports on a gang it is not driving, so it asks the game the same
        // question the feature does rather than assuming growth is over.
        const derived = deriveGangConfig(info, members, enemyCount, ns.gang.canRecruitMember());

        line(ns, "type", info.isHacking ? "hacking" : "combat");
        line(ns, "members", `${members.length}, facing ${enemyCount} rival(s)`);
        line(ns, "territory", `${(info.territory * 100).toFixed(2)}% (taking below ${(derived.territoryEnableBelow * 100).toFixed(1)}%)`);
        line(ns, "respect", `${ns.format.number(info.respect)} (phase ends at ${formatThreshold(ns, derived.respectPhaseEnd)})`);
        line(ns, "wanted", `penalty=${(info.wantedPenalty * 100).toFixed(1)}% rate=${info.wantedLevelGainRate >= 0 ? "+" : ""}${info.wantedLevelGainRate.toFixed(2)}`);
        // NET WORTH, matching what the gang feature passes. Reporting cash here would
        // describe a different decision than the one the running gang is making. Read from
        // the snapshot now, which computes it once for the goal too, so the report, the
        // gang and the wealth goal cannot disagree about how rich the player is.
        const netWorth = context.snapshot.netWorth;
        const moneyFloor = targetFor(context.goal, "netWorth", derived.moneyFloor);
        line(
            ns, "money floor",
            `${ns.format.number(moneyFloor)} (net worth ${ns.format.number(netWorth)}, ` +
            `currently ${netWorth < moneyFloor ? "BINDING" : "clear"})`,
        );

        // The two decisions, so a disagreement is visible rather than inferred
        // from the gang's behaviour.
        //
        // Passed `snapshot.homeCash`, the same figure the feature passes. Reporting these
        // without it made the doctor describe the pre-floor behaviour while the running
        // gang did something else — a diagnostic that lies is worse than none.
        const enemies = scanEnemies(ns.gang.getAllGangInformation(), info);
        // The gang feature overrides the money floor with the run's wealth goal before
        // deciding, so the doctor must too, or it would report the pre-goal behaviour while
        // the running gang did something else.
        const gangConfig = { ...derived, moneyFloor };
        const mode = decideMode(info, gangConfig, info.isHacking, enemies, netWorth);
        const warfare = decideWarfare(info, info.isHacking, gangConfig, enemies, netWorth);
        line(ns, "mode", `${mode.mode} (${mode.reason})`);
        line(ns, "warfare", `${warfare.action} (${warfare.reason})`);
        // The cleanup crew, measured the way the feature measures it: the size is
        // matched to how fast the level is rising, so the inputs are shown beside it.
        const pressure = wantedPressureFor(
            createGang(ns, capabilities.has("formulas")), info, members, specialsFor(info.isHacking),
        );
        line(
            ns, "cleanup crew",
            `${wantedWorkersFor(info, pressure, members.length, derived)} of ${members.length}` +
            ` (rise ${ns.format.number(wantedRise(pressure))}/cycle, ` +
            `each cleaner ${ns.format.number(pressure.cleanupRate)})`,
        );
    }

    section(ns, "Dark Net");
    // Read through the feature's own capability gate, so a player without
    // DarkscapeNavigator.exe sees "not available" rather than a crash. The same
    // mistake the multipliers section above exists to avoid.
    const darknetReason = capabilities.unavailableReason("darknet");
    if (darknetReason !== null) {
        line(ns, "available", `no (${darknetReason})`);
    } else {
        reportDarknet(ns, context);
    }

    // The report is buffered; this writes it and prints the two lines worth seeing in the
    // terminal without opening the file.
    finish(ns, capabilities.bitNode);
}

/**
 * What the Dark Net looks like from home right now.
 *
 * Deliberately shallow: `probe` reports only the neighbourhood of the server the
 * calling script runs on, and this runs on home, so anything deeper is not visible
 * from here. Saying so is more useful than an empty section — a player who expects
 * to see depth 8 and reads "1 known" should learn that the walk is done by workers
 * rather than assume the feature is broken.
 */
function reportDarknet(ns: NS, context: Context): void {
    let neighbours: string[] = [];
    try {
        neighbours = ns.dnet.probe();
    } catch {
        line(ns, "probe", "threw (the net is unreachable from home)");
        return;
    }

    // Home is where this script runs, so it is not a target even when the probe
    // lists it. Filtering it here keeps the count honest.
    const targets = neighbours.filter(host => host !== "home");
    line(ns, "visible from home", targets.length === 0 ? "nothing" : targets.join(", "));

    const workers = findScriptOnHome(ns, "worm.ts");
    line(ns, "worm worker", workers === null ? "MISSING (the net cannot be discovered)" : `${ns.format.ram(ns.getScriptRam(workers, "home"), 2)} per deployment`);

    try {
        const instability = ns.dnet.getDarknetInstability();
        // Both figures explain "why is authentication so slow or flaky", which is the
        // question a player asks when the feature appears stuck.
        line(ns, "auth duration", `×${instability.authenticationDurationMultiplier.toFixed(2)}`);
        line(ns, "auth timeout", `${(instability.authenticationTimeoutChance * 100).toFixed(1)}% chance`);
    } catch {
        line(ns, "instability", "unavailable");
    }

    line(ns, "charisma", String(context.snapshot.player.skills.charisma));
    line(ns, "stasis links", `${ns.dnet.getStasisLinkedServers().length} of ${ns.dnet.getStasisLinkLimit()} used`);

    // What the net is worth on THIS node. `dnet_money` scales phishing and caches, so a
    // node with 0.5 pays half and a node with 2 pays double — the difference between
    // the Dark Net being a money source and being a distraction.
    //
    // It is a PLAYER multiplier (`player.mults.dnet_money`), not a BitNode one, so it
    // needs no SF5 and no capability gate. Reading it from the snapshot also means it
    // cannot disagree with what the features see.
    const dnetMoney = context.snapshot.player.mults?.dnet_money;
    line(ns, "dnet_money", dnetMoney === undefined ? "unavailable" : `×${dnetMoney}`);

    // Whether the run currently wants what earning gives. Both are spent on the
    // player's behalf, so the reasons are worth stating rather than leaving the
    // feature's silence to be interpreted.
    const karmaWanted = subGoalsFor(context.goal, ["karma"]).some(goal => !goal.done);
    const chaWanted = subGoalsFor(context.goal, ["cha"]).some(goal => !goal.done);
    line(
        ns, "earning on",
        `caches=${karmaWanted ? "any host" : "stationary only"} ` +
        `phishing=${karmaWanted || chaWanted ? "yes" : "no"}`,
    );

    if (!context.capabilities.has("formulas")) {
        line(ns, "formulas", "no (authentication times are estimates)");
    }
}

/**
 * `respectPhaseEnd` is Infinity for a gang at its size cap, which is meaningful
 * rather than a number to print.
 */
function formatThreshold(ns: NS, value: number): string {
    return Number.isFinite(value) ? ns.format.number(value) : "never (gang is full)";
}

/** The measures that read as money rather than as a plain count. */
const MONEY_KEYS: ReadonlySet<SubGoalKey> = new Set<SubGoalKey>([
    "money", "netWorth", "stockAccess", "gangRespect", "rep",
]);

/**
 * Money reads as money, percentages as percentages, and the rest as plain numbers.
 *
 * `gangTerritory` is a fraction of the map, not a count, so it is shown as a percentage
 * rather than a long decimal — 0.999995 as "99.9995%" is legible, as a raw number it is not.
 */
function formatValue(ns: NS, key: SubGoalKey, value: number): string {
    if (key === "gangTerritory") return `${(value * 100).toFixed(4)}%`;
    if (MONEY_KEYS.has(key)) return ns.format.number(value);
    return value.toLocaleString("en-US");
}

/*
 * ─── REPORTING ───
 * A fixed-width layout is the difference between a report that is read and one
 * that is skimmed.
 *
 * THE REPORT GOES TO A FILE, NOT THE TAIL WINDOW. It is ~45 lines across ten
 * sections, which scrolls the single most useful part — the deployment and freshness
 * lines near the top — off the screen the moment anything else prints. A tail window
 * is also wiped by whatever runs next; the orchestrator clears its own log every pass,
 * and this script shares a home directory with it.
 *
 * So the calls below ACCUMULATE and `finish` writes once. Every caller keeps the same
 * `section`/`line` shape, which is why this is a change to two functions rather than to
 * forty.
 */

/** The report, in order, until `finish` writes it out. */
const report: string[] = [];

/** Where the report lands, on home. Reachable from the terminal and from file sync. */
export const REPORT_FILE = "doctor_report.txt";

function section(ns: NS, title: string): void {
    report.push(`\n── ${title} ${"─".repeat(Math.max(0, 40 - title.length))}`);
}

function line(ns: NS, label: string, value: string): void {
    report.push(`${label.padEnd(LABEL)}${value}`);
}

/**
 * Write the accumulated report and say where it went.
 *
 * A short summary reaches the terminal as well, because a script that prints nothing
 * looks like it failed — and the two facts worth seeing without opening the file are
 * whether the run is broken and whether its code is stale.
 */
function finish(ns: NS, bitNode: number): void {
    const header = `Doctor report — BitNode ${bitNode}, ${new Date().toISOString()}`;
    ns.write(REPORT_FILE, `${header}\n${report.join("\n")}\n`, "w");

    const stale = report.find(l => l.includes("STALE"));
    const broken = report.find(l => l.includes("scripts usable"));

    ns.tprint(`DOCTOR: report written to ~/${REPORT_FILE} (${report.length} lines)`);
    if (broken !== undefined) ns.tprint(`DOCTOR: ${broken.trim()}`);
    if (stale !== undefined) ns.tprint(`DOCTOR: ${stale.trim()}`);
    announce(ns, "DOCTOR", `report written to ~/${REPORT_FILE}`, stale === undefined ? "info" : "warn");
}

/**
 * The running instance of a script, or null when it is not running.
 *
 * Used for the staleness check: `onlineRunningTime` is the only fact that answers "is the
 * code this process is executing the code on disk", because a script keeps running the
 * copy it started with. File mtimes alone cannot say — sync writes them all in one pass.
 *
 * `getRunningScript` takes a path that matches what the game reports, which may or may not
 * carry a leading slash. Tried both rather than guessing.
 */
function findRunning(ns: NS, path: string): { onlineRunningTime: number } | null {
    for (const candidate of [path, basename(path)]) {
        try {
            const info = ns.getRunningScript(candidate, "home");
            if (info !== null && info !== undefined) return { onlineRunningTime: info.onlineRunningTime };
        } catch {
            // A path form the API does not accept. The other candidate may.
        }
    }
    return null;
}

/*
 * ─── LOOKUPS ───
 */

/**
 * `ns.getScriptRam` needs a path as the game sees it. The registry stores paths
 * relative to the orchestrator, so they are resolved the same way the
 * orchestrator's `dynamicImport` resolves them.
 */
function resolve(ns: NS, relativePath: string): string | null {
    return findScriptOnHome(ns, basename(relativePath));
}

function ramOf(ns: NS, relativePath: string): number {
    const resolved = resolve(ns, relativePath);
    return resolved === null ? 0 : ns.getScriptRam(resolved, "home");
}
