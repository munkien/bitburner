import type { BladeburnerActionName, BladeburnerActionType, BladeburnerSkillName, NS } from "@ns";

import { publishBladeburnerActivity } from "../../lib/bladeburner-activity.ts";
import type { Context } from "../../lib/context.ts";
import { bladeburnerYieldsForTraining, hasSingularityWork, trainingRemaining, trainingWantedHeld, winnableBlackOp } from "../player/activity.ts";
import { announce, clearStatus, publishStatus, shortError } from "../../lib/log.ts";

/*
 * ============================================================================
 * BLADEBURNER
 * ============================================================================
 * Runs contracts, operations and black ops, resting when stamina runs low and
 * relocating when chaos gets out of hand.
 *
 * It owns joining the division itself. The capability rule for `bladeburner`
 * deliberately does not require membership for that reason: requiring it would
 * gate the feature behind its own first action.
 *
 * The standalone `main` loop is gone. It was an orphan: the orchestrator never
 * knew about it, and having two entry points meant two places to keep correct.
 * ============================================================================
 */

/** A finished Bladeburner run is a fact about the save, not about this session. */
const DONE_FLAG = "bladeburner_done.txt";

/**
 * The maximum level to buy in each skill. `Infinity` means "keep buying it".
 *
 * HOW `buySkills` USES THIS. It repeatedly buys the CHEAPEST wanted skill, and `wanted`
 * is every skill whose level is below its cap here. So a cap is not a priority order — it
 * is a hard ceiling, and a cap of 0 means the skill is never bought at all, however cheap
 * it is and however many points are sitting unspent.
 *
 * WHY FOUR OF THESE CHANGED, and the reasoning is worth keeping because a cap looks like a
 * tuning knob and is actually a decision about what the division is for.
 *
 * Three were previously 0 or 10, which meant the division deliberately never bought them.
 * What they do makes that hard to justify (values from the game's own skill table):
 *
 *   Cyber's Edge     +2% MAX STAMINA per level, cost 1 × 3^n
 *   Hands of Midas   +10% money from Contracts per level, cost 2 × 2.5^n
 *   Hyperdrive       +10% experience from Contracts/Operations/BlackOps, cost 1 × 2.5^n
 *
 * The stamina one is the sharpest, and it is the reason this is a bug rather than a
 * preference. Everything this feature does is gated on stamina: below `REST_BELOW` it
 * stops working, and it rests until `REST_UNTIL`. Those are FRACTIONS of max stamina, so a
 * bigger pool does not change the rest/work RATIO — but it does mean each cycle works
 * longer in absolute terms, which is rank and money the division otherwise never earns.
 * Leaving it at 0 made a permanent ~45%-of-the-time rest unavoidable for the whole run, at
 * the cheapest first levels in the tree.
 *
 * Hands of Midas and Hyperdrive are the division's income and its levelling rate, both
 * cheap and both compounding, and neither was being bought at all.
 *
 * Datamancer is deliberately LEFT AT 0 — see the note on it below.
 *
 * The caps that remain finite (`Cloak` 25, `Short-Circuit` 25, `Tracer` 10) are unchanged.
 * Those are success-chance skills for specific action GROUPS, and once a group's actions
 * are comfortably above `MIN_CHANCE` more of the same skill buys nothing measurable, which
 * is a defensible ceiling in a way that 0 for stamina is not.
 */
const SKILL_CAPS: Readonly<Partial<Record<BladeburnerSkillName, number>>> = {
    "Blade's Intuition": Infinity, "Cloak": 25, "Short-Circuit": 25,
    "Digital Observer": Infinity, "Tracer": 10, "Overclock": Infinity,
    "Reaper": Infinity, "Evasive System": Infinity,
    /**
     * Datamancer: +5% to the ACCURACY of the synthoid population estimate.
     *
     * The one of the four whose cap of 0 is defensible, so it is left alone. It does not
     * raise a success chance, earn money or grant experience — it narrows the error bars on
     * a READING, and the reading it narrows is the population estimate, which the framework
     * does not act on directly. Buying it would spend points on better information about a
     * number nothing here consumes.
     *
     * If the division is ever made to chase population-based actions, this is the cap to
     * revisit first, and that is why it is called out rather than silently left at 0.
     */
    "Datamancer": 0,
    "Cyber's Edge": Infinity, "Hands of Midas": Infinity, "Hyperdrive": Infinity,
};

type Act = readonly [type: BladeburnerActionType, name: BladeburnerActionName];

const WORK: readonly Act[] = [
    ["Operations", "Assassination"],
    ["Operations", "Stealth Retirement Operation"],
    ["Operations", "Undercover Operation"],
    ["Operations", "Investigation"],
    ["Contracts", "Retirement"],
    ["Contracts", "Bounty Hunter"],
    ["Contracts", "Tracking"],
];

const REST: Act = ["General", "Hyperbolic Regeneration Chamber"];
const TRAIN: Act = ["General", "Training"];
const FIELD: Act = ["General", "Field Analysis"];
const RECRUIT: Act = ["General", "Recruitment"];
const DIPLOMACY: Act = ["General", "Diplomacy"];

/**
 * The estimated success chance an action must clear to be worth taking.
 *
 * COMPARED AGAINST THE MIDPOINT of the estimate interval, not its minimum — see `safe` in
 * `pickAction` for why, and note that `safeChanceOf` applies the same rule so the two cannot
 * disagree. The bar itself is unchanged at 0.8: with a midpoint the effective bar is looser,
 * and lowering the number as well would be two changes to the same knob at once.
 *
 * Below this the action is refused and the division does something else — Field Analysis if
 * anything looks reachable, Training otherwise. Failing an action costs the action's time
 * and a stamina hit, which is the cost this bar is sized against.
 */
const MIN_CHANCE = 0.8;
const REST_BELOW = 0.5;
const REST_UNTIL = 0.95;
const CHAOS_MAX = 50;
const CITY_MARGIN = 1.1;
const AUTOLEVEL = true;
const TEAM_SIZE = 5;

/** Actions that run out of counts, so "am I still busy?" has to be checked. */
const COUNTED_ACTION_TYPES: ReadonlySet<string> = new Set(["Contracts", "Operations"]);

const teamed = (a: Act): boolean => a[0] === "Operations" || a[0] === "Black Operations";

function buySkills(ns: NS): void {
    const bb = ns.bladeburner;
    let points = bb.getSkillPoints();
    const upgraded = new Map<BladeburnerSkillName, number>();

    while (true) {
        const wanted = bb.getSkillNames().filter(s => bb.getSkillLevel(s) < (SKILL_CAPS[s] ?? 0));
        if (wanted.length === 0) break;

        const cheapest = wanted.reduce((min, s) =>
            bb.getSkillUpgradeCost(s) < bb.getSkillUpgradeCost(min) ? s : min
        );

        const cost = bb.getSkillUpgradeCost(cheapest);
        if (cost > points) break;

        if (bb.upgradeSkill(cheapest)) {
            points -= cost;
            upgraded.set(cheapest, (upgraded.get(cheapest) ?? 0) + 1);
        } else {
            break;
        }
    }

    for (const [skill, levels] of upgraded) {
        announce(ns, "BLADEBURNER", `SKILL +${levels} ${skill} (now ${bb.getSkillLevel(skill)})`, "success");
    }
}

function pickCity(ns: NS): void {
    const bb = ns.bladeburner;
    const here = bb.getCity();
    const hereOk = bb.getCityChaos(here) <= CHAOS_MAX;
    let best = here;
    let bestPop = hereOk ? bb.getCityEstimatedPopulation(here) * CITY_MARGIN : 0;

    for (const c of Object.values(ns.enums.CityName)) {
        if (c === here || bb.getCityChaos(c) > CHAOS_MAX) continue;
        const pop = bb.getCityEstimatedPopulation(c);
        if (pop > bestPop) { best = c; bestPop = pop; }
    }

    if (best !== here) {
        announce(ns, "BLADEBURNER", `Relocating to ${best} (Population: ${ns.format.number(bestPop)})`, "tx");
        bb.switchCity(best);
    }
}

/**
 * The next black op to start, when it is winnable.
 *
 * `winnableBlackOp` (in `activity.ts`) is the shared predicate both features use,
 * so this holds the two to the same answer. It only returns the name/action shape
 * to hand to `startAction`/`setTeamSize`; the decision that the op is worth the
 * slot lives in that one place.
 */
function nextBlackOp(ns: NS): Act | null {
    if (!winnableBlackOp(ns)) return null;
    const bo = ns.bladeburner.getNextBlackOp();
    return bo ? (["Black Operations", bo.name] as const) : null;
}

function pickAction(ns: NS, currentName?: string): Act {
    const bb = ns.bladeburner;

    if (bb.getCityChaos(bb.getCity()) > CHAOS_MAX) return DIPLOMACY;

    const [stam, stamMax] = bb.getStamina();
    const idling = currentName === "Hyperbolic Regeneration Chamber";
    const tired = stam / stamMax < (idling ? REST_UNTIL : REST_BELOW);

    // If we are resting, stay resting until we hit REST_UNTIL
    if (idling && stam / stamMax < REST_UNTIL) return REST;
    if (!idling && tired) return REST;

    if (TEAM_SIZE > 0) {
        for (const a of WORK) {
            if (teamed(a) && bb.getTeamSize(a[0], a[1]) < TEAM_SIZE) {
                bb.setTeamSize(a[0], a[1], TEAM_SIZE);
            }
        }
        const bo = bb.getNextBlackOp();
        if (bo && bb.getTeamSize("Black Operations", bo.name) < TEAM_SIZE) {
            bb.setTeamSize("Black Operations", bo.name, TEAM_SIZE);
        }
    }

    let hopeful = false;
    /**
     * Whether an action's estimated success chance clears the bar.
     *
     * THE BAR IS THE MIDPOINT OF THE ESTIMATE, not its minimum, and that is a deliberate
     * loosening with a stated reason rather than a nudge.
     *
     * `getActionEstimatedSuccessChance` returns `[MIN, MAX]` — an UNCERTAINTY INTERVAL, not
     * a probability — so its bounds are how well the division knows the answer, not how good
     * the action is. Requiring the minimum to clear the bar therefore conflates the two: an
     * action whose true chance is comfortably high but whose estimate is wide is refused for
     * being POORLY MEASURED rather than for being risky. That is self-reinforcing, because
     * the skill that narrows these intervals is Datamancer and the fallback that improves
     * them is Field Analysis — so the more uncertain the division is, the less it does, and
     * the less it learns.
     *
     * The midpoint is the unbiased reading: for a symmetric interval it is the division's
     * best guess, so an action is taken when the division BELIEVES it clears the bar.
     *
     * `hi` is still recorded in `hopeful`, which is what decides between Field Analysis and
     * Training when nothing is safe — the interval's upper bound is exactly the "this could
     * be good if I knew more" signal that choice is looking for.
     */
    const safe = (a: Act, min: number): boolean => {
        const [lo, hi] = bb.getActionEstimatedSuccessChance(a[0], a[1]);
        hopeful ||= hi >= min;
        return (lo + hi) / 2 >= min;
    };

    let work: Act | null = nextBlackOp(ns);
    work ??= bestWork(ns, safe) ?? null;

    // An understrength team means RECRUIT FIRST, before taking the action.
    //
    // WHY THIS IS ABOVE `if (work)`, WHICH IT WAS NOT. The old order was:
    //
    //     if (work) return work;
    //     if (needTeam) return RECRUIT;
    //
    // and `needTeam` can only be true when `work` is non-null — `teamed(work)` dereferences
    // it. So the first line always fired and `RECRUIT` was UNREACHABLE. Operations and Black
    // Ops therefore ran with whatever team the `setTeamSize` loop above had managed to set,
    // and neither `RECRUIT` nor the `hopeful ? FIELD : TRAIN` fallback was ever reached from
    // this branch.
    //
    // The consequence was not a crash but a permanent understrength division: team size feeds
    // success chance and time, so every teamed action was takeable only at a worse chance
    // than the player had earned, and `MIN_CHANCE` then refused the ones that fell short —
    // which reads as the feature being lazy rather than as a staffing problem.
    //
    // Recruiting before the action is also the correct order regardless of the bug: filling a
    // team takes its own action, so a team that is short now is short for the action too.
    const needTeam = work !== null && teamed(work) && bb.getTeamSize(work[0], work[1]) < TEAM_SIZE;

    if (needTeam) return RECRUIT;
    if (work) return work;

    return hopeful ? FIELD : TRAIN;
}

/**
 * Why no contract or operation is takeable, as a log-ready sentence.
 *
 * WHY THIS EXISTS. `Training` is the fallback for "nothing is safe", and it is the one
 * branch with no report at all: the division starts it once, announces the switch, and then
 * says nothing for as long as it runs. A run spent forty minutes there with no way to tell
 * whether that was patience or a defect — the same "reads as patience, might be stuck"
 * failure this file has already been repaired for twice (the understrength team, and the
 * finished rest that never released the slot).
 *
 * The full list is printed rather than a summary, because the interesting question is never
 * "is anything safe" but "HOW FAR below the bar is the best one" — a division at 0.78 on its
 * best action is minutes from resuming, while one at 0.3 needs a great deal more training.
 * Those look identical from the action name alone.
 *
 * Read-only: it takes the same estimates `pickAction` takes and must not change what the
 * feature does. That is why it is called only on the fallback path.
 *
 * Exported for tests. The decision it describes is the one nobody can see from the outside,
 * so being able to assert its wording is worth more here than keeping it private.
 */
export function describeFallback(ns: NS): string {
    const bb = ns.bladeburner;
    const lines: string[] = [];

    for (const [type, name] of WORK) {
        try {
            const counts = bb.getActionCountRemaining(type, name);
            const [lo, hi] = bb.getActionEstimatedSuccessChance(type, name);
            const mid = (lo + hi) / 2;
            const verdict = counts < 1
                ? "no counts"
                : mid >= MIN_CHANCE ? "TAKEABLE" : `below ${MIN_CHANCE}`;
            lines.push(`${name}: ${mid.toFixed(3)} (${lo.toFixed(2)}-${hi.toFixed(2)}) counts=${counts} ${verdict}`);
        } catch (error) {
            lines.push(`${name}: unreadable (${shortError(error)})`);
        }
    }

    return lines.join("; ");
}

/**
 * The best safe action available, or null when none is.
 *
 * WHY THIS REPLACED A `WORK.find`. The old selection returned the first entry of a
 * hardcoded list that satisfied two conditions — has counts left, and succeeds at
 * `MIN_CHANCE` — with Operations listed above Contracts. That is an ORDER, not a
 * ranking: it can only ever pick the topmost acceptable action, so as the player's rank
 * and the actions' levels rise it keeps re-selecting the same entry and never climbs to
 * a better one. Reported as the feature being "stuck at the one bladeburner task".
 *
 * The order here is still Operations before Contracts, because an Operation grants more
 * rank than a Contract at the same level. What changed is what happens WITHIN that
 * grouping: candidates are compared on their actual rep and rank gain per second, so a
 * higher-level contract the player has grown into now outranks a lower-level one
 * instead of losing to whichever happened to be listed first.
 *
 * Actions are ranked by `getActionRepGain` per second of `getActionTime`, and that is
 * the figure that reflects what the division actually pays out. `getActionCurrentLevel`
 * is deliberately NOT the ranking key: it rises on its own (AUTOLEVEL is on) and is
 * therefore a property of the action rather than a reason to prefer it.
 */
function bestWork(ns: NS, safe: (a: Act, min: number) => boolean): Act | null {
    const bb = ns.bladeburner;

    let best: Act | null = null;
    let bestScore = 0;
    let bestIsOperation = false;

    for (const action of WORK) {
        const [type, name] = action;

        // Counts are what bound a contract: one at zero cannot be started at all.
        if (bb.getActionCountRemaining(type, name) < 1) continue;
        if (!safe(action, MIN_CHANCE)) continue;

        // An Operation beats a Contract outright, so the two are compared in tiers
        // rather than on one scale: an Operation's rank gain has no equivalent in a
        // Contract, and folding them into a single number would invent a conversion the
        // game does not have. Within a tier, the better rep-and-rank per second wins.
        const isOperation = type === "Operations";
        const better = best === null
            || (isOperation && !bestIsOperation)
            || (isOperation === bestIsOperation && scoreOf(ns, action) > bestScore);

        if (!better) continue;

        best = action;
        bestScore = scoreOf(ns, action);
        bestIsOperation = isOperation;
    }

    return best;
}

/**
 * What an action pays per second, for ranking. Zero when it cannot be measured, which
 * sorts it below anything that can — an unreadable action is not a reason to abandon a
 * readable one.
 *
 * `getActionTime` returning 0 would make the ratio infinite, so it is treated as
 * unmeasurable rather than as an instant action.
 */
function scoreOf(ns: NS, action: Act): number {
    const bb = ns.bladeburner;
    const [type, name] = action;

    try {
        const seconds = bb.getActionTime(type, name);
        if (!Number.isFinite(seconds) || seconds <= 0) return 0;

        const rep = bb.getActionRepGain(type, name);
        const rank = bb.getActionRankGain(type, name);
        if (!Number.isFinite(rep) || !Number.isFinite(rank)) return 0;

        // Rep is the scarcer of the two — rank comes quickly and caps early — so it
        // dominates the score and rank breaks ties.
        return (rep + rank / 1_000) / seconds;
    } catch {
        return 0;
    }
}

/**
 * Whether a running action is one this feature would have chosen.
 *
 * The framework's own choices come from `WORK`, plus the black ops, the general
 * actions, and a rest. Anything else is the player's — most commonly a
 * high-ranked Operation or a Black Operation the framework does not consider, and
 * those must not be reported as "not the best available" merely because they are
 * absent from `WORK`.
 *
 * Matched on NAME rather than type, because that is what distinguishes the choices:
 * several actions share a type, and a name outside this set is a deliberate act by
 * the player.
 */
function isFrameworkChoice(ns: NS, name: string): boolean {
    if (name === "Idle") return true;
    if (name === REST[1] || name === TRAIN[1] || name === FIELD[1] || name === RECRUIT[1] || name === DIPLOMACY[1]) {
        return true;
    }
    if (WORK.some(a => a[1] === name)) return true;

    // A black op the division is offering is one this feature starts deliberately, so
    // it is not a manual choice either.
    try {
        const bo = ns.bladeburner.getNextBlackOp();
        if (bo && bo.name === name) return true;
    } catch {
        // Not in the division, or the API is unavailable: fall through to "not ours".
    }

    return false;
}

/**
 * The safety predicate, exposed so the reconsideration path can ask the same question
 * `pickAction` asks rather than reimplementing the threshold.
 */
function safeChanceOf(ns: NS): (a: Act, min: number) => boolean {
    return (a: Act): boolean => {
        try {
            // The MIDPOINT of the estimate interval, matching `safe` in `pickAction`
            // exactly. The two must not disagree: this one decides whether a hand-started
            // action is worth replacing, so a stricter bar here would let the feature
            // announce "switching to X when it finishes" for an X it would itself have
            // refused to start.
            const [lo, hi] = ns.bladeburner.getActionEstimatedSuccessChance(a[0], a[1]);
            return (lo + hi) / 2 >= MIN_CHANCE;
        } catch {
            return false;
        }
    };
}

let hasJoinedFaction = false;

/**
 * The manually-started action already reported as "not the best available", or null.
 *
 * A condition rather than an event: it holds for as long as the player's action runs,
 * which for a Black Operation is minutes against a 5-second tick. Reported on the
 * transition into it, like the other condition logs here, so the ring is not filled with
 * the same sentence.
 */
let lastReconsiderReported: string | null = null;

/**
 * Whether the "not in Bladeburner" fallback has been reported since it became
 * true. The join call happens on a repeating tick path: when the player's combat
 * stats do not meet the 100 threshold yet, `joinBladeburnerDivision` keeps
 * failing to move `inBladeburner` off false, and an unconditional announce would
 * print "Joining the Division." every tick forever (the reported bug).
 */
let joinBlockedReported = false;

/**
 * The last action reported, including the pseudo-state "Resting".
 *
 * Deliberately not `lib/log.ts`. That helper compares a value and prints it when
 * it changes, whereas this logs a computed message — stamina percentage and rank
 * — on a transition between two states, and one of those states is a member task
 * rather than an action. Expressing that with `ChangeOnce` would mean
 * reconstructing the message from stored parts every tick, which is more code
 * than the comparison it would replace.
 */
let lastLoggedAction = "";

/*
 * "Is this feature mid-chain?" used to be a local `holdsSlot` here. It now lives
 * in `lib/activity.ts` as `bladeburnerHoldsChain`, because PROGRESSION needs the
 * same answer, and the two asking separately is what produced a deadlock:
 *
 *   Bladeburner yielded when  !holdsSlot && trainingRemaining(...)
 *   Progression yielded when  hasBladeburnerAction(...)
 *
 * With a chain in flight and training outstanding, Bladeburner kept its action
 * while progression stood down — and neither ran. Measured live as no progression
 * action announced for 130 log entries, money and experience both frozen. One
 * exported predicate means the two sides cannot disagree again.
 */

/**
 * Forget the feature's cross-tick memory.
 *
 * Exported for tests, which share one process and would otherwise inherit each
 * other's logging state. `holdsSlot` needs no reset because it is derived from the
 * running action rather than remembered, which is the other reason to prefer the
 * derived form (see above). Matches the convention `stocks.ts` and `darknet.ts`
 * already follow for their module state.
 */
export function reset(): void {
    lastLoggedAction = "";
    hasJoinedFaction = false;
    joinBlockedReported = false;
    lastReconsiderReported = null;
    reason = "";
    clearStatus("bladeburner");
}

/**
 * What the division is doing, or why it stood down.
 *
 * The counterpart to progression's reason, and the pair is what makes a stall
 * readable: a deadlock needs BOTH features to be idle, so seeing one reason
 * without the other says only half of it.
 */
let reason = "";

/**
 * The last action seen, published for features that cannot see Bladeburner themselves.
 *
 * Set on every tick that reads `getCurrentAction()`, so it is current rather than
 * sticky — a stale "running: true" would keep hacknet spending hashes on Bladeburner for
 * the rest of the run after the division stopped working.
 *
 * Read through the getter closure rather than captured, for the same reason the status
 * publisher is: the action is read further down this function than the registration.
 */
let actionRunning = false;

export function tick(ns: NS, context: Context): void {
    const bb = ns.bladeburner;

    // CLEARED EVERY TICK, because `reason` is a statement about THIS tick and nothing
    // else. It used to be written only on the branches that take an action, so any tick
    // that returned without one left the previous answer standing — and the one answer
    // that could never be corrected was the initial "starting", which meant a division
    // that had wedged reported "starting" for the rest of the run. Measured live: 3,215
    // consecutive telemetry samples, 23 minutes, with nothing running and `reason` never
    // moving. A blank reason now reads as "nothing to report", which `publishStatus`
    // turns into "starting" exactly once per tick rather than forever.
    reason = "";
    publishStatus("bladeburner", () => reason || "starting");

    // Published every tick, including the early returns below — the not-in-division
    // branch publishes "not running", which is the truth when there is no division and
    // the safe reading for a reader deciding whether to spend hashes on one.
    publishBladeburnerActivity({
        running: actionRunning,
        rank: bb.inBladeburner() ? Math.max(0, bb.getRank()) : 0,
    });

    if (!bb.inBladeburner()) {
        // Joining is attempted every tick, but the branch is left for good once
        // the player is a member. Two lines can come out of it, and each fires at
        // most once rather than on the repeating tick path (the reported bug):
        //   - success: "Joining the Division." the moment it takes
        //   - stats too low: one "cannot join" with the blocker, then silence
        const joined = bb.joinBladeburnerDivision();
        if (joined) {
            announce(ns, "BLADEBURNER", "Joining the Division.", "tx");
            joinBlockedReported = false;
        } else if (!joinBlockedReported) {
            const skills = context.snapshot.player.skills;
            announce(
                ns, "BLADEBURNER",
                `Cannot join: combat stats below 100 ` +
                `(str ${skills.strength}, def ${skills.defense}, ` +
                `dex ${skills.dexterity}, agi ${skills.agility}).`,
                "warn",
            );
            joinBlockedReported = true;
        }
        return;
    }

    joinBlockedReported = false;

    if (!hasJoinedFaction && bb.getRank() >= 25) {
        hasJoinedFaction = bb.joinBladeburnerFaction();
        if (hasJoinedFaction) announce(ns, "BLADEBURNER", "Joined the Bladeburner Faction!", "success");
    }

    if (!bb.getNextBlackOp() && !ns.fileExists(DONE_FLAG)) {
        announce(ns, "BLADEBURNER", `All Black Ops complete! Writing signal to ${DONE_FLAG}`, "success");
        ns.write(DONE_FLAG, "1", "w");
    }

    if (AUTOLEVEL) {
        for (const [t, n] of WORK) {
            if (!bb.getActionAutolevel(t, n)) bb.setActionAutolevel(t, n, true);
        }
    }

    buySkills(ns);
    pickCity(ns);

    const current = bb.getCurrentAction();
    const currentName = current?.name;
    // Published for `hacknet`, which cannot see a Bladeburner action through the
    // Singularity API. Set here, where the action is actually read, so it cannot
    // describe a state this tick did not observe.
    actionRunning = current !== null;

    // A contract or operation can run out of counts; every other action cannot.
    // The game reports the current action as plain strings, so narrow it here,
    // once, instead of casting at each call site.
    const running: { type: BladeburnerActionType; name: BladeburnerActionName } | null =
        current !== null && COUNTED_ACTION_TYPES.has(current.type)
            ? { type: current.type as BladeburnerActionType, name: current.name as BladeburnerActionName }
            : null;
    const actionExpired = running !== null && bb.getActionCountRemaining(running.type, running.name) <= 0;

    // Only pick a new action if we are idle, resting and finished, or our current contract ran out of counts
    const [stam, stamMax] = bb.getStamina();
    const isResting = currentName === "Hyperbolic Regeneration Chamber";
    const needsRest = !isResting && stam / stamMax < REST_BELOW;
    const finishedResting = isResting && stam / stamMax >= REST_UNTIL;

    // The player has one activity slot. Progression yields while this feature has
    // an action running (see `player.ts`), so the two never fight over it. What
    // remains is the tie when this feature is being asked to pick a new action —
    // either because the slot is idle, or because the running action's counts ran
    // out. Both are the same question: should the slot stay with Bladeburner, or
    // go back to training?
    //
    //   - NOT mid-chain: yield to outstanding training. A gym class or course is
    //     far faster than the experience here, so taking the slot when a stat is
    //     below its floor is not worth it.
    //   - Mid-chain (`holdsSlot`): continue. This is the half that prevents the
    //     deadlock — progression will not take the slot back while an action is
    //     running, so yielding here would leave BOTH features idle until something
    //     unrelated changed. An expired contract is exactly this case, which is why
    //     the guard covers `actionExpired` and not only `idle`.
    //
    // Resting is exempt either way. Stamina gates every action this feature can
    // take, so a rest that never happened would leave the division unusable — and
    // the player is free to train again once stamina is back.
    // `getCurrentAction()` returns NULL when nothing is running — there is no "Idle"
    // action. This used to also test `currentName === "Idle"`, which the game can never
    // return: `BladeburnerActionName` has no such member, and the implementation returns
    // `null` rather than an action object when `bladeburner.action` is unset. The check
    // was unreachable, and the `!current` half is what actually covers idleness.
    const idle = !current;
    const wantsToStart = idle || actionExpired || needsRest || finishedResting;

    // A manually-started action the framework did not choose.
    //
    // WHY THIS EXISTS. The gate above reacts to three things: idleness, expiry, and
    // stamina. A player who starts an action by hand produces NONE of them — the game
    // reports it as running, an action with no counts never expires, and a rested player
    // is not tired. So the feature returned here on every tick, for the whole run, and
    // reported nothing: it was managing nothing and it looked like it was stuck.
    //
    // "Reconsider without interrupting" is the rule, and the two halves are separate.
    // Reconsider: if the manual action is not what this feature would have picked, plan
    // to replace it. Without interrupting: do NOT call `startAction` on a running action,
    // because that cancels the player's choice and throws away whatever progress it has.
    // The replacement waits for a boundary the player will not notice — the action
    // finishing on its own, or the action having no counts left to lose.
    //
    // Worth noting what this deliberately does NOT do. It does not treat a manual action
    // as authoritative and leave it alone forever: the player's instruction was to have
    // the framework manage the division, and a single hand-started action is not that.
    // It also does not snapshot the manual choice into module state; the running action is
    // read from the game every tick, so the state cannot go stale.
    if (!idle && !actionExpired && !needsRest && !finishedResting) {
        if (currentName !== undefined && isFrameworkChoice(ns, currentName)) {
            // SAID, NOT SILENT. This is the common case — an action this feature chose is
            // running and there is no reason to interrupt it — and it used to return with
            // `reason` left blank, which `publishStatus` renders as "starting".
            //
            // That is the worst possible label for a division that is working normally. It
            // is the same string a wedged feature shows, so a healthy run and a deadlock
            // read identically on the dashboard and in every recording. Measured in
            // `runs/2026-11-03T21.24.46.416Z--16`: 45 of 45 frames reported "starting"
            // while hacking climbed 912 -> 926 and money 7.2b -> 10.8b, and the run was
            // diagnosed as stalled on that basis before the experience figures were read.
            reason = `holding ${currentName} (${current.type})`;
            return;
        }

        // Not what we would pick. Log the intention once, then wait for a boundary.
        if (lastReconsiderReported !== currentName) {
            lastReconsiderReported = currentName ?? null;
            const better = bestWork(ns, safeChanceOf(ns));
            announce(
                ns, "BLADEBURNER",
                better === null
                    ? `Holding manually-started "${currentName}" — no safe alternative yet.`
                    : `Manual action "${currentName}" is not the best available; ` +
                      `switching to "${better[1]}" when it finishes.`,
                "warn",
            );
        }
        return;
    }

    // The requested action has begun, so the report is spent and a later manual choice
    // should be reported again.
    lastReconsiderReported = null;

    // A rest that has done its job must be ENDED when the slot is handed back, not merely
    // abandoned while it still runs.
    //
    // This is the fix for sitting in the Hyperbolic Regeneration Chamber at full stamina.
    // The chamber is a Bladeburner action as far as everyone else is concerned —
    // `hasBladeburnerAction` excludes only "Idle" — so while it runs, progression treats the
    // slot as taken and will not train. But `holdsSlot` here excludes the chamber, because a
    // rest is not a chain. The yield below therefore returned with the chamber still running:
    // Bladeburner yielded, progression stayed off the slot, and both stood down with the
    // player resting at full stamina indefinitely.
    //
    // The yield is correct — a finished rest should hand the slot back — it just has to
    // actually release it. `stopBladeburnerAction` is the game's own "end the current
    // action" call, which leaves the division Idle so progression can take the slot.
    //
    // So a rest that reached `REST_UNTIL` is the one case where `idle` is not required: the
    // action is still running, and it is the thing being handed back. Every other tick asks
    // "am I idle", because a division with an action in flight has a claim and dropping it
    // merely alternates with training over the same slot.
    // WITH THE BLADE'S SIMULACRUM THERE IS NO SLOT TO YIELD. The augment stops
    // Bladeburner actions occupying the activity slot at all, so training and the
    // division run at the same time and handing the slot back would be giving away
    // something the division was never holding. The yield below is therefore
    // skipped entirely when it is owned, and the feature carries on picking its own
    // actions.
    const sharesSlot = !context.capabilities.has("bladesSimulacrum");
    // The SHARED predicate, so this side and progression cannot disagree about who
    // owns the slot. It is the same condition as `holdsSlot` above, expressed once
    // — see `bladeburnerYieldsForTraining`, which documents the deadlock that
    // asking two different questions produced.
    //
    // YIELDS TO TRAINING ONLY ON A CLAIM, and `idle` is the other half of that. Yielding on a
    // tick where this feature is already holding an action would throw the action away and
    // still leave the slot with nobody: progression assigns nothing while the work is in
    // flight, so its retry is a tick later, and the two alternate. Whoever holds it keeps it,
    // and on a shared slot with training wanted and nothing in flight, that is training.
    //
    // `finishedResting` is exempt for the reason the comment above gives: there the action
    // being dropped IS the one being handed back, so "idle" is the state the yield produces
    // rather than a precondition of it.
    if (
        !needsRest &&
        (idle || finishedResting) &&
        bladeburnerYieldsForTraining(
            ns,
            sharesSlot,
            trainingWantedHeld(trainingRemaining(context.snapshot.player, context.goal)),
        )
    ) {
        if (isResting) bb.stopBladeburnerAction();
        reason = "yielded to training";
        return;
    }

    // A winnable black op preempts everything: the division and grafting,
    // training and other work are all exclusive over the one activity slot, and
    // a >90% black op advances the run more than another gym session. Resting
    // still comes first — a tired player lowers the op's success below the bar,
    // and stamina gates every action this feature can take.
    const priorityOp = !needsRest ? nextBlackOp(ns) : null;
    if (priorityOp) {
        if (TEAM_SIZE > 0 && bb.getTeamSize(priorityOp[0], priorityOp[1]) < TEAM_SIZE) {
            bb.setTeamSize(priorityOp[0], priorityOp[1], TEAM_SIZE);
        }
        bb.startAction(priorityOp[0], priorityOp[1]);
        reason = `black op ${priorityOp[1]}`;
        return;
    }

    // Yields to the player's own Singularity work only while the two share the
    // slot. With the Simulacrum a Bladeburner action does not cancel a course or a
    // job, so there is nothing to defer to.
    if (sharesSlot && idle && hasSingularityWork(ns)) {
        reason = "yielded: the player has Singularity work";
        return;
    }

    {
        const [type, name] = pickAction(ns, currentName);
        // The division is keeping the slot, which is the state the deadlock needed
        // named: without it, "Bladeburner is active" reads the same as "Bladeburner
        // is holding the slot progression wants".
        reason = `keeping the slot: ${name} (${type})${needsRest ? ", needs rest" : ""}`;

        if (currentName !== name) {
            bb.startAction(type, name);

            if (lastLoggedAction !== name && name !== "Hyperbolic Regeneration Chamber") {
                const stamPct = ((stam / stamMax) * 100).toFixed(1);
                announce(ns, "BLADEBURNER", `Switched to ${name} (${type}) | Stamina: ${stamPct}% | Rank: ${ns.format.number(bb.getRank())}`);
                lastLoggedAction = name;

                // Training is the "nothing is safe" fallback and is otherwise silent for as
                // long as it runs. Say why it was chosen, once, at the moment it is chosen —
                // the switch above already reports only on change, so this inherits that
                // cadence and cannot spam a tick.
                if (name === TRAIN[1]) {
                    announce(
                        ns, "BLADEBURNER",
                        `No safe contract or operation, so training. ` +
                        `Stamina ${stamPct}% (rest below ${REST_BELOW * 100}%). Estimates: ${describeFallback(ns)}`,
                        "warn",
                    );
                }
            } else if (name === "Hyperbolic Regeneration Chamber" && lastLoggedAction !== "Resting") {
                announce(ns, "BLADEBURNER", `Stamina at ${((stam / stamMax) * 100).toFixed(1)}%. Resting until ${REST_UNTIL * 100}%...`);
                lastLoggedAction = "Resting";
            }
        }
    }
}