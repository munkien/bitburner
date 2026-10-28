/*
 * ============================================================================
 * THE INSTALLER'S OWN DEFECT
 * ============================================================================
 * `install.ts` is the half of retirement that stops everything and calls
 * `installAugmentations`. It is a standalone script, so it has no feature wrapper and no
 * fault isolation: if it does the wrong thing here, the run ends with its augmentations
 * uninstalled and nothing running.
 *
 * This file exists for one line. `ns.killall("home")` was called WITHOUT a safety guard,
 * and the game's documentation says that form does not skip the calling script — so the
 * installer killed itself and could never reach the install. The evidence is in `runs/`:
 * no recording has ever logged "Installing augmentations", including the one spawn that
 * reported success.
 *
 * The comment above that call claimed "`killall` spares this script". It was wrong, and
 * being wrong cost every run since the feature was written. A test is the only thing that
 * keeps a comment like that honest.
 * ============================================================================
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { NS } from "@ns";

import { main } from "./scripts/install.ts";

/** A queue of `n` augmentations, as the two game lists would report it. */
function queued(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `Aug${i}`);
}

/**
 * An `ns` recording every destructive call, in order.
 *
 * `kills` is the point: the assertions are about WHICH host was killed and WHETHER the
 * caller was spared, so a fixture that only counted calls could not tell the two apart.
 */
function fixture(opts: { installed?: number; total?: number; orchestrator?: boolean } = {}) {
    const orchestrator = opts.orchestrator ?? true;
    const installed = queued(opts.installed ?? 0);
    const all = queued(opts.total ?? 3);
    const kills: { host: string; guard: boolean | undefined }[] = [];
    const installed_ = { called: false, callback: "" as string };
    const announcements: string[] = [];

    const ns = {
        // `findScriptOnHome` resolves by basename through `ns.ls`.
        ls: (_host: string, substring: string) => {
            if (substring === "install.ts") return ["/features/retire/scripts/install.ts"];
            if (substring === "nexus.ts") return orchestrator ? ["/nexus.ts"] : [];
            return [];
        },
        getFileMetadata: () => ({}),
        // `scanNetwork` (lib/network.ts) walks the reachable map breadth-first from home,
        // so the fixture answers as the game does: home's neighbours, and nothing from the
        // leaves. The walk is what orders the teardown, so it has to be real.
        scan: (host: string) => (host === "home" ? ["n00dles", "joesguns"] : []),
        // THE LINE UNDER TEST. `guard` is `undefined` when the caller omitted it, which is
        // the defect: the game then does NOT skip the calling script.
        killall: (host: string, guard?: boolean) => {
            kills.push({ host, guard });
            return true;
        },
        singularity: {
            getOwnedAugmentations: (includeQueued: boolean) => (includeQueued ? all : installed),
            installAugmentations: (callback: string) => {
                installed_.called = true;
                installed_.callback = callback;
            },
        },
        ui: { openTail: () => {} },
        sleep: async () => {},
        announce: () => {},
        tprint: (line: string) => { announcements.push(line); },
        print: (line: string) => { announcements.push(line); },
        toast: () => {},
        writePort: () => true,
        tryWritePort: () => true,
        format: { number: (n: number) => String(n), ram: (n: number) => String(n) },
    } as unknown as NS;

    return { ns, kills, installed: installed_, announcements };
}

test("the home killall spares the installer itself", () => {
    // THE DEFECT. Without `safetyGuard: true` this kills the script that is about to call
    // `installAugmentations`, so the sequence silently ends one line short of the install.
    //
    // Asserted on the guard VALUE rather than on "a killall happened", because the bug was
    // a killall that happened and did too much.
    const f = fixture({ installed: 0, total: 3 });

    return main(f.ns).then(() => {
        const home = f.kills.filter(k => k.host === "home");
        assert.equal(home.length, 1, `home was killed ${home.length} times: ${JSON.stringify(f.kills)}`);
        assert.equal(
            home[0].guard,
            true,
            `home was killed without a safety guard, so the installer killed itself: ${JSON.stringify(home[0])}`,
        );
    });
});

test("the install is actually reached, after the teardown", () => {
    // The end-to-end assertion the bug made impossible. A run in `runs/` has never logged
    // "Installing augmentations", because the script died before this call.
    const f = fixture({ installed: 0, total: 3 });

    return main(f.ns).then(() => {
        assert.ok(f.installed.called, "installAugmentations was never called");
        assert.equal(f.installed.callback, "/nexus.ts", `the restart callback was ${f.installed.callback}`);
    });
});

test("remote hosts are killed before home, so none can interfere", () => {
    // Ordering is load-bearing: a worker on a remote host could spend the RAM or interfere
    // with the install if it were still running. Home is last because killing it is what
    // clears the orchestrator.
    const f = fixture({ installed: 0, total: 3 });

    return main(f.ns).then(() => {
        const hosts = f.kills.map(k => k.host);
        assert.deepEqual(
            hosts,
            ["n00dles", "joesguns", "home"],
            `the teardown order was ${JSON.stringify(hosts)}`,
        );
    });
});

test("an empty queue refuses before tearing anything down", () => {
    // Installing with nothing queued resets the game for no gain. The refusal must come
    // BEFORE the killall, or the run is stopped for nothing.
    const f = fixture({ installed: 3, total: 3 });

    return main(f.ns).then(() => {
        assert.deepEqual(f.kills, [], `scripts were killed for an empty queue: ${JSON.stringify(f.kills)}`);
        assert.ok(!f.installed.called, "the game was reset with an empty queue");
    });
});

test("a missing orchestrator refuses before tearing anything down", () => {
    // Without the restart callback the reset would leave the player with no framework and
    // nothing running, which is unrecoverable without noticing.
    const f = fixture({ installed: 0, total: 3, orchestrator: false });

    return main(f.ns).then(() => {
        assert.deepEqual(f.kills, [], `scripts were killed with no orchestrator deployed: ${JSON.stringify(f.kills)}`);
        assert.ok(!f.installed.called, "the game was reset with nothing to restart");
    });
});
