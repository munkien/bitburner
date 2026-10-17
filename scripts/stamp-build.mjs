// Write a fingerprint of the source that ships to the game into `build.txt`.
//
// WHY A CONTENT HASH AND NOT A COMMIT HASH. The question the stamp answers is "is the game
// running this code?" — which is not the same as "which commit is this?". Keying it to a
// commit made the answer depend on git bookkeeping that cannot be written inside the thing
// it describes: a pre-commit hook sees only the parent commit, and a post-commit hook that
// amends produces a new hash which invalidates the stamp it just wrote — a loop, measured,
// ~100 iterations before it was stopped.
//
// A hash of the files themselves has neither problem. Two trees with the same source stamp
// identically whatever the commits say; any change to any shipped file changes it. That is
// exactly the equality the reader cares about.
//
// WHAT IS HASHED: the files `filesync.json` actually pushes — its `scriptsFolder`, its
// `allowedFiletypes`, minus its `exclude`. Hashing the whole repo would make the stamp move
// when a README or a test changed, which would be a stamp that answers a question nobody
// asked. Deleted and renamed files are covered by including the path in the digest.
//
// The commit is still reported, as a convenience for the reader rather than as identity.
// It is prefixed `@`, so it is visibly not what the stamp is keyed on.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url);
const OUT = new URL("../src/game/build.txt", import.meta.url);
const CONFIG = new URL("../filesync.json", import.meta.url);

/** The sync's own settings, so the hash covers what the game actually receives. */
function syncSettings() {
    try {
        const c = JSON.parse(readFileSync(CONFIG, "utf8"));
        return {
            folder: c.scriptsFolder ?? ".",
            types: c.allowedFiletypes ?? [".js", ".script", ".txt"],
            exclude: c.exclude ?? [],
        };
    } catch {
        // A missing or unreadable config falls back to the shipped defaults of the sync
        // tool, rather than hashing nothing and reporting a stamp for an empty set.
        return { folder: "src/game", types: [".js", ".ts", ".tsx", ".script", ".json", ".txt"], exclude: [] };
    }
}

/** Every file under `dir` that the sync would push, as sorted relative paths. */
function shippedFiles(dir, types, exclude) {
    const out = [];
    const walk = (current) => {
        let entries;
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }
        for (const name of entries.sort()) {
            // THE STAMP MUST NOT HASH ITSELF. `build.txt` lives in the folder being walked, so
            // including it makes each run digest the previous run's output — a different
            // fingerprint every time, which is the one property this whole approach rests on.
            if (name === "build.txt") continue;
            const full = join(current, name);
            const rel = relative(ROOT.pathname, full);
            // An excluded path anywhere in its ancestry is not shipped, so neither it nor
            // anything below it belongs in the hash.
            if (exclude.some(e => rel === e || rel.startsWith(`${e}/`) || name === e)) continue;
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) walk(full);
            else if (types.some(t => name.endsWith(t))) out.push(rel);
        }
    };
    walk(new URL(dir, ROOT).pathname);
    return out.sort();
}

const { folder, types, exclude } = syncSettings();
const files = shippedFiles(folder, types, exclude);

// The PATH is hashed with the CONTENT, so a rename or a delete changes the digest even
// though the remaining bytes are identical. Hashing contents alone would call a file that
// vanished "unchanged", which is the one case a reader most needs to see.
const digest = createHash("sha256");
for (const file of files) {
    digest.update(file);
    try {
        digest.update(readFileSync(join(ROOT.pathname, file)));
    } catch {
        digest.update("<unreadable>");
    }
}
const fingerprint = digest.digest("hex").slice(0, 12);

/** The commit, for the reader — not what the stamp is keyed on. */
function commit() {
    try {
        return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
        return null;
    }
}

const line = `${fingerprint} (${files.length} files) @${commit() ?? "no-git"}`;
writeFileSync(OUT, `${line}\n`, "utf8");
console.log(`build stamp: ${line}`);
