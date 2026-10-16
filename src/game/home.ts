import type { NS, ProgramName } from "@ns";

import type { Context } from "./lib/context.ts";
import { announce } from "./lib/log.ts";

/*
 * ============================================================================
 * HOME & TOR
 * ============================================================================
 * Spends money on things that make everything else cheaper: home RAM, home
 * cores, the TOR router, the program set that unlocks servers, and the stock
 * market access chain (WSE account, TIX API, 4S Market Data TIX API).
 *
 * The stock unlocks are bought here rather than inside the stock feature
 * because they are purchases, not trading: the stock feature only ever reads
 * whether access exists (see lib/caps.ts), and a feature must not buy the
 * capability it is gated on, since it is not loaded until that purchase has
 * already happened.
 *
 * This file also RESERVES the cash for that chain (see `publishChainReserve`). It
 * is the only feature that knows what the next link costs and when it is nearly
 * affordable, so it is the only one that can say how much to hold back — the same
 * arrangement `player.ts` has for augmentations.
 *
 * This feature requires the Singularity API (see lib/registry.ts), because
 * buying hardware and downloading programs from the dark web are Singularity
 * actions. Without it the feature has nothing it can do, so the orchestrator
 * does not load it at all. That is deliberate: an earlier version declared
 * itself always available, called Singularity anyway, and threw once a second
 * on every node without SF4.
 *
 * Layer split inside this file:
 *   publishChainReserve()  writes the reserve other spenders read through `surplus`
 *   plan()                 decides what to buy next from the snapshot and the reserves
 *   execute()              performs it
 * ============================================================================
 */

/**
 * Program set, cheapest first. Buying in cost order means a fixed budget
 * unlocks as many servers as it can, and the port count each program opens is
 * what `lib/network.ts` uses to decide whether a server is reachable.
 */
const PROGRAMS: readonly ProgramName[] = [
    "BruteSSH.exe",
    "FTPCrack.exe",
    "relaySMTP.exe",
    "HTTPWorm.exe",
    "SQLInject.exe",
    "DarkscapeNavigator.exe",
];

const TOR_COST = 200_000;

/** One purchase per tick keeps spending inside the spend allowance below. */
const SPEND_ALLOWANCE = 0.5;

/**
 * How close to affordable a chain link must be before its cash is reserved.
 *
 * A fraction of the link's own cost, matching `plannedReserve` in `player.ts`. At 0.2,
 * the reserve engages once the player is within 20% of the next purchase — close enough
 * that holding the money back is brief, far enough that the last stretch is not raided by
 * another feature on the tick before the purchase.
 *
 * Reserving earlier would freeze hacknet, cloud and home RAM for most of the early game
 * to protect a purchase that is still a long way off.
 */
const NEAR_AFFORDABLE = 0.2;

type Purchase =
    | { readonly kind: "TOR"; readonly cost: number }
    | { readonly kind: "PROGRAM"; readonly name: ProgramName; readonly cost: number }
    | { readonly kind: "WSE"; readonly cost: number }
    | { readonly kind: "TIX"; readonly cost: number }
    | { readonly kind: "4S"; readonly cost: number }
    | { readonly kind: "HOME_RAM"; readonly cost: number }
    | { readonly kind: "HOME_CORES"; readonly cost: number };

/*
 * ─── PLAN ───
 * Pure: reads the context, calls nothing that changes the game.
 */

function plan(ns: NS, context: Context): Purchase | null {
    const { snapshot, reserves } = context;

    // Two allowances, and the difference between them is the point.
    //
    // `allowance` is half of what is left after the augmentation reserve — the budget
    // everything else shares, kept low so no single tick empties the bank.
    //
    // `chainAllowance` is the FULL home cash less the augmentation reserve, and it
    // deliberately does not apply `SPEND_ALLOWANCE`. A chain link is a one-off, known
    // cost that unlocks a whole feature, and halving it was quietly doubling the price
    // the framework needed on hand: TIX costs ~5e9, so the 0.5 multiplier meant waiting
    // for ~1e10 before it would be bought. The multiplier exists to stop runaway
    // spending on repeatable upgrades, which a one-time purchase is not.
    //
    // Note the chain may spend the money set aside FOR the chain. That is what
    // `stockAccessCash` is, so subtracting it here would make the reserve
    // self-defeating — it could never be used for the thing it was reserved for.
    const afterAugments = Math.max(0, snapshot.homeCash - reserves.cash);
    const allowance = afterAugments * SPEND_ALLOWANCE;
    const chainAllowance = afterAugments;
    if (allowance <= 0) return null;

    if (!context.capabilities.probes.tor) {
        return TOR_COST <= allowance ? { kind: "TOR", cost: TOR_COST } : null;
    }

    // The stock access chain comes FIRST, ahead of the darkweb programs.
    //
    // WHY THE ORDER MATTERS. Both draw on the same money, and only one purchase happens
    // per tick, so whichever is checked first gets it. Programs used to be first, which
    // meant the chain waited behind every unowned program — and the chain is the more
    // valuable of the two by a wide margin: it unlocks a whole income feature, whereas a
    // program only adds one more rooted server.
    //
    // It is not a hard beeline, and that is deliberate. The chain is taken first only
    // when the next link is affordable from `chainAllowance`; when it is not, the program
    // queue runs as before, so the early game still grows. The reserve published in
    // `tick` is what does the real work of making the link affordable sooner.
    const stockAccess = nextStockAccess(ns, chainAllowance);
    if (stockAccess !== null) return stockAccess;

    const program = nextProgram(ns, allowance);
    if (program !== null) return program;

    // Home hardware is permanent across resets, so it is bought before anything
    // else that only lasts one run.
    const ramCost = ns.singularity.getUpgradeHomeRamCost();
    if (ramCost > 0 && ramCost <= allowance) return { kind: "HOME_RAM", cost: ramCost };

    const coreCost = ns.singularity.getUpgradeHomeCoresCost();
    if (coreCost > 0 && coreCost <= allowance) return { kind: "HOME_CORES", cost: coreCost };

    return null;
}

function nextProgram(ns: NS, allowance: number): Purchase | null {
    for (const name of PROGRAMS) {
        if (ns.fileExists(name, "home")) continue;
        const cost = ns.singularity.getDarkwebProgramCost(name);
        if (cost > 0 && cost <= allowance) return { kind: "PROGRAM", name, cost };
        // Cheapest first, so an unaffordable program is never skipped over for a
        // more expensive one.
        break;
    }
    return null;
}

/**
 * The next unowned link in the stock access chain, or `null`.
 *
 * Read through `ns.stock` rather than `context.capabilities.probes.stocks`,
 * because the probe is a single boolean combining the WSE account and the TIX
 * API, and this needs to tell the three steps apart to buy them in order.
 */
function nextStockAccess(ns: NS, allowance: number): Purchase | null {
    const { WseAccountCost, TixApiCost, MarketDataTixApi4SCost } = ns.stock.getConstants();

    if (!ns.stock.hasWseAccount()) {
        return WseAccountCost <= allowance ? { kind: "WSE", cost: WseAccountCost } : null;
    }
    if (!ns.stock.hasTixApiAccess()) {
        return TixApiCost <= allowance ? { kind: "TIX", cost: TixApiCost } : null;
    }
    if (!ns.stock.has4SDataTixApi()) {
        return MarketDataTixApi4SCost <= allowance ? { kind: "4S", cost: MarketDataTixApi4SCost } : null;
    }
    return null;
}

/*
 * ─── EXECUTE ───
 * The only part of this file that changes game state.
 */

function execute(ns: NS, purchase: Purchase): boolean {
    switch (purchase.kind) {
        case "TOR":
            return ns.singularity.purchaseTor();
        case "PROGRAM":
            return ns.singularity.purchaseProgram(purchase.name);
        case "WSE":
            return ns.stock.purchaseWseAccount();
        case "TIX":
            return ns.stock.purchaseTixApi();
        case "4S":
            return ns.stock.purchase4SMarketDataTixApi();
        case "HOME_RAM":
            return ns.singularity.upgradeHomeRam();
        case "HOME_CORES":
            return ns.singularity.upgradeHomeCores();
    }
}

const LABELS: Record<Purchase["kind"], string> = {
    TOR: "TOR router",
    PROGRAM: "program",
    WSE: "WSE account",
    TIX: "TIX API access",
    "4S": "4S Market Data TIX API",
    HOME_RAM: "home RAM",
    HOME_CORES: "home cores",
};

/**
 * Publish how much cash is being kept back for the next link in the stock access chain.
 *
 * This is what stops the chain's money being spent by everything else. Every
 * money-spending feature reads the pool through `surplus`, which subtracts this reserve,
 * so hacknet nodes, cloud servers and home RAM all step back automatically once the
 * chain is close to affordable — without any of them knowing the chain exists.
 *
 * THROTTLED the same way progression throttles its augmentation reserve: the money is
 * only held back once the purchase is nearly affordable. Reserving from the first coin
 * would freeze every other feature for the whole early game, which is the opposite of
 * what was asked for — the goal is to reach the chain sooner, not to stop growing.
 *
 * `NEAR_AFFORDABLE` matches `plannedReserve` in `player.ts` for the same reason it
 * exists there: a reserve that starts too early starves the features that earn the money
 * the reserve is waiting for.
 */
function publishChainReserve(ns: NS, context: Context): void {
    const cost = context.snapshot.stockAccessCost;
    const cash = context.snapshot.homeCash;

    if (cost <= 0) {
        // Chain complete. Release the reserve immediately rather than leaving it set:
        // `home.ts` holds it, and nothing else would ever clear it.
        context.reserves.stockAccessCash = 0;
        return;
    }

    const need = cost - cash;
    context.reserves.stockAccessCash = need <= cost * NEAR_AFFORDABLE ? Math.ceil(cost) : 0;
}

export function tick(ns: NS, context: Context): void {
    publishChainReserve(ns, context);

    const purchase = plan(ns, context);
    if (purchase === null) return;

    const name = purchase.kind === "PROGRAM" ? `${LABELS.PROGRAM} ${purchase.name}` : LABELS[purchase.kind];
    // The API can still refuse (already owned, requirements unmet). Reporting the
    // refusal is more useful than silently retrying it next tick.
    //
    // A purchase is an event: an augmentation reset does not undo it, and the
    // spend is over by the time you read it, so the ring's few seconds are the
    // wrong window.
    if (execute(ns, purchase)) {
        announce(ns, "HOME", `Bought ${name} for $${ns.format.number(purchase.cost)}`, "tx");
    }
}
