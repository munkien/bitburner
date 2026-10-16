import type { DarknetServerDetails } from "@ns";

/*
 * ============================================================================
 * DARK NET MAP
 * ============================================================================
 * The traversal decisions, as pure functions of plain data.
 *
 * Why this exists. The Dark Net cannot be scanned: `dnet.probe()` reports only the
 * servers directly connected to the script's current server, so the map is built
 * one authenticated hop at a time. That makes the walk a graph problem with three
 * questions worth testing without a game:
 *
 *   frontier   what is worth opening next, given the player's charisma
 *   route      what session chain gets there from home
 *   reconcile  what survives a MUTATION, which is the hard one
 *
 * Nothing here reads or writes game state, so every decision in `darknet.ts` that
 * is more interesting than "call the API" is testable directly. It is the same
 * split as `plan.ts` against `target-facts.ts` and `gang-decisions.ts` against
 * `gang.ts`.
 *
 * The one fact that shapes everything below: a ROUTE is a chain, so a node is only
 * reachable while every node on its chain is still present and online. Servers go
 * offline permanently, so reachability is not a property of a node — it is a
 * property of the path to it.
 * ============================================================================
 */

/** One Dark Net server, as the framework understands it. */
export interface DarknetNode {
    /** Hostname or IP, as `probe` reports it. The key of the map. */
    readonly host: string;
    /** The server immediately towards home that this was reached from. */
    readonly via: string | null;
    readonly depth: number;
    /** `details.modelId`. Similar models share vulnerabilities. */
    readonly modelId: string;
    /** Charisma needed to `authenticate` without an unacceptable delay. */
    readonly requiredCharisma: number;
    readonly passwordLength: number;
    readonly passwordFormat: DarknetServerDetails["passwordFormat"];
    readonly passwordHint: string;
    /** Fixed servers do not move; they are the ones worth building a route through. */
    readonly stationary: boolean;
    /** False once the server has gone offline. */
    readonly online: boolean;
    /** Whether the framework currently holds a session. Expires with the script. */
    readonly session: boolean;
}

/** The map, keyed by host. */
export type DarknetMap = ReadonlyMap<string, DarknetNode>;

/** Where the walk starts: the darkweb host home can always see. */
export const ENTRY = "darkweb";

/** Everything needed to ask for one server's details, extracted from the game object. */
export function nodeFrom(
    host: string,
    via: string | null,
    details: DarknetServerDetails & { isOnline: boolean },
    session: boolean,
): DarknetNode {
    return {
        host,
        via,
        depth: details.depth,
        modelId: details.modelId,
        requiredCharisma: details.requiredCharismaSkill,
        passwordLength: details.passwordLength,
        passwordFormat: details.passwordFormat,
        passwordHint: details.passwordHint,
        stationary: details.isStationary,
        online: details.isOnline,
        session,
    };
}

/**
 * The chain of hosts from the entry to `host`, outermost first, or null when there
 * is no unbroken path.
 *
 * A route is not "the list of servers at decreasing depth": it is the actual parent
 * chain, because `authenticate` requires a DIRECT connection and `probe` only
 * reveals direct connections. A node whose parent has gone offline is unreachable
 * however healthy the node itself looks, which is the bug this function exists to
 * make unrepresentable — `via` is the only thing consulted, never depth.
 */
export function route(map: DarknetMap, host: string): string[] | null {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = host;

    while (cursor !== null) {
        // A cycle would mean the map was built from contradictory readings. Fail
        // rather than loop: a mutation mid-walk is exactly when that can happen.
        if (seen.has(cursor)) return null;
        seen.add(cursor);

        const node: DarknetNode | undefined = map.get(cursor);
        if (node === undefined || !node.online) return null;

        chain.push(cursor);

        // A node with no parent means the chain has ended somewhere other than the
        // entry, which is an ORPHAN rather than a root: the walk discovered it, so
        // something led there, and that something is now gone. Returning the partial
        // chain would report it as reachable from home.
        if (node.via === null && cursor !== ENTRY) return null;

        cursor = node.via;
    }

    return chain.reverse();
}

/**
 * Whether the framework can reach `host` from home right now.
 *
 * Reachability is `route` returning something, so this is the same question asked
 * of one node. It is separate only because it reads better at call sites than
 * `route(...) !== null`.
 */
export function reachable(map: DarknetMap, host: string): boolean {
    return route(map, host) !== null;
}

/**
 * What is worth opening next, best first.
 *
 * Two filters, and the order between them is the point:
 *
 *   - Nodes the player's charisma cannot open are excluded, not sorted last. An
 *     unopenable node is not slow progress, it is no progress, and leaving it in
 *     the list makes the walk appear stalled on a node it will never crack.
 *   - Reachable nodes come before unreachable ones. A node whose route is severed
 *     is still discoverable, and remembering it is useful, but walking towards it
 *     wastes the tick.
 *
 * Shallowest-first within each group, because depth is the progress measure and
 * every deeper node is only reachable THROUGH its parent. Among equals, stationary
 * servers win: they do not move, so a route through one survives more mutations
 * than a route through a server that might wander off.
 */
/**
 * How much slower this host is to authenticate than one at or below the player's charisma.
 *
 * The reciprocal of the ratio `charismaPenalty` reports, and defined here rather than
 * imported from the password module so the map does not depend on the walk's decision
 * layer. 1 means no penalty.
 */
function slowness(requiredCharisma: number, charisma: number): number {
    if (requiredCharisma <= 0) return 1;
    if (charisma <= 0) return requiredCharisma;
    return Math.max(1, requiredCharisma / charisma);
}

export function frontier(map: DarknetMap, charisma: number, limit = 1): DarknetNode[] {
    return [...map.values()]
        // The GATEWAY is never a target, and this is the exclusion that mattered most.
        //
        // `ENTRY` (`darkweb`) is where home is already connected — it is the door, not a
        // room. The game reports it as `depth: -1` with `passwordLength: 0`, and
        // `getDepth` documents -1 as "offline, not found, or not a darkweb server". Its
        // docs put the darknet itself at "depth 0", immediately BELOW darkweb.
        //
        // Treating it as a target deadlocked the walk with no error at all: the frontier
        // offered darkweb, `candidatesFor` returned an empty list (there is no password to
        // guess), `tryAuthenticate` looped over nothing and reported failure, so no session
        // was ever held, so no worker was ever deployed, so nothing was ever discovered —
        // and the next tick did exactly the same thing. Forever.
        //
        // A session on it is not merely unavailable; it is meaningless. Excluding it here
        // is what lets the walk start where the darknet actually begins.
        .filter((node: DarknetNode) => node.host !== ENTRY)
        .filter((node: DarknetNode) => node.online && !node.session)
        // Charisma is NOT a filter, and this line was the fourth place the same
        // misunderstanding appeared.
        //
        // The game is explicit: "the charisma level on a server is not a requirement for
        // authentication, but authentication takes longer if the player's charisma is
        // below the server's charisma level." Excluding such hosts meant the walk would
        // not even ATTEMPT them — so a player below a server's threshold had it silently
        // skipped forever, which is exactly the "nothing happens" this feature kept
        // producing. `worthAttempting` was already fixed for this; the frontier filter
        // that runs before it was not.
        //
        // Slow is a reason to try anyway. `frontier` still receives `charisma` so callers
        // can weigh the penalty when choosing, but it must not use it to hide a host.
        .map((node: DarknetNode) => ({ node, chain: route(map, node.host), penalty: slowness(node.requiredCharisma, charisma) }))
        .sort((a, b) => {
            const aReachable = a.chain === null ? 1 : 0;
            const bReachable = b.chain === null ? 1 : 0;
            if (aReachable !== bReachable) return aReachable - bReachable;
            if (a.node.depth !== b.node.depth) return a.node.depth - b.node.depth;
            // A host we are far below costs more time to open, so at equal depth the
            // cheaper one goes first. It is still offered — this only decides the order.
            if (a.penalty !== b.penalty) return a.penalty - b.penalty;
            if (a.node.stationary !== b.node.stationary) return a.node.stationary ? -1 : 1;
            return a.node.host.localeCompare(b.node.host);
        })
        .slice(0, limit)
        .map(entry => entry.node);
}

/** The deepest depth the map has evidence for, or -1 when it is empty. */
export function deepestDepth(map: DarknetMap): number {
    let deepest = -1;
    for (const node of map.values()) {
        if (node.online && node.depth > deepest) deepest = node.depth;
    }
    return deepest;
}

/**
 * What to do about a new reading of the same host after a mutation.
 *
 * A mutation can move a server, take it offline, or clean and re-password it, and
 * the game reports the change only when the framework looks again. Two rules:
 *
 *   - A host that has gone offline is kept, not deleted, so the dashboard can say
 *     it was lost rather than silently shrinking. `online: false` already excludes
 *     it from `frontier` and from every `route`.
 *   - A `via` that no longer exists, or whose own route is broken, is REPARENTED
 *     rather than trusted. This is the subtle one: a server whose parent went
 *     offline is unreachable through that parent, but if a second reading revealed
 *     the same host through a different live neighbour, the old `via` would pin it
 *     to a dead route forever.
 */
export function reconcileNode(previous: DarknetNode, fresh: DarknetNode, map: DarknetMap): DarknetNode {
    // The entry has no parent, and no report may give it one.
    //
    // This is load-bearing rather than defensive. A worker on a child of `darkweb`
    // probes its own neighbourhood and sees `darkweb` there, so the entry arrives in a
    // report with `via` pointing at that child — which makes a cycle
    // (`darkweb -> alpha -> darkweb`), `route` refuses it, and the whole map becomes
    // unreachable from home. The walk then stops entirely, at the exact moment it was
    // making progress.
    if (fresh.host === ENTRY) {
        return { ...fresh, via: null, depth: fresh.depth };
    }

    const via = resolveVia(fresh.via, previous.via, map);
    return {
        ...fresh,
        // A session does not survive a restart or a re-password, and the game does
        // not report that it expired: it simply starts refusing the calls. Trusting
        // a stale `session: true` means never re-authenticating.
        session: fresh.online ? fresh.session : false,
        via,
        depth: fresh.depth,
    };
}

/**
 * The parent to record for a node: the fresh reading if it still leads somewhere,
 * otherwise the previous one, otherwise null.
 *
 * Null is a legitimate answer: the node is known but orphaned, which is what a
 * mutation that cut it off from home looks like.
 */
function resolveVia(freshVia: string | null, previousVia: string | null, map: DarknetMap): string | null {
    if (freshVia !== null && map.get(freshVia)?.online) return freshVia;
    if (previousVia !== null && map.get(previousVia)?.online) return previousVia;
    return null;
}

/**
 * Fold a fresh reading into the map.
 *
 * `readings` is what one walk pass observed: each host with the neighbour it was
 * seen from. Hosts absent from the reading are left exactly as they were, because
 * absence is not evidence — `probe` only ever shows the immediate neighbourhood,
 * so a server not mentioned this pass is out of sight, not gone. Only an explicit
 * `isOnline: false` retires a node.
 */
export function reconcile(map: DarknetMap, readings: readonly DarknetNode[]): DarknetMap {
    const next = new Map(map);

    for (const reading of readings) {
        const previous = next.get(reading.host);
        next.set(
            reading.host,
            previous === undefined ? reading : reconcileNode(previous, reading, next),
        );
    }

    return next;
}

/**
 * Hosts whose session has been lost and must be re-established before anything
 * behind them is usable.
 *
 * This is the list the Master walks each pass. It is derived rather than tracked,
 * because a session is not framework state: it is the game's state, it expires
 * with the script, and any local record of it drifts the moment a server restarts.
 */
/**
 * The hosts on the way to `host` that still need a session, outermost first.
 *
 * The GATEWAY is excluded, and that exclusion is the third place the same mistake
 * appeared. `darkweb` is the door rather than a room: it has no password
 * (`passwordLength: 0`) and `getDepth` reports -1 for it, meaning "not a darkweb
 * server". So it can never hold a session, and listing it here meant every route began
 * with an impossible hop — `tryAuthenticate` on it produced no candidates, reported
 * failure, and the caller aborted before reaching the host it was actually trying to
 * open. The walk could discover the first level and never open it.
 */
export function needsSession(map: DarknetMap, host: string): string[] {
    const chain = route(map, host);
    if (chain === null) return [];

    return chain.filter(step => {
        if (step === ENTRY) return false;
        const node = map.get(step);
        return node !== undefined && node.online && !node.session;
    });
}
