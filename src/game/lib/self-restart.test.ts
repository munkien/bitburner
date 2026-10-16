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

import { createChangeWatcher } from "./self-restart.ts";
import type { NS } from "@ns";

interface FakeFile {
    readonly mtime: number;
}

/**
 * An `ns` with a filesystem that the test can change between calls, which is the whole
 * point — the watcher exists to notice exactly that.
 */
function fakeNs(files: Map<string, FakeFile>, entry = "/nexus.ts") {
    const spawned: string[] = [];

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
        spawn: (script: string) => { spawned.push(script); },
    } as unknown as NS;

    return { ns, spawned };
}

test("an edited file triggers a restart", () => {
    const files = new Map<string, FakeFile>([
        ["/nexus.ts", { mtime: 1 }],
        ["/lib/context.ts", { mtime: 1 }],
    ]);
    const { ns, spawned } = fakeNs(files);
    const watcher = createChangeWatcher(ns);
    assert.equal(watcher.enabled(), true);

    assert.equal(watcher.check(), false, "restarted with nothing changed");

    files.set("/lib/context.ts", { mtime: 2 });
    assert.equal(watcher.check(), true, "an edited file did not trigger a restart");
    assert.equal(spawned.length, 1);
});

test("a file ADDED after boot triggers a restart", () => {
    // The case the boot walk alone cannot see: `boot` is built once, so a new file is
    // not a key in it and `firstChanged` can never report it. Without the rescan the file
    // syncs in and nothing reloads — the exact trap the module exists to remove.
    const files = new Map<string, FakeFile>([["/nexus.ts", { mtime: 1 }]]);
    const { ns, spawned } = fakeNs(files);
    const watcher = createChangeWatcher(ns);

    assert.equal(watcher.check(), false);

    files.set("/lib/brand-new.ts", { mtime: 5 });
    assert.equal(watcher.check(), true, "a new file did not trigger a restart");
    assert.equal(spawned.length, 1);
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
    // duplicate orchestrator.
    const files = new Map<string, FakeFile>([["/nexus.ts", { mtime: 1 }]]);
    const { ns, spawned } = fakeNs(files);
    const watcher = createChangeWatcher(ns);

    files.set("/nexus.ts", { mtime: 2 });
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
