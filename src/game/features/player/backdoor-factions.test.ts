/*
 * ============================================================================
 * EVERY FACTION THAT NEEDS A BACKDOOR IS IN THE LIST
 * ============================================================================
 * Several factions are joined only by installing a backdoor on one particular server:
 *
 *   CSEC           CyberSec
 *   avmnite-02h    NiteSec
 *   I.I.I.I        The Black Hand
 *   run4theh111z   BitRunners
 *   fulcrumassets  Fulcrum Secret Technologies
 *
 * The reported fault: `fulcrumassets` was never backdoored. It was not in the list at all, so
 * `findBackdoor` never considered it however long the run played — the faction stayed
 * unjoinable and nothing anywhere said why.
 *
 * THIS IS A SILENT FAILURE BY CONSTRUCTION. A backdoor is attempted by walking this table and
 * stopping at the first server that needs one; a missing entry produces no attempt, no log
 * line and no error. It is indistinguishable from "the server does not need a backdoor".
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKDOOR_FACTIONS } from "./player.ts";

test("fulcrumassets is backdoored for Fulcrum Secret Technologies", () => {
    // THE REPORTED FAULT. The faction is joined by backdooring this server, and it appears
    // nowhere else in the framework except `sleeves.ts` as a company/faction mapping.
    assert.equal(
        BACKDOOR_FACTIONS["fulcrumassets"],
        "Fulcrum Secret Technologies",
        "fulcrumassets was never attempted, so the faction could not be joined",
    );
});

test("the four original backdoor factions are still present", () => {
    // THE CONTROL, and the reason this is a table rather than a lookup: adding an entry must
    // not displace one that was already working. Each of these was verified joinable on a
    // recorded run.
    assert.equal(BACKDOOR_FACTIONS["CSEC"], "CyberSec");
    assert.equal(BACKDOOR_FACTIONS["avmnite-02h"], "NiteSec");
    assert.equal(BACKDOOR_FACTIONS["I.I.I.I"], "The Black Hand");
    assert.equal(BACKDOOR_FACTIONS["run4theh111z"], "BitRunners");
});

test("no two factions share a server", () => {
    // A duplicated host would mean a backdoor installed for one faction silently counted
    // toward another, and `findBackdoor` would skip both once an early entry matched.
    const seen = new Map<string, string>();
    for (const [host, faction] of Object.entries(BACKDOOR_FACTIONS)) {
        const prior = seen.get(host);
        assert.equal(prior, undefined, `${host} is listed for both ${prior} and ${faction}`);
        seen.set(host, faction);
    }
});

test("every entry names a host and a faction", () => {
    // A blank either side is a row that can never match, which reads as a faction that
    // needs no backdoor.
    for (const [host, faction] of Object.entries(BACKDOOR_FACTIONS)) {
        assert.ok(host.trim() !== "", "an entry has a blank host");
        assert.ok(String(faction).trim() !== "", `the entry for ${host} has a blank faction`);
    }
});
