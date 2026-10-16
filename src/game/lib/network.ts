import type { NS } from "@ns";

/*
 * ============================================================================
 * SERVER NETWORK
 * ============================================================================
 * One traversal of the server network, and one place that knows how to take
 * root access. Before this existed, the same breadth-first walk was written
 * three times (hacking, share, retire) with three different filters, and the
 * same crack loop lived inside the hacking feature.
 *
 * These are execution helpers: they call `ns` and change nothing about the
 * framework's plans.
 * ============================================================================
 */

/** Explorer programs, in the order they must be tried. */
const PORT_OPENERS: readonly { readonly program: string; readonly open: (ns: NS, host: string) => void }[] = [
    { program: "BruteSSH.exe", open: (ns, host) => { ns.brutessh(host); } },
    { program: "FTPCrack.exe", open: (ns, host) => { ns.ftpcrack(host); } },
    { program: "relaySMTP.exe", open: (ns, host) => { ns.relaysmtp(host); } },
    { program: "HTTPWorm.exe", open: (ns, host) => { ns.httpworm(host); } },
    { program: "SQLInject.exe", open: (ns, host) => { ns.sqlinject(host); } },
];

/** The six cities plus the starting zone, which is not a city and has no travel. */
export const HOME = "home";

/**
 * Hostnames of the player's Hacknet Servers.
 *
 * A Hacknet Server appears in the scan graph like any other host, but it is not a
 * host to run tasks on: it exists to generate hashes, and treating it as a generic
 * server wastes the RAM that produces those hashes. The only authoritative way to
 * list them is the hacknet API — they have a hash capacity, where a plain Hacknet
 * Node (which is not a server at all) does not — so the names are collected from
 * there rather than guessed from a hostname prefix.
 */
export function hacknetServerNames(ns: NS): Set<string> {
    const names = new Set<string>();
    try {
        const count = ns.hacknet.numNodes();
        for (let i = 0; i < count; i++) {
            const stats = ns.hacknet.getNodeStats(i);
            if (stats.hashCapacity !== undefined) names.add(stats.name);
        }
    } catch {
        // Hacknet API unavailable (or refused in this BitNode). No servers to skip.
    }
    return names;
}

/**
 * Every server reachable from home, home included. Servers that are part of a
 * distinct flavour of the game (Hacknet servers, cloud servers) are still
 * servers, so callers filter by what they need.
 */
export function scanNetwork(ns: NS): string[] {
    const visited = new Set<string>([HOME]);
    const queue: string[] = [HOME];

    while (queue.length > 0) {
        for (const neighbour of ns.scan(queue.shift() as string)) {
            if (visited.has(neighbour)) continue;
            visited.add(neighbour);
            queue.push(neighbour);
        }
    }

    return [...visited];
}

function explorerPrograms(ns: NS): typeof PORT_OPENERS {
    return PORT_OPENERS.filter(({ program }) => ns.fileExists(program, HOME));
}

/**
 * Remote servers the framework has root on. Home is excluded, and so are Hacknet
 * Servers: they are reserved for hash generation and must not run tasks.
 *
 * Use this when the question is "which other machines can I reach". For "where
 * can I run workers", use `workerHosts`: home is a host like any other and has
 * the most RAM, so a list that quietly leaves it out loses most of the pool.
 */
export function rootedHosts(ns: NS): string[] {
    const notHosts = hacknetServerNames(ns);
    return scanNetwork(ns).filter(host =>
        host !== HOME && !notHosts.has(host) && ns.hasRootAccess(host),
    );
}

/**
 * Every host that can run worker scripts, home included.
 *
 * This exists because `crackReachable` skips home -- you do not nuke your own
 * machine -- and using its result as the host list silently dropped home from the
 * pool. The hacking feature deployed no threads there for several commits, and
 * the symptom was confusing: "plenty of RAM free" alongside "nothing running on
 * home", because the host was never considered rather than considered and
 * rejected.
 *
 * Home is included on the strength of being home, not on having root: it always
 * has root. Hacknet Servers are excluded: they exist to generate hashes, and
 * running workers on them spends the RAM that hash rate depends on.
 */
export function workerHosts(ns: NS): string[] {
    const notHosts = hacknetServerNames(ns);
    return scanNetwork(ns).filter(host =>
        (host === HOME || ns.hasRootAccess(host)) && !notHosts.has(host) && ns.getServerMaxRam(host) > 0,
    );
}

/**
 * Take root on every server the player's explorer programs allow, then report
 * which REMOTE servers now have root. Home is never included: it needs no
 * cracking, and a caller wanting somewhere to run scripts wants `workerHosts`.
 *
 * Runs the whole network because a new program or
 * a higher hacking level can open servers that were out of reach last time.
 */
export function crackReachable(ns: NS): string[] {
    const available = explorerPrograms(ns);
    const rooted: string[] = [];

    for (const host of scanNetwork(ns)) {
        if (host === HOME) continue;

        if (ns.hasRootAccess(host)) {
            rooted.push(host);
            continue;
        }
        if (available.length < ns.getServerNumPortsRequired(host)) continue;

        for (const { open } of available) open(ns, host);
        try {
            ns.nuke(host);
        } catch {
            // Some servers refuse nuke until a later hacking level.
            continue;
        }
        if (ns.hasRootAccess(host)) rooted.push(host);
    }

    return rooted;
}

/**
 * Copy a worker script to every host that does not have it yet, and return the
 * hosts that now have root but not the script.
 */
export function syncScript(ns: NS, file: string, hosts: readonly string[]): void {
    for (const host of hosts) {
        if (ns.fileExists(file, host)) continue;
        ns.scp(file, host, HOME);
    }
}
