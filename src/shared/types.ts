/**
 * The wire contract: the vocabulary every side of the connection must agree on.
 *
 * Imported by all three runtimes — the game (inside Bitburner), the sync server
 * (Node), and the UI (browser) — so it must stay dependency-free: types plus a
 * few const tables, no game calls, no decision logic.
 *
 * The division of labour this contract reflects:
 *
 *   - the GAME (nexus) decides and runs the strategy, and reports raw facts;
 *   - the SERVER is a dumb pipe: it holds the shared doc, broadcasts it, and
 *     relays operator commands without interpreting them;
 *   - the UI renders game state read-only and sends commands.
 *
 * There is deliberately no `Strategy`, `Phase`, or evaluator here any more: a
 * server-side decision layer was a second brain duplicating the game's, and it
 * has been removed.
 */

/** Raw facts the game reports. Each is a plain reading, computed by no one here. */
export interface Observation {
    /**
     * When the game assembled this reading, from the game's own clock
     * (`Date.now()`). Reported for information; staleness is judged from when
     * the *server* received it, since the two clocks can diverge.
     */
    at?: number;
    /** Player data, for the dossier. Projected by the game; see `Player`. */
    player?: Player;
    /** Home RAM in GB, so the operator can see headroom. */
    homeRam?: { max?: number; used?: number };
    /** Cash and holdings, as raw readings. */
    portfolio?: Portfolio;
    /** What the game's orchestrator is doing, for the console. See `NexusState`. */
    nexus?: NexusState;
    /**
     * The last few changes to the player's activity slot, oldest first.
     *
     * WHY THIS IS ON THE WIRE. "It keeps flipping on and off" was reported twice and neither
     * recording could answer it: `player.work` is a 1 Hz SNAPSHOT, so a flip that starts and
     * ends between samples leaves no trace, and the `ACTION` log tag records only that
     * something changed, never what it changed from. This is the transition history the file
     * needs for a flip to be a plain fact rather than a diff of 36,000 frames.
     *
     * Bounded and small. It rides on a payload published every second, and the shape of the
     * last minute is the point — the JSONL recorder already holds every frame for detail.
     */
    activity?: readonly ActivityChange[];
    /**
     * Whether the run believes it is thrashing, and why.
     *
     * The run says so DURING the flip rather than leaving it to be found in a file
     * afterwards. Absent when the slot is behaving, which is almost always.
     */
    flip?: ActivityFlip;
    /**
     * Which BitNode the run is in, and when that node was entered.
     *
     * THE SERVER'S SESSION BOUNDARY. A recorded run is one BitNode: the goals, the
     * features that can load and the whole economy change at an install, so a file
     * spanning two of them is two runs sharing a timeline. Without this the server
     * could only tell them apart by the process restarting, which left the operator
     * having to stop and start it by hand at exactly the moment the run resets.
     *
     * `installedAt` is `ns.getResetInfo().lastNodeReset`, the game's own record of when
     * the node was entered. Comparing it is what makes the detection robust: a node
     * number alone cannot see a re-entry into the SAME node, and a node installed
     * before this server started must not look like a transition it missed.
     *
     * Absent when the game cannot read it — the wire allows silence, so a client that
     * omits the field is never mistaken for one reporting a different node.
     */
    bitNode?: BitNodeStamp;
}

/** Which BitNode a run is in, as the game reports it. */
export interface BitNodeStamp {
    /** The node number, from `ns.getResetInfo().currentNode`. */
    node: number;
    /** When this node was entered, in the game's clock. Not a timestamp we wrote. */
    installedAt: number;
}

/** One change of the player's activity slot. */
export interface ActivityChange {
    /** Milliseconds since the run started, matching every other `t` in a recording. */
    readonly t: number;
    /** The action the slot held before, e.g. `UNI:Rothman University:Computer Science`. */
    readonly from: string;
    /** The action it holds now. */
    readonly to: string;
    /** Hacking levels at the moment of the change, so progress either side is visible. */
    readonly hacking: number;
    /**
     * Hacking experience at that moment.
     *
     * Carried because a LEVEL can be flat while experience climbs toward the next one, and
     * "studying but gaining nothing" and "studying slowly" look identical without it.
     */
    readonly hackingExp: number;
}

/** A run that has been alternating between activities. */
export interface ActivityFlip {
    /** The two actions trading places. */
    readonly pair: readonly [string, string];
    /** How many times the slot changed inside the window. */
    readonly changes: number;
    /** The window, in milliseconds, that was examined. */
    readonly windowMs: number;
}

/**
 * The player fields the console renders.
 *
 * The game projects `ns.getPlayer()` onto exactly this shape (`projectPlayer` in
 * `src/game/strategy.ts`). It is deliberately NOT the whole player object: the raw
 * one carries `mults`, a ~30-entry multiplier table nothing here reads, and
 * shipping it whole made the payload 57% dead weight on a one-second loop.
 *
 * As an explicit interface, a field the UI needs must be added here AND to the
 * projection — which is the point. Silence is the failure mode: a field the game
 * sends but this omits is invisible, and a field this declares but the game omits
 * renders blank.
 */
export interface Player {
    hp: { current: number; max: number };
    /** The seven stats, keyed by name. */
    skills: Record<string, number>;
    /** Experience per stat, keyed by name. */
    exp: Record<string, number>;
    city: string;
    location: string;
    /** Spendable cash. Holdings live in `Portfolio`. */
    money: number;
    numPeopleKilled: number;
    karma: number;
    entropy: number;
    /** Milliseconds. */
    totalPlaytime: number;
    factions: string[];
    /**
     * What holds the activity slot, or null when it is empty.
     *
     * The game has ONE activity slot and several features reason about it, each able to
     * report "yielded" while something is running. Without this the console shows two
     * features standing down and cannot tell that from neither doing anything — which is
     * how a course in progress read as a 43-minute deadlock. Null is the case a real
     * stall would show, so an empty slot is the thing to look for.
     */
    work?: WorkProjection | null;
}

/** The activity slot's contents, flattened for the console. */
export interface WorkProjection {
    /** The game's discriminant: CLASS, FACTION, COMPANY, CRIME, CREATE_PROGRAM, GRAFTING. */
    readonly type: string;
    /** Course, faction, company, crime, program or augmentation — whichever applies. */
    readonly what: string;
    /** The venue for CLASS work, the work type for FACTION work, empty otherwise. */
    readonly where: string;
}

/**
 * The gang's own state, published so its decisions can be read rather than inferred.
 *
 * WHY THIS IS ON THE WIRE. The gang has been diagnosed three times from a pressure line
 * that carried three numbers and no gang — `wanted=64.0%`, `rise=1/cycle`, `cleaners=0` —
 * and each reading of it was a guess about which missing figure was the cause. A member
 * count, the wanted level, and the crew the run CHOSE make the gap between "what the rule
 * asks for" and "what the gang is doing" visible in one frame.
 */
export interface GangState {
    readonly members: number;
    /** Whether the gang is still growing, which overrides the money floor. */
    readonly recruiting: boolean;
    /** The mode the run chose for the gang this tick. */
    readonly mode: string;
    readonly wanted: GangWantedState;
}

/** The gang's wanted-level state, as the run sees it. */
export interface GangWantedState {
    /** The gang's wanted level, exactly as the game reports it. */
    readonly level: number;
    /** Net wanted level per cycle. Negative means the level is falling. */
    readonly rate: number;
    /** `respect / (respect + level)`. Multiplies everything the gang earns. */
    readonly penalty: number;
    /** Members currently on the wanted task. */
    readonly cleaners: number;
    /**
     * Mean cleanup per member, as a magnitude.
     *
     * Over the WHOLE roster, which is why it looks small: nine members with one capable
     * cleaner report one ninth of that cleaner's rate. Read `best` to size a crew.
     */
    readonly each: number;
    /** What the BEST member removes per cycle — the figure a crew size is derived from. */
    readonly best: number;
    /** Members the floor requires on cleanup for the level not to rise. */
    readonly holdCrew: number;
}

/**
 * The game's decision state, published so the console can show what the run is
 * doing rather than only raw player stats.
 *
 * This is a REPORT, not a control surface: the game computes it and the UI
 * renders it read-only. No strategy travels this way — the orchestrator owns it.
 */
export interface NexusState {
    /**
     * What each feature is doing, or the guard that stopped it, by feature id.
     *
     * The answer to "why is this stalled?" — `features[].state` says a feature is
     * `active`, which is true whether it is working or has returned early from the
     * same branch for an hour. This is the difference, and it is what makes a
     * deadlock visible rather than something to deduce from frozen numbers.
     */
    statuses?: Record<string, string>;
    /** The goal being worked on, or null when every faction is joined. */
    goal?: {
        /** The achievement, named for display. */
        name: string;
        /** 0..1 how close the run is. */
        progress: number;
        /** The faction this goal closes. */
        faction?: string;
        /** What is still missing to close it. */
        subGoals?: NexusSubGoal[];
        /**
         * Roughly how long the outstanding work would take, in seconds, or null
         * when no measurement says.
         *
         * Published so the console can distinguish "nearly done" from "hours
         * away" — `progress` is a level ratio with no time in it, which is why a
         * multi-hour goal reads as 79%.
         */
        estimateSeconds?: number | null;
    } | null;
    /** How many further goals are queued behind the current one. */
    queued?: number;
    /**
     * The queued goals themselves, nearest first.
     *
     * The count alone made a real question unanswerable: "is a closer target
     * waiting behind this one?" Without the names and their progress, the only
     * way to tell a nearly-finished goal from a multi-hour one was to read the
     * source. Bounded by the caller, since this is a display list.
     */
    queue?: NexusGoal[];
    /** One line per feature the orchestrator knows about. */
    features?: NexusFeature[];
    /** The reserves in force right now, in the orchestrator's own units. */
    reserves?: { cash?: number; homeRamGb?: number };
    /**
     * When the retirement stall clock comes due, or absent when it is not counting.
     *
     * A COUNTDOWN, and the only threshold in the run that cannot be checked against a
     * figure already on the panel. "Five augmentations queued" is visible as a queue; "an
     * hour since the last purchase" is not visible at all, so without this a waiting run
     * and a timer that never armed look identical.
     *
     * Absent, not zero, when there is nothing to count: before a purchase has been
     * measured, or with too few queued for the clock to matter. The UI must treat a
     * missing field as "not counting" rather than as an expired timer.
     */
    stall?: { dueAt: number; queued: number };
}

/** A goal waiting behind the current one. */
export interface NexusGoal {
    /** The achievement, e.g. `join The Syndicate`. */
    name: string;
    /** 0..1 how close the run is, by the same measure as the current goal. */
    progress: number;
    /** Estimated seconds to close, or null when nothing measurable says. */
    estimateSeconds?: number | null;
}

/** A requirement still outstanding for the current goal. */
export interface NexusSubGoal {
    /** What the measurement is, e.g. `hacking`, `money`, `cha`. */
    key: string;
    /** What the player has now. */
    current: number;
    /** What the goal needs. */
    target: number;
    /** The feature ids that can advance it; empty means nothing loaded can. */
    contributors?: string[];
}

/** One feature's status, as the orchestrator sees it. */
export interface NexusFeature {
    /** Stable id, e.g. `hacking`, `stocks`, `gang`. */
    id: string;
    /** Human-readable name. */
    name: string;
    /**
     * Lifecycle state: `active` is ticking; `unavailable` means a capability is
     * missing; `failed`/`unloadable` are faults worth surfacing.
     */
    state: string;
    /** RAM charged for this feature, in GB. */
    ramGb?: number;
    /**
     * The measurements this feature can advance, from its registry declaration.
     *
     * Published so the command bar can offer only goals something loaded can
     * actually serve — the UI derives its options from what the game reports it
     * can do, rather than from a hardcoded list that could drift from the registry.
     * Static metadata, so it costs nothing to send.
     */
    movable?: string[];
}

/** What the player owns, as raw readings; the total is derived downstream. */
export interface Portfolio {
    /** Spendable money, i.e. `Player.money`. */
    cash?: number;
    /**
     * Present only when the player can actually trade. Absent means either no
     * WSE account/TIX API, or the game had no reason to pay the RAM cost.
     */
    stock?: StockBook;
    /** Derived: `cash + stock.value`. Computed in `shared/portfolio.ts`. */
    netWorth?: number;
}

/** The stock book: what is held and what it is worth right now. */
export interface StockBook {
    /** Current market value of all open positions. */
    value: number;
    /** What those positions cost to open — the basis for gain/loss. */
    invested: number;
    /** Number of symbols with a non-zero position. */
    positions: number;
    /** How many symbols were priced, so the UI can qualify the total. */
    symbols: number;
}

/**
 * Resource floors the operator wants held back.
 *
 * These carry no logic here; the game (nexus) maps them onto its own
 * `Context.reserves` (money → `cash`, ram → `homeRamGb`).
 */
export interface Reservations {
    /** Money to keep on hand, in dollars. */
    money: number;
    /** Home RAM to keep free, in GB. */
    ram: number;
}

/** Reserving nothing is the default, so behaviour is unchanged until set. */
export const NO_RESERVATIONS: Reservations = { money: 0, ram: 0 };

/**
 * An operator nudge, sent from the UI to the game.
 *
 * A `Command` is a pure signal the game applies; the server stores and forwards
 * it without interpreting it. Idempotent target state, not an event stream.
 */
export interface Command {
    /** The floor the run must not spend below. */
    reserves?: Partial<Reservations>;
    /** Enable/disable a feature by id; only the game knows what these mean. */
    features?: Record<string, boolean>;
    /**
     * The measurement the operator wants the run to prioritise.
     *
     * A REQUEST, not an instruction: the orchestration derives its goals from
     * player state, so this asks it to prefer a goal it already has rather than
     * to fabricate one. If nothing loaded can advance the measurement, the game
     * reports that instead of pretending.
     */
    goal?: SubGoalKey;
    /** Whether the features are allowed to act, or only observe. */
    autonomy?: Autonomy;
}

/**
 * Whether the orchestrator's features may act.
 *
 * `paused` stops the features ticking while everything else keeps running:
 * telemetry still publishes and commands are still polled, so the console stays
 * live and the pause is reversible. It is not the same as disabling every
 * feature, which is N commands and loses each feature's loaded state.
 */
export type Autonomy = "full" | "paused";

/**
 * The measurements the framework reasons about, and the vocabulary an operator
 * commands in.
 *
 * DUPLICATED BY DESIGN. The game cannot import this file — only `src/game` is
 * synced into Bitburner — so `src/game/lib/objective.ts` carries its own
 * `SubGoalKey` with the same members. **Keep the two in step**: a value here that
 * the game does not know is a command it silently ignores.
 */
export type SubGoalKey =
    | "hacking" | "combat" | "cha" | "money" | "kills" | "karma"
    | "netWorth" | "stockAccess" | "gangRespect" | "gangTerritory" | "rep";

/**
 * What kind of line a framework message is, for the console to colour by.
 *
 * Kept aligned with the game's own `MessageLevel` (`src/game/lib/message-color.ts`)
 * — the game sends the level, the UI decides what colour it means.
 */
export type LogLevel = "error" | "warn" | "success" | "info" | "tx";

/**
 * One framework message, as it crosses the wire.
 *
 * This is an EVENT, not state: unlike `Observation` it is append-only, and the
 * server keeps a history of it rather than replacing it. `seq` is the server's
 * own monotonic counter, which is what lets a reconnecting client ask for only
 * what it missed (`GET /api/log?since=`).
 */
export interface LogLine {
    /** Where it came from, e.g. "SLEEVES", "STOCK", "nexus". */
    readonly tag: string;
    /** The body, uncoloured — the UI applies colour from `level`. */
    readonly message: string;
    readonly level: LogLevel;
    /** When the game produced it, from the game's clock. */
    readonly at: number;
    /** The server's monotonic counter, assigned on receipt. */
    readonly seq: number;
}

/**
 * A batch of lines the game posts to `POST /api/log`.
 *
 * Batched rather than one request per line: the game drains its message port on
 * a cadence and sends what accumulated, so a burst costs one request instead of
 * dozens. `seq` is deliberately absent — the server assigns it.
 */
export interface LogBatch {
    readonly lines: ReadonlyArray<Omit<LogLine, "seq">>;
}
