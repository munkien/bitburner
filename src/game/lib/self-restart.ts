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

/**
 * How long a change must stay unchanged before it is acted on.
 *
 * WAS ONE SECOND, and that is too short for the thing it is actually testing. The point of
 * the debounce is to wait out `bitburner-filesync`, which rewrites a file several times
 * during one save — and a single edit to a shared module can touch a dozen files as the
 * syncer works through them. At one second the watcher could fire between two of those
 * writes, restart into a half-updated tree, and do it again on the next pass: the observed
 * symptom was the feature roster printing twice in one second.
 *
 * Sixty seconds is also the interval the operator asked for, and the two concerns agree —
 * a minute is comfortably longer than a sync takes and short enough that an edit shows up
 * while the edit is still in mind.
 *
 * NOT TO BE CONFUSED WITH `SPAWN_DELAY_MS`, which was the same constant until this change.
 * They answer different questions and a minute is right for only one of them.
 */
export const RESTART_DELAY_MS = 60_000;

/**
 * How long the game waits before starting the replacement copy.
 *
 * SEPARATE FROM THE DEBOUNCE, and the reason is that they were one constant. `spawnDelay`
 * is how long the script is DEAD before it reboots, so a minute there would leave the
 * orchestrator stopped for a minute after every restart — features unloaded, telemetry
 * dark, the dashboard showing a stale frame. The debounce decides WHEN to restart; this
 * decides how long the gap is, and a few seconds is the right answer to the second question
 * regardless of what the first is set to.
 *
 * Short because the work it covers is done: by the time the debounce has fired, file sync
 * has been quiet for `RESTART_DELAY_MS` and there is nothing left to wait for.
 */
export const SPAWN_DELAY_MS = 2_000;

/**
 * How many directories the tree walk may visit before it gives up.
 *
 * The framework is ~60 files in ~10 directories. This is far above that, and low enough
 * that a home which has accumulated a very large number of paths cannot stall the walk.
 * Exceeding it is REPORTED, not silent: a watcher covering part of the tree must say so,
 * because its failure mode is indistinguishable from "nothing changed".
 */
const MAX_DIRECTORIES = 500;

/**
 * The clock the debounce reads, held at module scope so a test can step it.
 *
 * `Date.now` in production. `advanceWatcherClockForTest` swaps it for a fake, which is
 * why it cannot be a local inside `createChangeWatcher`: the test must reach the same
 * binding the closure reads.
 */
let now: () => number = Date.now;

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
    // NO RESCAN FOR NEW FILES, DELIBERATELY — and this reverses a change made earlier
    // today.
    //
    // A new file IS a change the boot walk cannot see, and re-walking each pass caught
    // it. But it made the check UNSTABLE: `boot` is built from one walk, the rescan does
    // another, and nothing guarantees the two enumerate the same set. Once the walk is
    // bounded by `MAX_DIRECTORIES` and `ns.ls` ordering is not guaranteed, each pass can
    // reach a different subset — so files missing from `boot` look NEW on every check,
    // and nexus respawns itself in a loop. Measured: the full feature roster printed
    // twice in the same second, forever.
    //
    // Trading a rare miss (a brand-new file does not trigger a reload until the next
    // restart) for an infinite loop is the right way round. The restart that a new file
    // would have wanted is one `run /nexus.ts` away; a loop cannot be broken by the user.
    //
    // The `boot` map itself is only used when every key was readable, so a truncated walk
    // makes the watcher under-cover rather than misfire — and `MAX_DIRECTORIES` announces
    // when it truncates.
    let fired = false;
    /** When the current change was first seen, until it either fires or is cleared. */
    let changeSeenAt: number | null = null;
    /** Which file that was, so a different change restarts the clock. */
    let lastChanged: string | null = null;

    // SAY WHAT IS BEING WATCHED, at startup. Coverage was previously invisible: the
    // watcher could be covering the wrong tree, or a truncated one, and the only symptom
    // was "nothing reloaded", which reads the same as "nothing changed". One line here
    // turns that into something that can be checked rather than inferred.
    ns.tprint(`INFO: watching ${boot.size} file(s) for changes under ${self.filename}`);

    return {
        enabled: () => true,
        check: () => {
            // One restart per process: the whole point is that the new copy takes
            // over, and a second spawn from a dying script would start a duplicate.
            if (fired) return false;

            const changed = firstChanged(ns, boot);
            // Nothing changed. A file that vanished reads as -1, which is not a
            // change — spawning into a missing file would fail.
            if (changed === null) {
                changeSeenAt = null;
                return false;
            }

            // DEBOUNCE, because file sync rewrites files REPEATEDLY, not once.
            //
            // `boot` snapshots mtimes at construction. `bitburner-filesync` then keeps
            // writing for as long as it runs, so `firstChanged` reports a change on every
            // pass while a sync is in flight — and each `fired` guard is per-process, so
            // it cannot stop the NEXT process from respawning in the same way. Measured:
            // nexus booted and died repeatedly, mid-pass, with the exit trap recording
            // "unknown (never wrote the exit reason this pass)" because the death was a
            // spawn, not a crash.
            //
            // The rule: a change must be STABLE for a grace period before it is acted on.
            // The first sighting records the clock; only when the same file has kept its
            // new mtime for `RESTART_DELAY_MS` is it a genuine edit rather than a half-
            // written sync. A later change resets the clock, so a stream of writes never
            // triggers a restart at all.
            const nowMs = now();
            if (changeSeenAt === null || lastChanged !== changed) {
                changeSeenAt = nowMs;
                lastChanged = changed;
                return false;
            }
            if (nowMs - changeSeenAt < RESTART_DELAY_MS) return false;

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
                { threads: self.threads, spawnDelay: SPAWN_DELAY_MS },
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
 * Bounded by a VISITED SET rather than a file count.
 *
 * This was `MAX_WATCHED = 400`, justified as "a runaway enumeration would cost more than
 * a missed file". That was wrong on both counts. It capped the wrong dimension: the walk
 * has already paid for `ns.ls` on a directory by the time it decides whether to collect
 * its files, so the cap saved almost no work. And it failed SILENTLY — a home holding
 * more than 400 paths would stop collecting partway, leaving feature files unwatched
 * while the watcher believed it covered the tree, which reads as "nothing changed".
 *
 * The real hazard is revisiting a directory, and there was no guard against it: if
 * `ns.ls` ever returned a path leading back to one already walked, the queue would grow
 * without bound. A visited set removes that possibility outright and cannot under-cover,
 * because it limits repeats rather than coverage.
 *
 * Best-effort: an unreadable directory contributes nothing rather than throwing,
 * because a watcher that cannot enumerate everything should still watch what it
 * can.
 */
function discoverTree(ns: NS, entry: string): string[] {
    const root = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "";
    const files: string[] = [];
    /** Directories already walked. A set, so a repeated path cannot loop the walk. */
    const visited = new Set<string>();
    // `ns.ls` reports ABSOLUTE paths (see `lib/scripts.ts`), so the walk tracks
    // absolute directories and normalises what it reads — a bare name pushed onto
    // the queue would be looked up as if it were a root directory and silently
    // yield nothing, which is exactly how the first version of this missed every
    // feature file.
    const queue: string[] = [root === "" ? "/" : root];

    // A DIRECTORY BUDGET, capping the WALK rather than the collection.
    //
    // A visited set stops a directory being walked twice, but not a HOME THAT IS SIMPLY
    // LARGE: darknet servers, contract files and deployed scripts all live on home, so the
    // walk visits every directory it finds. Removing the old file cap left this unbounded,
    // and nexus stopped at boot inside this function — before its own "watching N files"
    // line printed, which is how it was identified: everything after `announceRoster`
    // vanished from the log while the features had already loaded.
    //
    // The old `MAX_WATCHED = 400` capped FILES, which saved no work because `ns.ls` had
    // already run for the directory. This caps the number of `ns.ls` calls, which is the
    // actual cost, and it is reported rather than silent.
    let budgetExceeded = false;

    while (queue.length > 0) {
        if (visited.size >= MAX_DIRECTORIES) {
            budgetExceeded = true;
            break;
        }

        const dir = queue.shift()!;
        if (visited.has(dir)) continue;
        visited.add(dir);

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

    // A PARTIAL COVERAGE IS SAID OUT LOUD. The alternative is a watcher that reloads on
    // some edits and not others, which reads exactly like "that edit did nothing".
    if (budgetExceeded) {
        ns.tprint(
            `WARN: file watcher stopped after ${visited.size} directories — ` +
            `only ${files.length} file(s) are being watched; restart manually after edits`,
        );
    }

    // The entry first, so a change to it is reported ahead of a helper's.
    return files.includes(entry) ? [entry, ...files.filter(f => f !== entry)] : files;
}

/** The last path segment. */
function basenameOf(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
}

/**
 * Step the watcher's clock forward by a fixed amount, for tests.
 *
 * The debounce is real-time, but a test must not wait a second between checks. This
 * replaces the clock with a fake that advances `ms` on every read, so `RESTART_DELAY_MS`
 * can be crossed in two calls. Production never calls it.
 */
export function advanceWatcherClockForTest(ms: number): void {
    // Returns a larger value on every read, so the debounce's grace period can be crossed
    // by calling check() twice. Production never calls this.
    let cursor = now();
    now = () => (cursor += ms);
}
