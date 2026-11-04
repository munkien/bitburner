/*
 * ============================================================================
 * THE CAPABILITY FLAGS ARE ON THE WIRE
 * ============================================================================
 * `Capabilities.probes` already held every flag the framework acts on, but the only way to
 * read them was the boot line in the in-game Terminal — which no recording captures. So a
 * question like "does this run own The Blade's Simulacrum?" could not be answered from a
 * `.jsonl` at all, and had to be inferred from downstream behaviour.
 *
 * THE COST OF THAT, MEASURED. The division reported `yielded to training` while the player
 * believed the augment was owned. The yield is gated on `capabilities.has("bladesSimulacrum")`,
 * so the whole disagreement turned on a boolean nobody could read. Two sessions were spent
 * reasoning about it from behaviour when the flag would have settled it in one query.
 *
 * `capabilityFlags` exists so that boolean — and the rest — is in every frame.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { capabilityFlags } from "./caps.ts";
import type { Capabilities } from "./caps.ts";

/** The smallest `Capabilities` that `capabilityFlags` reads. */
function caps(probes: Partial<Record<string, boolean>>): Capabilities {
    return {
        probes: {
            tor: false, stocks: false, formulasExe: false, gangMember: false,
            bladeburnerDivision: false, darkscapeNavigator: false, bladesSimulacrum: false,
            ...probes,
        },
    } as unknown as Capabilities;
}

test("bladesSimulacrum is reported", () => {
    // THE ONE THAT PROMPTED THIS. Whether the division yields for training turns on it.
    assert.equal(capabilityFlags(caps({ bladesSimulacrum: true })).bladesSimulacrum, true);
    assert.equal(capabilityFlags(caps({})).bladesSimulacrum, false);
});

test("every probe is present, so a missing key cannot read as false", () => {
    // A flag absent from the published object is indistinguishable from a flag that is
    // false — which is the exact confusion this is meant to end. The shape is asserted
    // against the probe list rather than a literal, so a probe added later is covered.
    const flags = capabilityFlags(caps({}));
    for (const key of Object.keys(caps({}).probes)) {
        assert.equal(typeof (flags as unknown as Record<string, boolean>)[key], "boolean", `${key} is missing`);
    }
});

test("the flags are copied, not aliased", () => {
    // The published object rides on telemetry. If it were the live `probes` object, a later
    // capability refresh would mutate a payload already sent, and a recording would show a
    // frame claiming a state the game was not in when the frame was taken.
    const source = caps({ tor: true });
    const flags = capabilityFlags(source);
    // The live object is mutated THROUGH a widened alias, because `CapabilityProbes` is
    // readonly by design — the point of the helper being that a caller cannot do this.
    (source.probes as unknown as { tor: boolean }).tor = false;

    assert.equal(flags.tor, true, "the published flags changed when the live probes did");
});

test("a true flag is never reported as false by omission", () => {
    // The specific hazard: building the object from a partial list would silently drop a
    // flag that happens to be true, which reads as "not owned" and is the direction that
    // costs a session.
    const all = caps({
        tor: true, stocks: true, formulasExe: true, gangMember: true,
        bladeburnerDivision: true, darkscapeNavigator: true, bladesSimulacrum: true,
    });
    const flags = capabilityFlags(all);

    for (const [key, value] of Object.entries(all.probes)) {
        assert.equal((flags as unknown as Record<string, boolean>)[key], value, `${key} was misreported`);
    }
});
