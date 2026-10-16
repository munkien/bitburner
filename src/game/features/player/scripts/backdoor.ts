import type { NS } from "@ns";

/**
 * Walks from home to one server and installs a backdoor on it.
 *
 * Runs as its own script because `installBackdoor` is asynchronous and takes
 * seconds: doing it inside a feature would block every other feature's tick.
 * The feature launches this with the target hostname as the first argument.
 *
 * `ns.singularity.connect` only moves one hop at a time, so the path has to be
 * walked in order.
 *
 * This scans the server graph itself rather than using lib/network.ts, which is
 * deliberate: that module answers "which servers exist", and this needs "which
 * route reaches this one". A breadth-first enumeration throws the route away.
 */
export async function main(ns: NS): Promise<void> {
    const target = ns.args[0];
    if (typeof target !== "string") return;

    const path = pathTo(ns, target);
    if (path === null) return;

    for (const hop of path) ns.singularity.connect(hop);
    await ns.singularity.installBackdoor();
    ns.singularity.connect("home");
}

function pathTo(ns: NS, target: string): string[] | null {
    return search(ns, "home", null, [], target);
}

function search(ns: NS, host: string, parent: string | null, trail: string[], target: string): string[] | null {
    if (host === target) return trail;

    for (const neighbour of ns.scan(host)) {
        if (neighbour === parent) continue;
        const found = search(ns, neighbour, host, [...trail, neighbour], target);
        if (found !== null) return found;
    }

    return null;
}
