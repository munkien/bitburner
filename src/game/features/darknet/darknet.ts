import type { NS } from "@ns";

import type { Context } from "../../lib/context.ts";
import { ChangeLog, announce } from "../../lib/log.ts";
import { subGoalsFor } from "../../lib/objective.ts";
import { drainReports, type WormReport } from "./darknet-reports.ts";
import { findScriptOnHome } from "../../lib/scripts.ts";
import {
    ENTRY,
    deepestDepth,
    frontier,
    needsSession,
    nodeFrom,
    reachable,
    reconcile,
    route,
    type DarknetMap,
    type DarknetNode,
} from "./darknet-map.ts";
import {
    candidatesFor,
    classifyFailure,
    charismaPenalty,
    worthAttempting,
    type DarknetVerdict,
    type PasswordFacts,
} from "./darknet-password.ts";

/*
 * ============================================================================
 * DARK NET (Master)
 * ============================================================================
 * Walks the Dark Net outward from `darkweb` and deploys Worm Workers onto the hosts
 * it opens.
 *
 * The placement is forced rather than chosen, and it is worth stating exactly why,
 * because the obvious design does not work:
 *
 *   - `dnet.probe()` reports the neighbourhood of the server the CALLING SCRIPT
 *     runs on. It takes no host argument. So a Master on home can only ever see
 *     home's neighbours, whatever it holds sessions for.
 *   - `authenticate` needs a DIRECT connection, so the chain must be walked hop by
 *     hop in order.
 *
 * The consequence: **the Master cannot discover the net on its own.** Discovery has
 * to happen out on the servers, which is what Worm Workers are for — they probe
 * their own neighbourhood and report it, and the Master folds those reports in. The
 * division of labour is therefore not a stylistic choice but the only arrangement
 * the API permits.
 *
 * The feature split the framework uses, mapped onto this file and its modules:
 *
 *   observe   read home's neighbourhood, and read what the workers reported
 *   plan      `darknet-map.ts` and `darknet-password.ts` decide the walk;
 *             `darknet-money.ts` decides what is worth earning
 *   execute   authenticate, deploy workers, and account what they earned
 *
 * Earning happens in the WORKER rather than here, because both of the net's money
 * sources require standing on the host: `openCache` opens a file "on the current
 * server", and `phishingAttack` "can only be run from scripts on darknet servers". The
 * worker is told whether the run still wants karma and charisma, since only the
 * Master has a `Context` to read the goal from.
 *
 * Not here yet: memory reclamation, stasis links, server migration. Each is one more
 * `dnet` call and its own decision.
 * ============================================================================
 */

/** Where the worker script lives, resolved at runtime because sync may nest it. */
const WORM_NAME = "worm.ts";

/**
 * The server this Master runs on.
 *
 * Named because `probe()` reports the caller's own neighbourhood, and each entry
 * has to be judged as a target rather than as a place to act from. Home is never a
 * target.
 */
const HOME = "home";

/**
 * How many hops to open per tick.
 *
 * One, because each hop is an `authenticate` round trip that can take seconds on an
 * unstable net, and the tick is shared with every other feature.
 */
const HOPS_PER_TICK = 1;

/** Hosts this Master has opened, and therefore can deploy to. */
const sessions = new Set<string>();

/**
 * Passwords this Master has already found, by host.
 *
 * The reason this exists, and the reason the walk was so slow.
 *
 * `authenticate` is ASYNC and its speed scales with threads — the game's docs say "the
 * speed of authentication scales with the number of threads used", and it defaults to
 * one. A Master is a single-threaded script running inside the orchestrator, so it
 * cannot give the call more threads; it was attacking every hop one tick at a time at
 * the slowest possible rate.
 *
 * `connectToSession` is the escape. It is SYNCHRONOUS, costs 0.05 GB, takes the server's
 * password, and — unlike `authenticate` — "can be used to get a session on servers at
 * any distance". So the expensive asynchronous call is needed only ONCE per host, to
 * discover the password. After that the whole route can be re-established in a single
 * synchronous pass, on every tick, however deep it goes.
 *
 * This also answers the objection that a session is per-PID and dies with the script:
 * re-establishing is now cheap enough to do unconditionally rather than something to
 * cache and hope.
 */
const knownPasswords = new Map<string, string>();

/** The map, accumulated across ticks because `probe` only ever shows a neighbourhood. */
let map: DarknetMap = new Map();

/**
 * Neighbours reported by Worm Workers, keyed by the host that reported them.
 *
 * This is the discovery channel. It is separate from `map` because a report is
 * evidence about an EDGE, and the node behind that edge still has to be read before
 * it can be judged.
 */
const reported = new Map<string, string[]>();

let log: ChangeLog | null = null;
let warnedNoWorm = false;
/** Whether the one-shot diagnostic has been printed. */
let diagnosed = false;

/**
 * What the Dark Net has earned this run.
 *
 * Money is not tracked, because the game's own balance already reports it. These two
 * are visible nowhere else, and the karma figure is the one a player needs to see: it
 * is spent on their behalf and is hard to undo.
 */
let cachesOpened = 0;
let karmaSpent = 0;

/** Password attempts awaiting their promise, one per (host, password). */
const inFlight = new Map<string, { settled: boolean; verdict: DarknetVerdict | null }>();

/** Module state is per-process, so a restart legitimately starts empty. Exposed for tests. */
export function reset(): void {
    sessions.clear();
    map = new Map();
    reported.clear();
    inFlight.clear();
    knownPasswords.clear();
    log = null;
    warnedNoWorm = false;
    diagnosed = false;
    cachesOpened = 0;
    karmaSpent = 0;
}

/**
 * The hosts this Master currently holds a session for.
 *
 * Exposed because the alternative is for a test to infer it from a log line, which
 * differs by a tick: the game grants the session when `authenticate` resolves, and
 * the Master only learns of it when it next reads the verdict. A test asserting on
 * the game's view would pass while the Master had not yet noticed.
 */
export function sessioned(): readonly string[] {
    return [...sessions];
}

export function tick(ns: NS, context: Context): void {
    log ??= new ChangeLog(ns, "DNET");
    log.updateNs(ns);

    // Once per process, say what the game actually reports.
    //
    // Everything the feature does downstream interprets these calls, and every failure
    // in them was caught and turned into an empty map — so "the net is unreachable",
    // "probe returned nothing", and "getServerDetails throws for every host" all looked
    // identical from outside. Diagnosing that by inference took several attempts and got
    // it wrong each time, which is what this line is for.
    //
    // To the TERMINAL, not the log panel: the panel is wiped every pass, so a one-shot
    // diagnostic printed there is gone before it can be read. `announce` writes to the
    // panel; `ns.tprint` survives.
    if (!diagnosed) {
        diagnosed = true;
        ns.tprint(`[DNET] diagnostic: ${diagnose(ns, context)}`);
    }

    // Worker reports arrive on a port rather than as a return value, because a worker
    // is a separate script in a separate context that exits when it is done. Drained
    // before `observe` so this pass can act on what the workers found.
    for (const report of drainReports(ns)) {
        acceptReport(report.from, report.reachable);

        // Earnings are reported as events, because each one is a thing that happened
        // rather than a reading: a cache is a one-off find, and the karma it cost is
        // the part a player would want to be able to look back at.
        if ((report.opened ?? 0) > 0) {
            cachesOpened += report.opened ?? 0;
            karmaSpent += report.karmaLost ?? 0;
            announce(ns, "DNET", `opened ${report.opened} cache(s) on ${report.from} (${report.karmaLost} karma)`, "tx");
        }
    }

    if (!observe(ns)) {
        // Not a fault: the net moves, and `darkweb` may simply not be adjacent to
        // home right now. A Situation rather than a Requirement, which is why the
        // feature stays loaded and reports rather than unloading itself.
        log.change("status", "Status", "unreachable", "darkweb is not visible from home");
        return;
    }

    const charisma = context.snapshot.player.skills.charisma;

    const target = frontier(map, charisma, 1)[0];
    if (target === undefined) {
        // Nothing is both reachable and openable. Say WHICH of the two it is, because
        // they need different responses: a charisma gap is answered by training, and a
        // severed route is answered by waiting for the net to reshape. Reporting
        // "walking" while nothing can move is the silence that makes a stuck feature
        // look like a working one.
        reportBlocked(ns, charisma);
    } else {
        openRouteTo(ns, target, charisma);
    }

    deploy(ns, context);

    // The CHANGING part must be the `value`, not the `detail`.
    //
    // `ChangeLog.change` deduplicates on `value` alone, so passing the constant
    // "walking" as the value and the depth as the detail printed this line exactly once
    // and then suppressed it forever — the depth could climb from 0 to 9 with nothing on
    // the panel to show for it. That is indistinguishable from a feature that has
    // stopped, which is how it was reported: "nothing is currently happening in the
    // darknet view".
    //
    // The depth and the count are what a reader watches, so they are the value.
    const depth = deepestDepth(map);
    log.change(
        "status", "Status",
        // `attempts` is part of the value, not the detail, for the same reason the depth
        // is: while the walk is attacking a server it makes no other visible progress,
        // and a wrong password used to produce no output at all. Without a changing
        // number here, "working through a password list" and "stuck" look identical for
        // as long as it takes to exhaust the candidates.
        `depth=${depth} known=${map.size} sessions=${sessions.size} attempts=${inFlight.size}`,
        `caches=${cachesOpened} karma=${karmaSpent}`,
    );
}

/**
 * Fold this pass's observations into the map.
 *
 * Three sources, and only the first is available to the Master directly:
 *
 *   home's own `probe`     finds `darkweb`, and re-confirms it after a mutation
 *   worker reports         what each opened host can see from where it stands
 *   `getServerDetails`     the facts behind every host named by either
 *
 * Returns false when the entry is not visible, which is the game's way of saying
 * the net has moved or the player is no longer connected to it.
 */
function observe(ns: NS): boolean {
    const readings: DarknetNode[] = [];

    // Home can always see `darkweb` when the net is reachable at all. This is the
    // root of every route, so it is read even when nothing else is.
    //
    // Home itself is EXCLUDED, and that is load-bearing: `probe()` reports the
    // servers connected to the caller, which from home includes any adjacent darknet
    // server AND home can be described as one. Recording home as a node put it at
    // depth -1, made it the shallowest entry in the frontier, and consumed the one
    // hop per tick trying to authenticate on the machine the script already runs on
    // — so the walk never advanced.
    for (const host of safeProbe(ns)) {
        if (host === HOME) continue;
        readings.push(readNode(ns, host, null));
    }

    // What the workers saw. An edge is only as good as the host that reported it, so
    // a report from a host we do NOT hold is not trusted as evidence yet — but it is
    // also not thrown away. A worker's report can arrive before the Master has
    // finished registering the session that produced it, and discarding it there
    // would lose a discovery the net may not offer again.
    // What the workers saw. An edge is only as good as the host that reported it, so a
    // report from a host we do NOT hold is not trusted as evidence yet — but it is also
    // not thrown away. A worker's report can arrive before the Master has finished
    // registering the session that produced it, and discarding it there would lose a
    // discovery the net may not offer again.
    //
    // The GATEWAY is accepted without a session, and that is the whole point. `darkweb`
    // cannot hold one — there is nothing to authenticate against — so requiring one threw
    // away every report it produced. A worker on the gateway is the ONLY way to learn what
    // lies below it, so discarding its report meant the darknet's first level could never
    // be discovered however long the feature ran.
    for (const [from, neighbours] of reported) {
        if (from !== ENTRY && !sessions.has(from)) continue;
        for (const host of neighbours) {
            // `from` is skipped because a server is not its own neighbour, and HOME
            // is skipped for the same reason it is skipped above: it is where this
            // script runs, not somewhere to authenticate.
            if (host === from || host === HOME) continue;
            readings.push(readNode(ns, host, from));
        }
    }

    map = reconcile(map, readings.filter(node => node.host !== ""));
    return reachable(map, ENTRY);
}

/**
 * The neighbourhood of the server this script runs on, which is home.
 *
 * There is deliberately no host parameter: `dnet.probe()` takes none, and a previous
 * version of this file accepted one and ignored it, which made the walk look like it
 * was reading remote neighbourhoods when it was re-reading home's. Remote discovery
 * goes through `reported`.
 */
function safeProbe(ns: NS): string[] {
    try {
        return ns.dnet.probe();
    } catch {
        return [];
    }
}

/** Read one server's details, or record it as offline when it has vanished. */
function readNode(ns: NS, host: string, via: string | null): DarknetNode {
    try {
        return nodeFrom(host, via, ns.dnet.getServerDetails(host), sessions.has(host));
    } catch {
        // Gone since the last reading, or never really there. Recorded as offline
        // rather than dropped, so a severed route is visible in the map instead of
        // silently shrinking it.
        return nodeFrom(host, via, {
            isConnectedToCurrentServer: false,
            hasSession: false,
            modelId: "unknown",
            passwordHint: "",
            data: "",
            logTrafficInterval: 0,
            passwordLength: 0,
            passwordFormat: "numeric",
            blockedRam: 0,
            difficulty: 0,
            depth: -1,
            requiredCharismaSkill: 0,
            isStationary: false,
            isOnline: false,
        }, false);
    }
}

/**
 * Establish the session chain to `target`, in order, stopping at the first hop that
 * will not open.
 *
 * `authenticate` requires a direct connection, so hop 3 cannot be opened before hop
 * 2. When a hop refuses, the walk stops there: everything past it is unreachable
 * through this route by definition, and trying to skip ahead would issue calls that
 * are guaranteed to fail.
 */
function openRouteTo(ns: NS, target: DarknetNode, charisma: number): void {
    const chain = route(map, target.host);
    if (chain === null) return;

    // Restore every hop we already know the password for, synchronously and all at once.
    //
    // This is the difference between a walk that takes one tick per hop and one that is
    // simply current. `connectToSession` is synchronous, cheap, and works at any
    // distance, so a known password costs nothing to re-apply — whereas `authenticate`
    // is async and single-threaded here, which is what made the walk crawl.
    //
    // Done first, and for the WHOLE chain, because a later hop cannot be reached until
    // the ones before it are re-established. The old per-tick budget applied here too,
    // which meant a five-hop route took five ticks to become current on every pass.
    for (const host of chain) {
        const password = knownPasswords.get(host);
        if (password === undefined) continue;
        if (sessions.has(host)) continue;

        if (reconnect(ns, host, password)) {
            sessions.add(host);
        } else {
            // The password stopped working, which a mutation can do: a server that
            // restarts may come back "cleaned and with a new password". Forgetting it
            // puts the host back in the attack path rather than leaving it permanently
            // unreachable through a stale credential.
            knownPasswords.delete(host);
        }
    }

    const missing = needsSession(map, target.host);
    let opened = 0;

    for (const host of missing) {
        // Budgeted, because these are the hops that need the expensive async call.
        if (opened >= HOPS_PER_TICK) return;

        const node = map.get(host);
        if (node === undefined) return;

        const outcome = tryAuthenticate(ns, node, charisma);
        // `pending` means nothing to decide yet: the round trip is still out, and
        // the next tick will pick it up.
        if (outcome === "pending") return;
        if (outcome === "failed") return;

        opened += 1;
    }
}

/**
 * Re-apply a known password, synchronously.
 *
 * Returns whether the session is held afterwards. A throw is a refusal, not a fault:
 * the game reports an unauthenticated host by throwing or by returning `success: false`,
 * and both mean "this host needs attacking again".
 */
function reconnect(ns: NS, host: string, password: string): boolean {
    try {
        return classifyFailure(ns.dnet.connectToSession(host, password)).kind === "ok";
    } catch {
        return false;
    }
}

/** `opened` once a session was granted; `pending` while a call is out; `failed` otherwise. */
type OpenOutcome = "opened" | "pending" | "failed";

/**
 * Say why nothing can move, so a stalled walk is distinguishable from a working one.
 *
 * The two blockers need different responses and are therefore named separately:
 *
 *   charisma   the frontier is empty because every known server demands more than the
 *              player has. Answered by training, and it is the common case early on.
 *   unreachable no unauthenticated server has an intact route from home. Answered by
 *              waiting for a mutation, or by re-reading the neighbourhood.
 *
 * Reported through `ChangeLog` rather than `announce`: this is a state that persists,
 * not an event, and repeating it every pass would bury the events that do matter.
 */
function reportBlocked(ns: NS, charisma: number): void {
    const candidates = [...map.values()].filter(node => node.online && !node.session);
    if (candidates.length === 0) {
        log?.change("blocked", "Blocked", "no targets", "every known server is offline or already open");
        return;
    }

    const lowest = candidates.reduce(
        (min, node) => (node.requiredCharisma < min ? node.requiredCharisma : min),
        Infinity,
    );
    if (Number.isFinite(lowest) && lowest > charisma) {
        log?.change("blocked", "Blocked", "charisma", `nearest needs ${lowest}, have ${charisma}`);
        return;
    }

    log?.change("blocked", "Blocked", "unreachable", `${candidates.length} known but none has a route from home`);
}

/**
 * Try the generated passwords against one server, best first.
 *
 * Synchronous by design. `authenticate` is async, and awaiting it would stall every
 * other feature for the duration of a round trip that can take seconds. Each
 * attempt's promise is adopted instead, and its verdict read on a later tick — which
 * is safe because a session persists until the script dies, and the map is re-read
 * every pass regardless.
 */
function tryAuthenticate(ns: NS, node: DarknetNode, charisma: number): OpenOutcome {
    const facts: PasswordFacts = {
        passwordHint: node.passwordHint,
        passwordLength: node.passwordLength,
        passwordFormat: node.passwordFormat,
        modelId: node.modelId,
        data: "",
    };

    const viable = worthAttempting(facts, charisma, node.requiredCharisma);
    if (!viable.ok) {
        // Once per server rather than once per tick: a server that cannot be opened
        // is a fact about the net, not an event, and repeating it every pass would
        // bury everything else in the panel.
        log?.change(`skip:${node.host}`, node.host, "skipped", viable.reason);
        return "failed";
    }

    // Charisma does not gate the attempt, but it does slow it down, and a slow host is
    // the one thing that looks like a stall. Reported once per host so the reason is
    // visible rather than inferred from how long a password is taking.
    const penalty = charismaPenalty(charisma, node.requiredCharisma);
    if (penalty > 1) {
        log?.change(
            `slow:${node.host}`, node.host, "slow",
            `charisma ${charisma} below ${node.requiredCharisma}, auth ~${penalty.toFixed(1)}x slower`,
        );
    }

    const candidates = candidatesFor(facts);

    for (const password of candidates) {
        const key = `${node.host}\u0000${password}`;
        const record = inFlight.get(key);

        if (record === undefined) {
            // Never tried. This is the only branch that issues, so a candidate is
            // attempted exactly once and the list advances on the next call.
            issue(ns, key, node.host, password);
            return "pending";
        }

        if (!record.settled) {
            // The round trip is still out. Nothing to decide yet.
            return "pending";
        }

        if (record.verdict?.kind === "ok") {
            grant(sessions, node, ns, password);
            return "opened";
        }

        // Settled and wrong. The record is LEFT IN PLACE, and that is the fix.
        //
        // The previous version deleted it here to "skip to the next candidate", then
        // `continue`d — which restarted the loop at candidates[0] and found no record
        // for the first password it had just erased. So the first candidate was issued
        // again, and the sequence cycled `aaaa, bbbb, aaaa, cccc, aaaa, bbbb, …` without
        // ever reaching a later one. A wrong password is a FACT about this host, and
        // forgetting it is what made the walk look stuck: it was stuck.
        //
        // The record also has to survive the tick, because `candidatesFor` is called
        // fresh every pass and rebuilds the same list. Keeping the verdict is what makes
        // the list a queue rather than a loop.
    }

    return "failed";
}

/** Adopt the promise for one attempt, recording its verdict for a later tick. */
function issue(ns: NS, key: string, host: string, password: string): void {
    const record: { settled: boolean; verdict: DarknetVerdict | null } = { settled: false, verdict: null };
    inFlight.set(key, record);

    void Promise.resolve(ns.dnet.authenticate(host, password))
        .then(result => {
            record.verdict = classifyFailure(result);
            record.settled = true;
        })
        .catch(() => {
            // A rejection is the API being unreachable, not a verdict on the
            // password, so it is recorded as retryable rather than as wrong.
            record.verdict = { kind: "retry", reason: "authenticate rejected" };
            record.settled = true;
        });
}

/** Record an opened session and say so once. */
function grant(
    sessions: Set<string>,
    node: DarknetNode,
    ns: NS,
    /** The password that worked, remembered so the route can be re-established for free. */
    password: string,
): void {
    knownPasswords.set(node.host, password);
    if (sessions.has(node.host)) return;
    sessions.add(node.host);
    announce(ns, "DNET", `opened ${node.host} (depth ${node.depth}, ${node.modelId})`, "success");
}

/**
 * Copy the worm onto every host we hold a session for, and start it.
 *
 * `scp` works at any distance once a session exists, but `exec` needs a direct
 * connection, a backdoor or a stasis link — so in practice this starts only on hosts
 * adjacent to home, and the copy is what makes deeper hosts usable when a route
 * eventually reaches them.
 *
 * A worker that cannot be started is not an error worth reporting every tick: the
 * host may have restarted, which a mutation does routinely.
 */
function deploy(ns: NS, context: Context): void {
    const worm = findScriptOnHome(ns, WORM_NAME);
    if (worm === null) {
        if (!warnedNoWorm) {
            warnedNoWorm = true;
            announce(ns, "DNET", `ERROR: ${WORM_NAME} is not deployed; the net cannot be discovered`, "error");
        }
        return;
    }

    // Every sessioned host gets a worker, including the entry. `darkweb` is not a
    // special case: it is a darknet server whose neighbourhood is where the second
    // hop comes from, and skipping it left the walk permanently stuck at one node —
    // the Master could open `darkweb` and then never learn what lay past it.
    // Whether the run still wants what a worker can earn. Answered by the goal,
    // which is the same predicate `player.ts` uses to decide whether to keep farming
    // Homicide — spending karma is progress while a faction gate still wants it and
    // waste once it does not.
    const karmaMatters = karmaStillWanted(context);
    const charismaWanted = charismaStillWanted(context);

    // Only the ENTRY is deployable from here.
    //
    // `ns.exec` reaches a darknet host only when "the script is running on a server that
    // is directly connected to the target, or the target has a backdoor or stasis link".
    // This script runs on home, so the only darknet host it can start a worker on is the
    // one directly connected to home — the entry. Attempting the deeper ones failed
    // silently: `exec` returns 0, nothing is started, and the walk stops at whatever the
    // first worker could see.
    //
    // Everything past the entry is reached by the WORKER chaining, which is why
    // `spreadOnward` exists in `worm.ts`: a worker is directly connected to its own
    // neighbours, so it is the only thing that can extend the frontier.
    //
    // Home itself is not in `sessions` (it is not a darknet host), so this is a
    // one-entry list in practice — but it is written as "what is adjacent to home"
    // rather than "the entry", so a future net that exposes two neighbours of home
    // needs no change here.
    // Hosts to put a worker on: the gateway, plus every sessioned host adjacent to home.
    //
    // The GATEWAY is the case that was missing, and it is why nothing was ever discovered.
    // `darkweb` is not a target — it cannot be authenticated, since it has no password —
    // so it never entered `sessions`, so `deploy` never put a worker on it, so its
    // neighbours were never reported. The walk could not learn that anything existed
    // below the door it was standing at.
    //
    // It does not need a SESSION to host a worker; it is directly connected to home, which
    // is what `exec` requires. So it is deployable on the same terms as any adjacent host.
    const adjacentToHome = new Set(safeProbe(ns));
    const deployable = new Set<string>([...sessions].filter(host => adjacentToHome.has(host)));
    if (adjacentToHome.has(ENTRY)) deployable.add(ENTRY);

    for (const host of deployable) {
        try {
            if (ns.scriptRunning(worm, host)) continue;
            if (!ns.fileExists(worm, host)) ns.scp(worm, host, "home");
            // One thread is correct here: a worker only probes and deploys, and the
            // authentication it reports on is the Master's job. Threads would scale
            // nothing this script does.
            ns.exec(worm, host, 1, host, karmaMatters, charismaWanted);
        } catch {
            // The host restarted or went offline between the session and now, which
            // is routine. Dropping the session is the correct response; the map
            // still knows the host, and the next reading will say whether it is back.
            sessions.delete(host);
        }
    }
}

/**
 * Whether any faction still wants the player to be less vicious.
 *
 * Karma is a CEILING: several factions require the player to be at or below a negative
 * value, so dropping it is progress while a gate is outstanding and waste once it is
 * met. It is deliberately NOT "is karma bad" — spending karma nothing needs spent is
 * the mistake ADR-0003 records, where a run reached -240K against a -54K target and
 * closed off content that wants a kinder player.
 *
 * Read through `subGoalsFor` rather than by scanning `goal.subGoals`: that is the
 * interface the goal publishes for exactly this question, and reading the raw
 * list is the duplication ADR-0003 exists to prevent.
 */
function karmaStillWanted(context: Context): boolean {
    return subGoalsFor(context.goal, ["karma"]).some(goal => !goal.done);
}

/**
 * Whether the run is waiting on charisma, which phishing also builds.
 *
 * Phishing earns money AND charisma, so it is worth doing for either. That is what
 * makes it survive a settled karma target where a non-stationary cache does not.
 */
function charismaStillWanted(context: Context): boolean {
    return subGoalsFor(context.goal, ["cha"]).some(goal => !goal.done);
}

/**
 * What the game reports, in one line, without interpretation.
 *
 * Every failure below is caught somewhere in the feature and turned into a benign-looking
 * empty result, which is why "nothing happens" has been so hard to pin down: a `probe`
 * that throws, a `probe` that returns nothing, and a `getServerDetails` that refuses every
 * host all produce the same visible outcome. This reports the raw answer to each question
 * so the difference is visible.
 *
 * Deliberately does NOT decide anything. It reads the same calls the walk does and says
 * what came back, including the thrown error message, which is the part that was being
 * discarded.
 */
function diagnose(ns: NS, context: Context): string {
    const parts: string[] = [];

    // 1. The call the whole feature depends on, and the one whose failure is swallowed.
    //
    // Probed ONCE and the result kept. An earlier version called `probe()` again inside
    // the details check below, so when `probe` threw, the second throw was reported as
    // though `getServerDetails` had failed — attributing the fault to the wrong call,
    // which is the exact class of confusion this diagnostic exists to remove.
    let neighbours: string[] = [];
    let probeError: string | null = null;
    try {
        neighbours = ns.dnet.probe();
    } catch (error) {
        probeError = String(error);
    }
    parts.push(probeError !== null ? `probe THREW: ${probeError}` : `probe=${neighbours.length === 0 ? "EMPTY" : JSON.stringify(neighbours)}`);

    // 2. Whether the exe is really on home, since the capability gate is a file check.
    try {
        parts.push(`exe=${ns.fileExists("DarkscapeNavigator.exe", "home") ? "present" : "MISSING"}`);
    } catch (error) {
        parts.push(`fileExists THREW: ${String(error)}`);
    }

    // 3. Whether the details read works for the first thing probe named. A `probe` that
    //    succeeds and a `getServerDetails` that refuses is a different problem from both
    //    failing, and this is the only place that distinction is visible.
    const first = neighbours[0];
    if (probeError !== null) {
        parts.push("details=skipped (probe threw)");
    } else if (first === undefined) {
        parts.push("details=skipped (probe named nothing)");
    } else {
        try {
            const details = ns.dnet.getServerDetails(first);
            parts.push(
                `details(${first})={depth:${details.depth} chars:${details.requiredCharismaSkill} ` +
                `len:${details.passwordLength} fmt:${details.passwordFormat} online:${details.isOnline}}`,
            );
        } catch (error) {
            parts.push(`getServerDetails THREW: ${String(error)}`);
        }
    }

    // 4. What the run is allowed to do, in the terms the feature's own gate uses.
    parts.push(`darknet-capability=${context.capabilities.has("darknet") ? "yes" : "no"}`);
    parts.push(`charisma=${context.snapshot.player.skills.charisma}`);

    return parts.join(" | ");
}

/**
 * Record what a worker found, keyed by the host that found it.
 *
 * The drain in `tick` is the only production caller; the port is the channel and this
 * is the write into the map's staging area. Exported because the tests drive discovery
 * through it directly in the cases where the port is not what is under test.
 */
export function acceptReport(host: string, neighbours: readonly string[]): void {
    reported.set(host, [...neighbours]);
}
