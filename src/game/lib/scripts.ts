import type { NS } from "@ns";

/*
 * ============================================================================
 * SCRIPT LOOKUP
 * ============================================================================
 * One place that knows how to find a script on home by name.
 *
 * This exists because of a fact about deployment, not about the framework: the
 * game's file sync can place a project at the root or under a subdirectory, so a
 * script that needs to start another one cannot hard-code a path. Every writer
 * and reader of script paths goes through here so there is one answer.
 * ============================================================================
 */

/**
 * Absolute path of a script on home, found by basename, or `null` when it is
 * not deployed.
 *
 * Matching on the basename rather than a fixed path is what makes this work at
 * either deployment layout. The first match wins, which is fine because the
 * registry keeps script basenames unique.
 */
export function findScriptOnHome(ns: NS, basename: string): string | null {
    const found = ns.ls("home", basename).find(path => path.split("/").pop() === basename);
    if (found === undefined) return null;
    return found.startsWith("/") ? found : `/${found}`;
}

/**
 * The filename part of a path.
 *
 * A registry path is written relative to the orchestrator (`./gang.ts`) while
 * `ns.ls` reports absolute paths (`/gang.ts`), so anything matching one against
 * the other needs this. It lives here rather than in each caller because two
 * callers have already needed it.
 */
export function basename(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
}
