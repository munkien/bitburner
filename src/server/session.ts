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
