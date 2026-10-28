/*
 * ============================================================================
 * RESTARTING A CLASS THE PLAYER IS ALREADY TAKING
 * ============================================================================
 * `assignAction` re-issues `universityCourse`/`gymWorkout` on EVERY tick. That is the
 * right call for a slot that has moved on — the game replaces whatever is running — but
 * it is not free when the slot has not moved: the game treats the re-issue as a NEW
 * action, finishes the running one, and starts another.
 *
 * WHY THIS FILE EXISTS. `player.ts` has warned about exactly this since the beginning,
 * above `CLASS_STAT`: the class-type strings "must match exactly or `isDoingAction` never
 * recognises the class and every tick restarts it". The strings were kept in step, but
 * the comparison was never WIRED IN: `isDoingAction` is called only from the COMPANY
 * promotion path. So the guard the comment describes does not exist, and the defect it
 * described is the live behaviour.
 *
 * The recorded evidence is `runs/2026-10-28T04.50.35`, one transition per second for ten
 * minutes, with progression reporting "acting: course Computer Science" on both sides:
 *
 *   1688494  CLASS:Rothman University:Computer Science -> none
 *   1689496  none -> CLASS:Rothman University:Computer Science
 *   1690512  none -> CLASS:Rothman University:Computer Science
 *
 * What the same file does NOT show is a large loss, and that matters for the size of this
 * fix. `hackingExp` still climbs across those ten minutes (1634.21 at 1688494, 5169.04 at
 * 1843696) and `totalPlaytime` advances normally, so the game is crediting experience and
 * the class is not inert. What is wrong is that it is torn down and rebuilt every second
 * instead of being left to run, which is the reported flicker; whether that also forfeits
 * partial progress is not something this recording can answer, and is not claimed here.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { NS } from "@ns";

import type { PlayerAction } from "./player.ts";
import { alreadyDoing } from "./player.ts";

/** `getCurrentWork()` values, shaped as the game reports them. */
const COURSE = { type: "CLASS", location: "Rothman University", classType: "Computer Science" };
const GYM_STR = { type: "CLASS", location: "Powerhouse Gym", classType: "str" };
const HOMICIDE = { type: "CRIME", crimeType: "Homicide" };

const UNI = { kind: "UNI", university: "Rothman University", course: "Computer Science", city: "Sector-12" } as PlayerAction;
const GYM = { kind: "GYM", gym: "Powerhouse Gym", stat: "str", city: "Sector-12" } as PlayerAction;

/**
 * An `ns` whose `universityCourse`/`gymWorkout` behave as the game's do: a call is a NEW
 * action, and it ends whatever was running.
 *
 * The counting is the point. A fixture that only reported success could not tell "the
 * class was left alone" from "the class was restarted with the same arguments", and those
 * are the two things this test has to separate.
 */
function fixture(current: unknown) {
    const calls: string[] = [];
    const ns = {
        singularity: {
            getCurrentWork: () => current,
            universityCourse: (university: string, course: string) => {
                calls.push(`UNI:${university}:${course}`);
                return true;
            },
            gymWorkout: (gym: string, stat: string) => {
                calls.push(`GYM:${gym}:${stat}`);
                return true;
            },
        },
    } as unknown as NS;
    return { ns, calls };
}

test("a course already in progress is left alone", () => {
    // THE DEFECT. Without this the API is called every second, and the game finishes and
    // restarts the class each time — which is the flicker, and the reason no studying
    // completed in the recorded run.
    const f = fixture(COURSE);
    assert.equal(alreadyDoing(f.ns, UNI), true, "a course in progress was not recognised");
});

test("a course at a DIFFERENT university is recognised as different", () => {
    // The comparison is on location as well as course: moving the player to another campus
    // for the same course is a real change of action and must be issued.
    const elsewhere = { ...COURSE, location: "Volhaven University" };
    assert.equal(alreadyDoing(fixture(elsewhere).ns, UNI), false);
});

test("a different course at the same university is recognised as different", () => {
    const otherCourse = { ...COURSE, classType: "Algorithms" };
    assert.equal(alreadyDoing(fixture(otherCourse).ns, UNI), false);
});

test("a gym class already in progress is left alone", () => {
    // Gym classes report the SHORT stat code in `classType`, not the long form — the other
    // half of the warning above `CLASS_STAT`, and the half that would silently break if
    // the comparison were written against "strength".
    const f = fixture(GYM_STR);
    assert.equal(alreadyDoing(f.ns, GYM), true, "a gym class in progress was not recognised");
});

test("a gym class for a different stat is recognised as different", () => {
    const agility = { ...GYM_STR, classType: "agi" };
    assert.equal(alreadyDoing(fixture(agility).ns, GYM), false);
});

test("a crime in the slot is not a class, so the course is issued", () => {
    // The release path in `tick` deliberately replaces a class with a one-second crime.
    // The next tick must put the course back, or that release becomes a permanent stop.
    assert.equal(alreadyDoing(fixture(HOMICIDE).ns, UNI), false);
});

test("a non-class action never claims to be already done, whatever the slot holds", () => {
    // The guard is applied only to classes, and it must never become a general "is this
    // action already running" shortcut: `TRAVEL` in particular has to be issued every
    // time it is chosen, or a trip would be skipped. Applying it INSIDE the class branches
    // rather than above the `TRAVEL` branch is what keeps that true, and this pins it.
    const f = fixture(COURSE);
    assert.equal(alreadyDoing(f.ns, { kind: "TRAVEL", city: "Volhaven" } as PlayerAction), false);
    assert.equal(alreadyDoing(f.ns, { kind: "CRIME", crime: "Homicide" } as PlayerAction), false);
});

test("an empty slot is not a class", () => {
    assert.equal(alreadyDoing(fixture(null).ns, UNI), false);
    assert.equal(alreadyDoing(fixture(null).ns, GYM), false);
});

test("a work type that cannot be read does not claim the action is done", () => {
    // `getCurrentWork` is a game call and can throw. Reporting "already doing it" on a
    // failed read would leave the player doing nothing at all, which is worse than a
    // restarted class: it is silence for the rest of the run.
    const ns = {
        singularity: {
            getCurrentWork: () => {
                throw new Error("no singularity access");
            },
        },
    } as unknown as NS;
    assert.equal(alreadyDoing(ns, UNI), false);
});
