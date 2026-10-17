import type { NS } from "@ns";

import { sendReport, type WorkerProblem, type WormReport } from "../darknet-reports.ts";
import { readCacheResult, worthOpening, worthPhishing } from "../darknet-money.ts";
import { findScriptOnHome } from "../../../lib/scripts.ts";

/*
 * ============================================================================
 * WORM WORKER
 * ============================================================================
 * One Dark Net action, performed from the server it is deployed on.
 *
 * Why this is its own script rather than part of the Master. The Dark Net API
 * requires scripts to run ON darknet hosts: `probe` reports only what is directly
 * connected to the script's current server, `authenticate` needs that direct
 * connection, and `phishingAttack` is documented as only usable from a darknet
 * server. A home-side script cannot do any of it.
 *
 * Why it is SHORT. Every darknet call carries static RAM, and the host's blocked
 * RAM is the binding constraint — `dnet.getBlockedRam` exists precisely because
 * owners reserve part of it. It is copied onto many hosts, so its own cost is paid
 * many times over. One action, then exit; the Master deploys another if it wants
 * another.
 *
 * How it reports back. A separate script in a separate context cannot return a
 * value, and its `tprint` goes to the Terminal where nothing reads it. So it writes
 * to a Netscript PORT, which is shared across hosts and costs 0 GB — see
 * lib/darknet-reports.ts. That is the only channel that reaches the Master.
 *
 * This deliberately does NOT authenticate. A session is granted per PID, so a
 * worker's session dies with the worker, and the Master already holds the chain it
 * needs. A worker that re-authenticated would duplicate the Master's work and race
 * it for the same server.
 * ============================================================================
 */

/**
 * This script, so a worker can copy itself onto its neighbours.
 *
 * Resolved by BASENAME rather than a path: a worker may be running on a darknet host
 * where the game placed it under a different directory than the Master expects, and
 * `findScriptOnHome` is the one place that knows how to look.
 */
const WORM_NAME = "worm.ts";

export async function main(ns: NS): Promise<void> {
    // The host defaults to the one this script is RUNNING ON, which is the only server a
    // worker can legitimately be asked about.
    //
    // It used to require an argument and return silently without one, so `run worm.ts`
    // by hand printed "script finished running" and nothing else — indistinguishable
    // from a script that crashed, and it is the same silent-failure shape this file was
    // written to remove. `ns.getHostname()` makes a manual run do the right thing rather
    // than nothing.
    const host = typeof ns.args[0] === "string" ? ns.args[0] : ns.getHostname();

    // A worker that dies before reporting is invisible, and that has cost real time on
    // this feature: an empty map reads exactly like a net with nothing in it, and a
    // worker that never ran reads like a host with no neighbours. So every step records
    // WHY it failed, and the report is sent even when the probe did not work — that is
    // the case most worth hearing about.
    const problems: WorkerProblem[] = [];
    const note = (step: string, detail: string): void => {
        problems.push({ step, detail });
    };

    // The Master's answers about the RUN, passed as arguments because a worker has no
    // `Context`: it needs the goal to know whether karma and charisma are still
    // wanted, and it cannot read `context.snapshot` on a darknet host.
    //
    // Defaulting to "not wanted" rather than "wanted" is deliberate: a worker launched
    // by hand, or by a Master that passed nothing, should do the harmless half
    // (discovery) rather than start spending karma on a guess.
    const wantKarma = ns.args[1] === true;
    const wantCharisma = ns.args[2] === true;

    // The one call a worker makes in this version: report what is next to it. The
    // discovery half of the walk has to happen out here, because only a script on
    // the server can see its neighbours.
    let reachable: string[] = [];
    try {
        reachable = ns.dnet.probe();
    } catch (error) {
        // Reported rather than returning. A worker that exits here sends nothing, and
        // from the Master's side that is indistinguishable from a host with no
        // neighbours — the whole map stays at whatever it was, with no clue why.
        //
        // TPRINT as well as the port: a person running this by hand is looking at the
        // Terminal, and a worker that exits without a word is the failure this file
        // exists to remove.
        const detail = error instanceof Error ? error.message : String(error);
        note("probe", detail);
        ns.tprint(`[WORM] ${host}: probe failed — ${detail}`);
        sendReport(ns, { from: host, reachable, depth: -1, problems });
        return;
    }

    ns.tprint(`[WORM] ${host}: ${reachable.length} neighbour(s)${reachable.length > 0 ? ` (${reachable.join(", ")})` : ""}`);

    let depth = -1;
    try {
        depth = ns.dnet.getDepth(host);
    } catch (error) {
        // Not fatal — discovery still worked — but recorded, because a host reporting
        // depth -1 when it is not the entry means the walk cannot order its frontier.
        note("depth", error instanceof Error ? error.message : String(error));
    }

    // Earning, after discovery: a failed cache open must not cost the report, or the
    // Master loses a discovered neighbourhood to a bug in the money path.
    const { opened, karmaLost, problem } = await earn(ns, host, wantKarma, wantCharisma);
    if (problem !== undefined) note("earn", problem);

    // Spread onward BEFORE reporting.
    //
    // This is what makes the walk deeper than one hop, and it is forced by the API:
    // `ns.exec` reaches a target only when "the script is running on a server that is
    // directly connected to the target, or the target has a backdoor or stasis link".
    // A Master on home can therefore start a worker on `darkweb` and no further, so
    // discovery used to stop at depth 1 however long it ran — the worker on `darkweb`
    // could see `alpha`, and nothing could ever stand on `alpha` to see `beta`.
    //
    // A worker, by contrast, IS directly connected to its own neighbours. So each one
    // re-deploys itself to the places it just found, and the frontier advances one hop
    // per generation. The Master still owns the sessions and the map; this only extends
    // the reach.
    const { started: spread, refused, problem: spreadProblem } = await spreadOnward(
        ns, host, reachable, wantKarma, wantCharisma,
    );
    if (spreadProblem !== undefined) note("spread", spreadProblem);
    // A refusal is the normal case on a first pass — the Master opens neighbours one at a
    // time — so it is reported as a count rather than as a problem, but it IS reported:
    // `spread=0` with six neighbours and no explanation was indistinguishable from a
    // worker that never tried.
    if (refused.length > 0) note("spread", `exec refused on ${refused.length}: ${refused.join(", ")}`);

    const report: WormReport = { from: host, reachable, depth, opened, karmaLost, spread, problems };
    sendReport(ns, report);

    // ALWAYS SAY SOMETHING before exiting.
    //
    // The port is how the Master hears; the Terminal is how a PERSON hears, and a worker
    // started by hand has no Master to report to. This used to exit silently, which read
    // as "script finished running" and nothing else — the same silent-failure shape the
    // report channel was added to remove, one layer up.
    ns.tprint(
        `[WORM] ${host}: depth=${depth} neighbours=${reachable.length} spread=${spread.length}` +
        ` caches=${opened} karma=${karmaLost}` +
        (problems.length > 0 ? ` problems=${problems.length}` : ""),
    );
    for (const problem of problems) ns.tprint(`[WORM] ${host}: ${problem.step} — ${problem.detail}`);
}

/**
 * Start a copy of this worker on each neighbour that will take one.
 *
 * Returns the hosts it managed to start on, which the Master reports so the walk's reach
 * is visible rather than inferred. A neighbour that refuses is not an error: most will,
 * because a session may not exist yet on either side — the Master opens them, and the
 * next generation of workers tries again.
 *
 * `spread` is passed through so a chain cannot grow without bound: a worker started by a
 * worker reports itself as one hop further from home, and the caller can cap it.
 */
async function spreadOnward(
    ns: NS,
    host: string,
    neighbours: readonly string[],
    wantKarma: boolean,
    wantCharisma: boolean,
): Promise<{ started: string[]; refused: string[]; problem?: string }> {
    const started: string[] = [];
    /** Neighbours whose `exec` returned 0 — refused, not failed. */
    const refused: string[] = [];
    /** The first neighbour that threw, if any. */
    let problem: string | undefined;
    const self = findScriptOnHome(ns, WORM_NAME);
    // Reported rather than returning bare: without the script a worker cannot spread, so
    // the walk stops at this depth, and that is invisible from the Master.
    if (self === null) return { started, refused, problem: `${WORM_NAME} not found from ${host}` };

    for (const neighbour of neighbours) {
        // Back towards home would be a wasted deployment, and `home` is not a darknet
        // host at all.
        if (neighbour === host || neighbour === "home") continue;

        try {
            if (ns.scriptRunning(self, neighbour)) continue;
            // Copy from HERE, which is a legal `scp` source because "scp() *from* the
            // server is always allowed". Home could not reach it.
            if (!ns.fileExists(self, neighbour)) await ns.scp(self, neighbour, host);

            // `exec` RETURNS 0 when it refuses — it does not throw — so the catch below
            // never fires for the ordinary case of a neighbour this worker has no session
            // on. Measured: `spread=0` with six neighbours found and no problem recorded
            // at all, because nothing looked at the return value.
            //
            // A refusal is the normal state here, not an error: the Master owns the
            // sessions and opens the neighbours one at a time, so most of a worker's
            // neighbours will refuse on the first pass. Recorded once per neighbour so
            // the reason is available without turning a routine refusal into noise.
            const pid = ns.exec(self, neighbour, 1, neighbour, wantKarma, wantCharisma);
            if (pid > 0) {
                started.push(neighbour);
            } else {
                // WHY it refused, not just that it did. `exec` returns 0 for several
                // unrelated reasons and the difference decides what to do: no session
                // means the Master must open the host, while no RAM means it cannot be
                // opened usefully however many times we try. `getBlockedRam` is 0 GB.
                refused.push(`${neighbour} (${refusalReason(ns, neighbour, self)})`);
            }
        } catch (error) {
            // No session yet, or the neighbour moved. The Master will try again once it
            // holds one; a worker does not retry, because it exits. Recorded because a
            // neighbour that refuses is the difference between "nothing is out there"
            // and "we could not reach it", and only the reason tells them apart.
            problem ??= `scp/exec to ${neighbour} failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    return { started, refused, problem };
}

/**
 * Open this host's caches and phish from it.
 *
 * Runs on the host, which is the only place either call works: `openCache` opens a
 * file "on the current server", and `phishingAttack` "can only be run from scripts on
 * darknet servers".
 *
 * Every failure path returns rather than throwing. A worker exists to discover and
 * earn, and a host that has gone offline mid-deployment should cost the Master one
 * wasted deployment, not an unhandled rejection.
 */
async function earn(
    ns: NS,
    host: string,
    wantKarma: boolean,
    wantCharisma: boolean,
): Promise<{ opened: number; karmaLost: number; problem?: string }> {
    let opened = 0;
    let karmaLost = 0;
    /** The first thing that went wrong, if anything did. */
    let problem: string | undefined;

    // Caches first: they are a one-off find, so leaving one behind loses it, while
    // phishing can be repeated on a later deployment.
    let caches: string[] = [];
    try {
        caches = ns.ls(host, ".cache");
    } catch (error) {
        problem ??= `ls failed: ${error instanceof Error ? error.message : String(error)}`;
        caches = [];
    }

    const decision = worthOpening({ caches, stationary: false, blockedRam: 0 }, wantKarma);
    if (decision.open) {
        for (const filename of decision.filenames) {
            let result;
            try {
                result = ns.dnet.openCache(filename, true);
            } catch (error) {
                problem ??= `openCache refused: ${error instanceof Error ? error.message : String(error)}`;
                break;
            }

            const verdict = readCacheResult(result);
            if (verdict.kind === "stop") break;
            if (verdict.kind === "gone") continue;

            opened += 1;
            karmaLost += verdict.karmaLoss;
        }
    }

    // Phishing last, and only while something wants what it gives.
    let threads = 1;
    try {
        threads = Math.max(1, Math.floor(ns.getServerMaxRam(host) / Math.max(1, ns.getScriptRam(ns.getScriptName(), host))));
    } catch {
        threads = 1;
    }

    const phish = worthPhishing({
        hostCharisma: 0,
        playerCharisma: 0,
        threads,
        charismaWanted: wantCharisma,
        karmaMatters: wantKarma,
    });

    if (phish.phish) {
        try {
            await ns.dnet.phishingAttack();
        } catch {
            // A refusal or a rejection is the same answer here: this deployment is
            // over. The Master re-deploys, and a retry loop inside the worker would
            // hold the host's RAM for no gain.
        }
    }

    return { opened, karmaLost, problem };
}

/**
 * The most likely reason `exec` refused this neighbour, in a few words.
 *
 * `exec` returns 0 and says nothing, so every refusal looks alike from the caller. The
 * two causes that matter need opposite responses: a missing session is fixed by the
 * Master opening the host, whereas insufficient RAM is not something a worker can do
 * anything about — and with no session, `getServerDetails` may itself say nothing useful.
 *
 * Diagnostic only: nothing branches on this, and an unreadable host reports as
 * "unknown" rather than being omitted.
 */
function refusalReason(ns: NS, neighbour: string, self: string): string {
    try {
        const details = ns.dnet.getServerDetails(neighbour);
        const blocked = ns.dnet.getBlockedRam(neighbour);
        const parts: string[] = [];
        if (!details.hasSession) parts.push("no session");
        if (blocked > 0) parts.push(`${blocked}GB blocked`);
        if (!ns.fileExists(self, neighbour)) parts.push("no script");
        return parts.length > 0 ? parts.join(", ") : "exec refused, reason unknown";
    } catch {
        return "unreadable";
    }
}
