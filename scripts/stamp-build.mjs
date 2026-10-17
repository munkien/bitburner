// Write the current git commit into a file the game can read.
//
// WHY A FILE. The game cannot run `git`, so the only way a running script can name the
// commit it came from is for the build to leave that answer on disk before syncing.
// `src/game/build.txt` then travels through `bitburner-filesync` like any other file
// (`.txt` is in `allowedFiletypes`).
//
// WHY IT MATTERS. The orchestrator used to print the hardcoded string "nexus.ts v2",
// which cannot distinguish a current copy from a two-day-old one. That is exactly the
// question that cost a session: a run was diagnosed against code that had never been
// synced, and nothing the game printed could have said so.
//
// Failure is not fatal. A tree without git, or a dirty one, still syncs — it just
// reports what it can.

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT = new URL("../src/game/build.txt", import.meta.url);

/** `git rev-parse --short HEAD`, or null when this is not a repo. */
function commit() {
    try {
        return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
        return null;
    }
}

/** Commit date, so two builds can be ordered without knowing the clock. */
function commitDate() {
    try {
        return execSync("git log -1 --format=%cd --date=iso-strict", { encoding: "utf8" }).trim();
    } catch {
        return null;
    }
}

/** Whether tracked files differ from the commit. Reported, not enforced. */
function dirty() {
    try {
        return execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
    } catch {
        return false;
    }
}

const hash = commit();
const line = hash === null
    ? "unknown (not a git repository)"
    : `${hash}${dirty() ? "+dirty" : ""} (${commitDate()})`;

writeFileSync(OUT, `${line}\n`, "utf8");
console.log(`build stamp: ${line}`);
