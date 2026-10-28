import type { NS } from "@ns";

import type { Context } from "../../lib/context.ts";
import { announce } from "../../lib/log.ts";
import { findScriptOnHome } from "../../lib/scripts.ts";
import { decideRetirement, INSTALL_WAIT_MS, MIN_QUEUED, type RetirementFacts } from "./retire-decisions.ts";

/*
 * ============================================================================
 * RETIREMENT (Feature)
 * ============================================================================
 * The deliberate end of a run: liquidate, spend on things that survive the reset, then
 * hand off the install and restart.
 *
 * Why this is now a Feature, and where the boundary is. Retirement used to be a
 * Standalone Entry that began by calling `ns.killall("home")` — safe, because
 * `killall` spares the calling script. As a Feature it runs INSIDE the Orchestrator,
 * so that same call would kill the thing running it, and the Orchestrator is what
 * would have restarted it. A Feature cannot kill its own driver and survive.
 *
 * So the sequence is split by what each half can do:
 *
 *   this Feature   the in-run work: liquidate stocks and hashes, buy home upgrades,
 *                  buy NeuroFlux Governors. None of it needs the network stopped, and
 *                  all of it leaves the run playable if it fails.
 *   the handoff    a small standalone script that stops everything, installs, and lets
 *                  the game restart the Orchestrator. It must be a separate script
 *                  because it has to outlive the killall.
 *
 * The split also fixes a real defect in the old order. That version killed the
 * orchestrator FIRST and only restarted it through `installAugmentations`, so an early
 * return or a throw anywhere in between left the framework dead with nothing to bring
 * it back. Now nothing is torn down until the install is certain.
 * ============================================================================
 */

/** The standalone half, resolved at runtime like every other spawned script. */
const HANDOFF_NAME = "install.ts";

/** Retirement is not urgent: it is checked on a slow cadence by the registry. */
export function intervalMs(): number {
    return 60_000;
}

/**
 * There is no `HANDOFF_GRACE_MS` any more, and its removal is part of the fix rather than
 * a tidy-up.
 *
 * That constant existed to police `ns.run`, whose behaviour includes returning a pid even
 * when no process survives — so `handoff` had to sleep out the installer's own hold and
 * then ask the machine whether anything was running. It was a verification loop around a
 * call that could not report its own failure, and in the 2026-10-25 recording it failed
 * 83 times in a row while the run re-liquidated and re-bought Governors on every retry.
 *
 * The handoff is now started with `ns.spawn`, whose documented purpose is to "execute a
 * new script without being constrained by the RAM usage of the current one". It terminates
 * the caller and replaces it in the same tick, or it throws. There is no window to wait
 * out and no pid to disbelieve, so the verification, the hold that made it possible, and
 * `install.ts`'s matching `HOLD_MS` all go together.
 */

let handoffStarted = false;

/**
 * Whether this run has already been liquidated and spent on an install.
 *
 * SEPARATE FROM `handoffStarted`, because they answer different questions and the
 * difference is where the defect was. `handoffStarted` means "an install is under way";
 * this means "the money is already gone". A failed spawn sets the second and not the
 * first, and that is precisely the state a retry must recognise.
 *
 * Only `reset` clears it, which happens when a handoff is verified to have started — the
 * queue is about to be consumed, so the next run begins with nothing spent. Nothing else
 * in a run can legitimately un-spend it.
 */
let spent = false;

/*
 * ─── THE STALL CLOCK ───
 * When the queue last grew — or when it was first seen to be worth timing.
 *
 * Measured here rather than published by `player.ts`, which is what actually calls
 * `purchaseAugmentation`. A timestamp written there would be a fourth place holding
 * augmentation state — after `readFacts`, `install.ts` and the snapshot — and
 * `retire-decisions.ts` exists precisely because two of those already disagreed once.
 * This Feature reads the same list the decision reads, on the same cadence, so the two
 * cannot drift.
 *
 * The cost of that choice is resolution: the registry ticks this once a minute, so a
 * purchase is noticed within a minute of happening. Against a one-hour window that is
 * noise.
 *
 * IT MUST NOT DEPEND ON HAVING WATCHED A PURCHASE, and the first version did. See
 * `observeQueue` for the defect — in short, a run can reach two augmentations, be
 * reloaded for any reason, and then never grow its queue again, so a clock that can only
 * be armed by growth is a clock that never starts.
 */
let lastQueued = -1;
let lastHomeCash = 0;
let lastPurchaseAt: number | null = null;

/** Forget the one-shot flag and the stall clock. Exported for tests, like the other resets. */
export function reset(): void {
    handoffStarted = false;
    spent = false;
    lastQueued = -1;
    lastHomeCash = 0;
    lastPurchaseAt = null;
}

/**
 * Note when the queue last grew — or, failing that, when it was first seen to be non-empty.
 *
 * WHAT COUNTS AS A PURCHASE, and why the queue growing is not enough. A rise in `queued`
 * alone cannot distinguish a purchase from the game briefly reporting the two lists
 * inconsistently — the same reading that let `install.ts` compute a negative count. A
 * false rise would restart the clock without anything having been bought, and the stall
 * this exists to catch would never fire.
 *
 * Home cash falling alongside it is the second witness. A purchase costs money, so the
 * two moving together is a purchase; the queue moving alone is a re-read. It is not a
 * perfect witness — a purchase can be made while other spending also lowers cash — but
 * the failure mode of accepting a false purchase is only that retirement waits, which is
 * where it already was.
 *
 * WHY A BASELINE ALSO ARMS THE CLOCK, which is the fix for the defect this shipped with.
 * Previously the clock could only start on an observed GROWTH, and that is not enough:
 *
 *   - The module is re-imported whenever the orchestrator self-restarts on a file change,
 *     and the import is fresh. All three variables reset to their initial values.
 *   - `lastPurchaseAt` comes back null, and it can then only be set by a purchase.
 *   - A run sitting on two augmentations that has already bought everything it can afford
 *     is never going to buy another, so `queued` never grows.
 *
 * Arming only on growth therefore produces a clock that CANNOT START, on precisely the run
 * the fallback was written for. The reload is the trigger — it flips the run back to a
 * state the clock refuses to measure — and the observed symptom was a retirement happening
 * or not happening for reasons unrelated to the hour that had (or had not) passed.
 *
 * So the first reading of a NEW module instance across a non-empty queue counts as the
 * start. It dates the clock from when this instance first SAW the queue rather than from
 * when the last purchase actually happened, which is a lower bound on that purchase and
 * therefore errs toward waiting — the safe direction, and the same one every other
 * uncertainty in this file resolves toward.
 *
 * `now` is passed in rather than read here so the caller owns the clock, which is what
 * makes the behaviour testable without sleeping.
 */
function observeQueue(ns: NS, queued: number, homeCash: number, now: number): void {
    const first = lastQueued < 0;
    const grew = !first && queued > lastQueued;
    const spent = !first && homeCash < lastHomeCash;

    lastQueued = queued;
    lastHomeCash = homeCash;

    if (grew && spent) {
        lastPurchaseAt = now;
        ns.tprint(
            `INFO: retirement clock restarted after a purchase, ${queued} augmentation(s) queued. ` +
            `Installs in ${INSTALL_WAIT_MS / 60_000} min if nothing more is bought.`,
        );
        return;
    }

    // ARM THE CLOCK WHENEVER IT IS UNARMED AND THE QUEUE QUALIFIES — not only on the first
    // reading of a module instance.
    //
    // THE FIRST VERSION ARMED ONLY INSIDE THE BASELINE BRANCH, WHICH LEFT A QUEUE THAT
    // GROWS INTO THE RANGE PERMANENTLY UNTIMED. A run sitting at two queued is below
    // `MIN_QUEUED`, so the baseline branch declined to arm; buying a third later grows the
    // queue, but by then `lastQueued` is set, so control never reaches the baseline branch
    // again. The clock stays null forever and the run never retires — on exactly the path a
    // normal run takes, because buying one augmentation at a time is the normal case.
    //
    // Arming here is safe in the other direction too. A queue that DROPS below the minimum
    // (an install, or the game restating the lists) does not disarm; only `reset` does, and
    // `tick` calls it when a handoff starts. So this can re-arm a clock that is already
    // armed only when it is null, which is exactly the untimed case.
    if (lastPurchaseAt === null && queued > MIN_QUEUED) {
        lastPurchaseAt = now;
        // Said once, because it fires once: the condition requires the clock to be unarmed.
        // A reader debugging a timer needs to know whether it started from a purchase or
        // from a level it happened to reach, and this is the second case.
        ns.tprint(
            `INFO: retirement clock started, ${queued} augmentation(s) queued ` +
            `and no purchase seen since it began counting. Installs in ${INSTALL_WAIT_MS / 60_000} min ` +
            `if nothing more is bought.`,
        );
    }
}

/**
 * Do the retirement: spend the run out, then hand off the install. Returns whether an
 * install is now under way.
 *
 * EXTRACTED SO A MANUAL RETIREMENT RUNS THE SAME SEQUENCE. `manual-retire.ts` is a
 * standalone script the player starts by hand, and it must not be a second implementation
 * of this — the framework already learned that lesson with `retire-decisions.ts`, which
 * exists because `player.ts` and `retire.ts` each had their own idea of when a run should
 * end. One function means a manual retirement liquidates, upgrades, buys NeuroFlux and
 * installs in exactly the order an automatic one does, and a change to that order applies
 * to both.
 *
 * EACH STEP IS INDEPENDENT, deliberately. A failure in the stock API leaves the run
 * playable and the other two steps still run: the old retirement aborted the whole
 * sequence on the first refusal, which is how a run ended up stuck between "decided to
 * retire" and "installed" with its holdings already sold.
 *
 * Exported for that script and for tests. Nothing else should call it — the automatic path
 * reaches it through `tick`, after `decideRetirement` has said yes.
 */
export function retireNow(ns: NS, context: Context): boolean {
    if (spent) {
        // A RETIREMENT IS SPENT ONCE ITS MONEY IS GONE, and this guard is the whole reason
        // the flag exists.
        //
        // The observed defect: the handoff failed, `tick` retried a minute later, and
        // every retry ran `retireNow` from the top. Stocks were re-sold, home was
        // re-upgraded, and — the part that costs a run — NeuroFlux Governors were bought
        // again, because a Governor bought a minute ago has RISEN IN PRICE but the run's
        // cash has not. Three of those purchases were logged in one run (5, then 4, then
        // 1), each one a fresh augmentation the reset was supposed to be paid for with.
        //
        // The comments below call these steps "independent" and "safe to fail"; that was
        // true of a single attempt and false of a retry loop, which is what the retry
        // became once the spawn started being verified. Retrying must mean retrying the
        // HANDOFF, which is the step that failed, not re-spending the run to reach it.
        return handoff(ns);
    }

    // SET BEFORE THE SPENDING, not after it, and this is the second half of the fix above.
    //
    // The guard at the top of this function was correct in intent and unreachable in
    // practice: `spent` used to be assigned on the far side of `buyNeuroFlux`, so a run
    // that threw, or that returned early, or whose handoff never started, came back with
    // the flag still false and spent again. Moving it above the first purchase makes "the
    // run has spent" true for the whole sequence rather than for its last statement.
    //
    // Nothing un-sets it except `reset`, which a verified install performs. A handoff that
    // does not stick therefore still never re-buys Governors — it retries the handoff,
    // which is the only step that can be retried for free.
    spent = true;

    const gained = liquidate(ns);
    const upgraded = upgradeHome(ns);
    const neuro = buyNeuroFlux(ns);

    announce(
        ns, "RETIRE",
        // "RAISED", not "Liquidated": the figure is cash the sales put into home, which is
        // what the line after it spent. See `liquidate` for why this is measured rather
        // than summed, and why the old label described a different quantity.
        `Raised $${ns.format.number(gained)} in cash; home +${upgraded.ram} RAM +${upgraded.cores} cores; ` +
        `bought ${neuro} NeuroFlux Governor(s).`,
    );

    // No `spent = true` here any more: the flag is set BEFORE the spending above, so that
    // it covers the sequence rather than only its last statement. See the comment at the
    // top of this function for why that ordering is the fix.

    return handoff(ns);
}

/**
 * Whether this run's holdings have already been turned into an install.
 *
 * The counterpart of `handoffStarted`, for the other half of the sequence. Exported for
 * tests alone — `retireNow` and `reset` own it.
 */
export function hasSpentForTest(): boolean {
    return spent;
}

/**
 * Put the module back into the state a stalled run reaches: a handoff that was started
 * and never finished. Exported for tests only — there is no runtime path that should set
 * this directly, because the flag is owned by `reconcileHandoff` and `handoff`.
 */
export function markHandoffStartedForTest(): void {
    handoffStarted = true;
}

/**
 * The stall clock, as the dashboard should show it — or null when it is not counting.
 *
 * WHY THE DASHBOARD NEEDS THIS AT ALL. Every other threshold in the framework is a number
 * a reader can check against a figure already on screen: five augmentations queued is
 * visible as a queue. This one is a COUNTDOWN, and a countdown nobody can see is
 * indistinguishable from a bug. The failure mode it would hide is exactly the one this
 * fallback was built to prevent: a run sitting at three augmentations with a timer that
 * silently never armed, which reads as patience for as long as you care to watch.
 *
 * Null, not zero, when there is nothing to show — before a purchase has been measured, or
 * with too few queued for the clock to matter. Zero would render as a timer at its last
 * second, which is a claim, and this must not make one it cannot support.
 */
export function stallClock(): { readonly dueAt: number; readonly queued: number } | null {
    if (lastPurchaseAt === null) return null;

    // THE CLOCK IS ONLY RUNNING IF IT COULD ACTUALLY FIRE.
    //
    // `decideRetirement` requires STRICTLY more than `MIN_QUEUED` augmentations, so a queue of
    // two is not a queue waiting on time — it is a queue waiting on another purchase, and no
    // amount of waiting will install it. Reporting a countdown for that state is a promise the
    // rule will never keep, and it is indistinguishable from a timer that has broken.
    //
    // Reported as "the timer for installing augments is not working in the react UI". The timer
    // was working; it was counting down to a deadline that could never fire, because the queue
    // sat at two and `queued > MIN_QUEUED` was false. The panel showed "due" indefinitely,
    // which is exactly what a broken countdown looks like.
    //
    // Null here means "not counting", which is the truth: the run is waiting on a purchase.
    if (!(lastQueued > MIN_QUEUED)) return null;

    return { dueAt: lastPurchaseAt + INSTALL_WAIT_MS, queued: lastQueued };
}

export function tick(ns: NS, context: Context): void {
    const now = Date.now();

    // Reconcile before deciding: a handoff that exited without installing must not keep
    // the decision answering "already running" for the rest of the run.
    reconcileHandoff(ns);

    // ADOPT A HANDOFF THAT IS ALREADY RUNNING, before the decision reads the flag.
    //
    // `handoffStarted` is module state, so it is false in a freshly imported module — and a
    // real run reloads this module whenever the orchestrator self-restarts on a file change.
    // An installer started by the previous instance would then be invisible, and this one
    // would spawn a second copy that fights the first for the same augmentations.
    //
    // Checked here rather than inside `handoff` because the decision has to know before it
    // fires: the whole point is that a retirement must not be announced, and must not spend
    // the run again, while an install is already under way.
    //
    // BOTH FLAGS ARE SET, and `spent` is the important one. An install in flight means the
    // money for it is already gone — the previous instance bought the Governors — so a
    // later tick that somehow re-decides must not liquidate a second time.
    if (!handoffStarted) {
        const file = findScriptOnHome(ns, HANDOFF_NAME);
        if (file !== null && ns.scriptRunning(file, "home")) {
            handoffStarted = true;
            spent = true;
        }
    }

    const facts = readFacts(ns, context);
    observeQueue(ns, facts.queued, context.snapshot.homeCash, now);

    // Milliseconds since the last observed purchase, or null before the first one. Null
    // rather than 0: the decision treats 0 as "a purchase just landed", which is the
    // answer that makes the clock wait.
    const msSincePurchase = lastPurchaseAt === null ? null : now - lastPurchaseAt;
    const verdict = decideRetirement({ ...facts, msSincePurchase });

    if (verdict.kind === "wait") {
        // Once per state rather than every tick. A feature that reports "not yet" every
        // minute for a whole run is noise, and the reason changes rarely.
        return;
    }

    announce(ns, "RETIRE", `=== INITIATING RETIREMENT: ${verdict.reason} ===`, "warn");

    const started = retireNow(ns, context);

    // THIS LINE IS UNREACHABLE IN PRODUCTION, and saying so is more honest than leaving it
    // looking like a live step.
    //
    // `retireNow` reaches `ns.spawn(..., { spawnDelay: 0 })`, which replaces this script
    // synchronously: nothing after it in this pass runs, including the line below. The
    // reset therefore happens by the process being gone — the module state dies with it,
    // which is the strongest possible clearing of it.
    //
    // It is kept because a spawn that does NOT happen leaves `started` false, and then this
    // is correctly a no-op; and because a test fixture's `spawn` returns instead of
    // replacing the process, so the assertion "a verified handoff disarms the clock" needs
    // something to be true of. What it must never do is talk a reader into believing the
    // success path continues past the spawn.
    if (started) reset();
}

/**
 * What the run looks like to the decision, read from the snapshot where possible.
 *
 * Every fact EXCEPT `msSincePurchase`, which is not read from the game at all: it is
 * measured by `observeQueue` across ticks, so `tick` supplies it. Typing the return as
 * `Omit<...>` keeps the decision's contract in one place while making it impossible for
 * this function to invent the one fact it cannot know.
 */
function readFacts(ns: NS, context: Context): Omit<RetirementFacts, "msSincePurchase"> {
    const installed = safeOwned(ns, false);
    const all = safeOwned(ns, true);

    return {
        // Counted from the two lists rather than trusting one: `queued` is what is in
        // `all` but not in `installed`, which is the game's own definition.
        queued: all.filter(aug => !installed.includes(aug)).length,
        installed: installed.length,
        factions: context.snapshot.player.factions.length,
        cash: context.snapshot.homeCash,
        canInstall: context.capabilities.has("singularity"),
        alreadyStarted: handoffStarted,
    };
}

/** `getOwnedAugmentations` throws without the Singularity API, so the count is 0 then. */
function safeOwned(ns: NS, includeQueued: boolean): string[] {
    try {
        return ns.singularity.getOwnedAugmentations(includeQueued);
    } catch {
        return [];
    }
}

/**
 * Sell everything that will not survive the reset.
 *
 * Stocks and Hacknet hashes both become cash, and cash is what the home upgrades and
 * NeuroFlux Governors are bought with. Both are best-effort: neither can leave the run
 * worse off than not trying, so neither is allowed to stop the sequence.
 *
 * RETURNS CASH RAISED, MEASURED — NOT PROFIT, SUMMED. The old version added up
 * `(sellPrice - avgPrice) * shares` per symbol and called the result "Liquidated", which
 * was wrong in two ways a reader could see on screen:
 *
 *   - It is PROFIT, not proceeds. A run that bought 5b of stock at par and sold it reported
 *     "Liquidated $0", while its cash had gone up by five billion.
 *   - It can be NEGATIVE, and was: the 2026-10-25 run logged `Liquidated $-225.504m` in the
 *     middle of selling everything it owned. A loss is a true thing to report, but not under
 *     the label "Liquidated", and not as a sentence about how much money a retirement raised.
 *
 * Neither is a calculation this function needs to perform. Cash before and cash after is the
 * question the caller is actually asking ("what can the home upgrades and Governors be bought
 * with"), it is exact by construction, and it cannot disagree with the game's own balance the
 * way a per-symbol formula can — including for the Hacknet hashes, which the old sum ignored
 * entirely and which are a real part of what a retirement converts.
 *
 * Measured on `home`, which is where both stock sales and "Sell for Money" land.
 */
function liquidate(ns: NS): number {
    const before = ns.getServerMoneyAvailable("home");

    try {
        if (ns.stock.hasWseAccount() && ns.stock.hasTixApiAccess()) {
            for (const symbol of ns.stock.getSymbols()) {
                const [shares, , shortShares] = ns.stock.getPosition(symbol);
                if (shares > 0) ns.stock.sellStock(symbol, shares);
                if (shortShares > 0) ns.stock.sellShort(symbol, shortShares);
            }
        }
    } catch {
        announce(ns, "RETIRE", "Stock liquidation failed; continuing.");
    }

    try {
        const sell = "Sell for Money";
        const n = Math.floor(ns.hacknet.numHashes() / ns.hacknet.hashCost(sell));
        if (n > 0) ns.hacknet.spendHashes(sell, "", n);
    } catch {
        // No Hacknet, or no hashes. Not worth reporting: the common case early on.
    }

    return ns.getServerMoneyAvailable("home") - before;
}

/**
 * Home RAM and cores, which persist across a reset.
 *
 * These are the only permanent purchases retirement makes, so they are done before
 * NeuroFlux: a Governor is lost if the augmentations are not installed, and these are
 * not lost either way.
 */
function upgradeHome(ns: NS): { ram: number; cores: number } {
    let ram = 0;
    let cores = 0;

    try {
        while (ns.singularity.upgradeHomeRam()) ram += 1;
    } catch {
        // Ran out of money, or the API refused. Either way the loop is done.
    }

    try {
        while (ns.singularity.upgradeHomeCores()) cores += 1;
    } catch {
        // As above.
    }

    return { ram, cores };
}

/**
 * Buy NeuroFlux Governors with whatever is left.
 *
 * Cheapest-value-per-rep first among the factions that sell it: a donation is only
 * worth making when the faction's favour allows it, and the faction with the highest
 * reputation needs the smallest donation.
 */
function buyNeuroFlux(ns: NS): number {
    const NEURO = "NeuroFlux Governor";
    let count = 0;

    try {
        const player = ns.getPlayer();
        const repMult = player.mults.faction_rep || 1;
        const donateFavor = ns.getFavorToDonate();
        const sellers = player.factions.filter(faction =>
            ns.singularity.getAugmentationsFromFaction(faction).includes(NEURO));

        // Bounded rather than `while (true)`: the loop always breaks when nothing is
        // bought, but a bound makes it provably terminate if the game ever reports a
        // purchase that did not change the price.
        for (let attempt = 0; attempt < 100; attempt++) {
            const price = ns.singularity.getAugmentationPrice(NEURO);
            const money = ns.getServerMoneyAvailable("home");
            if (money < price) break;

            const repRequired = ns.singularity.getAugmentationRepReq(NEURO);
            const ranked = sellers
                .map(faction => ({ faction, rep: ns.singularity.getFactionRep(faction) }))
                .sort((a, b) => b.rep - a.rep);

            let bought = false;
            for (const { faction, rep } of ranked) {
                if (rep < repRequired) {
                    if (ns.singularity.getFactionFavor(faction) < donateFavor) continue;
                    const donation = Math.ceil(((repRequired - rep) * 1e6) / repMult);
                    if (money < price + donation) continue;
                    if (!ns.singularity.donateToFaction(faction, donation)) continue;
                }
                if (ns.singularity.purchaseAugmentation(faction, NEURO)) {
                    bought = true;
                    break;
                }
            }

            if (!bought) break;
            count += 1;
        }
    } catch {
        announce(ns, "RETIRE", "NeuroFlux purchase stopped early; continuing.", "warn");
    }

    return count;
}

/**
 * Hand the install to a script that can outlive the teardown.
 *
 * The handoff, not this Feature, does the `killall`: this runs inside the Orchestrator,
 * so it cannot stop the machine it is running on. The script is spawned once and
 * remembered, because a second copy would fight the first for the same augmentations.
 *
 * STARTED WITH `ns.spawn`, AND THAT IS THE FIX FOR THE STALL.
 *
 * The 2026-10-25 recording shows the old mechanism failing 90 times in one run: 7 spawns
 * the game refused outright, 83 that returned a pid with no process behind it, and one
 * that reported "Install started" and was never heard from again. Home RAM was the cause
 * and the design made it unavoidable — the orchestrator holds a `ramOverride` reservation
 * that grows to fill home, so it sat at 4095.85 of 4096 GB and `install.ts` had 0.15 GB to
 * fit into.
 *
 * `ns.spawn` is documented to "execute a new script without being constrained by the RAM
 * usage of the current one", and with `spawnDelay: 0` it replaces this script
 * synchronously — "there will not be any opportunity for other scripts to use up the RAM
 * in-between". So the orchestrator's entire reservation is handed to the installer in one
 * step, which is the "there is room now" the run never had. Killing nexus is part of the
 * deal: `spawn` terminates the caller, so the reservation it was holding is gone with it.
 *
 * THIS DOES NOT RETURN ON THE SUCCESS PATH. `spawn` does not come back, so `handoffStarted`
 * and the announcements below are only reached on the failures — which are exactly the
 * cases that need to be told. Nothing may follow the `spawn` call, because nothing after
 * it can run.
 *
 * NO VERIFICATION ANY MORE, and its absence is deliberate. `ns.run` returned a pid that
 * was not evidence a process existed, which is why the old code slept out the installer's
 * hold and asked the machine afterwards. `spawn` cannot make that claim: it either replaces
 * this script or it throws. The startup hold in `install.ts` went with the check that
 * needed it, so the installer now begins its work immediately rather than sleeping first.
 *
 * Returns whether a handoff is now in flight. The caller uses that to decide whether the
 * queue is about to be consumed — see the reset in `tick` — so this must report the
 * "already running" case as well as the "just spawned" one: both mean an install is under
 * way and the queued augmentations are about to become installed.
 */
function handoff(ns: NS): boolean {
    const file = findScriptOnHome(ns, HANDOFF_NAME);
    if (file === null) {
        announce(
            ns, "RETIRE",
            `ERROR: ${HANDOFF_NAME} is not deployed, so the install cannot run. ` +
            `The run is still playable; start the install by hand if ${HANDOFF_NAME} appears.`,
        );
        return false;
    }

    if (ns.scriptRunning(file, "home")) {
        handoffStarted = true;
        return true;
    }

    // ANNOUNCED BEFORE THE SPAWN. `spawn` replaces this script, so a line printed after it
    // would never be written — and this is the last thing the run says before it resets.
    announce(
        ns, "RETIRE",
        `Spawning ${file} and releasing the orchestrator's RAM (${refusal(ns)}).`,
        "success",
    );

    // `spawnDelay: 0` is the synchronous replace. It is what makes the RAM hand-over
    // atomic: with a delay, another script could take the freed memory in the gap.
    ns.spawn(file, { threads: 1, spawnDelay: 0 });

    // UNREACHABLE on the success path, and kept for the one case that is real: a `spawn`
    // that threw. The throw is not caught here — the caller's tick guard reports feature
    // faults — so this return exists only to satisfy the return type rather than to be
    // read as an outcome.
    handoffStarted = true;
    return true;
}

/**
 * What home had room for, for the messages above.
 *
 * Still useful AFTER the fix, in the opposite direction: the spawn no longer needs the
 * room, so this figure is how a reader confirms the reservation really was the thing
 * filling home. Read from the game rather than the snapshot because the snapshot is a tick
 * old and this is printed from a live decision.
 *
 * NO CONTEXT ARGUMENT, deliberately. Cash is asked for directly and RAM is a `getServer`.
 * The alternative was a `Context` parameter, which `manual-retire.ts` does not have — it is
 * a standalone entry with no orchestrator around it — and inventing one there to satisfy a
 * message is how the two callers would drift apart.
 */
function refusal(ns: NS): string {
    const host = ns.getServer("home");
    const free = Math.max(0, host.maxRam - host.ramUsed);
    return `Home has ${ns.format.ram(free)} of ${ns.format.ram(host.maxRam)} free, ` +
        `${ns.format.number(ns.getServerMoneyAvailable("home"))} spendable.`;
}

/**
 * Whether the handoff we started is still in flight.
 *
 * THE FLAG USED TO LATCH, AND THAT STALLED RUNS WITH AUGMENTATIONS QUEUED. Once
 * `handoffStarted` was set the decision returned "the installer is already running" on
 * every later tick, whether or not anything was. `install.ts` refuses and exits without
 * installing in two ordinary cases — the orchestrator is not on home, or nothing is
 * actually queued — and the orchestrator survives both, because a refused handoff never
 * killed anything. So the run reported an installer that had already exited, forever, with
 * nine augmentations bought and no install.
 *
 * Cleared here rather than in the failure paths inside `install.ts`: that script may be
 * killed or reset mid-flight, and a flag it is responsible for clearing would leak in
 * exactly the cases that matter. The orchestrator is the only process that observes the
 * outcome, so the orchestrator is the one that reconciles it.
 */
export function reconcileHandoff(ns: NS): void {
    if (!handoffStarted) return;
    const file = findScriptOnHome(ns, HANDOFF_NAME);
    // Deployed but not running: it exited without installing. Reset so the next tick can
    // try again, and say so once — silence here is what made the stall look like patience.
    if (file !== null && !ns.scriptRunning(file, "home")) {
        handoffStarted = false;
        announce(
            ns, "RETIRE",
            `The install handoff exited without installing; retrying. ` +
            `(${HANDOFF_NAME} reports its reason above.)`,
            "warn",
        );
    }
}
