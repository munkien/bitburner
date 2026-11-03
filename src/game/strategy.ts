/**
 * Local types, inlined so this module has no dependencies that reach outside
 * `src/game`. `src/game` is the single home for Bitburner scripts, synced
 * directly to the game by `bitburner-filesync` (no `dist/` staging), so an
 * import across the `src/game` → `shared` boundary could not be resolved
 * in-game. The authoritative copies live in `src/shared/types.ts` for the
 * server and UI; these mirror them for the game side only.
 */

/** An operator nudge, sent from the UI. */
export interface Command {
    reserves?: { money?: number; ram?: number };
    features?: Record<string, boolean>;
    /** The measurement to prioritise; see `SubGoalKey` in lib/objective.ts. */
    goal?: string;
    /** Whether features may act, or only observe. */
    autonomy?: "full" | "paused";
}

/** Cash and holdings, as raw readings. */
export interface Portfolio {
    cash?: number;
    stock?: {
        value: number;
        invested: number;
        positions: number;
        symbols: number;
    };
}

/** The state published to the server, as a plain object. */
export interface TelemetryState {
    /** When this reading was assembled, from the game's clock. */
    at?: number;
    player?: Player;
    homeRam?: { max?: number; used?: number };
    portfolio?: Portfolio;
    nexus?: NexusState;
    /** Which BitNode this run is in. See `BitNodeStamp` in `shared/types.ts`. */
    bitNode?: BitNodeStamp;
    /** Recent activity transitions. See `ActivityChange` in `shared/types.ts`. */
    activity?: readonly ActivityChange[];
    /** Whether the run is thrashing, and why. See `ActivityFlip`. */
    flip?: ActivityFlip;
    /** The gang's own state. See `GangState` in `shared/types.ts`. */
    gang?: GangState;
}

/** The gang's wanted-level state, as the console reads it. */
export interface GangWantedState {
    level: number;
    rate: number;
    penalty: number;
    cleaners: number;
    each: number;
    best: number;
    holdCrew: number;
}

/** The gang's own state, published by the feature that acts on it. */
export interface GangState {
    members: number;
    recruiting: boolean;
    mode: string;
    /**
     * The gang's total power, as the game reports it.
     *
     * PUBLISHED BECAUSE ITS ABSENCE COST A SESSION. Power is the stat that decides whether
     * the gang can take territory, and it appears nowhere else on the wire — so "the gang
     * has stopped growing stronger" was unverifiable from a recording and had to be
     * reconstructed from a MODE log line that happens to print it.
     */
    power: number;
    /** Share of the map the gang holds, which is what power is FOR. */
    territory: number;
    /** How many rival gangs remain. Zero means all the ground is already taken. */
    enemies: number;
    wanted: GangWantedState;
}

/**
 * A reader for the gang's state, published by the gang feature.
 *
 * A PUBLISHER RATHER THAN A DIRECT READ, for the reason `publishTrainingRate` gives: this
 * module must not import the gang feature, and the feature is the only thing that knows
 * what it decided. One writer, one reader, no second derivation that could disagree.
 *
 * Null until the feature ticks, which is also what a run with no gang reports — the frame
 * then simply has no `gang` field rather than an invented one.
 */
let gangState: (() => GangState | null) | null = null;

/** Set once by the gang feature; passing null clears it (tests). */
export function publishGangState(get: (() => GangState | null) | null): void {
    gangState = get;
}

function readGangState(): GangState | null {
    if (gangState === null) return null;
    try {
        return gangState();
    } catch {
        // Diagnostic state must never break the pass that reports it.
        return null;
    }
}

/** One change of the player's activity slot, as the console reads it. */
export interface ActivityChange {
    t: number;
    from: string;
    to: string;
    hacking: number;
    hackingExp: number;
}

/** A run alternating between two activities. */
export interface ActivityFlip {
    pair: readonly [string, string];
    changes: number;
    windowMs: number;
}

/** Which BitNode the run is in, and when it was entered. */
export interface BitNodeStamp {
    node: number;
    installedAt: number;
}

/**
 * The player fields the console renders.
 *
 * Mirrors `Player` in `src/ui/doc.ts` (inlined so this module stays
 * self-contained in `src/game`). Kept as an explicit shape rather than `unknown`
 * because the projection below is only correct if this and the UI agree — a field
 * the UI needs but this omits would arrive as `undefined` and render as blank.
 */
export interface Player {
    hp: { current: number; max: number };
    skills: Record<string, number>;
    exp: Record<string, number>;
    city: string;
    location: string;
    money: number;
    numPeopleKilled: number;
    karma: number;
    entropy: number;
    totalPlaytime: number;
    factions: string[];
    /**
     * What the player is doing in the single activity slot, as the game reports it.
     *
     * WHY THIS IS ON THE WIRE. Two features can each report "yielded" while an activity
     * is running — Bladeburner deferring to a course, progression standing down because
     * the course it wants is already in the slot. From the status lines alone that is
     * indistinguishable from the two standing down and NOTHING happening, which is what
     * it was read as: a 43-minute "deadlock" that was actually a course in progress.
     *
     * Exp movement was used to guess at this and it is not evidence — a class raises
     * exp whether or not the framework is doing anything sensible. The slot's actual
     * contents are the fact, so it is reported rather than inferred.
     *
     * Null when the slot is empty, which is the case a genuine deadlock would show.
     */
    work: WorkProjection | null;
}

/**
 * The current work, flattened to plain fields.
 *
 * `ns.singularity.getCurrentWork()` returns a discriminated union whose shape varies by
 * type, and the console only needs to name it. `type` plus whichever identifying fields
 * exist is enough to tell a course from a gym session from a contract.
 */
export interface WorkProjection {
    /** The game's discriminant: CLASS, FACTION, COMPANY, CRIME, CREATE_PROGRAM, … */
    readonly type: string;
    /** Course name, faction name, company, crime, or program — whichever applies. */
    readonly what: string;
    /** For CLASS work, the venue. Empty otherwise. */
    readonly where: string;
}

/**
 * The orchestrator's decision state, reported to the console.
 *
 * Mirrors `NexusState` in `src/shared/types.ts` (inlined here so this module
 * stays self-contained in `src/game`). It is a REPORT: the game computes it, the
 * UI renders it read-only.
 */
export interface NexusState {
    /** What each feature is doing, or the guard that stopped it, by feature id. */
    statuses?: Record<string, string>;
    goal?: {
        name: string;
        progress: number;
        faction?: string;
        estimateSeconds?: number | null;
        subGoals?: NexusSubGoal[];
    } | null;
    queued?: number;
    queue?: NexusGoal[];
    features?: NexusFeature[];
    /**
     * Every reserve in force, mirroring `src/shared/types.ts`.
     *
     * KEPT IN STEP BY HAND, which is the drift this file already warns about for `stall` —
     * and it has now happened here: the shared type grew and this copy did not, so the
     * orchestrator failed to compile against its own state. The fields added are the
     * stock-chain reserve and the measured income the other two are derived from.
     */
    reserves?: {
        cash?: number;
        stockAccessCash?: number;
        homeRamGb?: number;
        incomePerSecond?: number | null;
    };
    /**
     * When the retirement stall clock comes due, or absent when it is not counting.
     *
     * Mirrors the same field on `src/shared/types.ts`, which the UI imports. Keep the two
     * in step: the orchestrator writes this shape, and a field added here but not there is
     * a value the console renders as missing.
     */
    stall?: { dueAt: number; queued: number };
}

/** A goal waiting behind the current one. */
export interface NexusGoal {
    name: string;
    progress: number;
    estimateSeconds?: number | null;
}

/** A requirement still outstanding for the current goal. */
export interface NexusSubGoal {
    key: string;
    current: number;
    target: number;
    contributors?: string[];
}

/** One feature's status, as the orchestrator sees it. */
export interface NexusFeature {
    id: string;
    name: string;
    state: string;
    ramGb?: number;
}

/**
 * Sync-server client, used by the nexus orchestrator (`nexus.ts`).
 *
 * This module makes no decisions. It samples facts with `ns.*`, publishes them
 * to the server as plain JSON, and polls for operator commands. All strategy —
 * how money is spent, which features run, what the goal is — is decided by
 * nexus, never here and never on the server.
 *
 * It is a plain Bitburner module: `ns` + `fetch` only, no bundled dependencies.
 * `nexus.ts` is the single entry point that drives it.
 */

const SERVER = "http://127.0.0.1:3000";

/**
 * Poll for an operator nudge and acknowledge it once received.
 *
 * The server stores the latest `Command` until the game confirms it applied it.
 * A nudge is idempotent target state, so "apply" is safe to repeat.
 *
 * Returns null when no command is pending.
 */
export async function pollCommand(): Promise<Command | null> {
    try {
        const res = await fetch(`${SERVER}/api/command`);
        if (res.status === 204) return null;
        if (!res.ok) return null;
        return (await res.json()) as Command;
    } catch {
        return null;
    }
}

/** Confirm the nudge is applied, so the server can accept the next one. */
export async function ackCommand(): Promise<void> {
    try {
        await fetch(`${SERVER}/api/command/ack`, { method: "POST" });
    } catch {
        // Ack is best-effort: a missed ack means the game re-applies an
        // idempotent target state next poll, which is harmless.
    }
}

/** One framework message, as it is sent to the server. */
export interface LogLine {
    tag: string;
    message: string;
    level: "error" | "warn" | "success" | "info" | "tx";
    at: number;
}

/**
 * Publish a batch of framework messages to the server.
 *
 * Batched because the caller drains an in-game message port on a cadence, so a
 * burst costs one request. The server assigns each line its sequence number, so
 * nothing here has to know about ordering or de-duplication.
 *
 * Best-effort like the other calls: a dropped batch costs console lines, and
 * stopping the run over them would be the wrong trade.
 */
export async function publishLog(lines: readonly LogLine[]): Promise<boolean> {
    if (lines.length === 0) return true;
    try {
        const res = await fetch(`${SERVER}/api/log`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lines }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Announce that a new orchestrator execution has started.
 *
 * THE SERVER CANNOT INFER THIS, and the gap is a recording that lies. It already notices a
 * BitNode change from the telemetry frames, but a RESTART leaves the node untouched — a file
 * edit with the sync watcher running, a self-restart after a sync, an operator running
 * `nexus.ts` again — so a restarted run continues the file belonging to the execution it
 * replaced, and the two share a timeline.
 *
 * Called ONCE from `main`, before the first pass, so the first frame of the new execution
 * lands in the new file rather than ending the old one.
 *
 * Best-effort like every other call here: a server that is not running is the ordinary
 * state of a game played without the dashboard, and it must not stop the orchestrator.
 * Returns the recording path when the server names one, purely so the console can say where
 * this run is being written.
 */
export async function announceRun(startedAt: number, build: string): Promise<string | null> {
    try {
        const res = await fetch(`${SERVER}/api/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ startedAt, build }),
        });
        if (!res.ok) return null;
        const body = await res.json() as { recording?: string | null };
        return typeof body.recording === "string" ? body.recording : null;
    } catch {
        // No server, or it went away between ticks. Not an error worth reporting: the
        // orchestrator's job is to play the game, and the recording is a side effect.
        return null;
    }
}

/**
 * Publish the raw facts to the server as plain JSON.
 *
 * No SyncState, no patches: the server is the one that turns this into
 * whatever its SSE stream needs. This module only turns `ns` reads into a
 * plain object and sends it.
 */
export async function publish(state: TelemetryState): Promise<boolean> {
    try {
        const res = await fetch(`${SERVER}/api/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Sample the raw facts the dashboard needs.
 *
 * Each field is a plain reading — no thresholds, no comparisons. The game makes
 * no decision here; it only reports what it sees. `nexus` is passed in by the
 * caller (the orchestrator), which is the only thing that knows its own state.
 */
export function sample(ns: NS, nexus?: NexusState, history?: { activity?: readonly ActivityChange[]; flip?: ActivityFlip }): TelemetryState {
    const gang = readGangState();
    return {
        at: Date.now(),
        player: projectPlayer(ns),
        homeRam: {
            max: ns.getServerMaxRam("home"),
            used: ns.getServerUsedRam("home"),
        },
        portfolio: samplePortfolio(ns),
        nexus,
        // Reported from the game rather than inferred by the server: only the game knows
        // when it entered this node, and this is what lets the server close a session on an
        // install instead of on a process restart. See `BitNodeStamp`.
        bitNode: sampleBitNode(ns),
        // Passed in by the orchestrator, which is the only thing keeping a history. Absent
        // fields rather than empty ones, so a game that does not track this publishes a
        // payload with no `activity` key at all instead of an empty list a reader would have
        // to interpret.
        ...(history?.activity === undefined ? {} : { activity: history.activity }),
        ...(history?.flip === undefined ? {} : { flip: history.flip }),
        // Absent when there is no gang, which is the honest reading rather than a gang of
        // zeroes a reader would have to interpret.
        ...(gang === null ? {} : { gang }),
    };
}

/**
 * Which node this is, and when it began.
 *
 * `getResetInfo` is the cheap route — 1 GB, and not subject to the Singularity RAM
 * multiplier, unlike `getOwnedSourceFiles` — and it is already what the capability
 * detection reads, so this asks the game nothing new.
 *
 * Undefined rather than a guess when it cannot be read: the server treats a frame
 * WITHOUT a stamp as "no opinion about the node" and never as a different one, so a
 * failure here can only mean a session that does not roll, never a spurious roll.
 */
function sampleBitNode(ns: NS): BitNodeStamp | undefined {
    try {
        const info = ns.getResetInfo();
        return { node: info.currentNode, installedAt: info.lastNodeReset };
    } catch {
        return undefined;
    }
}

/**
 * `ns.getPlayer()`, reduced to the fields the console actually renders.
 *
 * WHY THIS EXISTS. The raw object was sent whole, and measured 1768 of a 3080
 * byte payload — 57% of what went over the wire every second. Most of it was
 * `mults`, a table of ~30 multipliers nothing on the UI side reads, plus `jobs`.
 * The UI's own `Player` type described a "trimmed view" from the start; this is
 * the projection that makes that true instead of aspirational.
 *
 * Written as an explicit field list rather than a delete-list, so a field added
 * to the game's player object never silently starts crossing the wire. Anything
 * the console wants has to be named here, which is the correct amount of
 * friction: `mults` alone was quadrupling the payload because nobody asked.
 */
function projectPlayer(ns: NS): Player {
    const p = ns.getPlayer();
    return {
        hp: { current: p.hp.current, max: p.hp.max },
        skills: { ...p.skills },
        exp: { ...p.exp },
        city: p.city,
        location: p.location,
        money: p.money,
        numPeopleKilled: p.numPeopleKilled,
        karma: p.karma,
        entropy: p.entropy,
        totalPlaytime: p.totalPlaytime,
        factions: [...p.factions],
        work: projectWork(ns),
    };
}

/**
 * What holds the activity slot, or null when it is empty.
 *
 * Never throws: `getCurrentWork` needs the Singularity API, and a run without it must
 * report "nothing running" rather than fault the telemetry that everything else reads.
 */
function projectWork(ns: NS): WorkProjection | null {
    let task: ReturnType<NS["singularity"]["getCurrentWork"]>;
    try {
        task = ns.singularity.getCurrentWork();
    } catch {
        return null;
    }
    if (task === null) return null;

    // One case per variant of the game's `Task` union. Written as a switch on the
    // discriminant rather than a field probe, so a variant added to the game is a
    // compile error here rather than a blank row in the console.
    switch (task.type) {
        case "CLASS": return { type: task.type, what: task.classType, where: task.location };
        case "COMPANY": return { type: task.type, what: task.companyName, where: "" };
        case "CREATE_PROGRAM": return { type: task.type, what: task.programName, where: "" };
        case "CRIME": return { type: task.type, what: task.crimeType, where: "" };
        case "FACTION": return { type: task.type, what: task.factionName, where: task.factionWorkType };
        case "GRAFTING": return { type: task.type, what: task.augmentation, where: "" };
    }
}

/**
 * Sample cash and the stock book.
 *
 * The stock API is gated behind a WSE account and TIX API access, and each
 * portfolio call costs ~2 GB. Both accessor calls are cheap (0.05 GB), so we
 * check them first and skip the expensive loop entirely when the player cannot
 * trade — otherwise every tick would pay for readings that are always zero.
 */
function samplePortfolio(ns: NS): Portfolio {
    const portfolio: Portfolio = { cash: ns.getServerMoneyAvailable("home") };

    if (!ns.stock.hasWseAccount() || !ns.stock.hasTixApiAccess()) {
        return portfolio;
    }

    const symbols = ns.stock.getSymbols();
    let value = 0;
    let invested = 0;
    let positions = 0;

    for (const sym of symbols) {
        const [sharesLong, avgLongPrice, sharesShort, avgShortPrice] =
            ns.stock.getPosition(sym);
        if (sharesLong <= 0 && sharesShort <= 0) continue;

        positions += 1;
        value += (sharesLong + sharesShort) * ns.stock.getPrice(sym);
        invested += sharesLong * avgLongPrice + sharesShort * avgShortPrice;
    }

    portfolio.stock = {
        value,
        invested,
        positions,
        symbols: symbols.length,
    };

    return portfolio;
}
