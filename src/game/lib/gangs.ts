/*
 * ============================================================================
 * GANG MEASURES
 * ============================================================================
 * Everything known about obtaining a gang, in one place.
 *
 * WHY THIS MODULE EXISTS. Creating a gang needs three separate facts, each of which two
 * or more parts of the framework would otherwise declare for themselves:
 *
 *   the factions that allow it       the game states these only inside its own gang
 *                                    code, so a copy is unavoidable — and a copy in two
 *                                    files is the drift ADR 0003 records
 *   the karma it takes               -54000, which is ALSO `GOAL_TARGETS.karma`. The run
 *                                    already farms toward that figure without knowing
 *                                    why, so the two must not be able to disagree
 *   which factions give which TYPE   fixed at creation and irreversible, so the mapping
 *                                    is a decision rather than a lookup
 *
 * It calls no game function and reads no clock, so it is reachable from `lib/` (which may
 * not import a feature, ADR 0001) and testable without a game.
 * ============================================================================
 */

import type { FactionName } from "@ns";

/** Source File 2, which unlocks gangs outside BitNode 2. */
export const SF_GANG = 2;

/**
 * BitNode 2, where gangs are available without Source File 2.
 *
 * The game's own rule: `bitNodeN === 2` grants access outright, otherwise SF2 is
 * required. Neither is a threshold this framework chooses.
 */
export const GANG_BITNODE = 2;

/**
 * Karma at or below which a gang may be created.
 *
 * THE SAME NUMBER AS `GOAL_TARGETS.karma`, and that is the point rather than a
 * coincidence. The run farms karma to -54000 because that is what the late-game
 * factions ask for — and it is also what the gang asks for, since the game's
 * `GangConstants.GangKarmaRequirement` is -54000. The karma goal therefore already
 * pursues this figure; it simply never knew the gang was one of the things it was
 * for. Declared here so the goal and the gang decision read one value.
 */
export const GANG_KARMA = -54_000;

/**
 * Factions that allow a gang, and the TYPE of gang each gives.
 *
 * The type is fixed when the gang is created and there is no API to change it, so this
 * is a permanent choice for the whole BitNode — which is why it is stated here rather
 * than inferred at the call site.
 *
 * From the game: a gang is a HACKING gang when the faction is NiteSec or The Black
 * Hand, and a COMBAT gang otherwise. The split is not a preference this framework has;
 * it is what the game does with the faction it was handed.
 */
export type GangKind = "hacking" | "combat";

export const GANG_FACTIONS: Readonly<Partial<Record<FactionName, GangKind>>> = {
    // Backdoor-accessible: see `BACKDOOR_FACTIONS` in the player feature. The cheapest
    // route to a gang, because a backdoor needs only root and a hacking level.
    NiteSec: "hacking",
    "The Black Hand": "hacking",

    // Combat gangs. Every one of these also requires karma, and the deeper ones require
    // kills, so reaching them is a longer project than installing a backdoor.
    "Slum Snakes": "combat",
    Tetrads: "combat",
    "The Syndicate": "combat",
    "The Dark Army": "combat",
    "Speakers for the Dead": "combat",
};

/** Whether a faction allows creating a gang at all. */
export function gangKindOf(faction: FactionName): GangKind | null {
    return GANG_FACTIONS[faction] ?? null;
}

/**
 * The factions of one kind, so a caller can ask "is any hacking gang reachable" without
 * walking the table itself.
 */
export function factionsOfKind(kind: GangKind): readonly FactionName[] {
    return (Object.entries(GANG_FACTIONS) as [FactionName, GangKind][])
        .filter(([, k]) => k === kind)
        .map(([faction]) => faction);
}

/* ─── the coin flip ─── */

/** The flag recording which kind this run committed to, once and for all. */
export const GANG_CHOICE_FLAG = "gang_choice.txt";

/**
 * Which kind of gang this run goes for, decided once and written down.
 *
 * WHY A FLIP, AND WHY IT MUST BE PERSISTED. The choice is a coin toss between a hacking
 * gang and a combat gang, which makes each run a different exercise. The type cannot be
 * changed after creation and choosing wrong means the whole BitNode plays differently,
 * so it is a decision the run makes ONCE — not a preference re-evaluated as the
 * situation changes.
 *
 * That distinction is why this is a flag file rather than a value computed per pass. The
 * orchestrator self-restarts on every file edit, and a run spans days; a flip recomputed
 * each pass would land differently each time, and the run would work toward a hacking
 * gang on one tick and a combat one on the next. That is the same shape as the goal
 * ranking's thrash, with a worse consequence — a gang, once made, is permanent.
 *
 * SEEDED FROM THE NODE, not from `Math.random()`. A stored choice is lost if the file is
 * deleted, and a lost choice that re-flips could contradict a gang that already exists.
 * Seeding on the BitNode number makes the answer REPRODUCIBLE: the same node always
 * yields the same kind, so a lost flag is recoverable rather than a second decision.
 *
 * `seed` is passed rather than read, so this stays pure and testable without a game.
 */
export function chosenGangKind(seed: number): GangKind {
    // A cheap deterministic mix. Not a hash for security, only for spreading adjacent
    // node numbers apart — BitNodes 2 and 3 must not both fall the same way by accident.
    const mixed = Math.abs(Math.sin(seed * 12.9898) * 43758.5453);
    return mixed - Math.floor(mixed) < 0.5 ? "hacking" : "combat";
}

/**
 * The gang faction the run should join for `kind`, given what it has joined already.
 *
 * Returns a faction already held when there is one — the cheapest possible route, since
 * joining costs nothing further — and otherwise the first candidate, which is the
 * caller's cue to go and earn membership. Null when the kind has no candidates at all,
 * which cannot happen with the table above but keeps the signature honest.
 */
export function gangFactionFor(
    kind: GangKind,
    joined: readonly FactionName[],
): { readonly faction: FactionName; readonly haveIt: boolean } | null {
    const candidates = factionsOfKind(kind);
    const held = candidates.find(candidate => joined.includes(candidate));
    if (held !== undefined) return { faction: held, haveIt: true };

    const first = candidates[0];
    return first === undefined ? null : { faction: first, haveIt: false };
}
