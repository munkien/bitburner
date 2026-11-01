/*
 * ============================================================================
 * SESSION BOUNDARY
 * ============================================================================
 * When a recorded run should end and a new one begin.
 *
 * WHY THIS FILE EXISTS. A run file is one BitNode. The goals, the features that can load
 * and the entire economy change at an install, and a file that spans two of them is two
 * runs sharing a timeline — which is exactly the kind of artefact the recorder was built
 * to avoid. The only way to end a file was to stop the server, so the operator had to kill
 * it by hand at the moment their run reset and start it again, which is precisely when
 * they were least interested in a terminal.
 *
 * The decision is PURE and lives here rather than inside the request handler, so what
 * counts as a new run can be pinned as a test instead of inferred from a live server.
 * The handler's job is then only to notice the verdict and act on it.
 *
 * THE RULE, and the three cases it has to get right — each of which produced a wrong file
 * when it was got wrong:
 *
 *   a DIFFERENT node          roll. Exit, enter node 2, the run in the file is over.
 *   the SAME node, ENTERED    roll. Nodes can be re-entered, and `The Wall` and the
 *                             `Source-File` path both do it; the node number alone cannot
 *                             see this, which is why the install time is reported too.
 *   a node installed BEFORE   do NOT roll. Start the server on a run that has been going
 *   the server started        for hours and nothing has transitioned: a detector that
 *                             rolled on the first frame would split that run for nothing.
 *
 * SILENCE IS NOT A SIGNAL. A frame that omits the stamp — an older game build, or a
 * `getResetInfo` that threw — says nothing about the node, so it can neither start nor
 * prevent a roll. Treating it as a change would roll the session on every frame from a
 * game that cannot report.
 * ============================================================================
 */

import type { BitNodeStamp } from "../shared/types.ts";

/** What the server knows about the run in the current file. */
export interface SessionAnchor {
    /** Evidence of how this session began, or `null` when it began without any. */
    readonly node: BitNodeStamp | null;
    /** When the server opened this session, in the server's clock. */
    readonly startedAt: number;
}

/**
 * Whether an incoming stamp means the run in the file is over.
 *
 * `anchor.node === null` is the session that began with no evidence — the first frames
 * never carried a stamp, or the server was started against a game that could not report
 * one. That session ADOPTS the next stamp it sees rather than rolling on it: there is
 * nothing to contradict, and rolling would put the same run in a second file for the
 * pleasure of having an answer.
 *
 * The install time is compared only as a difference in this direction, `anchor.node`
 * being where the file's evidence started. A frame whose install time is EARLIER than the
 * anchor's is still a roll — the node was re-entered and the game's clock says so — but a
 * session that started with no evidence cannot tell, which is the adopt case above.
 */
export function isNewSession(anchor: SessionAnchor, incoming: BitNodeStamp | null | undefined): boolean {
    // No opinion from the game: it neither starts a run nor prevents one.
    if (incoming === null || incoming === undefined) return false;
    // A stamp that is not a node and a time is the game telling us nothing readable. Both
    // halves are needed to compare, so a frame with one and not the other is silence too.
    if (!Number.isFinite(incoming.node) || !Number.isFinite(incoming.installedAt)) return false;

    // The session began without evidence, so this frame becomes its evidence.
    if (anchor.node === null) return false;

    return incoming.node !== anchor.node.node || incoming.installedAt !== anchor.node.installedAt;
}

/**
 * Why the session rolled, as a log-ready phrase.
 *
 * Named because "a new run started" is not the interesting fact — WHY it started is.
 * Only ever called for a stamp `isNewSession` has already accepted, so both are present.
 */
export function describeBoundary(anchor: SessionAnchor, incoming: BitNodeStamp): string {
    const previous = anchor.node;
    if (previous === null) return `BitNode ${incoming.node}`;
    if (previous.node !== incoming.node) {
        return `BitNode ${previous.node} → ${incoming.node}`;
    }
    return `BitNode ${incoming.node} re-entered`;
}

/*
 * ----------------------------------------------------------------------------
 * AN ANNUNCED START
 * ----------------------------------------------------------------------------
 * `isNewSession` INFERS a new run from the node changing. That inference is necessary
 * because the node is the strongest evidence a frame carries, but it is not the whole
 * truth: the game can restart `nexus.ts` — a file edit, a self-restart after a sync, an
 * operator typing `run nexus.ts` again — and every one of those starts a new run while the
 * BitNode stays put. The recording then continues a file that belongs to an execution which
 * has ended, and the two runs share a timeline.
 *
 * So the game ANNOUNCES the start rather than leaving it to be inferred. This is the
 * opposite trade to the one `isNewSession` makes: that rule has to work from evidence it
 * cannot control, while this one is told directly.
 */

/** A start announced by the game, as the game reports it. */
export interface RunStart {
    /** When the orchestrator's `main` began, in the game's clock. */
    readonly startedAt: number;
    /** The build the starting copy is running, so a stale sync is visible. */
    readonly build?: string;
}

/**
 * Whether an announced start should roll the run file.
 *
 * NOT EVERY ANNOUNCEMENT IS A NEW RUN, and the game cannot know: `nexus.ts` can be started
 * twice by accident, and a restarted orchestrator re-announces the same run. The three
 * cases, each of which produced a wrong file when handled wrongly:
 *
 *   the SAME start, announced twice   do not roll. The idempotency case — a retried POST,
 *                                     or a second announcement from the same execution.
 *   a start the server already has    do not roll. A restart of the SERVER against a game
 *                                     that has been running for hours must not split the
 *                                     run it is joining, which is the same rule
 *                                     `isNewSession` makes for a pre-existing install.
 *   a LATER start than the current    roll. The orchestrator restarted; the execution in
 *                                     the file is over.
 *
 * `lastStartedAt` is the start time of the execution currently being recorded, and `null`
 * means the server has recorded nothing yet — in which case there is nothing to split, so
 * the announcement is adopted rather than rolled on.
 *
 * A start EARLIER than the one being recorded is refused for the same reason: a delayed
 * announcement from a previous execution, arriving after its successor has already rolled
 * the file, must not roll it a second time for a run that has ended.
 */
export function isAnnouncedRun(
    lastStartedAt: number | null,
    announced: RunStart | null | undefined,
): boolean {
    // No announcement, or one without a usable clock: silence, which neither starts a run
    // nor prevents one. `startedAt` is what makes two announcements comparable at all.
    if (announced === null || announced === undefined) return false;
    if (!Number.isFinite(announced.startedAt)) return false;

    if (lastStartedAt === null) return false;

    return announced.startedAt > lastStartedAt;
}

/** Why an announced run rolled, as a log-ready phrase. */
export function describeAnnouncedStart(previous: number | null, announced: RunStart): string {
    if (previous === null) return "starting";
    const seconds = Math.round((announced.startedAt - previous) / 1000);
    // The elapsed time is the useful half: a restart seconds apart is a self-restart after
    // a sync, hours apart is an operator starting a fresh run, and the two read the same
    // without it.
    return `orchestrator restarted (previous ran ${formatElapsed(seconds)})`;
}

/** A duration a reader can act on rather than a raw second count. */
function formatElapsed(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}
