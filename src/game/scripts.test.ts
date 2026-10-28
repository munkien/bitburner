/*
 * ============================================================================
 * SCRIPT LOOKUP BY BASENAME
 * ============================================================================
 * `findScriptOnHome` exists because the deployment layout is not fixed: the sync mirrors
 * `src/game` into the game with its directories intact, so `install.ts` lands at
 * `/features/retire/scripts/install.ts` rather than at the root. Every caller that
 * resolves a script by a hard-coded path is therefore wrong on a synced deploy and right
 * only on a hand-copied one.
 *
 * THE BUG THIS FILE EXISTS FOR. `manual-retire.ts` checked `ns.fileExists("install.ts",
 * "home")` as its preflight and refused to run on a perfectly healthy game — while
 * `retire.ts`, which had always used `findScriptOnHome`, went on spawning the same file
 * without trouble. Two readers of one path, one of them wrong, and the wrong one was
 * invisible until a player tried the manual command and was told to "deploy it first".
 *
 * A lookup that only works at the root is the failure mode, so the tests below exercise
 * the nested layout specifically — a fixture with the file at the root would pass against
 * the buggy version and prove nothing.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { basename, findScriptOnHome } from "./lib/scripts.ts";
import type { NS } from "@ns";

/**
 * An `ns` whose home holds exactly the given paths.
 *
 * `ns.ls(host, substring)` filters by SUBSTRING, which is the game's real behaviour and
 * the reason the basename comparison inside `findScriptOnHome` is doing real work rather
 * than restating the query: asking for "install.ts" also matches
 * "features/retire/scripts/install.ts", and asking for "install" would match both that and
 * "installer.ts".
 */
function homeNs(paths: readonly string[]): NS {
    return {
        ls: (_host: string, substring: string) =>
            paths.filter(path => path.includes(substring)),
    } as unknown as NS;
}

test("a script in a subdirectory is found by its basename", () => {
    // THE REGRESSION. This is where the sync actually puts the file, and a path-based
    // check reports it missing.
    const ns = homeNs(["/features/retire/scripts/install.ts"]);

    assert.equal(
        findScriptOnHome(ns, "install.ts"),
        "/features/retire/scripts/install.ts",
        "a nested script was not found, which is what made manual-retire refuse",
    );
});

test("a script at the root is still found", () => {
    // The other layout. Hand-copying a file to the root must keep working — the fix is
    // "resolve by name", not "require a subdirectory".
    assert.equal(findScriptOnHome(homeNs(["/install.ts"]), "install.ts"), "/install.ts");
});

test("the returned path always starts at the root", () => {
    // `ns.run` takes an absolute path. The game reports `ns.ls` entries without a leading
    // slash in some versions, so a path assembled from a partial match has to be
    // normalised — passing a relative path to `run` silently fails to spawn.
    const ns = {
        ls: () => ["features/retire/scripts/install.ts"],
    } as unknown as NS;

    assert.equal(
        findScriptOnHome(ns, "install.ts"),
        "/features/retire/scripts/install.ts",
        "a relative path was returned; run() would not find it",
    );
});

test("a missing script is null, not a wrong path", () => {
    // The preflight depends on this distinction: null is what makes it refuse, and a
    // non-null answer for an absent file would let a retirement proceed into a reset with
    // no installer to perform it.
    assert.equal(findScriptOnHome(homeNs(["/other.ts"]), "install.ts"), null);
});

test("only an exact basename matches, not a substring of one", () => {
    // `ns.ls` filters by substring, so a lookup for "install.ts" also returns anything
    // whose path merely CONTAINS it. The comparison inside the helper is what narrows that
    // to the file actually asked for, and without it an approximate match could be spawned
    // in place of the real handoff.
    const ns = homeNs(["/scripts/install.ts.bak", "/features/retire/scripts/install.ts"]);

    assert.equal(
        findScriptOnHome(ns, "install.ts"),
        "/features/retire/scripts/install.ts",
        "an approximate match was returned instead of the exact script",
    );
});

test("basename strips directories and keeps the file", () => {
    // The helper every path comparison in the framework is built on.
    assert.equal(basename("./features/retire/scripts/install.ts"), "install.ts");
    assert.equal(basename("/install.ts"), "install.ts");
    assert.equal(basename("install.ts"), "install.ts");
});
