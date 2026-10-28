import type { FeatureMeta } from "./features.ts";
import { HACKTOCRACY_BITNODE, always, exceptIn } from "./features.ts";
import { SLEEVE_MOVABLE, type Participation } from "./objective.ts";

/*
 * ============================================================================
 * REGISTRY
 * ============================================================================
 * Every feature the framework knows about, and the standalone entries it keeps
 * running.
 *
 * Adding a feature is one entry here plus one file. Nothing in the orchestrator
 * changes, because it reads nothing but this list.
 *
 * This file is statically imported by the orchestrator, so it must not call the
 * game or import a feature: doing either would charge RAM at boot, before the
 * RAM gate has decided whether the feature can be afforded. Only `path` strings
 * and capability names live here.
 *
 * `priority` decides tick order and who gets home RAM first. `requires` is
 * checked before loading, and `enabled` covers preconditions capability rules
 * cannot express.
 * ============================================================================
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export const FEATURES: readonly FeatureMeta[] = [
    {
        id: "hacking",
        name: "Hacking",
        path: "./features/hacking/hacking.ts",
        priority: always(10),
        // The only feature that needs sub-second ticks. It launches batches on a
        // 40 ms spacing, and a batch is launched when `now` reaches the planned
        // landing time, so a slower tick would launch late and drift the pipeline
        // out of sync. Everything it does not have to launch on time, it defers
        // itself via its own REFRESH_MS.
        intervalMs: 40,
        requires: [],
        // Farming servers pays money and raises hacking, which is what the early
        // cash-floor and hacking-gated goals are waiting on.
        movable: ["hacking", "money", "netWorth"],
    },
    {
        id: "home",
        name: "Home & TOR",
        path: "./home.ts",
        priority: always(20),
        intervalMs: SECOND,
        // Buying and downloading programs is a Singularity action. Without it
        // the feature has nothing to do, so it is not loaded at all.
        requires: ["singularity"],
        movable: [],
    },
    {
        id: "stocks",
        name: "Stock Market",
        path: "./features/stocks/stocks.ts",
        priority: always(30),
        intervalMs: 6 * SECOND,
        requires: ["stocks"],
        // The market follows its own net-worth tiers rather than the run's goal, but it
        // genuinely raises wealth, so it declares that it can move it. A feature is
        // declared movable when it CAN move the measure, not only when it is trying to.
        movable: ["netWorth", "money"],
    },
    {
        id: "progression",
        name: "Progression",
        path: "./features/player/player.ts",
        priority: always(40),
        intervalMs: SECOND,
        requires: ["singularity"],
        // The feature that trains stats, farms karma and kills, and works for faction
        // reputation. Every one of those is a goal measurement.
        movable: ["hacking", "combat", "cha", "karma", "kills", "money", "rep"],
    },
    {
        id: "grafting",
        name: "Grafting",
        path: "./grafting.ts",
        // After progression: a graft is a fallback for augmentations the player
        // already has elsewhere, not the main way to acquire them.
        priority: always(42),
        intervalMs: MINUTE,
        requires: ["grafting"],
        // Grafting buys augmentations, which is not a goal measurement in the run's
        // model: augmentations reset the run rather than closing a sub-goal.
        movable: [],
    },
    {
        id: "bladeburner",
        name: "Bladeburner",
        path: "./features/bladeburner/bladeburner.ts",
        priority: always(50),
        intervalMs: 5 * SECOND,
        requires: ["bladeburner"],
        // Raises combat stats and rank, so it can move the combat floor. Rank is not a
        // goal measurement.
        movable: ["combat"],
    },
    // {
    //     id: "darknet",
    //     name: "Dark Net",
    //     path: "./features/darknet/darknet.ts",
    //     // After Bladeburner and before gang: it neither feeds progression nor
    //     // contends for the activity slot, so it sits wherever its home RAM cost is
    //     // least likely to displace a feature that does.
    //     priority: 555,
    //     // Five seconds, not the thirty this started at.
    //     //
    //     // The walk advances ONE HOP PER TICK, and each hop needs a tick to authenticate
    //     // and another for the worker round trip to come back — so a 30s interval put
    //     // three minutes between the feature loading and its second hop. Meanwhile its
    //     // status line is deduplicated, so between hops it printed nothing at all: the
    //     // dashboard showed a Dark Net row that never changed, which reads as a feature
    //     // doing nothing.
    //     //
    //     // The cost is low. Two calls per tick on home (`probe`, `getServerDetails`) plus
    //     // whatever the Master decides, and the expensive work happens on the workers.
    //     // This was originally justified by a `nextMutation` subscription the feature
    //     // never actually made; see the note in `darknet.ts`.
    //     intervalMs: 5 * SECOND,
    //     // `DarkscapeNavigator.exe` on home. The Dark Net is reachable on any node
    //     // once the program is bought, so this is a probe rather than a Source File.
    //     requires: ["darknet"],
    //     // Phishing and caches pay money and raise karma (the kills side) and charisma,
    //     // which is why the feature reads the karma and cha goals to decide what to open.
    //     movable: ["money", "karma", "cha"],
    // },
    {
        id: "gang",
        name: "Gang",
        path: "./features/gang/gang.ts",
        priority: always(60),
        intervalMs: 2 * SECOND,
        requires: ["gang"],
        // The gang earns money, grows its own respect, and takes territory. All three are
        // goal measurements, and gang's own money rule is built on the net-worth figure.
        movable: ["netWorth", "money", "gangRespect", "gangTerritory"],
    },
    {
        id: "retire",
        name: "Retirement",
        path: "./features/retire/retire.ts",
        // Last, because retirement ends the run: anything with real work left should
        // have its turn before this decides the run is finished. Its own cadence is a
        // minute, so the ordering costs nothing when it is waiting.
        priority: always(110),
        intervalMs: MINUTE,
        requires: ["singularity"],
        // Retirement ends the run; it advances no goal.
        movable: [],
    },
    {
        id: "sleeves",
        name: "Sleeves",
        path: "./features/sleeves/sleeves.ts",
        priority: always(20),
        intervalMs: 5 * SECOND,
        requires: ["sleeves"],
        // One definition, read by this file and by the sleeves feature itself, so the two
        // cannot disagree about what a sleeve can do. That disagreement was a real bug: this
        // listed `rep` while the feature's own list did not, so a reputation goal was
        // attributed to sleeves as a contributor and then never worked on. See
        // `SLEEVE_MOVABLE` for what is in the list and why each entry is there.
        //
        // This is a VALUE import from `lib/objective.ts`, not a type-only one like the
        // import at the top of this file. That is safe under this file's own rule — it must
        // not call the game or import a feature — because `goal.ts` is a `lib/` module
        // that does neither, so reading it here costs no RAM and runs no game code.
        movable: SLEEVE_MOVABLE,
    },
    {
        id: "share",
        name: "Share",
        path: "./share.ts",
        priority: always(150),
        intervalMs: 5 * SECOND,
        requires: [],
        // Sharing boosts faction reputation, which is the whole point of the feature; now
        // that reputation is a goal measure it declares that it can move it.
        movable: ["rep"],
    },
    {
        id: "cloud",
        name: "Cloud Fleet",
        path: "./cloud.ts",
        // DEAD LAST IN HACKTOCRACY, because it cannot run there at all: BitNode 9 sets
        // `CloudServerLimit: 0`, so there are no servers to buy. The feature is still
        // admitted (the capability rule only excludes BitNode 8), so its priority decides
        // how much home RAM it claims ahead of Hacknet before discovering it has nothing to
        // do — and in that node home RAM costs five times as much. Dropping it below
        // everything else costs nothing where it does work and stops it displacing the
        // node's actual income.
        priority: exceptIn(HACKTOCRACY_BITNODE, 250, 90),
        intervalMs: SECOND,
        // BitNode 8 has no server-based income: its only money is the stock
        // market, so a cloud fleet of workers has nothing to farm there.
        requires: ["serverIncome"],
        movable: ["money", "netWorth"],
    },
    {
        id: "hacknet",
        name: "Hacknet",
        path: "./hacknet.ts",
        // FIRST IN HACKTOCRACY, and that is the whole point of the node. Hacknet Server is
        // what BitNode 9 unlocks, SF9 makes it cheaper and more productive, and the node
        // takes hacking apart everywhere else: `ScriptHackMoney: 0.1`, `HackExpGain: 0.05`,
        // `HackingLevelMultiplier: 0.5`. So the default order spends the run's home RAM on
        // features that the node's multipliers have gutted, while the one mechanic it
        // boosts waits at number 100.
        //
        // Ahead of everything except Backdoor/Home at 20, which are cheap one-offs rather
        // than ongoing RAM claims. Hacknet pays for itself in hashes, and hashes buy the
        // money and the RAM that the rest of the framework then spends.
        priority: exceptIn(HACKTOCRACY_BITNODE, 25, 100),
        intervalMs: SECOND,
        // Same as cloud: hacknet nodes earn from servers, and BitNode 8 grants
        // none, so the feature is switched off rather than left burning RAM.
        requires: ["serverIncome"],
        // Hacknet earns money, and its hash spending is gated on the net-worth figure
        // rather than on cash — see the feature's WEALTH_TARGET note.
        movable: ["money", "netWorth"],
    },
];

/** Feature scripts in tick order, for the standalone entries that start the orchestrator. */
/**
 * The features in the order they should run, for one BitNode.
 *
 * THE SORT MOVED HERE, and it has to. `priority` is a function of the node, so every
 * caller that sorted by `a.priority - b.priority` would now be comparing two functions —
 * which is `NaN`, and `NaN` makes the comparator inconsistent in a way that leaves the
 * array in an arbitrary order rather than failing loudly. There were five such callers
 * across the orchestrator, the runtime and the doctor; one function means one answer.
 *
 * Ties fall back to `id`, so features that share a priority (Home at 20 and Sleeves at
 * 20 in the default order) do not depend on the order they happen to be written in.
 */
export function featuresInOrder(bitNode: number): FeatureMeta[] {
    return [...FEATURES].sort(
        (a, b) => a.priority(bitNode) - b.priority(bitNode) || a.id.localeCompare(b.id),
    );
}

/** Feature scripts in tick order, for the standalone entries that start the orchestrator. */
export function featurePaths(bitNode: number): string[] {
    return featuresInOrder(bitNode).map(feature => feature.path);
}

/**
 * What each feature can advance, for the goal system to attribute work to.
 *
 * The registry owns this mapping because it already owns the features, and because the
 * declarations it reads are metadata rather than behaviour: building the list here costs
 * nothing at boot and imports no feature. Kept as a function so the two callers (the
 * orchestrator building the Context, and the doctor reporting it) share one reading of the
 * same list.
 */
export function featureParticipation(): Participation[] {
    return FEATURES.map(feature => ({ id: feature.id, movable: feature.movable }));
}
