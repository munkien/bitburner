/*
 * ============================================================================
 * THE SLOT, WITH THE BLADE'S SIMULACRUM
 * ============================================================================
 * What changes when the run owns the augment that stops Bladeburner occupying the
 * player's single activity slot.
 *
 * WHY THIS FILE EXISTS. The augment is threaded through the code as a `slotsShared` flag.
 * Three of the four places that read it got the answer right. The fourth did not:
 * progression still stood down for a running BLACK OP with the augment owned, on the
 * reasoning that a black op owns the slot — which is exactly what the augment undoes.
 *
 * The failure is invisible rather than loud. Training simply stops while a black op runs,
 * which looks like patience, and the augment's entire value is that both proceed at once.
 * So `yieldsForBlackOpOrGraft` is a named function rather than an inline `||` chain, and
 * these tests call it: a composition is where the defect lived, and a composition is
 * therefore what has to be tested.
 *
 * WHAT THE AUGMENT DOES NOT DO, also pinned: it frees the slot from BLADEBURNER actions.
 * A graft is not one, and interrupting a graft destroys its progress rather than pausing
 * it, so a graft is honoured with or without the augment.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bladeburnerKeepsSlot, bladeburnerYieldsForTraining, hasActiveBlackOp, publishTrainingRate, resetSlotHold, trainingRemaining, trainingWantedHeld } from "./activity.ts";
import { yieldsForBlackOpOrGraft } from "./player.ts";
import type { NS, Player } from "@ns";
import type { Goal } from "../../lib/objective.ts";

const BLACK_OP = { type: "Black Operations", name: "Operation Typhoon" };
const CONTRACT = { type: "Contracts", name: "Tracking" };
const RESTING = { type: "General", name: "Hyperbolic Regeneration Chamber" };
const GRAFTING = { type: "GRAFTING" };

/**
 * An `ns` reporting a Bladeburner action and a Singularity work item.
 *
 * `getCurrentWork` is what `hasActiveGraft` reads, so a graft and a Bladeburner action are
 * expressed through different calls — which is also why they cannot be confused for each
 * other at runtime.
 */
function fakeNs(
    bladeburnerAction: { type: string; name: string } | null,
    work: unknown = null,
): NS {
    return {
        bladeburner: {
            inBladeburner: () => true,
            getCurrentAction: () => bladeburnerAction,
            // A black op is only "winnable" past its rank bar with a good success chance;
            // returning 0 keeps `winnableBlackOp` false so the tests isolate the RUNNING
            // case. The running case is the one that regressed.
            getNextBlackOp: () => null,
            getRank: () => 0,
        },
        singularity: {
            getCurrentWork: () => work,
        },
    } as unknown as NS;
}

/* ─── the flag, as the two callers read it ─── */

test("with the augment, the slot is never Bladeburner's alone", () => {
    // `slotsShared: false` means the augment is owned, and every question about who owns
    // the slot then answers "nobody is excluded".
    const ns = fakeNs(CONTRACT);

    assert.equal(bladeburnerKeepsSlot(ns, false, true), false, "training was told to stand down");
    assert.equal(bladeburnerKeepsSlot(ns, false, false), false);
    // The inverse, because the two features read opposite halves of the same answer.
    assert.equal(bladeburnerYieldsForTraining(ns, false, true), true);
});

test("without the augment, a chain still keeps the slot", () => {
    // THE CONTROL. If `bladeburnerKeepsSlot` returned false unconditionally, the test
    // above would pass while the shared-slot behaviour had been removed entirely.
    assert.equal(
        bladeburnerKeepsSlot(fakeNs(CONTRACT), true, true),
        true,
        "a contract in flight stopped keeping the slot, which reinstates the old deadlock",
    );
});

/* ─── the black op: Bladeburner's action, and the one that regressed ─── */

test("a black op is recognised as one", () => {
    assert.equal(hasActiveBlackOp(fakeNs(BLACK_OP)), true);
    assert.equal(hasActiveBlackOp(fakeNs(CONTRACT)), false, "a contract is not a black op");
    assert.equal(hasActiveBlackOp(fakeNs(null)), false);
    assert.equal(hasActiveBlackOp(fakeNs(RESTING)), false, "a rest is not a black op");
});

test("a running black op stops training only when the slot is shared", () => {
    // THE REGRESSION. With the augment owned there is no contention, so a black op must
    // not stop the player's own work — that is the entire point of owning the augment.
    assert.equal(
        yieldsForBlackOpOrGraft(fakeNs(BLACK_OP), true),
        true,
        "a shared black op must be honoured",
    );
    assert.equal(
        yieldsForBlackOpOrGraft(fakeNs(BLACK_OP), false),
        false,
        "with the augment owned, a black op still stopped training — the augment was half-applied",
    );
});

test("a contract does not stop training either way", () => {
    // Contracts are preempted by training by design: a gym class is faster than the
    // experience a contract grants. Only a black op is time-sensitive enough to win.
    assert.equal(yieldsForBlackOpOrGraft(fakeNs(CONTRACT), true), false);
    assert.equal(yieldsForBlackOpOrGraft(fakeNs(CONTRACT), false), false);
});

test("a graft is honoured with or without the augment", () => {
    // THE HALF THAT MUST NOT BE RELAXED. The augment frees the slot from BLADEBURNER
    // actions; a graft is not one, and interrupting it destroys progress that waiting
    // would have preserved.
    assert.equal(
        yieldsForBlackOpOrGraft(fakeNs(null, GRAFTING), true),
        true,
        "a graft was interrupted with a shared slot",
    );
    assert.equal(
        yieldsForBlackOpOrGraft(fakeNs(null, GRAFTING), false),
        true,
        "a graft was interrupted because the augment also relaxed the graft rule",
    );
});

test("a graft outranks even a black op, augment or not", () => {
    // Both can be "running" at once only in a fixture, but the ordering matters: the graft
    // is returned first and unconditionally, so no flag can accidentally let a black op
    // cancel one.
    assert.equal(yieldsForBlackOpOrGraft(fakeNs(BLACK_OP, GRAFTING), false), true);
    assert.equal(yieldsForBlackOpOrGraft(fakeNs(BLACK_OP, GRAFTING), true), true);
});

test("an idle division and no graft leaves the slot free", () => {
    // THE CONTROL for every test above: the function must be false in the ordinary
    // state, or it would stop training permanently and every assertion would still pass.
    assert.equal(yieldsForBlackOpOrGraft(fakeNs(null), true), false);
    assert.equal(yieldsForBlackOpOrGraft(fakeNs(null), false), false);
});

/* ─── the input both sides share: is training actually wanted? ─── */

/**
 * A player whose stats are below the floor, so the floor is what decides.
 *
 * Agility is the lowest combat stat, which is the one `belowFloor` reports, and the rate
 * publisher is keyed by its short code — so a test that sets the "agi" rate is measuring
 * the measurement the decision is about.
 */
function fakePlayer(agility = 50): Player {
    return {
        skills: {
            hacking: 500, // above the 100 floor: hacking must not be the reported gap
            strength: 200, defense: 200, dexterity: 200, agility,
        },
    } as unknown as Player;
}

test("no measured rate means UNKNOWN, so training is WANTED and the slot is not stranded", () => {
    // THE REGRESSION, twice over. `trainingRemaining` first passed a null rate straight
    // into `floorReachable`, which reads null as "no baseline yet, keep training". That was
    // right, and it was then "fixed" into the opposite error: null was reclassified as a
    // stall, so `trainingRemaining` returned false whenever nothing had been measured yet.
    //
    // The rate model reports null for the ticks right after EVERY class boundary
    // (`trackRate` drops its open sample when the player is not in a class). So the moment
    // Bladeburner took the slot, the rate went null, training stopped being wanted, and the
    // division kept a slot it was not using — measured live as "starting" for 3,215
    // consecutive samples and a 23-minute stall with hacking frozen at 114 against a target
    // of 200.
    //
    // An unknown is not evidence of a stall. The handover must not depend on a reading that
    // is systematically absent exactly when the handover happens.
    resetSlotHold();
    publishTrainingRate(() => null);
    try {
        assert.equal(
            trainingRemaining(fakePlayer(), null),
            true,
            "an unmeasured stat was read as a stall, which strands the slot with a division that has nothing to do",
        );
    } finally {
        publishTrainingRate(null);
        resetSlotHold();
    }
});

test("a MEASURED zero rate is a stall, so the slot is not wanted either", () => {
    // The other half of the same distinction. A zero rate is evidence — the stat did not
    // rise this window — and `floorReachable` refuses it, which is the behaviour that must
    // survive the fix above. Pinned here because the two cases arrive as the same `number`.
    resetSlotHold();
    publishTrainingRate(() => 0);
    try {
        assert.equal(trainingRemaining(fakePlayer(), null), false);
    } finally {
        publishTrainingRate(null);
        resetSlotHold();
    }
});

test("a healthy measured rate still wants the slot, so the fix is not a blanket 'no'", () => {
    // THE CONTROL for both assertions above. If `trainingRemaining` had simply been made
    // to return false, the two tests would pass while the feature that claims the slot had
    // been disabled — and Bladeburner would never train the floor it is supposed to yield to.
    resetSlotHold();
    publishTrainingRate(() => 10);
    try {
        assert.equal(
            trainingRemaining(fakePlayer(), null),
            true,
            "a reachable target stopped wanting training, which breaks the handover in the other direction",
        );
    } finally {
        publishTrainingRate(null);
        resetSlotHold();
    }
});

test("a flickering rate cannot reverse the handover mid-flight", () => {
    // THE HYSTERESIS. Even with the null case fixed, the rate is recalibrated every tick,
    // so `trainingRemaining` can still alternate around a boundary. A handover driven by
    // that alternation is a handover driven by noise: Bladeburner stands down, progression
    // starts nothing (its cap, a travel), and the next tick reverses both.
    resetSlotHold();
    const t0 = 1_000_000;

    // Wanted, then not wanted a second later: still wanted, because the hold is sticky.
    assert.equal(trainingWantedHeld(true, t0), true);
    assert.equal(
        trainingWantedHeld(false, t0 + 1_000),
        true,
        "one tick of no-rate reversed the handover, which reinstates the fight over the slot",
    );

    // Past the hold, a genuine "not wanted" releases it. The hold must EXPIRE, or the slot
    // would be bound to training for the whole run. The boundary is checked from both sides:
    // still held just inside 90s, released just outside it.
    assert.equal(
        trainingWantedHeld(false, t0 + 89_000),
        true,
        "the hold expired early, which lets a flicker through again",
    );
        assert.equal(
            trainingWantedHeld(false, t0 + 91_000),
            false,
            "the hold never expires, which hands the slot to training permanently",
        );
    resetSlotHold();
});

test("an idle division never keeps a slot it is not using, even with no rate measured", () => {
    // THE DEADLOCK, end to end, as it was measured live rather than as it was reasoned about.
    //
    // The rate goes null on the ticks right after every class boundary — that is, exactly
    // when the handover happens. When null was read as "no training wanted", Bladeburner was
    // told it could keep the slot while having no action to put in it, and progression was
    // told to stand down for it. Both features idled: 3,215 consecutive telemetry samples of
    // "bladeburner: starting" against "progression: yielded: Bladeburner keeps the slot
    // (training not wanted)", 23 minutes at a stretch, hacking frozen at 114 against 200.
    //
    // So the pair is asserted together, because either half alone still passes while the
    // other is wrong — the failure needed both sides to agree on a nonsense answer.
    resetSlotHold();
    publishTrainingRate(() => null);
    try {
        const idleNs = fakeNs(null); // no action: the division is not using the slot
        const wanted = trainingRemaining(fakePlayer(), null);

        assert.equal(wanted, true, "an unmeasured stat stopped wanting training");
        assert.equal(
            bladeburnerKeepsSlot(idleNs, true, wanted),
            false,
            "an idle division kept the slot, which is the deadlock: neither feature can act",
        );
        assert.equal(
            bladeburnerYieldsForTraining(idleNs, true, wanted),
            true,
            "the division did not yield to training it had already decided not to use the slot for",
        );
    } finally {
        publishTrainingRate(null);
        resetSlotHold();
    }
});
