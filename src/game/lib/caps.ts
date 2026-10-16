import type { NS } from "@ns";

import { SF_GANG } from "./gangs.ts";

/*
 * ============================================================================
 * CAPABILITY DETECTION
 * ============================================================================
 * PURPOSE
 *   Answer exactly one question, in exactly one place: "what can this BitNode
 *   and this set of Source Files actually do?"
 *
 *   Every feature declares the capabilities it needs (see lib/features.ts) and
 *   is skipped, with a logged reason, when they are missing. No feature probes
 *   the game for its own availability, and nothing relies on catching an
 *   exception thrown by an unavailable API.
 *
 * TWO KINDS OF CAPABILITY
 *   Static  — BitNode number and Source File levels. Cannot change during a run
 *             (a reset restarts every script), so they are read once.
 *   Probed  — facts that flips mid-run: TOR router bought, TIX API purchased,
 *             Formulas.exe downloaded, gang joined, division joined. Re-read on
 *             a slow interval by the orchestrator.
 *
 *   Probes are deliberately cheap: `deriveCapabilities` must stay usable as the
 *   orchestrator's baseline RAM cost. `ns.sleeve.getNumSleeves()` costs 4 GB and
 *   is therefore NOT probed here — the sleeve feature gates itself on SF10/BN10
 *   and checks its own sleeve count after it has been loaded.
 * ============================================================================
 */

/**
 * Source File numbers this framework knows about. Source File N is unlocked by
 * completing BitNode N, and satisfies the same requirement as being *in* BitNode
 * N, which is why requirements are always expressed as "SF n or BitNode n".
 */
export const SF = {
    /** The gang Source File, which `lib/gangs.ts` also names — one number, one source. */
    GANG: SF_GANG,
    SINGULARITY: 4,
    FORMULAS: 5,
    BLADEBURNER: 6,
    BLADEBURNER_ALT: 7,
    STOCK_SHORTING: 8,
    SLEEVES: 10,
} as const;

/** `Formulas.exe` grants the formula APIs without Source File 5. */
export const FORMULAS_EXE = "Formulas.exe";

/**
 * `DarkscapeNavigator.exe` unlocks the Dark Net API.
 *
 * Not a Source File: the Dark Net is reachable on any node once the program is
 * bought from the dark web, which makes this the same shape of requirement as the
 * TOR router rather than a capability a BitNode grants.
 */
export const DARKSCAPE_EXE = "DarkscapeNavigator.exe";

/**
 * `The Blade's Simulacrum` — the augmentation that stops Bladeburner actions
 * from occupying the player's single activity slot.
 *
 * Granted automatically at BitNode 7 Source File level 3, so it is a fact about
 * the run rather than something bought.
 *
 * THE NAME IS THE GAME'S OWN, copied from its documentation of the grant
 * ("you will immediately receive \"The Blade's Simulacrum\" augmentation").
 * `getOwnedAugmentations` returns canonical names, so an approximate match is
 * simply a check that never fires — which is why the one name lives here rather
 * than being spelled out at each call site.
 */
export const BLADES_SIMULACRUM = "The Blade's Simulacrum";

export const CAPABILITY_KEYS = [
    "singularity",
    "gang",
    "createGang",
    "bladeburner",
    "bladesSimulacrum",
    "sleeves",
    "grafting",
    "formulas",
    "multipliers",
    "shorting",
    "stocks",
    "tor",
    "darknet",
    "serverIncome",
    "augmentPurchase",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Runtime probes. Every one of these can flip while the game is running. */
export interface CapabilityProbes {
    readonly tor: boolean;
    readonly stocks: boolean;
    readonly formulasExe: boolean;
    readonly gangMember: boolean;
    readonly bladeburnerDivision: boolean;
    readonly darkscapeNavigator: boolean;
    /** Whether the run owns The Blade's Simulacrum (Bladeburner no longer takes the slot). */
    readonly bladesSimulacrum: boolean;
}

type ProbeKey = keyof CapabilityProbes;

interface CapabilityRule {
    /** Human-readable name used in log messages. */
    readonly label: string;
    /** Any one of these Source Files satisfies the rule. */
    readonly sourceFiles?: readonly number[];
    /** Any one of these BitNodes satisfies the rule. */
    readonly bitNodes?: readonly number[];
    /**
     * BitNodes where the capability is never available, regardless of Source
     * Files. Used when a BitNode removes a mechanic rather than adding one: in
     * BitNode 8 the only income is the stock market, so server-based money is
     * out, and no Source File brings it back.
     */
    readonly excludedBitNodes?: readonly number[];
    /**
     * Runtime state that Source File levels cannot express.
     *
     * "only" — the probe *is* the requirement; there is no Source File or
     *          BitNode that could unlock it (the TOR router is bought).
     * "and"  — an extra precondition: SF2 alone is not enough to work a gang,
     *          you must also be in one.
     * "or"   — an alternative that satisfies the rule on its own: Formulas.exe
     *          grants the formula APIs without SF5.
     *
     * The three modes need three different phrases (a missing-state clause, a
     * second missing-state clause, or a name to append to the requirement list),
     * so the union carries exactly one of them and the compiler enforces it.
     */
    readonly probe?: ProbeRule;
}

type ProbeRule =
    | { readonly key: ProbeKey; readonly mode: "only"; readonly missing: string }
    | { readonly key: ProbeKey; readonly mode: "and"; readonly missing: string }
    | { readonly key: ProbeKey; readonly mode: "or"; readonly alternative: string };

/** SF n is unlocked in BitNode n, so both sides of a rule are usually the same numbers. */
function sfOrNode(...nodes: readonly number[]): Pick<CapabilityRule, "sourceFiles" | "bitNodes"> {
    return { sourceFiles: nodes, bitNodes: nodes };
}

const RULES: Readonly<Record<CapabilityKey, CapabilityRule>> = {
    singularity: {
        label: "Singularity API",
        ...sfOrNode(SF.SINGULARITY),
    },
    gang: {
        label: "Gang API",
        ...sfOrNode(SF.GANG),
        probe: { key: "gangMember", mode: "and", missing: "not currently in a gang" },
    },
    createGang: {
        label: "Gang creation",
        ...sfOrNode(SF.GANG),
        // Deliberately NO membership probe, following the Bladeburner rule below.
        //
        // Separate from `gang` above, which is the "already in one" rule. With
        // `gangMember` here this capability would be false at exactly the moment the
        // feature that creates a gang needed to run — gating an action behind its own
        // outcome. BitNode 2 also allows a gang without Source File 2, so it cannot be
        // an SF-only rule either; `sfOrNode` covers both.
    },
    bladeburner: {
        label: "Bladeburner API",
        ...sfOrNode(SF.BLADEBURNER, SF.BLADEBURNER_ALT),
        // Deliberately no `bladeburnerDivision` probe: joining the division is
        // this framework's job, so requiring membership would gate the feature
        // behind its own first action.
    },
    /**
     * The Blade's Simulacrum: the augmentation that frees Bladeburner actions
     * from the player's single activity slot.
     *
     * A probe rather than a Source File rule because owning the augment is the
     * fact that matters, not the SF level that grants it — and because the same
     * augment can be obtained by grafting on a node where the SF is not at 3.
     * Nothing requires this capability: it is read to RELAX a constraint, never
     * to gate a feature, so a run without it behaves exactly as before.
     */
    bladesSimulacrum: {
        label: "The Blade's Simulacrum",
        probe: {
            key: "bladesSimulacrum",
            mode: "only",
            missing: `${BLADES_SIMULACRUM} not owned`,
        },
    },
    sleeves: {
        label: "Sleeve API",
        ...sfOrNode(SF.SLEEVES),
    },
    grafting: {
        label: "Grafting API",
        // SF10 or BitNode 10 unlocks grafting as the import/export mechanic, and
        // BitNode 8 needs it too: Ghost of Wall Street has no augment purchases,
        // so grafting is the only way to gain augmentations there.
        sourceFiles: [SF.SLEEVES],
        bitNodes: [SF.SLEEVES, 8],
    },
    formulas: {
        label: "Formulas API",
        ...sfOrNode(SF.FORMULAS),
        probe: { key: "formulasExe", mode: "or", alternative: FORMULAS_EXE },
    },
    /**
     * `ns.getBitNodeMultipliers()` needs SF5 or BitNode 5 and throws otherwise.
     * Deliberately NOT the same rule as `formulas`: Formulas.exe satisfies the
     * formula APIs but does not satisfy this one, so a player can have one and
     * not the other.
     */
    multipliers: {
        label: "BitNode multipliers",
        ...sfOrNode(SF.FORMULAS),
    },
    shorting: {
        label: "Stock shorting",
        ...sfOrNode(SF.STOCK_SHORTING),
    },
    stocks: {
        label: "Stock market access",
        probe: { key: "stocks", mode: "only", missing: "WSE account and TIX API not owned" },
    },
    /**
     * Server-based income — cloud fleets and hacknet nodes — is the default way
     * to make money, and only BitNode 8 takes it away. No Source File restores
     * it there: that node's sole income is the stock market, so the two passive
     * income features are switched off rather than left to spend RAM chasing
     * money the node will never grant.
     */
    serverIncome: {
        label: "Server-based income",
        // The literal 8, not SF.STOCK_SHORTING: the two share a number, but the
        // exclusion is about the BitNode, and tying it to the shorting Source
        // File would make the rule read as "no income where shorting exists".
        excludedBitNodes: [8],
    },
    /**
     * Augment purchasing is the default way to gain augmentations, removed by
     * BitNode 8 (Ghost of Wall Street): there you cannot buy augmentations from
     * factions, only graft them. Peeking at the node here lets progression drop
     * the whole purchase pipeline — reserve, donations, faction rep-farming —
     * rather than keep spending toward a purchase the node will never allow.
     */
    augmentPurchase: {
        label: "Augment purchasing",
        excludedBitNodes: [8, 9],
    },
    tor: {
        label: "TOR router",
        probe: { key: "tor", mode: "only", missing: "TOR router not purchased" },
    },
    /**
     * The Dark Net API needs `DarkscapeNavigator.exe` on home.
     *
     * Deliberately a probe rather than a Source File rule: the program is bought
     * from the dark web, so it can appear mid-run, and it is what actually decides
     * whether `ns.dnet` can be called. Whether `darkweb` is currently *reachable*
     * is a different question and a Situation, not a Requirement — it flips with
     * every mutation, and gating on it would unload the feature each time the net
     * reshaped itself.
     */
    darknet: {
        label: "Dark Net API",
        probe: {
            key: "darkscapeNavigator",
            mode: "only",
            missing: `${DARKSCAPE_EXE} not owned`,
        },
    },
};

/** Read once per run: these cannot change while a script is running. */
export interface StaticCapabilities {
    readonly bitNode: number;
    /** Source File number → active level. Files the player does not own are absent. */
    readonly sourceFiles: ReadonlyMap<number, number>;
}

export interface Capabilities extends StaticCapabilities {
    readonly probes: CapabilityProbes;
    /** Active level of a Source File, or 0 when it is not owned. */
    sourceFileLevel(n: number): number;
    has(key: CapabilityKey): boolean;
    /** `null` when the capability is available, otherwise why it is not. */
    unavailableReason(key: CapabilityKey): string | null;
    /** One-line summary of the run's static capabilities, for the boot log. */
    describe(): string;
}

/**
 * `requires SF4 or BitNode 4`, optionally extended with a probed alternative:
 * `requires SF5 or BitNode 5 or Formulas.exe`.
 */
function requirementText(rule: CapabilityRule, alternative?: string): string {
    const parts: string[] = [];
    if (rule.sourceFiles?.length) parts.push(rule.sourceFiles.map(n => `SF${n}`).join("/"));
    if (rule.bitNodes?.length) parts.push(rule.bitNodes.map(n => `BitNode ${n}`).join("/"));
    if (alternative !== undefined) parts.push(alternative);
    return parts.length > 0 ? `requires ${parts.join(" or ")}` : "unavailable";
}

/**
 * The Source File / BitNode half of a rule.
 *
 * Probe-only rules have no such half and return false here, so their `only`
 * branch in `judge` runs first. An exclusion-only rule (available except in
 * certain BitNodes) has no positive requirement, so it is satisfied by default;
 * the exclusion is handled separately in `judge`.
 */
function baseSatisfied(rule: CapabilityRule, staticCaps: StaticCapabilities): boolean {
    if (!rule.sourceFiles && !rule.bitNodes) return rule.excludedBitNodes !== undefined;
    const hasSF = rule.sourceFiles?.some(n => (staticCaps.sourceFiles.get(n) ?? 0) > 0) ?? false;
    const inBN = rule.bitNodes?.includes(staticCaps.bitNode) ?? false;
    return hasSF || inBN;
}

interface Verdict {
    readonly available: boolean;
    /** `null` when available, otherwise why not. */
    readonly reason: string | null;
}

const AVAILABLE: Verdict = { available: true, reason: null };

function unavailable(reason: string): Verdict {
    return { available: false, reason };
}

/**
 * Decide a rule once, keeping the decision and its explanation together so the
 * two can never disagree.
 */
function judge(rule: CapabilityRule, staticCaps: StaticCapabilities, probes: CapabilityProbes): Verdict {
    const probe = rule.probe;

    // A BitNode that removes the mechanic outright is never available, whatever
    // Source Files the player owns. Checked before every other branch so it
    // cannot be satisfied by accident.
    if (rule.excludedBitNodes?.includes(staticCaps.bitNode)) {
        return unavailable(`disabled in BitNode ${staticCaps.bitNode}`);
    }

    // The probe is the whole requirement: no Source File or BitNode can unlock it.
    if (probe?.mode === "only") {
        return probes[probe.key] ? AVAILABLE : unavailable(probe.missing);
    }

    const base = baseSatisfied(rule, staticCaps);

    if (probe?.mode === "or") {
        if (probes[probe.key] || base) return AVAILABLE;
        return unavailable(requirementText(rule, probe.alternative));
    }

    if (probe?.mode === "and") {
        if (probes[probe.key]) {
            return base ? AVAILABLE : unavailable(requirementText(rule));
        }
        // Both blockers are reported when neither is satisfied.
        return unavailable(base ? probe.missing : `${requirementText(rule)}; ${probe.missing}`);
    }

    return base ? AVAILABLE : unavailable(requirementText(rule));
}

export function deriveCapabilities(staticCaps: StaticCapabilities, probes: CapabilityProbes): Capabilities {
    const verdicts = new Map<CapabilityKey, Verdict>();
    for (const key of CAPABILITY_KEYS) {
        verdicts.set(key, judge(RULES[key], staticCaps, probes));
    }

    const formatSourceFiles = (): string => {
        const owned = [...staticCaps.sourceFiles.entries()]
            .filter(([, level]) => level > 0)
            .sort(([a], [b]) => a - b)
            .map(([n, level]) => `${n}.${level}`);
        return owned.length > 0 ? owned.join(", ") : "none";
    };

    return {
        bitNode: staticCaps.bitNode,
        sourceFiles: staticCaps.sourceFiles,
        probes,
        sourceFileLevel: (n: number): number => staticCaps.sourceFiles.get(n) ?? 0,
        has: (key: CapabilityKey): boolean => verdicts.get(key)?.available ?? false,
        unavailableReason: (key: CapabilityKey): string | null => {
            const verdict = verdicts.get(key);
            return verdict !== undefined && !verdict.available ? verdict.reason : null;
        },
        describe: (): string => `BitNode ${staticCaps.bitNode}; source files: ${formatSourceFiles()}`,
    };
}

/**
 * `ns.getResetInfo()` costs 1 GB and is not subject to the Singularity RAM
 * multiplier, unlike `ns.singularity.getOwnedSourceFiles()`. It reports the
 * *active* Source File levels, so BitNode option overrides are respected.
 */
export function readStaticCapabilities(ns: NS): StaticCapabilities {
    const info = ns.getResetInfo();
    return { bitNode: info.currentNode, sourceFiles: new Map(info.ownedSF) };
}

function probe(read: () => boolean): boolean {
    try {
        return read();
    } catch {
        // The API is gated behind a Source File we do not have, or refuses to
        // answer yet. Either way the capability is not available.
        return false;
    }
}

export function readProbes(ns: NS): CapabilityProbes {
    return {
        tor: probe(() => ns.hasTorRouter()),
        stocks: probe(() => ns.stock.hasWseAccount() && ns.stock.hasTixApiAccess()),
        formulasExe: probe(() => ns.fileExists(FORMULAS_EXE, "home")),
        darkscapeNavigator: probe(() => ns.fileExists(DARKSCAPE_EXE, "home")),
        gangMember: probe(() => ns.gang.inGang()),
        bladeburnerDivision: probe(() => ns.bladeburner.inBladeburner()),
        // `includeQueued` is false: the augment's effect is only real once
        // installed, and a queued augmentation has not been installed yet.
        bladesSimulacrum: probe(() =>
            ns.singularity.getOwnedAugmentations(false).includes(BLADES_SIMULACRUM)
        ),
    };
}

/** Reuses already-known static capabilities unless `previous` is absent. */
export function detectCapabilities(ns: NS, previous?: Capabilities): Capabilities {
    const staticCaps: StaticCapabilities = previous
        ? { bitNode: previous.bitNode, sourceFiles: previous.sourceFiles }
        : readStaticCapabilities(ns);
    return deriveCapabilities(staticCaps, readProbes(ns));
}

/**
 * First requirement a feature cannot meet, as a log-ready sentence, or `null`
 * when every requirement is satisfied. Used by the orchestrator to skip a
 * feature with a reason instead of letting it fail at runtime.
 */
export function unmetRequirement(caps: Capabilities, requires: readonly CapabilityKey[]): string | null {
    for (const key of requires) {
        const reason = caps.unavailableReason(key);
        if (reason !== null) return `${RULES[key].label}: ${reason}`;
    }
    return null;
}

