/*
 * ============================================================================
 * FLIP DETECTION
 * ============================================================================
 * Whether the activity slot has been thrashing, as a test rather than as a log to read.
 *
 * WHY THIS FILE EXISTS. "It keeps flipping on and off" was reported twice and neither
 * recording could answer it. The trace in `activity-trace.ts` is what makes it answerable
 * going forward; this is what decides, from that trace, whether the run should SAY so
 * while it is happening — because a flip that is visible only by hand-diffing a file
 * afterwards is still a bug the operator has to find.
 *
 * The rule is deliberately about ALTERNATION rather than volume. A run that legitimately
 * moves between activities — a backdoor, a program, a crime for cash, back to the course —
 * produces changes too, and warning on every change would be noise. What is pathological is
 * coming BACK: the same pair trading places repeatedly, which is a decision that disagrees
 * with itself.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivityTrace, activityKey, detectFlip, FLIP_WINDOW_MS } from "./activity-trace.ts";

const at = (hacking = 100, hackingExp = 1000) => ({ hacking, hackingExp });
const trace = () => new ActivityTrace();

test("the first sighting is not a transition", () => {
    // A run that starts mid-class has not flipped. Recording "nothing → class" would put an
    // entry in every history that describes when the script started, not what the run did.
    const t = trace();
    assert.deepEqual(t.observe(0, { key: "UNI:Rothman University:Computer Science" }, at()), []);
});

test("a change records what it came from as well as where it went", () => {
    // The ACTION log tag says only that something changed. The pair is the fact that makes
    // a flip legible, and it is the half a log cannot give.
    const t = trace();
    t.observe(0, { key: "UNI:Rothman" }, at());
    const changes = t.observe(1_000, { key: "CRIME:Homicide" }, at(101, 2_500));
    assert.deepEqual(changes, [
        { t: 1_000, from: "UNI:Rothman", to: "CRIME:Homicide", hacking: 101, hackingExp: 2_500 },
    ]);
});

test("staying put adds nothing", () => {
    const t = trace();
    t.observe(0, { key: "UNI:Rothman" }, at());
    for (let i = 1; i <= 20; i++) t.observe(i * 1_000, { key: "UNI:Rothman" }, at());
    assert.deepEqual(t.snapshot(), []);
});

test("the history is bounded and keeps the newest", () => {
    // It rides on the payload published every second, so it cannot grow with the run. The
    // recent shape is the point; the JSONL recorder already has every frame.
    const t = new ActivityTrace(4);
    t.observe(0, { key: "A" }, at());
    for (let i = 1; i <= 10; i++) t.observe(i, { key: i % 2 === 0 ? "A" : "B" }, at());
    const kept = t.snapshot();
    assert.equal(kept.length, 4);
    assert.equal(kept.at(-1)?.t, 10, "the newest transition was dropped");
});

test("the returned history is a copy, so a later change cannot rewrite a published frame", () => {
    const t = trace();
    t.observe(0, { key: "A" }, at());
    const published = t.observe(1, { key: "B" }, at());
    // A frame that has already been serialised must not change under the recorder.
    t.observe(2, { key: "A" }, at());
    assert.equal(published.length, 1);
    assert.equal(published[0]?.to, "B");
});

test("a flip is legible: the same pair, alternating, in a short window", () => {
    // The shape the operator reports, as data. Two activities taking turns; a reader of the
    // file can see it without diffing frames.
    const t = trace();
    const course = { key: "UNI:Rothman University:Computer Science" };
    const homicide = { key: "CRIME:Homicide" };
    t.observe(0, course, at());
    for (let i = 1; i <= 6; i++) t.observe(i * 1_000, i % 2 === 0 ? course : homicide, at());
    const changes = t.snapshot();
    assert.equal(changes.length, 6);
    assert.ok(changes.every(c => (c.to === "UNI:Rothman University:Computer Science" ? c.from === "CRIME:Homicide" : c.from === "UNI:Rothman University:Computer Science")));
});

test("hacking experience is recorded, which is how 'studying but gaining nothing' is seen", () => {
    // The levels can be flat while the experience climbs at a rate that will never reach the
    // next level. Level alone cannot show that; both are recorded so it can.
    const t = trace();
    t.observe(0, { key: "UNI" }, at(129, 168_000));
    const [change] = t.observe(60_000, { key: "CRIME" }, at(129, 168_400));
    assert.equal(change?.hacking, 129);
    assert.equal(change?.hackingExp, 168_400);
});

test("a reset leaves the trace empty, so two runs do not share history", () => {
    const t = trace();
    t.observe(0, { key: "A" }, at());
    t.observe(1, { key: "B" }, at());
    t.reset();
    assert.deepEqual(t.snapshot(), []);
    // And the next sighting starts fresh rather than diffing against the old key.
    assert.deepEqual(t.observe(2, { key: "C" }, at()), []);
});

test("the activity key matches the change log's vocabulary", () => {
    // The two are read side by side, so a second encoding would be a second thing to match up.
    assert.equal(activityKey(null), "none");
    assert.equal(
        activityKey({ type: "CLASS", location: "Rothman University", classType: "Computer Science" }),
        "CLASS:Rothman University:Computer Science",
    );
    assert.equal(activityKey({ type: "CRIME", crimeType: "Homicide" }), "CRIME:Homicide");
    assert.equal(activityKey({ type: "FACTION", factionName: "NiteSec", factionWorkType: "Hacking" }), "FACTION:NiteSec:Hacking");
    // An unrecognised type is named rather than dropped: the slot doing something unknown is
    // a fact, and skipping it would make the slot look unchanged.
    assert.equal(activityKey({ type: "SOMETHING_NEW" }), "OTHER:SOMETHING_NEW");
});

/* ─── deciding whether the history is a flip ─── */

test("two activities taking turns is a flip", () => {
    const changes = [
        { t: 1_000, from: "UNI", to: "CRIME", hacking: 1, hackingExp: 1 },
        { t: 2_000, from: "CRIME", to: "UNI", hacking: 1, hackingExp: 1 },
        { t: 3_000, from: "UNI", to: "CRIME", hacking: 1, hackingExp: 1 },
        { t: 4_000, from: "CRIME", to: "UNI", hacking: 1, hackingExp: 1 },
    ];
    const flip = detectFlip(changes, 5_000);
    assert.deepEqual(flip, { pair: ["CRIME", "UNI"], changes: 4, windowMs: FLIP_WINDOW_MS });
});

test("a run moving through several activities is busy, not flipping", () => {
    // Three activities is a different fault — nothing is winning — and calling it a flip of
    // the first two would misdescribe it. The history stands as the evidence instead.
    const changes = [
        { t: 1_000, from: "UNI", to: "CRIME", hacking: 1, hackingExp: 1 },
        { t: 2_000, from: "CRIME", to: "GYM", hacking: 1, hackingExp: 1 },
        { t: 3_000, from: "GYM", to: "UNI", hacking: 1, hackingExp: 1 },
        { t: 4_000, from: "UNI", to: "PROGRAM", hacking: 1, hackingExp: 1 },
    ];
    assert.equal(detectFlip(changes, 5_000), null);
});

test("too few changes is not enough evidence", () => {
    const changes = [
        { t: 1_000, from: "UNI", to: "CRIME", hacking: 1, hackingExp: 1 },
        { t: 2_000, from: "CRIME", to: "UNI", hacking: 1, hackingExp: 1 },
    ];
    assert.equal(detectFlip(changes, 3_000), null);
});

test("a flip that stopped is no longer reported", () => {
    // The warning has to clear when the thrashing does, or the console reports a fault the
    // run has already recovered from — which is how a real fault stops being read.
    const changes = [
        { t: 1_000, from: "UNI", to: "CRIME", hacking: 1, hackingExp: 1 },
        { t: 2_000, from: "CRIME", to: "UNI", hacking: 1, hackingExp: 1 },
        { t: 3_000, from: "UNI", to: "CRIME", hacking: 1, hackingExp: 1 },
        { t: 4_000, from: "CRIME", to: "UNI", hacking: 1, hackingExp: 1 },
    ];
    assert.ok(detectFlip(changes, 5_000) !== null);
    assert.equal(detectFlip(changes, 5_000 + FLIP_WINDOW_MS + 1), null);
});

test("a change with no destination difference is not an alternation", () => {
    const changes = Array.from({ length: 6 }, (_, i) => ({
        t: i * 1_000, from: "UNI", to: "UNI", hacking: 1, hackingExp: 1,
    }));
    assert.equal(detectFlip(changes, 10_000), null);
});
