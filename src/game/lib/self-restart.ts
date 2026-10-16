import type { NS } from "@ns";

/*
 * ============================================================================
 * SELF-RESTART ON CHANGE
 * ============================================================================
 * Reload this script when its own file changes on disk.
 *
 * THE PROBLEM THIS SOLVES. File Sync pushes a changed `.ts` file into the game,
 * but a RUNNING script keeps executing the copy it started with — nothing
 * re-reads the file. So an edit silently has no effect until the script is
 * manually stopped and started again, and the symptom is indistinguishable from
 * a bug in the new code. That has cost three separate debugging sessions in this
 * framework already: a missing `.ts` extension, a silent telemetry loop, and an
 * empty message stream. It is a deployment trap, not a code defect, which is why
 * it kept recurring.
 *
 * THE MECHANISM. `ns.getFileMetadata` costs 0 GB and returns `mtime`, so
 * detecting a change is free. `ns.spawn` terminates the current script and
 * re-executes it — its documented purpose is "execute a new script without being
 * constrained by the RAM usage of the current one", which is exactly a clean
 * reload with no external supervisor.
 *
 * THE COST, stated plainly. A restart loses in-memory state: the loaded feature
 * modules, the recent-lines ring, the operator nudge last applied, and any partial
 * plan a feature held. The framework recovers all of it from the game on the next
 * pass, which is why this is acceptable — but it is a real cost, and it is why the
 * restart is driven by an ACTUAL change rather than a timer.
 * ============================================================================
 */

/** How long to let file sync finish writing before booting the new copy. */
const RESTART_DELAY_MS = 1_000;

/**
 * The most files to watch.
 *
 * A bound rather than no limit: the walk runs once at boot and a runaway
 * enumeration would cost more than a missed file. The tree is around 60 files,
 * so this is comfortably above it.
 */
const MAX_WATCHED = 400;

/**
 * Watches this script's own file for changes.
 *
 * Constructed once at boot. If the fingerprint cannot be read the watcher is
 * DISABLED rather than approximated: restarting into an unknown file state is
 * worse than not restarting at all.
 */
export interface ChangeWatcher {
    /**
     * Restart the script if its file has changed since boot.
     *
     * Returns true when a restart was initiated. The caller does not need to act
     * on that — `spawn` terminates this script — but it is returned so the
     * decision is testable rather than only observable in the game.
     */
    check(): boolean;
    /** Whether the watcher has a usable fingerprint. False disables the check. */
    enabled(): boolean;
}

export function createChangeWatcher(ns: NS): ChangeWatcher {
    const self = readSelf(ns);
    if (self === null) return DISABLED;

    // WATCH THE WHOLE TREE, not just this script's own file.
    //
    // Watching only `nexus.ts` meant an edit to a feature — the common case, and
    // where most of the logic lives — did not reload anything. That limitation was
    // known when this was written and it became the blocker during a deadlock fix:
    // `activity.ts` and `player.ts` changed, no reload fired, and the game kept
    // running the old code while the console showed no evidence of why.
    //
    // The tree is discovered rather than hardcoded, so a new feature is covered
    // when it is added rather than when someone remembers to list it.
    const watched = discoverTree(ns, self.filename);
    const boot = new Map<string, number>();
    for (const file of watched) {
        const mtime = readMtime(ns, file);
        boot.set(file, mtime ?? -1);
    }
    // No fingerprint for our own file, no check. A file that cannot be read once
    // is not a file to restart on the strength of a later read succeeding.
    if ((boot.get(self.filename) ?? -1) < 0) return DISABLED;

    // A NEW FILE IS A CHANGE, and it is the case the boot walk alone cannot see.
    //
    // `boot` is built once, from the tree as it stood at boot. A file added afterwards
    // — a new feature, a new `lib/` module — is pushed by file sync and then never
    // watched, because it is not a key in `boot` and `firstChanged` iterates that map.
    // So the file arrives and NOTHING RELOADS, which is precisely the "an edit silently
    // has no effect" trap this module exists to remove, reappearing for new files.
    //
    // The rescan is affordable. `ns.ls` is already called at boot for the same walk, so
    // its 0.2 GB is a STATIC cost this script pays whether or not the rescan happens;
    // `getFileMetadata` is free. The tree is ~55 files and this runs once a second.
    const scanForNew = (): string | null => {
        for (const file of discoverTree(ns, self.filename)) {
            if (boot.has(file)) continue;
            // Not merely present but readable: a file mid-write has no usable mtime,
            // and spawning into a half-synced script is worse than waiting a second.
            if (readMtime(ns, file) === null) continue;
            return file;
        }
        return null;
    };

    let fired = false;

    return {
        enabled: () => true,
        check: () => {
            // One restart per process: the whole point is that the new copy takes
            // over, and a second spawn from a dying script would start a duplicate.
            if (fired) return false;

            // Modified files first, so an edit to existing code is reported ahead of a
            // new file that arrived in the same sync — the edit is what the reader is
            // usually looking for.
            const changed = firstChanged(ns, boot) ?? scanForNew();
            // Nothing changed. A file that vanished reads as -1, which is not a
            // change — spawning into a missing file would fail.
            if (changed === null) return false;

            fired = true;

            // Announced BEFORE spawning, because `spawn` terminates this script:
            // anything after the call may never run. The line reaches the log panel
            // and the console stream, so the restart is visible rather than
            // mysterious — and it names WHICH file changed, which is the thing that
            // was missing when a reload silently did not happen.
            ns.print(`[nexus] reloading: ${changed} changed on disk`);
            ns.tprint(`INFO: ${changed} changed on disk — restarting to load the new code`);

            ns.spawn(
                self.filename,
                { threads: self.threads, spawnDelay: RESTART_DELAY_MS },
                ...self.args,
            );
            return true;
        },
    };
}

/** The watcher used when no usable fingerprint exists: it never restarts. */
const DISABLED: ChangeWatcher = {
    enabled: () => false,
    check: () => false,
};

/** This script's path, thread count and arguments, or null when unavailable. */
function readSelf(ns: NS): { filename: string; threads: number; args: ScriptArg[] } | null {
    try {
        const self = ns.self();
        if (typeof self.filename !== "string" || self.filename === "") return null;
        return {
            filename: self.filename,
            // Preserve the running configuration: a restart must not silently
            // downgrade a multi-thread orchestrator to one thread.
            threads: self.threads > 0 ? self.threads : 1,
            args: self.args,
        };
    } catch {
        // Not a script context, or the API is unavailable. Nothing to watch.
        return null;
    }
}

/** A file's modification time, or null when it cannot be read. */
function readMtime(ns: NS, filename: string): number | null {
    try {
        const meta = ns.getFileMetadata(filename);
        return typeof meta?.mtime === "number" ? meta.mtime : null;
    } catch {
        return null;
    }
}

/**
 * Which watched file changed first, or null when none did.
 *
 * Ordered by the map, which `discoverTree` builds from our own file outward, so
 * the report names the most meaningful file rather than whichever the game
 * happened to list first.
 */
function firstChanged(ns: NS, boot: ReadonlyMap<string, number>): string | null {
    for (const [file, was] of boot) {
        const now = readMtime(ns, file);
        // Unreadable is not changed: a vanished file is not something to spawn
        // into, and a transient read failure would otherwise restart the run.
        if (now === null) continue;
        if (now !== was) return file;
    }
    return null;
}

/**
 * Every `.ts` file under the orchestrator's root.
 *
 * The deployment places the tree at the same root as the entry script, so the
 * entry's directory is the tree's root and a recursive walk covers
 * `features/hacking/...`, `lib/...` and the rest. Discovered rather than listed
 * so a new feature is watched when it lands, not when someone remembers to add
 * it here.
 *
 * Bounded by `MAX_WATCHED`: this runs once at boot and a runaway walk would
 * matter more than a missing file.
 *
 * Best-effort: an unreadable directory contributes nothing rather than throwing,
 * because a watcher that cannot enumerate everything should still watch what it
 * can.
 */
function discoverTree(ns: NS, entry: string): string[] {
    const root = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "";
    const files: string[] = [];
    // `ns.ls` reports ABSOLUTE paths (see `lib/scripts.ts`), so the walk tracks
    // absolute directories and normalises what it reads — a bare name pushed onto
    // the queue would be looked up as if it were a root directory and silently
    // yield nothing, which is exactly how the first version of this missed every
    // feature file.
    const queue: string[] = [root === "" ? "/" : root];

    while (queue.length > 0 && files.length < MAX_WATCHED) {
        const dir = queue.shift()!;

        let entries: string[];
        try {
            entries = ns.ls("home", dir) as string[];
        } catch {
            continue;
        }

        for (const raw of entries) {
            const path = raw.startsWith("/") ? raw : `/${raw}`;
            if (path.startsWith(root === "" ? "/" : `${root}/`) === false && path !== entry) continue;
            if (path.endsWith(".d.ts")) continue;
            if (path.endsWith(".ts")) {
                files.push(path);
            } else if (!basenameOf(path).includes(".")) {
                // No extension in the last segment: a directory. Descend, since
                // `ns.ls` is not recursive and features live several levels down.
                queue.push(path);
            }
        }
    }

    // The entry first, so a change to it is reported ahead of a helper's.
    return files.includes(entry) ? [entry, ...files.filter(f => f !== entry)] : files;
}

/** The last path segment. */
function basenameOf(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
}
