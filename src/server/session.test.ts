/*
 * ============================================================================
 * SESSION ROLLING
 * ============================================================================
 * When a recorded run ends, as a test rather than as a live server.
 *
 * WHY THIS FILE EXISTS. The operator used to have to quit the server and start it again
 * whenever their run reset, because a run file is one BitNode and the server only ever
 * opened one file. The rule for ending it is in `session.ts`; this pins it, including the
 * cases that must NOT end it — a run that was already going when the server started, and a
 * game too old or too broken to say which node it is on.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeBoundary, isNewSession, type SessionAnchor } from "./session.ts";

/** A session that began in node `node`, installed at `installedAt`. */
function anchored(node: number | null, installedAt = 1_000): SessionAnchor {
    return { node: node === null ? null : { node, installedAt }, startedAt: 5_000 };
}

const stamp = (node: number, installedAt: number) => ({ node, installedAt });

test("the same node is not a new session", () => {
    assert.equal(isNewSession(anchored(1), stamp(1, 1_000)), false);
});

test("a different node is a new session", () => {
    assert.equal(isNewSession(anchored(1), stamp(2, 1_000)), true);
});

test("the same node entered again is a new session", () => {
    // Nodes can be re-entered, and no node NUMBER can see it. Comparing the install time
    // is the only thing that does, and it is why the game reports one.
    assert.equal(isNewSession(anchored(3, 1_000), stamp(3, 9_000)), true);
});

test("a run that was already going when the server started is not rolled on", () => {
    // The session opened with this evidence. Nothing has transitioned, so the file stands:
    // a detector that rolled here would split every run the server was started against.
    const anchor = anchored(4, 123_456);
    assert.equal(isNewSession(anchor, stamp(4, 123_456)), false);
});

test("a session with no evidence adopts the first stamp instead of rolling on it", () => {
    // The first frames carried no stamp — a game that cannot report, or a server started
    // before the field existed. There is nothing to contradict, so the next stamp becomes
    // the evidence. Rolling here would put one run in two files to have an answer sooner.
    const anchor = anchored(null);
    assert.equal(isNewSession(anchor, stamp(7, 42)), false);
    // And having adopted it, the SAME rule applies from then on: a real transition still
    // rolls, so adopting does not disarm the detector.
    assert.equal(isNewSession({ node: stamp(7, 42), startedAt: 5_000 }, stamp(8, 99)), true);
});

test("a frame with no stamp neither starts nor prevents a session", () => {
    assert.equal(isNewSession(anchored(1), undefined), false);
    assert.equal(isNewSession(anchored(1, 1_000), undefined), false);
    assert.equal(isNewSession(anchored(1), null), false);
});

test("a stamp that is not a node and a time is treated as no stamp", () => {
    // `getResetInfo` throwing gives the game nothing to report, and a half-filled object
    // is the same silence. Neither half alone can be compared against an anchor.
    assert.equal(isNewSession(anchored(1), { node: Number.NaN, installedAt: 1 }), false);
    assert.equal(isNewSession(anchored(1), { node: 2, installedAt: Number.NaN }), false);
});

test("the reason names the transition, because that is the interesting fact", () => {
    assert.equal(describeBoundary(anchored(1), stamp(2, 5)), "BitNode 1 → 2");
    assert.equal(describeBoundary(anchored(3, 1_000), stamp(3, 9_000)), "BitNode 3 re-entered");
    assert.equal(describeBoundary(anchored(null), stamp(7, 1)), "BitNode 7");
});
