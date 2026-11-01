/*
 * ============================================================================
 * SELF-RESTART
 * ============================================================================
 * Whether a change on disk actually reloads the running script.
 *
 * WHY THIS FILE EXISTS. The module's own header records that an edit silently having no
 * effect "has cost three separate debugging sessions in this framework already" — the
 * failure is a deployment trap whose symptom is indistinguishable from a bug in the new
 * code. The boot walk covers files that existed at startup; this pins the case it could
 * not cover, a file added afterwards, which is what a new feature or `lib/` module is.
 *
 * A fake `ns` is enough: the module reads `self()`, `ls`, `getFileMetadata` and calls
 * `spawn`. Nothing here needs a real game.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RESTART_DELAY_MS, SPAWN_DELAY_MS, advanceWatcherClockForTest, createChangeWatcher } from "./self-restart.ts";
import type { NS } from "@ns";

/**
 * Enough to cross the debounce in two clock reads.
 *
 * DERIVED FROM THE CONSTANT rather than restated. These tests used the literal `2000`,
 * which was comfortably past the one-second grace period and silently stopped being past it
 * when the debounce was raised to a minute. A test that encodes a tuning value becomes a
 * test rewrite every time the value is tuned; a test that encodes the RULE survives it.
 */
const PAST_GRACE_MS = RESTART_DELAY_MS + 1_000;

interface FakeFile {
    readonly mtime: number;
}

/**
 * An `ns` with a filesystem that the test can change between calls, which is the whole
 * point — the watcher exists to notice exactly that.
 */
function fakeNs(files: Map<string, FakeFile>, entry = "/nexus.ts") {
    const spawned: string[] = [];
    /** The `spawnDelay` each spawn was asked for, so the restart GAP is assertable. */
    const delays: number[] = [];

    const ns = {
        self: () => ({ filename: entry, threads: 1, args: [] }),
        // `ls` is not recursive and takes a directory. It reports ABSOLUTE paths (see
        // `lib/scripts.ts`), which the walk depends on — returning bare basenames loses
        // the directory and the walked `path` becomes `/${basename}`, which then matches
        // nothing in the map and reads as unchanged.
        ls: (_host: string, dir: string) => {
            const prefix = dir.endsWith("/") ? dir : `${dir}/`;
            const out: string[] = [];
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue;
                const rest = path.slice(prefix.length);
                // The immediate child: the whole path to a file, or the path to the
                // directory's next segment when there is more below it.
                out.push(rest.includes("/") ? `${prefix}${rest.slice(0, rest.indexOf("/"))}` : path);
            }
            return [...new Set(out)];
        },
        getFileMetadata: (path: string) => {
            const f = files.get(path.startsWith("/") ? path : `/${path}`);
            return f === undefined ? null : { mtime: f.mtime };
        },
        print: () => {},
        tprint: () => {},
        // The SECOND argument is the options object — `spawn(file, {threads, spawnDelay},
        // ...args)`. A fake that reads it as a thread count records nothing, which is how
        // the first version of the delay test failed while the code was correct.
        spawn: (script: string, opts?: { spawnDelay?: number }) => {
            spawned.push(script);
            delays.push(opts?.spawnDelay ?? 0);
        },
    } as unknown as NS;

    return { ns, spawned, delays };
}

test("an edited file triggers a restart, after the grace period", () => {
    const files = new Map<string, FakeFile>([
        ["/nexus.ts", { mtime: 1 }],
        ["/lib/context.ts", { mtime: 1 }],
    ]);
    const { ns, spawned } = fakeNs(files);
    const watcher = createChangeWatcher(ns);
    assert.equal(watcher.enabled(), true);

    assert.equal(watcher.check(), false, "restarted with nothing changed");

    // Past the grace period whatever it is set to. Hardcoding the old one second made
    // these tests fail when the debounce was raised to a minute — the tests knew the
    // number rather than the rule, which is the kind of coupling that turns a tuning
    // change into a test rewrite.
    advanceWatcherClockForTest(PAST_GRACE_MS);
    files.set("/lib/context.ts", { mtime: 2 });
    assert.equal(watcher.check(), false, "fired on the first sighting of a change");
    assert.equal(watcher.check(), true, "a stable change did not trigger a restart");
    assert.equal(spawned.length, 1);
});

test("an unchanged tree never restarts, however often it is checked", () => {
    // THE PROPERTY THAT MATTERS MOST, and the one a rescan broke.
    //
    // The watcher used to re-walk the tree on every check and compare it against the map
    // built at boot. Two walks of the same home need not enumerate the same set — `ns.ls`
    // ordering is not guaranteed, and a bounded walk can stop in a different place — so a
    // file missing from `boot` looked NEW on every pass. Measured: nexus respawning
    // itself continuously, with the full feature roster printed twice a second.
    //
    // A watcher that fires on nothing is worse than one that misses a rare new file. The
    // miss is one manual restart away; a loop cannot be broken by the user at all.
    const files = new Map<string, FakeFile>([
        ["/nexus.ts", { mtime: 1 }],
        ["/lib/context.ts", { mtime: 1 }],
    ]);
    const { ns, spawned } = fakeNs(files);
    const watcher = createChangeWatcher(ns);

    for (let i = 0; i < 50; i++) {
        assert.equal(watcher.check(), false, `restarted on an unchanged tree at check ${i}`);
    }
    assert.equal(spawned.length, 0);
});

test("a new file does not restart on its own, the price of that stability", () => {
    // Stated as a test rather than left in a comment, so the trade-off cannot be "fixed"
    // back into a loop by someone who notices the miss and not the reason for it.
    const files = new Map<string, FakeFile>([["/nexus.ts", { mtime: 1 }]]);
    const { ns, spawned } = fakeNs(files);
    const watcher = createChangeWatcher(ns);

    assert.equal(watcher.check(), false);
    files.set("/lib/brand-new.ts", { mtime: 5 });
    assert.equal(watcher.check(), false, "a new file triggered a restart");
    assert.equal(spawned.length, 0);
});

test("an unreadable file is not treated as new", () => {
    // A file mid-write has no usable mtime. Spawning into a half-synced script is worse
    // than waiting a second, so it must be skipped rather than reported.
    const files = new Map<string, FakeFile>([["/nexus.ts", { mtime: 1 }]]);
    const { ns } = fakeNs(files);
    const watcher = createChangeWatcher(ns);

    // Present in the listing but with no metadata — `getFileMetadata` returns null for
    // paths absent from the map, which is what a half-written file looks like.
    const listing = new Map(files);
    listing.set("/lib/half-written.ts", { mtime: 5 });
    const partial = fakeNs(listing).ns;
    Object.assign(partial, { getFileMetadata: (p: string) => (p.endsWith("half-written.ts") ? null : { mtime: 1 }) });

    assert.equal(watcher.check(), false);
    assert.equal(createChangeWatcher(partial).check(), false, "an unreadable new file triggered a restart");
});

test("only one restart happens, however often check is called", () => {
    // `spawn` terminates this script. A second call from a dying process would start a
    // duplicate orchestrator — and the `fired` guard must hold across any number of
    // checks once the debounce has let the restart through.
    const files = new Map<string, FakeFile>([["/nexus.ts", { mtime: 1 }]]);
    const { ns, spawned } = fakeNs(files);
    const watcher = createChangeWatcher(ns);

    // Past the grace period whatever it is set to. Hardcoding the old one second made
    // these tests fail when the debounce was raised to a minute — the tests knew the
    // number rather than the rule, which is the kind of coupling that turns a tuning
    // change into a test rewrite.
    advanceWatcherClockForTest(PAST_GRACE_MS);
    files.set("/nexus.ts", { mtime: 2 });
    assert.equal(watcher.check(), false);
    assert.equal(watcher.check(), true);
    assert.equal(watcher.check(), false);
    assert.equal(watcher.check(), false);
    assert.equal(spawned.length, 1, "the script spawned more than once");
});

test("a watcher with no readable fingerprint never restarts", () => {
    // Restarting into an unknown file state is worse than not restarting, so an
    // unfingerprinted watcher is disabled rather than approximated.
    const { ns } = fakeNs(new Map());
    const watcher = createChangeWatcher(ns);
    assert.equal(watcher.enabled(), false);
    assert.equal(watcher.check(), false);
});

test("the spawn delay is not the debounce, whatever the debounce is set to", () => {
    // THE TWO CONSTANTS WERE ONE, and raising the debounce to sixty seconds would have set
    // `spawnDelay` to sixty seconds with it — the orchestrator would die and stay dead for a
    // minute after every restart, with features unloaded and telemetry dark. The debounce
    // decides WHEN to restart; the spawn delay decides how long the gap is, and a minute is
    // the right answer to only the first.
    //
    // Asserted through the spawn CALL rather than by comparing two constants, because the
    // defect was that the call read the wrong one — a constant comparison would still pass
    // while the call site was wrong.
    const files = new Map<string, FakeFile>([["/nexus.ts", { mtime: 1 }]]);
    const { ns, spawned, delays } = fakeNs(files);
    const watcher = createChangeWatcher(ns);

    advanceWatcherClockForTest(PAST_GRACE_MS);
    files.set("/nexus.ts", { mtime: 2 });
    assert.equal(watcher.check(), false);
    assert.equal(watcher.check(), true);

    assert.equal(spawned.length, 1);
    assert.equal(delays.length, 1);
    // AN EXACT VALUE, not an inequality. The first version of this test asserted
    // `delays[0] < RESTART_DELAY_MS`, which the BUG also satisfies — 2000 is less than
    // 60000, and so is 60000 is not. Asserting the exact figure is what makes the call site
    // testable: the defect was which constant was READ, and only equality pins that.
    assert.equal(
        delays[0],
        SPAWN_DELAY_MS,
        `spawnDelay ${delays[0]}ms is not the restart gap — the debounce value has leaked in`,
    );
    assert.notEqual(
        delays[0],
        RESTART_DELAY_MS,
        "the spawn delay is the debounce again; the orchestrator would stay dead for a minute",
    );
});
