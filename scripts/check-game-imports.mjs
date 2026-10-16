// Preflight for the in-game scripts in `src/game`.
//
// Bitburner resolves modules itself, per file, and does NOT add a file
// extension for you. Every local import therefore has to name the file it wants
// — `./strategy.ts`, not `./strategy`. An extensionless import typechecks fine
// in TypeScript (which is why this slipped through once), but fails to resolve
// in the game, where the symptom is a script that throws on import and simply
// never runs — no error the player sees, just nothing happening.
//
// This is run before syncing so that class of bug is caught on disk rather than
// in the game. It is deliberately a lint, not a compiler: it checks the one rule
// the compiler does not.
//
// Usage: `node scripts/check-game-imports.mjs`

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = process.cwd();
const gameDir = resolve(root, "src/game");

/** Every `.ts` file under a directory, recursively. */
async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
}

// A local import: starts with `./` or `../`. Anything else (a bare `@ns`, a
// package) is not this rule's business.
const LOCAL_IMPORT = /from\s+["'](\.\.?\/[^"']*)["']/g;

let problems = 0;
for (const file of await walk(gameDir)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(LOCAL_IMPORT)) {
        const spec = match[1];
        // Must name a file: `.ts`, `.tsx`, or `.d.ts` (the last is a type-only
        // declaration and resolves as written).
        if (/\.(ts|tsx)$/.test(spec)) continue;
        const rel = file.slice(root.length + 1);
        console.error(`  ${rel}: import "${spec}" has no file extension`);
        problems += 1;
    }
}

if (problems > 0) {
    console.error(
        `\n${problems} local import(s) in src/game lack a file extension. ` +
        `Bitburner cannot resolve these in-game — add ".ts" (or ".tsx").`
    );
    process.exit(1);
}

console.log("src/game imports: all local imports are extension-explicit");
