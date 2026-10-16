import type { NS } from "@ns";

/*
 * Netscript actions that a feature runs as scripts rather than inline, so that
 * the action's RAM is charged to a short-lived worker instead of to the feature
 * that is running for the whole session.
 *
 * These are generated into the game's filesystem with `ns.write` at startup
 * instead of being deployed as project files. The reason is RAM: a feature that
 * imported hack/grow/weaken helpers would pay for their `ns` calls on every
 * tick, while these one-line scripts pay one thread's worth each time they run.
 *
 * The `additionalMsec` argument is how a batch is timed: Bitburner's hack/grow/
 * weaken all accept it, and it lets the caller schedule a landing at an exact
 * millisecond without sleeping.
 * ============================================================================
 */

export const ACTION = {
    hack: "h.js",
    grow: "g.js",
    weaken: "w.js",
} as const;

/**
 * Create the worker scripts if they are missing.
 *
 * `additionalMsec` is passed by name, so the generated source stays a single
 * line and never needs a type import.
 */
export function ensureActionScripts(ns: NS): void {
    write(ns, ACTION.hack, "hack");
    write(ns, ACTION.grow, "grow");
    write(ns, ACTION.weaken, "weaken");
}

function write(ns: NS, file: string, action: "hack" | "grow" | "weaken"): void {
    ns.write(
        file,
        `export async function main(ns) { await ns.${action}(ns.args[0], { additionalMsec: ns.args[1] }); }`,
        "w",
    );
}
