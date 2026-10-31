import type { NS, Player } from "@ns";

import type { Goal } from "../../lib/objective.ts";
// Imported from `lib/` directly, not re-exported through `progression.ts`/`rate-tracker.ts`.
// A chain of bare re-exports is not resolvable by Bitburner's per-file syntax checker, which
// is what made Progression fail to compile.
import { floorReachable } from "../../lib/training-budget.ts";
import type { MeasuredStat } from "../../lib/rate-tracker.ts";
import { belowFloor, trainingTargets, type FloorTargets } from "./progression.ts";

/*
 * ============================================================================
 * PLAYER ACTIVITY
 * ============================================================================
 * The player has one activity slot. A gym class, a university course, faction
 * work, company work, a crime, a program or a graft all occupy it, and starting
 * any of them cancels whatever was there.
 *
 * Bladeburner is separate state: `ns.bladeburner.startAction` also takes the
 * slot, and `ns.singularity.getCurrentWork` does not report it. So the two are
 * disjoint, and each side can ask about the other without deadlocking.
 *
 * THE EXCEPTION, and why the predicates below take a flag: the augment The
 * Blade's Simulacrum stops Bladeburner actions from taking the slot at all, so
 * with it Bladeburner runs alongside everything else rather than excluding it.
 * The rules here still hold, they just do not apply — see `hasBladeburnerAction`.
 *
 * This exists because two features were fighting over the slot. Progression
 * checked whether Bladeburner was busy before starting work, but Bladeburner did
 * not check the reverse, so its next tick would cancel whatever training had just
 * begun. Nothing in either file was wrong on its own; the pair had no agreement.
 *
 * Both features ask through here so the question is answered in one place.
 * ============================================================================
 */

/**
 * The floor to train to when the goal names none of the measurements this
 * can raise, which happens when the player is between goals.
 *
 * A fallback rather than a target: the live values come from the goal, and
 * the number here is only reached when it has nothing to say. It lives beside its
 * one remaining caller now that `player.ts` and `sleeves.ts` carry their own,
 * which is why it is not exported.
 */
const FLOOR_FALLBACK: FloorTargets = { hacking: 100, combat: 100 };

/* ─── THE MEASURED RATE, PUBLISHED BY THE FEATURE THAT MEASURES IT ─── */

/** The `player.skills` key for each rate code. */
const STAT_KEY: Readonly<Record<MeasuredStat, "hacking" | "strength" | "defense" | "dexterity" | "agility" | "charisma">> = {
    hacking: "hacking", str: "strength", def: "defense", dex: "dexterity", agi: "agility", cha: "charisma",
};

/** The rate code for each long combat skill name, as `belowFloor` reports it. */
const STAT_OF_COMBAT: Readonly<Record<string, MeasuredStat>> = {
    strength: "str", defense: "def", dexterity: "dex", agility: "agi",
};

/** Levels per second for a measurement, or null when none has been measured yet. */
type RatePublisher = (stat: MeasuredStat) => number | null;

let trainingRatePublisher: RatePublisher | null = null;

/**
 * Publish the measured XP rate, so the yield signal can apply the same reachability rule the
 * training decision uses.
 *
 * WHY A PUBLISHER RATHER THAN AN IMPORT. The rate is measured in `player.ts`, which is the
 * feature that also imports THIS module — so importing the rate back would be a cycle, and a
 * static import between the entry and its helper is the shape ADR-0001 warns about anyway.
 * A publisher set once at tick time is the same one-writer rule `Reserves` uses: the feature
 * that owns the measurement writes it, and every reader gets the same figure.
 *
 * A null publisher (the default, and what a test that does not care sees) means "no rate
 * measured", which `floorReachable` reads as "keep training" — the safe direction, since
 * refusing on no evidence would stop a fresh run from ever training.
 */
export function publishTrainingRate(publisher: RatePublisher | null): void {
    trainingRatePublisher = publisher;
}

/**
 * The measured rate for a measurement, or null when none has been taken.
 *
 * The read side of the publisher above, so the goal machinery can estimate
 * effort from the SAME measurement the training decision uses. A second rate
 * would be a second thing to disagree with, which is the reason the publisher
 * pattern exists at all.
 *
 * Takes the long `SubGoalKey` names rather than the short rate codes, because the
 * caller is `goal.ts`, whose vocabulary is the goal's.
 */
export function measuredRateFor(key: string): number | null {
    if (trainingRatePublisher === null) return null;
    // `combat` is the goal's word for whichever combat stat is lowest; the player
    // measures them separately, and strength is the one the floor trains toward
    // when combat is behind. Mapping it here keeps that choice in one place.
    const code = key === "hacking" ? "hacking" : key === "cha" ? "cha" : key === "combat" ? "str" : null;
    if (code === null) return null;
    return trainingRatePublisher(code as MeasuredStat);
}

/**
 * Whether the player is doing something that `ns.singularity.getCurrentWork`
 * reports, as opposed to a Bladeburner action.
 */
export function hasSingularityWork(ns: NS): boolean {
    return ns.singularity.getCurrentWork() !== null;
}

/**
 * Whether a Bladeburner action is holding the activity slot.
 *
 * `slotTaken` is false when the run owns The Blade's Simulacrum, which stops
 * Bladeburner actions from occupying the single slot: with it, Bladeburner
 * runs ALONGSIDE training, gang work and everything else rather than excluding
 * them. So the question "is the slot busy with Bladeburner" has the answer
 * "no" in that case, whatever the division is actually doing — the callers use
 * this to decide whether to yield, and there is nothing to yield to.
 *
 * The flag is an argument rather than something read here because reading it
 * needs the Singularity API and augment ownership, both of which are already in
 * the `Context` the callers hold. It defaults to `true` — the conservative
 * direction: an unaware caller behaves exactly as before the augment existed.
 *
 * `getCurrentAction` returns a null-or-Idle action when nothing is happening, and
 * throws when the player is not in the division at all.
 */
export function hasBladeburnerAction(ns: NS, slotTaken = true): boolean {
    if (!slotTaken) return false;
    try {
        if (!ns.bladeburner.inBladeburner()) return false;
        const action = ns.bladeburner.getCurrentAction();
        return action !== null && (action.type as string) !== "Idle";
    } catch {
        // Not in the division, or the API is unavailable on this node.
        return false;
    }
}

/**
 * Whether Bladeburner is holding the slot as an uninterrupted CHAIN.
 *
 * This is Bladeburner's own `holdsSlot` test, and it exists here rather than
 * being imported from the feature because features may not import each other
 * (ADR-0001) — and because progression needs the same answer, not a copy of it.
 *
 * A chain means an action of the division's own is in flight, so it intends to
 * follow it with another rather than handing the slot back. A REST does not
 * count: resting is forced by stamina rather than chosen, and the division yields
 * after one, so treating it as a chain would bind the slot to Bladeburner for the
 * rest of the run.
 */
export function bladeburnerHoldsChain(ns: NS): boolean {
    try {
        if (!ns.bladeburner.inBladeburner()) return false;
        const action = ns.bladeburner.getCurrentAction();
        if (action === null) return false;
        return (action.type as string) !== "Idle"
            && action.name !== "Hyperbolic Regeneration Chamber";
    } catch {
        // Not in the division, or the API is unavailable on this node.
        return false;
    }
}

/**
 * Whether Bladeburner is KEEPING the activity slot rather than handing it back.
 *
 * THE SHARED ANSWER, and this is the fix for a deadlock. The two features were
 * asking different questions and both stood down:
 *
 *   Bladeburner yields when  !holdsChain && trainingWanted  (it is being generous)
 *   Progression yielded when  hasBladeburnerAction(...)      (it saw an action)
 *
 * With a chain in flight and training outstanding, `holdsChain` is true so
 * Bladeburner keeps its action — while progression saw a running action and stood
 * down. Nothing ran: measured live as no progression action announced for 130 log
 * entries, with money and experience both frozen.
 *
 * SO PROGRESSION MUST ASK THE INVERSE. "Does Bladeburner yield?" and "should
 * progression yield?" are opposite questions; giving both the same predicate just
 * moves the deadlock to the other branch, which a truth table showed immediately —
 * with no chain and training wanted, both yielded and neither acted. This returns
 * the one thing progression needs, so the pair cannot contradict each other.
 *
 * ONLY A CHAIN KEEPS THE SLOT, and the clause that said otherwise was a deadlock.
 *
 * It used to end `return !trainingWanted` — with no chain in flight, the division kept the
 * slot precisely when training was NOT wanted. Both features read that as exclusive
 * ownership and both stood down:
 *
 *   progression     yielded: Bladeburner keeps the slot (training not wanted)
 *   bladeburner     returned on its own yield, never reaching `pickAction`
 *   getCurrentWork  null
 *
 * Measured: 26 minutes, ~1,500 consecutive telemetry frames, money climbing 9b → 24b while
 * hacking crawled 414 → 417 in two hours. Nobody held the slot and every panel looked calm.
 *
 * The reasoning error is worth naming, because it is a shape that will recur. "Training is
 * not wanted" is the ABSENCE of a request from the one feature that could fill the slot. It
 * is not a claim on it, and not evidence that anybody else wants it. Treating a refusal as a
 * handover leaves the slot with whoever was asked to yield — who has, by construction, just
 * decided to do nothing.
 *
 * So the rule is: THE SLOT IS CLAIMED BY WHOEVER ACTS. With no chain in flight the division
 * is not acting, so the slot is free and progression takes it. This does not re-open the
 * original deadlock the function was written for: that one needed a chain to be running
 * while progression stood down, and the `holdsChain` clause still answers it.
 *
 * `slotsShared` is false when the run owns The Blade's Simulacrum, in which case
 * there is no contention and the slot is never Bladeburner's alone.
 */
export function bladeburnerKeepsSlot(
    ns: NS,
    slotsShared: boolean,
    trainingWanted: boolean,
): boolean {
    if (!slotsShared) return false;
    // An action in flight is the only claim. `trainingWanted` is deliberately not consulted:
    // both features already read it for their own halves, and a third reading here is what
    // turned a refusal into an ownership statement. Kept in the signature because the two
    // callers pair it with it, and removing it would tempt a caller to reintroduce the term.
    void trainingWanted;
    return bladeburnerHoldsChain(ns);
}

/**
 * Whether training is wanted, HELD STICKY so a flicker cannot reverse the handover.
 *
 * WHY THIS EXISTS, and it is the second half of the same reported fault. The truth
 * table above makes the pair consistent WITHIN a tick, but the input they share —
 * `trainingRemaining` — is derived from a rate model that recalibrates: `trackRate`
 * drops its open sample whenever the player is not in a class, so the first readings
 * after a class boundary report no rate at all, and the value can therefore read
 * `true` on one tick and `false` on the next with nothing in the world having changed.
 *
 * A handover driven by that input is a handover driven by noise. Measured as the
 * symptom this whole file exists to prevent, in its newest form: Bladeburner stands
 * down for training, progression finds nothing it can start (its cap, a travel, a
 * reachable-stat switch), and the next tick reverses both. Neither makes progress and
 * the log says both are behaving correctly.
 *
 * So the answer LATCHES. Once training is wanted it stays wanted for `HOLD_MS`, which
 * is longer than any recalibration window by an order of magnitude and shorter than the
 * training cap, so a genuinely finished target releases the slot well inside the time
 * the run would have spent on it anyway. `false` is returned immediately and only ever
 * after the hold has expired — there is no symmetric latch, because the direction that
 * must not flicker is the one that hands work to training.
 *
 * The clock is module state, like `trainingRatePublisher`, and is reset with it: two
 * tests in one process must not inherit each other's hold.
 */
const HOLD_MS = 90_000;
let wantedSince = 0;

export function trainingWantedHeld(trainingWanted: boolean, now: number = Date.now()): boolean {
    if (trainingWanted) {
        if (wantedSince === 0) wantedSince = now;
        return true;
    }
    if (wantedSince === 0) return false;
    if (now - wantedSince < HOLD_MS) return true;
    wantedSince = 0;
    return false;
}

/** Forget the hold. Exported for tests, alongside `publishTrainingRate(null)`. */
export function resetSlotHold(): void {
    wantedSince = 0;
}

/**
 * Whether Bladeburner is about to hand the slot back for training.
 *
 * The other side of `bladeburnerKeepsSlot`, stated separately so each caller
 * reads as what it means rather than as a negation. The two are exact inverses,
 * which is what stops them disagreeing.
 */
export function bladeburnerYieldsForTraining(
    ns: NS,
    slotsShared: boolean,
    trainingWanted: boolean,
): boolean {
    return !bladeburnerKeepsSlot(ns, slotsShared, trainingWanted);
}

/**
 * Whether an augmentation graft is running right now.
 *
 * A graft owns the activity slot just like a program or a course does, but it is
 * the one work whose progress is destroyed rather than merely paused when
 * something else starts — re-grafting begins again from zero. It is also the
 * slowest work in the game, so the loss is measured in real wall-clock hours,
 * not seconds.
 *
 * Progression reads `getCurrentWork()` for its own actions, so a graft *does*
 * appear there under the type `"GRAFTING"`; unlike Bladeburner it is not
 * invisible to the Singularity API. But progression starts its next action by
 * looking for a change, and a graft is not one of the actions progression ever
 * asks for — so without this guard, the moment a program/training target is
 * wanted, `assignAction` would start it and cancel the graft in flight. This
 * predicate is what lets progression treat a graft like a running black op: an
 * owner of the slot that must not be interrupted.
 */
export function hasActiveGraft(ns: NS): boolean {
    try {
        const work = ns.singularity.getCurrentWork();
        return work !== null && (work as { type?: string }).type === "GRAFTING";
    } catch {
        return false;
    }
}

/**
 * A Bladeburner black op is the one action that owns the activity slot ahead of
 * progression. The bar below is the single source of truth for that priority.
 */
export const BLACK_OP_MIN_CHANCE = 0.9;

/**
 * Whether a black op is available to start *and* worth the slot right now: the
 * player outranks it and its estimated success clears the bar.
 *
 * This is the shared predicate that stops progression and Bladeburner from
 * flapping. When it is true, progression must not study/graft (so it yields the
 * slot) and Bladeburner must start the op. When it is false, progression owns the
 * slot and Bladeburner waits — which for contracts/operations is the right
 * trade, because training is faster than the experience they grant.
 *
 * A *running* black op is reported separately by `hasActiveBlackOp`, because the
 * two questions differ: this one is about what to start next, that one is about
 * what must not be interrupted.
 */
export function winnableBlackOp(ns: NS): boolean {
    try {
        const bb = ns.bladeburner;
        if (!bb.inBladeburner()) return false;
        const bo = bb.getNextBlackOp();
        if (!bo || bb.getRank() < bo.rank) return false;
        const [lo] = bb.getActionEstimatedSuccessChance("Black Operations", bo.name);
        return lo >= BLACK_OP_MIN_CHANCE;
    } catch {
        return false;
    }
}

/**
 * Whether a Bladeburner black op is running right now.
 *
 * A running black op must not be interrupted: it is time-sensitive and exclusive
 * with grafting/training/working, so once the division has started one it owns the
 * slot until the op finishes. Contracts and operations are different — training
 * is faster than the experience they grant — so progression still preempts those.
 */
export function hasActiveBlackOp(ns: NS): boolean {
    try {
        if (!ns.bladeburner.inBladeburner()) return false;
        const action = ns.bladeburner.getCurrentAction();
        return action !== null && (action.type as string) === "Black Operations";
    } catch {
        return false;
    }
}

/**
 * Whether progression still has stat training to do, given the run's goal.
 *
 * Every stat has to reach the floor before the faction and company work that
 * follows becomes available, and training in a gym or a course is much faster
 * than the experience a Bladeburner action grants. So while this is true,
 * progression owns the activity slot and Bladeburner waits.
 *
 * The floor comes from the goal, not from a constant here. It used to be
 * `TRAINING_TARGET = 100` declared in this file, which meant the feature that
 * YIELDS the slot (Bladeburner) decided training was finished at a level the
 * feature that CLAIMS it (progression) was still training past — the same class
 * of drift ADR-0003 removed from `player.ts` and `sleeves.ts`, surviving in the
 * one place neither of them reads.
 *
 * The decision itself is `floorReachable`, so this asks the same question the
 * progression feature asks rather than reimplementing it. That is what makes the
 * two impossible to disagree: there is one comparison, in `progression.ts`, and
 * both callers reach it.
 *
 * WHY THE REACHABILITY HALF WAS ADDED. `belowFloor` alone answers "is a stat short of its
 * target", which is not the question the slot turns on: progression will NOT train a target
 * it cannot reach within the budget (see `floorReachable`), so a stat short of an
 * unreachable target means progression is doing something else. Yielding on `belowFloor`
 * alone therefore handed Bladeburner's slot to training that was never going to happen —
 * the feature that yields and the feature that claims disagreeing, the exact fault this
 * function exists to prevent.
 */
export function trainingRemaining(player: Player, goal: Goal | null): boolean {
    const under = belowFloor(player, trainingTargets(goal, FLOOR_FALLBACK));
    if (under === null) return false;

    // The rate for the measurement being trained, published by the feature that measures it.
    // Bladeburner has no rate model of its own and must not grow one — a second measurement
    // would be a second thing to disagree with.
    const stat = under.kind === "hacking" ? "hacking" : STAT_OF_COMBAT[under.skill ?? "strength"];
    const rate = trainingRatePublisher === null ? null : trainingRatePublisher(stat);
    return floorReachable(under, player.skills[STAT_KEY[stat]], rate) && !measuredStall(rate);
}

/**
 * Whether a rate that IS evidence says the stat is not moving, so training it is a dead end.
 *
 * ONLY A MEASURED RATE CAN BE EVIDENCE. The distinction this preserves is the one
 * `floorReachable` already makes, and it is the whole point of the slot handover:
 *
 *   null        nothing measured yet. NO EVIDENCE. Reads as "training wanted", because the
 *               slot is a handover and refusing on an unknown hands it to nobody.
 *   Infinity    unusable arithmetic rather than an observation. Also no evidence.
 *               (`floorReachable` already reads this as "keep training".)
 *   <= 0        measured, and the stat did not rise. THAT is a stall, and the one case that
 *               may legitimately keep the slot off training.
 *
 * THE FAULT THIS FIXES, and it was measured live rather than reasoned about. An earlier
 * version of this predicate treated `null` as a stall too, on the argument that "a handover
 * on an unknown is a handover on nothing". The argument is right and the conclusion was
 * backwards: `null` is the rate for the ticks right after EVERY class boundary, because
 * `trackRate` drops its open sample whenever the player is not in a class. So the moment
 * progression stopped training and Bladeburner got the slot, the rate went null, the
 * predicate reported "no training wanted", and Bladeburner kept the slot forever while
 * picking nothing — `reason` never moved off "starting" for 3,215 consecutive ticks, and
 * progression reported "yielded: Bladeburner keeps the slot (training not wanted)". Neither
 * feature ran for 23 minutes at a stretch, with hacking frozen at 114 against a target of
 * 200. The handover must never depend on a reading that is systematically absent exactly
 * when the handover happens.
 */
function measuredStall(rate: number | null): boolean {
    return rate !== null && Number.isFinite(rate) && rate <= 0;
}


