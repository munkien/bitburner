import type { NS } from "@ns";

import { detectCapabilities, type Capabilities } from "./lib/caps.ts";
import {
    createContextReader,
    createRecent,
    createReserves,
    createSnapshot,
    deriveGoalsFor,
    type Context,
    type Reserves,
} from "./lib/context.ts";
import { createFeatureRuntime, type FeatureStatus } from "./lib/feature-runtime.ts";
import { announce, readStatuses } from "./lib/log.ts";
import { currentGoal, preferGoal, type Goal, type SubGoalKey } from "./lib/objective.ts";
import { measuredRateFor } from "./features/player/activity.ts";
import { featureParticipation, featuresInOrder } from "./lib/registry.ts";
import { stallClock } from "./features/retire/retire.ts";
import {
    sample,
    publish,
    publishLog,
    pollCommand,
    ackCommand,
    type Command,
    type NexusState,
} from "./strategy.ts";
import { drainMessages } from "./lib/messages.ts";
import { createChangeWatcher, type ChangeWatcher } from "./lib/self-restart.ts";

/*
 * ============================================================================
 * ORCHESTRATOR
 * ============================================================================
 * The framework loop. It decides which features are active and drives them, and
 * it does no automation of its own.
 *
 * Each pass:
 *
 *   capabilities  re-read the facts that can flip mid-run (TIX API, gang, TOR)
 *   snapshot      read game state once, for every feature to share
 *   pass          hand both to the feature runtime, which loads and ticks
 *   report        draw the dashboard
 *   publish       on a slower cadence, send telemetry and messages to the server
 *
 * What this module is, and is not. It owns the LOOP: sleeping between passes,
 * counting consecutive failures, deciding to stop, clearing the log panel and
 * drawing the dashboard. It does not own feature lifecycle — loading, RAM
 * accounting, retry cooldowns, tick cadence all live behind
 * `lib/feature-runtime.ts`'s single `pass` method.
 *
 * That split is what makes the runtime testable. It used to be this file's
 * body, interleaved with the loop, so the RAM gate and the error policy could
 * only be reached by starting the loop and racing a timer.
 *
 * The capability refresh stays here rather than moving behind the seam, because
 * this is also what builds the `Context` a tick receives: the requirements a
 * feature was admitted under and the readings it ticks with have to be the same
 * `Capabilities` value, and only one place can guarantee that.
 *
 * TELEMETRY AND COMMANDS. This is the single game entry point. Besides driving
 * the features it is also the bridge to the sync server and the React console: on
 * a slower cadence than the pass loop it publishes raw telemetry (`sample` +
 * `publish` in `./strategy.ts`), drains the framework's message port and posts
 * the batch (`publishLog`), and polls for operator commands. A command can set
 * reserve floors, switch features off, ask the run to prioritise a measurement
 * (re-ranking the derived goals, never inventing one), or pause automation
 * entirely while telemetry keeps flowing. That work lives in `./strategy.ts` so
 * this file keeps owning only the loop.
 *
 * SELF-RESTART. On that same cadence it checks whether its own file changed on
 * disk, and re-runs itself if so (`./lib/self-restart.ts`). Without it an edit
 * pushed by File Sync has no effect on a running script, which is a trap this
 * framework has fallen into three times.
 *
 * It watches the WHOLE TREE, not only this file. Watching this file alone meant a
 * feature edit — the common case, and where most of the logic lives — reloaded
 * nothing, and the symptom is indistinguishable from a fix that does not work. The
 * tree is discovered by walking from this script's directory, so a new feature is
 * covered when it lands rather than when someone remembers to list it here.
 * ============================================================================
 */

const LOOP_MS = 20;
/** How long to wait before retrying a feature that failed to load or threw. */
const LOAD_INTERVAL_MS = 1_000;

/**
 * How often to publish telemetry and poll for operator nudges.
 *
 * The loop runs every `LOOP_MS` (20ms), far too fast to hit the sync server on
 * every pass. Telemetry is for a human dashboard, so a second is plenty.
 */
const TELEMETRY_MS = 1_000;

/** How many queued goals to publish, for the console's "what is waiting" list. */
const QUEUE_DISPLAY_LIMIT = 10;

/**
 * Where the build leaves the commit it was made from.
 *
 * Written beside this script by `scripts/stamp-build.mjs`, which `npm run sync` runs
 * before pushing. The game cannot run `git`, so a file is the only way the answer can
 * travel with the code it describes.
 */
const BUILD_STAMP = "build.txt";

/**
 * Where the orchestrator writes the reason it stopped, if it stopped at all.
 *
 * Written by an `atExit` callback, which the game runs when the script dies for ANY
 * reason — a return, a throw, a killall, a spawn, out of RAM. A normal stop of the
 * framework writes "stopped"; anything else — the case that has been chased for six
 * rounds — leaves the real cause on disk where the next run (or a human) can read it.
 */
const EXIT_REASON_FILE = "nexus_exit_reason.txt";

/**
 * The largest failure count that still looks like a transient fault. A feature
 * that is simply not deployed is handled per-feature and does not count here.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");
    ns.ui.openTail();

    // THE EXIT TRAP, registered before anything else can die.
    //
    // The orchestrator has been exiting silently, with no ERROR line and no return path
    // that explains it. This callback runs on ANY death and writes where it was, so the
    // next boot can name the killer instead of the symptoms being re-diagnosed from a
    // recording that ends mid-pass.
    //
    // `reason` is cleared at the start of a pass and set on every ordinary exit path, so
    // the file only says something UNEXPECTED when the script died somewhere that never
    // had a chance to write a reason.
    let exitReason = "unknown (died before the loop wrote a reason)";
    ns.atExit(() => {
        try {
            ns.write(EXIT_REASON_FILE, `${exitReason}\n`, "w");
        } catch {
            // Even the cleanup can fail (e.g. out of RAM). Nothing more to do.
        }
    });
    // To the Terminal rather than the log panel: the first pass clears the panel,
    // so a startup line printed there would be gone before it could be read.
    ns.tprint("INFO: starting orchestrator");
    // NAMES THE COMMIT, so a stale in-game copy is obvious rather than something to
    // infer from the absence of telemetry.
    //
    // The game cannot run `git`, so the answer is left on disk by the build —
    // `scripts/stamp-build.mjs` writes `build.txt`, `npm run sync` runs it, and the file
    // travels through the sync like any other. It used to print the constant "nexus.ts
    // v2", which could not distinguish a current copy from a two-day-old one; that is
    // exactly the question that went unanswered while a run was diagnosed against code
    // that had never been synced.
    ns.tprint(`INFO: build: ${buildStamp(ns)}`);

    let capabilities: Capabilities = detectCapabilities(ns);
    ns.tprint(`INFO: ${capabilities.describe()}`);

    const reserves = createReserves();
    // One ring for the whole run. Created per pass it would be empty every time it
    // was read, since the features fill it after the pass begins.
    const recent = createRecent(ns);
    const runtime = createFeatureRuntime(ns);

    announceRoster(ns);

    // Reloads this script when its own file changes on disk. See the module for
    // why this exists; constructed once, and disabled entirely when no usable
    // fingerprint can be read.
    //
    // GUARDED, because it has taken the orchestrator down twice. Constructing it walks
    // the home filesystem, and anything that throws there killed nexus AFTER the roster
    // printed and BEFORE the loop began — so the symptom was a script that announced
    // thirteen features, loaded none of them, and returned to the prompt. No pass ever
    // ran, so the loop's own error handling could not report it.
    //
    // A watcher is a convenience: it saves the developer a manual restart. It must never
    // be able to prevent the framework from starting, so a failure here disables it and
    // says so rather than propagating.
    let changeWatcher: ChangeWatcher;
    try {
        changeWatcher = createChangeWatcher(ns);
    } catch (error) {
        ns.tprint(`WARN: file watcher unavailable (${describeError(error)}) — reload manually after edits`);
        changeWatcher = { enabled: () => false, check: () => false };
    }

    let lastLoadAt = 0;
    let consecutiveFailures = 0;

    // Telemetry/nudge cadence, separate from the pass loop.
    let lastTelemetryAt = 0;
    /** Whether the "publishing" line has been printed, so it is printed once. */
    let announcedTelemetry = false;

    // The operator's standing nudge, last received from the UI. Held so it
    // survives a poll with nothing pending, and applied as a floor each pass.
    let nudge: Command | null = null;

    // The goal the previous pass put at the head, so this pass's ranking can keep it instead
    // of trading it away on a purchase. Held HERE and not in the goal machinery, because that
    // is pure derivation and this is memory — the loop is the only thing that has any. See
    // `WorkingGoal`: without it the head follows the working balance, and the recorded runs
    // show it changing 30-110 times an hour for no reason but a gig being paid for.
    let working: Goal | null = null;

    while (true) {
        // Clear the trap every pass. If the process dies mid-pass, the atExit hook
        // writes whatever happened to be there — so an ordinary stop records its reason,
        // while a death the loop never saw still reads "unknown" and points at a crash
        // rather than at a decision.
        exitReason = "unknown (never wrote the exit reason this pass)";

        // A pass may fail, and a pass that fails must not take the framework with
        // it. Everything that runs on a timer is fallible: the capability probes
        // call the game, and the runtime imports modules and awaits feature
        // code. Without this guard the first failure ends the script, and because
        // `ns.clearLog` runs later in the same pass, the screen shows only what
        // printed before it: a silent stop.
        try {
            const now = Date.now();

            // Telemetry and message publishing run on their own slower cadence, so
            // the 20ms pass loop is not blocked on HTTP. Applied to reserves below,
            // before the snapshot that reads them.
            const dueTelemetry = now - lastTelemetryAt >= TELEMETRY_MS;
            if (dueTelemetry) {
                lastTelemetryAt = now;

                // Reload if this script's own file changed on disk. Checked HERE
                // rather than on every pass because it is file I/O, and once a
                // second is far more often than an edit arrives. `spawn` does not
                // return, so nothing below this runs once a restart begins.
                changeWatcher.check();

                const pending = await pollCommand();
                if (pending) {
                    nudge = pending;
                    await ackCommand();
                }

                // Drain the framework's message port and forward the batch to the
                // sync server, which is how feature output reaches the React
                // console. Drained here rather than per message so a burst costs
                // one request; the port is a FIFO and this is its only consumer.
                await publishLog(drainMessages(ns));
            }
            // The operator's reserves are a FLOOR, not a replacement. Applied
            // EVERY pass, right before the snapshot that reads them, because a
            // feature may lower a reserve during its tick (player.ts assigns
            // `reserves.cash`; the runtime assigns `homeRamGb`). Doing it here
            // means the floor is in force for the snapshot regardless of what
            // the previous pass wrote.
            if (nudge?.reserves?.money !== undefined) {
                reserves.cash = Math.max(reserves.cash, nudge.reserves.money);
            }
            if (nudge?.reserves?.ram !== undefined) {
                reserves.homeRamGb = Math.max(reserves.homeRamGb, nudge.reserves.ram);
            }

            // The operator's feature switches. Rebuilt from the nudge each pass —
            // NOT merged — because the nudge is the complete operator intent: a
            // feature re-enabled in the console must leave the disabled set, and
            // merging would only ever add. `value === false` means "off"; `true`
            // or absent means "on" (the framework's own judgement applies).
            //
            // A fresh set each pass, never a mutation of the previous one: the
            // runtime may still hold the Context that carried it.
            const disabled = new Set<string>();
            if (nudge?.features) {
                for (const [id, on] of Object.entries(nudge.features)) {
                    if (on === false) disabled.add(id);
                }
            }

            // Game state is read once per pass and shared by every feature: the
            // capability probes and the ticks all see the same snapshot. The
            // goal derives from that snapshot, so every feature works toward
            // the same goal rather than deriving its own.
            const snapshot = createSnapshot(ns, reserves.cash);

            // Refreshed here, not in the runtime, because the Context built below
            // has to carry the same reading the runtime admitted features under.
            if (now - lastLoadAt >= LOAD_INTERVAL_MS) {
                lastLoadAt = now;
                capabilities = detectCapabilities(ns, capabilities);
            }

            // Derived once and shared: `goal` is the first of `goals`, so a feature
            // reading either sees the same ranking. The registry's declarations are what
            // let each goal say which features can advance it, and mark what nothing can.
            //
            // The operator's requested goal re-ranks this list rather than
            // replacing it: goals stay derived from game state, and a request that
            // nothing can serve leaves the ranking alone. See `preferGoal`.
            //
            // The rate lookup is the feature's own measurement, passed rather than
            // imported (see `measuredRateFor`): it fills each goal's effort
            // estimate for REPORTING. Ranking still uses `progress` — see
            // `estimateSeconds` for why that is deliberate for now.
            const derived = deriveGoalsFor(
                snapshot,
                featureParticipation(),
                measuredRateFor,
                // The goal the run is already on. NOT consulted when the operator has named a
                // measurement: they have said what to work on, and keeping the previous goal
                // against that would make the command look ignored. A satisfied goal is gone
                // from `derived` by now, which is how a handover is supposed to happen.
                nudge?.goal === undefined ? { working: working ?? undefined } : {},
            );
            const goals = preferGoal(derived, nudge?.goal as SubGoalKey | undefined);
            working = currentGoal(goals);

            const context: Context = {
                capabilities,
                snapshot,
                reserves,
                disabled,
                goals,
                goal: currentGoal(goals),
                recent,
                // Read from the feature's own module state, AFTER the previous pass's
                // tick. One pass behind, deliberately: the clock is armed by a tick, and a
                // figure read before the tick that sets it would report a timer that is
                // already running as not yet started.
                stall: stallClock(),
                multipliers: createContextReader(ns, capabilities),
            };

            // If the operator asked for a measurement and the ranking did not move,
            // say so once. Silence would be indistinguishable from the command never
            // arriving, which is the failure this reporting exists to prevent.
            reportGoalRequest(ns, nudge?.goal, goals);

            // PAUSED: observe, do not act. The features are not ticked, so nothing
            // changes game state — but telemetry still publishes and commands are
            // still polled, so the console stays live and the pause is reversible.
            //
            // This is deliberately a skip AROUND the runtime rather than a stop of
            // the loop: killing the script would lose the loaded modules and the
            // console's connection, which is the opposite of a pause.
            const paused = nudge?.autonomy === "paused";
            if (paused) {
                reportPaused(ns);
            } else {
                reportResumed(ns);
                const outcome = await runtime.pass(context, capabilities);
                if (!outcome.ok) {
                    // Through the framework's own channel, not the log panel, because
                    // the panel is cleared and rewritten every pass and this message
                    // must outlive the pass it happened in.
                    ns.tprint(`ERROR: orchestrator pass failed: ${describeError(outcome.error)}`);
                    consecutiveFailures += 1;

                    // A pass that fails every time will fail forever. Stopping is
                    // better than a silent spin, and the log says which pass died.
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        ns.tprint(
                            `ERROR: orchestrator stopping after ${MAX_CONSECUTIVE_FAILURES} failed passes; ` +
                            `last failure: ${describeError(outcome.error)}`,
                        );
            exitReason = "3 failed passes: " + describeError(outcome.error);
                        return;
                    }
                } else {
                    consecutiveFailures = 0;
                }
            }

            ns.clearLog();
            report(ns, runtime.status(), context);

            // Telemetry, on its own slower cadence. Published AFTER the pass so
            // it reports this pass's goal and feature states rather than the
            // previous frame's. `sample` reads `ns`; the nexus block is built
            // here from the same `context` the dashboard uses, so the console
            // and the in-game panel cannot disagree.
            if (dueTelemetry) {
                const published = await publish(
                    sample(ns, describeNexus(context, runtime.status(), reserves))
                );
                if (!published) {
                    ns.tprint("WARN: telemetry publish failed — is the sync server running?");
                } else if (!announcedTelemetry) {
                    // Once, not per tick: a successful publish is otherwise
                    // invisible, so "publishing fine" and "never reached the
                    // publish branch" look identical from outside the game.
                    announcedTelemetry = true;
                    ns.tprint("INFO: telemetry publishing to the sync server");
                }
            }
        } catch (error) {
            // A failure outside the runtime: the probes, the snapshot, or the
            // dashboard. Treated the same way, because the loop must survive all
            // three.
            ns.tprint(`ERROR: orchestrator pass failed: ${describeError(error)}`);
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                ns.tprint(
                    `ERROR: orchestrator stopping after ${MAX_CONSECUTIVE_FAILURES} failed passes; ` +
                    `last failure: ${describeError(error)}`,
                );
            exitReason = "3 failed passes (snapshot): " + describeError(error);
                return;
            }
        }

        await ns.sleep(LOOP_MS);
    }
}

/** The message alone is useless without the call site for a game API failure. */
function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack === undefined ? error.message : `${error.message}\n${error.stack}`;
    }
    return String(error);
}

/**
 * Say once that automation is paused, rather than every pass.
 *
 * Reported on the transition, because the loop runs 50 times a second and a line
 * per pass would drown the console. The resume is announced by the same function
 * seeing the state change back.
 */
let reportedPaused: boolean | null = null;

function reportPaused(ns: NS): void {
    if (reportedPaused === true) return;
    reportedPaused = true;
    announce(ns, "nexus", "automation paused by operator — observing only", "warn");
}

/** Announce the return to full autonomy, once, on the transition. */
function reportResumed(ns: NS): void {
    if (reportedPaused !== true) return;
    reportedPaused = false;
    announce(ns, "nexus", "automation resumed", "success");
}

/**
 * Tell the operator when the goal they asked for is not being worked on.
 *
 * Reported ONCE per request, on change, because this runs every pass: a request
 * that nothing can serve would otherwise repeat for the life of the run.
 *
 * Three outcomes, and only the third is worth a line:
 *
 *   no request        nothing to say.
 *   request served    the goal in hand has an outstanding sub-goal on that key, so
 *                     the ranking moved and the dashboard shows it.
 *   request ignored   no goal has anything left to do on that measurement. Either
 *                     nothing loaded can advance it, or every goal that could is
 *                     already satisfied. Said out loud, because a command that
 *                     silently does nothing is indistinguishable from one that
 *                     never arrived.
 */
let reportedGoal: string | null = null;

function reportGoalRequest(
    ns: NS,
    requested: string | undefined,
    goals: readonly Goal[],
): void {
    const current = goals[0] ?? null;
    const served =
        requested !== undefined &&
        current !== null &&
        current.subGoals.some(goal => goal.key === requested && !goal.done);

    // The identity is the request plus whether it took: a request that starts being
    // served should be reported as a change, and so should one that stops.
    const state = requested === undefined ? null : `${requested}:${served}`;
    if (state === reportedGoal) return;
    reportedGoal = state;

    if (requested === undefined || served) return;

    announce(
        ns, "nexus",
        `goal "${requested}" has nothing outstanding to advance — ` +
        `the derived ranking stands`,
        "warn",
    );
}

/**
 * A goal value the way a reader expects to see it: money as money, a fraction of the map
 * as a percentage, everything else as a plain number.
 *
 * Shared with the doctor so the same figure is not shown two different ways in two places.
 */
function formatGoalValue(ns: NS, key: SubGoalKey, value: number): string {
    // The measures that are money rather than a count.
    if (key === "money" || key === "netWorth" || key === "stockAccess" || key === "gangRespect" || key === "rep") {
        return ns.format.number(value);
    }
    if (key === "gangTerritory") return `${(value * 100).toFixed(2)}%`;
    return value.toLocaleString("en-US");
}

/**
 * One goal, on a line: its name, progress, and what is still outstanding.
 * Short enough for the dashboard, which is redrawn every pass: the full breakdown lives in
 * doctor.ts, and this is the summary a glance needs.
 */
function describeGoal(ns: NS, goal: Goal): string {
    const gaps = goal.subGoals
        .map(subGoal => {
            const now = formatGoalValue(ns, subGoal.key, subGoal.current);
            const want = formatGoalValue(ns, subGoal.key, subGoal.target);
            // Mark a requirement nothing can advance, so a goal that is stuck reads as
            // stuck rather than as one the framework is quietly working on.
            const stuck = subGoal.contributors.length === 0 ? "!" : "";
            return `${subGoal.key}${stuck} ${now}→${want}`;
        })
        .join(", ");

    return `${goal.goal} (${(goal.progress * 100).toFixed(0)}%)${gaps === "" ? "" : ` — ${gaps}`}`;
}

/**
 * Announce what the framework is going to run, once, at boot.
 *
 * WHY THIS IS NOT ON THE DASHBOARD. It was: fourteen rows, one per registered feature,
 * redrawn every pass. That content is a CONSTANT between the rare
 * events that change it — a feature loading, dying, or being unloaded — so it consumed most
 * of a small panel to restate something the reader learned at startup, and it pushed the
 * lines that DO change (the feature output in the ring) off the bottom. The panel is for
 * what is happening; this is for what WILL happen, and it belongs where it can be read once
 * and scrolled back to.
 *
 * WHAT IS ANNOUNCED, and what deliberately is not:
 *
 *   the registry roster   Every feature the framework knows about, with its priority and
 *                         whether it needs anything. This is the answer to "why is there no
 *                         gang feature", which is otherwise three files away in the registry.
 *
 * The per-feature LOAD/SKIP/FAIL events are not repeated here: the runtime already
 * announces those as they happen (`reportOnce`), and this is the static roster rather than
 * a status report. Announcing both would print each feature twice at startup.
 *
 * Individual mounts go to `tprint`, which survives in the Terminal. A line per feature at
 * boot is right for that channel; a line per feature per PASS is what was wrong.
 */
function announceRoster(ns: NS): void {
    // IN THE ORDER THIS NODE ACTUALLY RUNS THEM, which is the whole reason priority became
    // a function of the BitNode: in Hacktocracy the printed list is a different list, and a
    // log showing the default order would be describing a run that is not happening.
    const bitNode = detectCapabilities(ns).bitNode;
    const order = featuresInOrder(bitNode);
    ns.tprint(`INFO: ${order.length} features registered, in priority order:`);
    for (const meta of order) {
        const needs = meta.requires.length > 0 ? ` — needs ${meta.requires.join(", ")}` : "";
        ns.tprint(`INFO:   ${String(meta.priority(bitNode)).padStart(4)}  ${meta.name}${needs}`);
    }
}

/**
 * The goals, on one line each, in rank order.
 *
 * The FIRST line is the goal being worked on now; the rest are queued behind it. Showing
 * only the current one left the others invisible — a reader could not tell that a goal was
 * waiting, or that something further down was already close.
 */
export function describeGoals(ns: NS, context: Context): string[] {
    if (context.goals.length === 0) return ["none (every faction joined)"];

    const lines = [`${describeGoal(ns, context.goals[0]!)}`];
    for (const goal of context.goals.slice(1)) {
        // Queued goals are indented and lose the outstanding breakdown: the detail belongs
        // to the goal being worked on, and repeating it for every goal would crowd out the
        // feature rows below.
        lines.push(`  · ${goal.goal} (${(goal.progress * 100).toFixed(0)}%)`);
    }
    return lines;
}

/**
 * Build the decision state the console renders, from the same inputs the
 * in-game dashboard uses.
 *
 * The point is that the panel and the console cannot disagree: both read the
 * one `context` and the one `runtime.status()` the pass produced. This is a
 * report only — nothing here is consulted by any feature.
 */
function describeNexus(
    context: Context,
    states: readonly FeatureStatus[],
    reserves: Reserves,
): NexusState {
    const goal = context.goal;

    return {
        // What each feature is doing, or the guard that stopped it. Carried in the
        // same frame as the rest of the state, so it reaches both the console and
        // the run recorder — a stall is then readable rather than inferred from the
        // fact that nothing changed.
        statuses: readStatuses(),
        goal: goal
            ? {
                name: goal.goal,
                progress: goal.progress,
                faction: String(goal.faction),
                estimateSeconds: goal.estimateSeconds,
                subGoals: goal.subGoals.map(subGoal => ({
                    key: subGoal.key,
                    current: subGoal.current,
                    target: subGoal.target,
                    contributors: [...subGoal.contributors],
                })),
            }
            : null,
        // `goals[0]` IS the goal, so the queue is everything after it.
        queued: Math.max(0, context.goals.length - 1),
        // The queued goals themselves, so the console can answer "is something
        // closer waiting?" — the question that makes goal ranking observable.
        // Capped: this is a display list, and the tail of a long queue is not
        // what a reader is scanning for.
        queue: context.goals.slice(1, QUEUE_DISPLAY_LIMIT + 1).map(goal => ({
            name: goal.goal,
            progress: goal.progress,
            estimateSeconds: goal.estimateSeconds,
        })),
        features: states.map(state => ({
            id: state.meta.id,
            name: state.meta.name,
            state: state.state,
            ramGb: state.ramGb,
            // The registry's declaration of what this feature can move. Static, so
            // it costs nothing, and it is what lets the command bar offer only the
            // goals something loaded can serve.
            movable: [...state.meta.movable],
        })),
        reserves: { cash: reserves.cash, homeRamGb: reserves.homeRamGb },
        // Spread rather than assigned, so an absent clock is an ABSENT FIELD and not a
        // `null` the UI has to distinguish from "waiting". The two states the console
        // must not confuse are "no clock" and "clock about to expire", and leaving the
        // field off is the one encoding that cannot be misread.
        ...(context.stall ? { stall: context.stall } : {}),
    };
}

/**
 * Draw the dashboard, into the log panel.
 *
 * A redrawn frame: `ns.print` plus `clearLog` is right for it, and the previous frame
 * SHOULD disappear. The rule for what belongs here is that the content has to CHANGE, or
 * be worth watching while it does not — a line that says the same thing every pass is
 * consuming a row of a small panel to tell the reader something they learned once.
 *
 * WHAT WAS REMOVED AND WHY, because each of these was here and each was a mistake of the
 * same kind:
 *
 *   the capabilities header   Fixed at boot. The BitNode, the Source Files and the API
 *                             capabilities cannot change during a run, so a header
 *                             restating them every pass spends the first line on a
 *                             constant. Announced once to the Terminal instead.
 *   the feature list          Fourteen rows, one per registered feature, of which the
 *                             only interesting content is which ones are NOT running.
 *                             A load or a death is an EVENT and goes to the Terminal;
 *                             the list itself is a constant between those events. What
 *                             stays here is the one-line summary below, which is the
 *                             part a reader actually scans for.
 *   the QUEUED goals          The first version of this fix kept the goal in hand and all
 *                             seventeen queued behind it. That was the same mistake again:
 *                             the queue is a near-constant list, it dominated the panel at
 *                             eighteen lines, and it is the reason the features' own output
 *                             was invisible. What stays is the goal being worked on and a
 *                             COUNT of what is waiting.
 *   the skip reasons          `X skipped: Singularity API: requires SF4` is a fact about the
 *                             run that cannot change without a reset, and it was being
 *                             redrawn every pass for every feature. Announced once at boot
 *                             with the roster; on the panel a non-running feature is named
 *                             and no more, because the reason is a scroll away.
 *
 * WHAT IS LEFT is what a reader watches: the goal being worked on and how far off it is,
 * anything that has FAILED or stopped, the two live figures that explain a feature not
 * loading (reserves and home RAM), and the ring of what the features have said recently.
 * Those are the lines that were previously being pushed off the bottom by the constant
 * ones — and the ring is the point of the panel, so anything that crowds it out is a bug.
 */
function report(ns: NS, states: readonly FeatureStatus[], context: Context): void {
    // The goal in hand, with its outstanding breakdown, because that is what every
    // threshold in every feature is derived from: a reader asking "why is it training
    // combat" finds the answer here.
    //
    // The QUEUE is a count rather than a list. It was seventeen lines, which made it the
    // largest thing on the panel and left no room for what the features were saying — and a
    // queue barely moves between passes, so those seventeen lines were restating a constant.
    const goalLines = describeGoals(ns, context);
    ns.print(`Goal: ${goalLines[0]}`);
    if (goalLines.length > 1) {
        ns.print(`  +${goalLines.length - 1} queued behind it`);
    }

    // What is NOT working, as a count plus the ones that need ATTENTION.
    //
    // Naming every stopped feature is the same mistake as naming every active one: on a
    // fresh BitNode that is thirteen near-identical lines of "stopped", and they are a
    // constant — a feature does not stop and start between passes. The distinction that
    // matters is between the two ways a feature can be absent:
    //
    //   expected   It needs a Source File or a Node the run does not have. Nothing to do
    //              about it, and the reason is in the Terminal from the boot announcement.
    //   faulted    It was admitted, then failed to load or died. On a run whose
    //              capabilities were met this is a BUG, it is the only thing here worth
    //              acting on, and it would otherwise be invisible as a number.
    //
    // So the faults are named and the merely-absent are counted. `unavailable` is the
    // expected case; `unloadable`, `failed`, `unloaded` and "waiting for RAM" are not.
    const active = states.filter(state => state.state === "active");
    const faults = states.filter(state => state.state === "failed" || state.state === "unloadable");
    const stopped = states.length - active.length;

    for (const state of faults) {
        // `state.reported` already holds the runtime's assembled line — the failure text
        // with its stack's first line — so it is printed as-is rather than re-derived. It
        // is also the reason this list is worth having: the message exists only for a
        // feature that got far enough to fail, and nothing else on the panel would show it.
        ns.print(`FAULT: ${state.meta.name} — ${state.reported?.message ?? state.state}`);
    }

    const totalRam = active.reduce((sum, state) => sum + state.ramGb, 0);
    ns.print(
        `${active.length}/${states.length} active` +
        (active.length > 0 ? ` (${ns.format.ram(totalRam, 0)})` : "") +
        (stopped > 0 ? `, ${stopped} not running` : ""),
    );

    // Live figures, kept because they are the answer to "why is that feature not
    // running". Home RAM as a fraction rather than the reserve alone, because a full home
    // is the usual cause and the reserve line only shows what is being held back.
    const used = ns.getServerUsedRam("home");
    const total = ns.getServerMaxRam("home");
    ns.print(
        `Reserves: cash ${ns.format.number(context.reserves.cash)}, ` +
        `home RAM ${context.reserves.homeRamGb} GB held`,
    );
    ns.print(`Home RAM: ${ns.format.ram(used, 2)} / ${ns.format.ram(total, 2)} used`);

    // What the features have said recently, under the dashboard.
    //
    // This is the only place feature output is visible at all: a feature's `ns.print`
    // lands in this same panel, which clearLog empties every pass, so without the ring
    // nine features would be talking to nobody. It is also the reason the constant lines
    // above had to go — the ring is the content, and it was being pushed off screen.
    const recent = context.recent.read();
    if (recent.length > 0) {
        ns.print("");
        ns.print(`─── recent (last ${recent.length}) ───`);
        for (const note of recent) ns.print(note);
    }
}

/**
 * A fingerprint of the source this copy was built from, or why it cannot say.
 *
 * Read from `build.txt`, which `npm run sync` writes beside this script. Never throws and
 * never returns empty: a caller printing the build should not have to handle a failure,
 * and "unknown" is a far more useful line than nothing at all.
 *
 * THE FINGERPRINT IS A HASH OF THE SOURCE FILES, not of a commit. Two copies of the same
 * code stamp identically whatever the repository says, which is the equality a reader
 * actually wants — "is the game running the code on disk?". Keying it to a commit made
 * that question depend on git bookkeeping that cannot be written inside the thing it
 * describes. The commit is still appended, after `@`, for convenience.
 *
 * So comparing this line to a fresh `npm run stamp` answers "is the game current?":
 * same fingerprint means same source.
 */
function buildStamp(ns: NS): string {
    try {
        if (!ns.fileExists(BUILD_STAMP, "home")) return "unstamped (build.txt not synced)";
        const stamp = ns.read(BUILD_STAMP).trim();
        return stamp === "" ? "unstamped (build.txt empty)" : stamp;
    } catch {
        return "unknown (build.txt unreadable)";
    }
}
