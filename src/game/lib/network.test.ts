/*
 * ============================================================================
 * A HOST THAT NO LONGER EXISTS IS SKIPPED, NOT FATAL
 * ============================================================================
 * `workerHosts` and `rootedHosts` walk the reachable tree and then ask the game about each
 * name. The walk and the question are separate calls, and a cloud server can stop existing
 * between them — `ns.scan` reported it, and by the time `getServerMaxRam` is asked the name
 * does not resolve.
 *
 * Measured in `runs/2026-11-04T09.37.53.447Z--33`, on the FIRST message of the session:
 *
 *   Hacking faulted: RUNTIME ERROR
 *   getServerMaxRam: Invalid host: 'cloud-0'
 *   Share faulted:   RUNTIME ERROR
 *   getServerMaxRam: Invalid host: 'cloud-0'
 *
 * Two features died on one bad name, and they recovered on a later pass. A host list is a
 * FILTER — its job is to answer "which hosts are usable", and a host that cannot be read is
 * not usable. Throwing turns a missing server into a dead feature, which is a far worse
 * outcome than a shorter list.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { rootedHosts, workerHosts } from "./network.ts";
import type { NS } from "@ns";

/**
 * An `ns` where `gone` is reported by `scan` but refuses every per-host question.
 *
 * This is the race as the game presents it: the name is in the tree, and every call that
 * would describe it throws "Invalid host".
 */
function nsWithVanishedHost(gone: string, opts: { ram?: number } = {}): NS {
    const hostile = (host: string): boolean => host === gone;
    return {
        scan: (host: string) => (host === "home" ? ["home", "n00dles", gone] : []),
        hasRootAccess: (host: string) => {
            if (hostile(host)) throw new Error(`Invalid host: '${host}'`);
            return true;
        },
        getServerMaxRam: (host: string) => {
            if (hostile(host)) throw new Error(`Invalid host: '${host}'`);
            return host === "home" ? (opts.ram ?? 64) : 16;
        },
        getServerUsedRam: () => 0,
        hacknet: { numNodes: () => 0 },
    } as unknown as NS;
}

test("a host that vanished between the walk and the query is skipped", () => {
    // THE CRASH. `workerHosts` asked `getServerMaxRam("cloud-0")` and the name no longer
    // resolved, which threw out of the filter and killed the hacking feature.
    const hosts = workerHosts(nsWithVanishedHost("cloud-0"));

    assert.ok(!hosts.includes("cloud-0"), "a vanished host was returned as a worker host");
    assert.ok(hosts.includes("n00dles"), "a live host was lost along with the vanished one");
    assert.ok(hosts.includes("home"), "home was lost along with the vanished one");
});

test("`rootedHosts` skips a vanished host too", () => {
    // The other half of the same crash: `share` uses `rootedHosts`, which asks
    // `hasRootAccess` instead and threw on the same name.
    const hosts = rootedHosts(nsWithVanishedHost("cloud-0"));

    assert.ok(!hosts.includes("cloud-0"), "a vanished host was returned as a rooted host");
    assert.ok(hosts.includes("n00dles"), "a live host was lost along with the vanished one");
});

test("a healthy tree is unaffected", () => {
    // THE CONTROL. A guard that swallowed everything would pass both tests above while
    // breaking every host list, so the ordinary case is asserted explicitly.
    const healthy = {
        scan: (host: string) => (host === "home" ? ["home", "n00dles", "foodnstuff"] : []),
        hasRootAccess: () => true,
        getServerMaxRam: () => 16,
        getServerUsedRam: () => 0,
        hacknet: { numNodes: () => 0 },
    } as unknown as NS;

    const hosts = workerHosts(healthy);
    assert.ok(hosts.includes("n00dles") && hosts.includes("foodnstuff"), "a healthy tree lost hosts");
});
