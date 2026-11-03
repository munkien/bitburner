import type { NS } from "@ns";

import type { Context } from "../../lib/context.ts";
import { ChangeOnce, announce } from "../../lib/log.ts";
import {
    createPriceHistory,
    isWorthTrading,
    readMomentum,
    roundTripCost,
    worthHolding,
    type PriceHistory,
} from "./price-history.ts";

interface StockData {
    symbol: string;
    bid: number;
    ask: number;
    price: number;
    spreadPct: number;
    forecast: number;
    volatility: number;
    maxShares: number;
    longShares: number;
    longAvg: number;
    shortShares: number;
    shortAvg: number;
}

interface Candidate {
    s: StockData;
    direction: 1 | -1;
    /**
     * Ranking key for this candidate, comparable only to other candidates from the SAME
     * signal. With 4S it is the forecast, direction-adjusted so a strong short ranks as high
     * as a strong long; without it, the risk-adjusted momentum score. The two are not on one
     * scale, which is why the sort picks the field the signal produced rather than mixing
     * them.
     */
    rank: number;
    riskAdj: number;
    execPrice: number;
    maxBudget: number;
    /**
     * Which signal chose this, in the log. The old line hard-coded `fc=` from the
     * forecast field, which under momentum would print "fc=0.50" on every trade —
     * a number that had no part in the decision and reads as "no edge" for a trade
     * that was deliberately taken.
     */
    reason: string;
}

interface Profile {
    minEdge: number;
    deployTargetPct: number;
    riskAdjPower: number;
}

const CONFIG = {
    // --- Hard signal bounds ---
    EXIT_EDGE: 0.005,
    /**
     * The exit deadband with 4S, which is a different number for a different job.
     *
     * `EXIT_EDGE` above is the momentum path's deadband, sized so a LAGGING mean-vs-mean
     * reading that flips sign on noise does not toggle a position. With 4S the reading is the
     * game's own probability instead, and it is far quieter: it does not flip on price noise,
     * it moves as the game's model updates. So the 4S deadband only has to absorb the last
     * digit before the horizon is genuinely gone, and a wider one would hold positions whose
     * edge has already disappeared — paying the spread to find out later.
     *
     * 0.002 is one two-hundredth of the scale either side of 0.5: a forecast of 0.502 reads
     * as "no usable edge this tick" rather than as a reason to keep paying for a position.
     */
    EXIT_EDGE_4S: 0.002,
    // No volatility cap. There was one (MAX_VOLATILITY = 0.10), applied only with 4S because
    // volatility is a 4S-only reading. It is gone because the instruction is to act on the
    // best forecast available, and excluding the volatile names drops exactly the strongest
    // forecasts. The spread bound below still rejects the illiquid ones, which is a cost
    // concern rather than a prediction one.
    MAX_SPREAD_PCT: 0.06,

    // --- Capital reserve ---
    RESERVE_CASH_PCT: 0.10,

    // --- Sizing ---
    /**
     * The largest share of the deployable pool any single symbol may take, WITHOUT 4S.
     *
     * Without this, one strong signal and one candidate equals one symbol holding
     * the whole bankroll: the weighted sizing only thins a position when there is
     * competition, so the final candidate of a sparse market could absorb
     * everything. A spread of positions is the whole point of a portfolio, and a
     * single name is not one.
     *
     * The weighted sizing gives `w / totalWeight` of the pool to each candidate, so a
     * lone candidate takes all of it no matter how weak its signal was relative to
     * anything. A quarter of the deployable pool keeps one name from being the whole
     * portfolio while still letting a genuinely strong single signal take a meaningful
     * slice.
     *
     * NOT APPLIED WITH 4S — see `MAX_SYMBOL_PCT_4S`.
     */
    MAX_SYMBOL_PCT: 0.25,

    /**
     * The largest share of the deployable pool any single symbol may take, WITH 4S.
     *
     * `1` — no concentration limit — and that is the point of paying for 4S. The cap above
     * exists because a momentum signal is weak: with no better information, spreading across
     * names is how a strategy that is often wrong limits the cost of being wrong once. The
     * forecast is not weak, so the reason for the cap does not apply, and a strong forecast
     * should be allowed to take the whole pool rather than being diluted toward names the
     * model rates lower.
     *
     * What still bounds a position, and why this is not simply reckless:
     *
     *   - `maxShares` is the game's own per-symbol limit, and it is real. `maxBudget` carries
     *     it into the sizing, so a symbol cannot be over-bought even here.
     *   - The weighted sizing only hands the whole pool to a single candidate when there is a
     *     single candidate. A wide market still spreads across names in proportion to
     *     `w / totalWeight`, which is the behaviour worth having.
     *   - `minPositionBudget` still refuses positions too thin to pay for their commission.
     *
     * The risk this deliberately accepts: one name can be the entire portfolio, so a single
     * adverse tick is felt in full. That is the trade the instruction asks for — act on the
     * forecast rather than hedge against it — and it is why this is a separate constant rather
     * than a change to the one above, so the momentum path keeps its diversification.
     */
    MAX_SYMBOL_PCT_4S: 1,

    // --- Exits ---
    STOP_LOSS_PCT: 0.30,
    TAKE_PROFIT_PCT: 0.50,

    /** Per-symbol cooldown after a trade, so one signal is not acted on twice. */
    SYMBOL_COOLDOWN_MS: 20_000,

    /**
     * How many commissions a position must be worth before it is opened.
     *
     * The commission is a fixed cost per trade, so it is only negligible relative to a
     * position of adequate size. This is the floor that bounds how much capital goes to
     * fees, and — through `maxPositions` in the entry loop — how thinly a pool can be
     * fanned across a wide market.
     *
     * 500 is chosen against the observed regime rather than picked round. Below ~5e8 the
     * entry's own cost gate (`isWorthTrading`) already refuses everything, because the
     * commission is too large a fraction of the affordable position for any realistic
     * move to clear. At 5e8 this floor allows roughly 8 positions across a market of ~30,
     * which is where concentration starts to matter; at 5e9 it allows ~80, so it stops
     * binding entirely and the market is spread normally. A lower value (the original
     * 20) never binds at any bankroll the entry gate permits, which made it a knob that
     * did nothing.
     */
    MIN_POSITION_COMMISSIONS: 500,

    COMMISSION: 100_000,
};

/**
 * How much harder the momentum fallback has to work to clear the same bar.
 *
 * Momentum on a market that moves every tick is mostly noise, so the profile's own
 * `minEdge` — tuned for a real forecast — would fire on almost anything. Scaling it up
 * is the cheapest honest adjustment: it makes the weaker signal demonstrate more
 * before it is trusted with money.
 */
const MOMENTUM_THRESHOLD_MULTIPLE = 2.5;

/**
 * How much of a window's steps must agree with its direction before the signal counts.
 *
 * Added because ranking by `strength` alone actively selects the WORST candidates. On a
 * random walk, the largest window-to-window differences come from the noisiest series —
 * a few large ticks landing in the right places — so the strongest-looking symbol is
 * often the least likely to continue. Requiring most steps to move with the direction
 * filters that out, and unlike a bigger `strength` threshold it does so without
 * excluding genuine slow trends (which are small per step but highly consistent).
 *
 * 0.6 is a majority, set low enough that a trend with a few counter-steps still passes.
 */
const MOMENTUM_MIN_CONSISTENCY = 0.6;
const PROFILE_ANCHORS: { nw: number; profile: Profile }[] = [
    { nw: 1e7, profile: { minEdge: 0.045, deployTargetPct: 0.75, riskAdjPower: 1.8 } },
    { nw: 5e7, profile: { minEdge: 0.035, deployTargetPct: 0.80, riskAdjPower: 1.5 } },
    { nw: 2.5e8, profile: { minEdge: 0.025, deployTargetPct: 0.85, riskAdjPower: 1.2 } },
    { nw: 1e9, profile: { minEdge: 0.018, deployTargetPct: 0.90, riskAdjPower: 1.0 } },
    { nw: 5e9, profile: { minEdge: 0.014, deployTargetPct: 0.93, riskAdjPower: 0.9 } },
    { nw: 2.5e10, profile: { minEdge: 0.012, deployTargetPct: 0.95, riskAdjPower: 0.8 } },
    { nw: 1e11, profile: { minEdge: 0.010, deployTargetPct: 0.97, riskAdjPower: 0.7 } },
];

/* ─── FEATURE STATE (persists across ticks) ─── */
let log: ChangeOnce | null = null;

let initialized = false;
const cooldowns: Record<string, number> = {};

/**
 * Recent prices per symbol, for the momentum fallback.
 *
 * Module state like the rest of the feature's memory: it has to outlive a tick, and it
 * is only meaningful within one run.
 */
let priceHistory: PriceHistory = createPriceHistory();

/**
 * Forget the feature's cross-tick memory. Exported for tests, which share one process
 * and would otherwise inherit each other's cooldowns and price samples.
 */
export function reset(): void {
    priceHistory = createPriceHistory();
    for (const symbol of Object.keys(cooldowns)) delete cooldowns[symbol];
    initialized = false;
    log = null;
}

/**
 * Trades the stock market long, and short when SF8 or BitNode 8 allows it.
 *
 * Shorting used to be detected by placing a one-share short and covering it,
 * paying two commissions to answer a question the capability layer already
 * knows (see lib/caps.ts).
 */
/**
 * How much cash the market may put into positions.
 *
 * TWO RESERVES, APPLIED IN ORDER, because they answer different questions and both still
 * stand:
 *
 *   `reservedCash`        cash another feature has spoken for — the framework's reserve. It
 *                         is not the market's, at any price.
 *   `netWorth * pct`      the market's OWN solvency margin, so positions are not all-in.
 *
 * THE BUG THIS FIXES. The second was applied and the first was not: `stocks.ts` read
 * `player.money` and subtracted only `RESERVE_CASH_PCT` of net worth, so it spent money an
 * augmentation was being saved for. Measured in `runs/2026-11-03T21.39.26.280Z--18`, three
 * breaches in five minutes — `reserve 45.8m, money 62.6m -> 9.1m` and so on — with a worst
 * case of 152.9m short against a 218.5m reserve.
 *
 * This is the same defect the augment buyer had, in a different feature: a spender comparing
 * a balance instead of a surplus. Both were invisible until a reserve existed to breach.
 *
 * Pure, and the parameters come in rather than being read, so the arithmetic is assertable
 * without standing up a market.
 */
export function deployableFor(p: {
    /** Home cash, the figure `player.money` reports. */
    readonly cash: number;
    /** Cash the framework has reserved — `reserves.cash + reserves.stockAccessCash`. */
    readonly reservedCash: number;
    /** Cash plus holdings, what the market's own margin is a fraction of. */
    readonly netWorth: number;
    /** The market's solvency margin, `CONFIG.RESERVE_CASH_PCT`. */
    readonly reserveCashPct: number;
    /** The tier's share of the remainder it is willing to have deployed. */
    readonly deployTargetPct: number;
}): number {
    // THE FRAMEWORK'S RESERVE FIRST, and clamped at zero: a reserve larger than the balance
    // means the market has nothing, not a negative amount. The clamp matters — a negative
    // here becomes a huge unsigned figure once it reaches the order sizing.
    const free = Math.max(0, p.cash - p.reservedCash);

    // The market's own margin, taken from net worth as it always was. It is a different
    // quantity on purpose: it is about total exposure, not about which cash is unspoken for.
    const own = p.netWorth * p.reserveCashPct;

    return Math.max(0, (free - own) * p.deployTargetPct);
}

export function tick(ns: NS, context: Context): void {
    log ??= new ChangeOnce(ns, "STOCK");
    log.updateNs(ns);

    const now = Date.now();

    // 1. Startup logging
    if (!initialized) {
        if (!context.capabilities.has("stocks")) {
            // An event: without it the feature returns on every tick, and the
            // Terminal should say why once rather than the panel saying it forever.
            announce(ns, "STOCK", "ERROR: TIX API access required.", "error");
            return;
        }

        if (!context.capabilities.has("shorting")) {
            announce(ns, "STOCK", "Shorting unavailable (needs SF8 or BitNode 8). Long only.", "warn");
        }
        if (!ns.stock.has4SDataTixApi()) {
            // A condition rather than a transition: 4S is absent for the whole run
            // until it is bought (a one-way purchase), so this is said once, at
            // startup, instead of on every tick.
            announce(ns, "STOCK", "WARN: 4S data missing - Entries use momentum fallback.", "warn");
        }
        announce(ns, "STOCK", "Online.", "success");
        initialized = true;
    }

    const shortingAvailable = context.capabilities.has("shorting");
    const has4S = ns.stock.has4SDataTixApi();

    const cash = context.snapshot.player.money;
    const stocks = readStocks(ns, has4S);

    // Sample every symbol, whether or not 4S data is present. The fallback needs a
    // window of history before it can say anything, so waiting until 4S turns out to be
    // missing would mean the feature idles for the whole window it just spent not
    // recording. Cheap: one push per symbol per tick, and no game calls.
    for (const s of stocks) priceHistory.record(s.symbol, s.price);

    // ----- Portfolio Snapshot -----
    let holdingsValue = 0;
    for (const s of stocks) {
        holdingsValue += s.longShares * s.bid;
        holdingsValue -= s.shortShares * s.ask;
    }
    const netWorth = cash + holdingsValue;
    // `reserveCash` is GONE from here and now lives inside `deployableFor`, where both
    // reserves are applied together. It was `netWorth * RESERVE_CASH_PCT` — the market's own
    // solvency margin, not the framework's reserve — and keeping it as a local invited exactly
    // the mistake it made: spending cash another feature had already spoken for.

    // ----- Profile Determination -----
    // The tier sets `minEdge` and `riskAdjPower`; having 4S then raises the deployment target
    // to the whole post-reserve balance, because the signal it buys is a real model rather
    // than the momentum fallback the tier's gentler deployment was sized for.
    const { profile: tierProfile, tierIndex } = deriveProfile(netWorth);
    const profile = deployProfile(tierProfile, has4S);
    // The profile changes a handful of times per run, so this is logged on the
    // transition rather than every tick.
    log!.once(
        tierIndex,
        `Tier shift @ NW ${fmt(netWorth)} (minEdge=${profile.minEdge.toFixed(3)})`,
    );

    // ==================== EXITS ====================
    //
    // The exit must be judged by the SAME signal that opened the position, and getting
    // that wrong is what made this feature buy and sell in the same breath.
    //
    // `signalGone` used to read `s.forecast` unconditionally. Without 4S Market Data
    // that field is the constant 0.5 this file writes as a fallback, because
    // `getForecast` throws — so `0.5 < 0.5 + EXIT_EDGE` was true on every long and
    // `0.5 > 0.5 - EXIT_EDGE` on every short. Every position was closed on the tick
    // after it opened, labelled `[SIG]`, paying two commissions for a hold the entry
    // signal had not asked to end. The live log read:
    //
    //   BUY  X x990.66k @ 10.7 (mom=4.94% n=14)
    //   SELL X x990.66k [SIG] PnL: 0.5%       <- one tick later
    for (const s of stocks) {
        const exit = exitSignal(s, has4S, priceHistory);

        // WITH 4S the exit is the forecast and nothing else: no stop-loss, no take-profit.
        //
        // WHY THE PERCENTAGE RULES GO. A stop at -30% and a take-profit at +50% are
        // PATH-based rules — they read the position's own P&L and ignore the signal that
        // opened it. That is the right shape for a signal that cannot be trusted, because
        // there is nothing better to act on. With a forecast that says what the next tick
        // will do, both rules are actively harmful in opposite directions:
        //
        //   take-profit  exits a position the model still rates, capping the edge that was
        //                paid for. A number going up is not a reason to leave a trade the
        //                forecast still supports.
        //   stop-loss    exits a position the model still rates, at the worst possible
        //                moment. A tick moving against a 55% forecast is the 45% case
        //                happening, which is expected and not information.
        //
        // So with 4S a position is held while the forecast supports its direction and closed
        // when it does not — `[SIG]` is the only exit reason, and the P&L is reported rather
        // than acted on.
        //
        // WITHOUT 4S both rules stay exactly as they were. The momentum signal genuinely can
        // be wrong for a long time without the reading noticing, so a backstop there is
        // insurance rather than interference.
        if (s.longShares > 0 && s.longAvg > 0) {
            const pnlPct = (s.price - s.longAvg) / s.longAvg;
            // A long is done when the signal no longer points up. `null` means there is
            // not enough history to say, and an unanswerable question must not close a
            // position — that is just the same bug wearing a different hat.
            const signalGone = exit !== null && exit <= 0;
            const stop = !has4S && pnlPct <= -CONFIG.STOP_LOSS_PCT;
            const tp = !has4S && pnlPct >= CONFIG.TAKE_PROFIT_PCT;

            if (signalGone || stop || tp) {
                const perShare = ns.stock.sellStock(s.symbol, s.longShares);
                if (perShare > 0) {
                    const why = stop ? "STOP" : tp ? "TP" : "SIG";
                    // A fill is an event: it is the record of what the strategy did
                    // and the P&L it realised, which is worth reading after the fact.
                    announce(ns, "STOCK", `SELL ${s.symbol} x${fmt(s.longShares)} [${why}] PnL: ${(pnlPct * 100).toFixed(1)}%`, "tx");
                    cooldowns[s.symbol] = now + CONFIG.SYMBOL_COOLDOWN_MS;
                }
            }
        }

        if (s.shortShares > 0 && s.shortAvg > 0) {
            const pnlPct = (s.shortAvg - s.price) / s.shortAvg;
            // Mirrored: a short is done when the signal no longer points down. The percentage
            // rules are gated on `!has4S` for the reasons given on the long branch above —
            // with 4S the forecast is the exit, without it a backstop still applies.
            const signalGone = exit !== null && exit >= 0;
            const stop = !has4S && pnlPct <= -CONFIG.STOP_LOSS_PCT;
            const tp = !has4S && pnlPct >= CONFIG.TAKE_PROFIT_PCT;

            if (signalGone || stop || tp) {
                const perShare = ns.stock.sellShort(s.symbol, s.shortShares);
                if (perShare > 0) {
                    const why = stop ? "STOP" : tp ? "TP" : "SIG";
                    announce(ns, "STOCK", `COVER ${s.symbol} x${fmt(s.shortShares)} [${why}] PnL: ${(pnlPct * 100).toFixed(1)}%`, "tx");
                    cooldowns[s.symbol] = now + CONFIG.SYMBOL_COOLDOWN_MS;
                }
            }
        }
    }

    // ==================== ENTRIES ====================
    // `has4S` selects the SIGNAL, not whether to trade. It used to wrap this whole
    // block, so a node with the TIX API but no 4S data could only ever sell — the
    // feature was reported as "not buying stocks until 4S is bought", which was
    // exactly what the code said to do and was never what it should have done.
    //
    // With 4S: the game's forecast, which is a real model.
    // Without: price momentum, which is a weaker signal and is treated as one.
    {
        const candidates: Candidate[] = [];

        for (const s of stocks) {
            if ((cooldowns[s.symbol] ?? 0) > now) continue;
            if (s.longShares > 0 || s.shortShares > 0) continue;
            if (s.spreadPct > CONFIG.MAX_SPREAD_PCT) continue;

            // The fixed commission as a fraction of the position this symbol could carry, in
            // the same form `momentumSignal` computes it, so the two signals' cost bars are in
            // the same units and cannot drift apart. Capped by available cash as well as by the
            // symbol's own limit, because that is what actually bounds the position.
            const commissionPct = CONFIG.COMMISSION / Math.min(
                Math.max(1, s.maxShares * s.ask),
                Math.max(1, cash),
            );

            const signal = has4S
                ? forecastSignal(s, profile, commissionPct)
                : momentumSignal(s, priceHistory, profile, cash);
            if (signal === null) continue;

            // No volatility cap here. It existed to keep the momentum fallback out of wild
            // movers, and it only ever applied WITH 4S (volatility is a 4S-only reading).
            // With 4S the signal is the game's own forecast, and the instruction is to act
            // on the best forecast available — refusing the volatile names would drop the
            // strongest signals, which is the opposite of the point.

            const isShort = signal.direction < 0;
            if (isShort && !shortingAvailable) continue;

            const execPrice = isShort ? s.bid : s.ask;
            if (execPrice <= 0) continue;
            candidates.push({
                s,
                direction: isShort ? -1 : 1,
                // Ranking key. With 4S it is the forecast, direction-folded by `rankOf` so
                // a strong short ranks with a strong long; without 4S, the risk-adjusted
                // momentum score. The two are not comparable, so the sort below picks the
                // field the signal actually produced rather than mixing them.
                rank: signal.rank,
                riskAdj: signal.riskAdj,
                execPrice,
                maxBudget: s.maxShares * execPrice,
                reason: signal.reason,
            });
        }

        // Post-4S the order is the forecast, best first; without it, the risk-adjusted
        // momentum score as before. `rank` already encodes direction (a strong short ranks
        // as high as a strong long), so one descending sort serves both.
        candidates.sort((a, b) => has4S ? b.rank - a.rank : b.riskAdj - a.riskAdj);

        // THE FRAMEWORK'S RESERVE IS SUBTRACTED FIRST, then the market's own margin, then the
        // profile's deployment fraction. See `deployableFor` — this line used to subtract only
        // `reserveCash`, which is the market's solvency margin and knows nothing about cash
        // another feature has spoken for.
        const deployable = deployableFor({
            cash,
            reservedCash: context.reserves.cash + context.reserves.stockAccessCash,
            netWorth,
            reserveCashPct: CONFIG.RESERVE_CASH_PCT,
            deployTargetPct: profile.deployTargetPct,
        });
        let remaining = deployable;
        // No single name may hold more than this slice, however strong its signal.
        //
        // The cap is relaxed to `MAX_SYMBOL_PCT_4S` (no limit) when 4S is present, because the
        // reason for the cap — a weak signal worth diversifying against — does not apply to a
        // trustworthy forecast. Kept as a per-path constant rather than one number so the
        // momentum path keeps its diversification.
        const symbolCap = deployable * (has4S ? CONFIG.MAX_SYMBOL_PCT_4S : CONFIG.MAX_SYMBOL_PCT);

        // The smallest position worth opening, in cash.
        //
        // WHY THIS EXISTS. The commission is a FIXED 100k per trade, so it is a
        // percentage of the POSITION rather than of the move, and nothing else in the
        // sizing bounds how thin a position may get. A wide market where every symbol
        // qualifies at once takes a slice of `deployable` per symbol however small:
        // twelve positions of 4m each pay 1.2m in commission, which is 25% of the
        // capital deployed, before the market does anything at all.
        //
        // Expressed as a multiple of the commission because that is the unit the harm is
        // in — "a position must be worth at least this many commissions to be worth
        // opening". Derived from the commission rather than declared as a flat number, so
        // it stays correct if the game's commission changes.
        //
        // This replaces the earlier `budget <= COMMISSION * 3` check, which was the same
        // idea with a bar so low it never bound: 3 commissions is 300k, and any position
        // the entry's own cost gate allowed was already far above it. The gate that
        // actually rejects thin positions is in `momentumSignal`, where the commission is
        // compared against the affordable position size; this is the second line of
        // defence for the case where several symbols compete for a thin pool.
        const minPositionBudget = CONFIG.COMMISSION * CONFIG.MIN_POSITION_COMMISSIONS;
        const maxPositions = Math.min(candidates.length, Math.max(1, Math.floor(deployable / Math.max(1, minPositionBudget))));

        // Positions already open count toward the cap.
        //
        // Without this the cap bounds only a SINGLE tick, which is not the constraint that
        // matters: a wide market fills the cap on one tick and the remainder on the next,
        // so a limit of 7 across 12 qualifying symbols still ends at 12 after two ticks.
        // The capital is what should limit total exposure, so what is held has to be
        // subtracted here rather than re-derived from the candidate list each tick.
        //
        // Held positions were filtered out of `candidates` above, so this count is what
        // the cap is being applied on top of.
        const heldCount = stocks.filter(s => s.longShares > 0 || s.shortShares > 0).length;
        const roomFor = Math.max(0, maxPositions - heldCount);

        const weighted = candidates
            .slice(0, roomFor)
            .map(c => ({
                c,
                w: Math.pow(c.riskAdj, profile.riskAdjPower),
            }));
        const totalWeight = weighted.reduce((sum, x) => sum + x.w, 0);

        if (totalWeight > 0 && remaining > 0) {
            for (const { c, w } of weighted) {
                if (remaining <= minPositionBudget) break;

                const share = deployable * (w / totalWeight);
                const budget = Math.min(share, symbolCap, c.maxBudget, remaining);
                // A position below the floor is not opened, rather than opened smaller.
                //
                // `maxBudget` is exempt, and that exemption is the whole subtlety here.
                // It is the game's own limit on what this SYMBOL can hold, not a slice of
                // the pool — so when it is the binding term, the position is as large as
                // it is allowed to be and the commission was already checked against it
                // by the entry's own cost gate. Applying the floor to it would refuse
                // every symbol whose share limit happens to be small, which is most of
                // them, and the feature would never trade at all. The floor is about how
                // thinly the POOL is split, so it applies to `share` and `remaining`.
                const limitedBySymbol = c.maxBudget <= Math.min(share, remaining);
                if (!limitedBySymbol && budget < minPositionBudget) continue;

                const shares = Math.floor((budget - CONFIG.COMMISSION) / c.execPrice);
                if (shares <= 0) continue;

                if (c.direction === 1) {
                    const bought = ns.stock.buyStock(c.s.symbol, shares);
                    if (bought > 0) {
                        const cost = bought * c.execPrice + CONFIG.COMMISSION;
                        announce(ns, "STOCK", `BUY ${c.s.symbol} x${fmt(bought)} @ ${fmt(c.execPrice)} (${c.reason})`, "tx");
                        cooldowns[c.s.symbol] = now + CONFIG.SYMBOL_COOLDOWN_MS;
                        remaining -= cost;
                    }
                } else {
                    const shorted = ns.stock.buyShort(c.s.symbol, shares);
                    if (shorted > 0) {
                        const cost = shorted * c.execPrice + CONFIG.COMMISSION;
                        announce(ns, "STOCK", `SHORT ${c.s.symbol} x${fmt(shorted)} @ ${fmt(c.execPrice)} (${c.reason})`, "tx");
                        cooldowns[c.s.symbol] = now + CONFIG.SYMBOL_COOLDOWN_MS;
                        remaining -= cost;
                    }
                }
            }
        }
    }
}

/* ─── SIGNALS ─── */

/** What a signal decided: which way, how strongly, and how the log should describe it. */
interface Signal {
    readonly direction: 1 | -1;
    /** Confidence, comparable with `profile.minEdge` so both signals share one threshold. */
    readonly edge: number;
    /** `edge` adjusted for risk, used to rank candidates against each other. */
    readonly riskAdj: number;
    /**
     * "Best first" score for THIS signal, higher always better.
     *
     * With 4S it is the direction-adjusted forecast (see `rankOf`); the momentum signal
     * sets it equal to `riskAdj`, since its own best-first order is the risk-adjusted move.
     * One field so the sort is a single descending comparison whatever produced the
     * candidate.
     */
    readonly rank: number;
    readonly reason: string;
}

/**
 * The 4S signal: the game's own forecast, which is a real model.
 *
 * `getForecast` is a PROBABILITY that the price rises on the next tick, so `edge` is the
 * distance from a coin flip rather than a price move. That distinction decides the threshold:
 * the bar is economic (see `minEdge4S`), and the expected move it implies is
 * `edge × 2 × volatility`, which is what has to beat the round trip.
 *
 * `riskAdj` divides by volatility so a steady mover outranks a wild one at the same
 * confidence — which is the point of having paid for volatility data.
 *
 * `commissionPct` is the fixed commission as a fraction of the position this symbol could
 * carry, so the cost floor is in the same units as the move. It is passed in rather than
 * computed here because the entry loop already derives it for the sizing and the two must
 * agree.
 */
function forecastSignal(s: StockData, profile: Profile, commissionPct: number): Signal | null {
    const edge = s.forecast - 0.5;
    if (!isFinite(edge)) return null;

    const strength = Math.abs(edge);
    const floor = minEdge4S(s, profile, commissionPct);
    if (strength < floor) return null;

    return {
        direction: edge < 0 ? -1 : 1,
        edge: strength,
        riskAdj: strength / Math.max(s.volatility, 0.001),
        rank: rankOf(s.forecast),
        reason: `fc=${s.forecast.toFixed(2)} min=${floor.toFixed(3)}`,
    };
}

/**
 * A forecast as a "best first" score, so a strong short and a strong long rank alike.
 *
 * `forecast` runs 0..1 with 0.5 as no edge. A long wants it HIGH and a short wants it LOW,
 * so ranking on the raw number would put every long above every short — the best short would
 * sort last. Folding a short's forecast to `1 - forecast` puts both on one "distance from
 * no-edge, in the direction of the bet" axis, which is what "best forecast first" means once
 * shorts are in play. Called once per symbol at signal time, so the ranking key and the
 * direction cannot drift apart.
 */
function rankOf(forecast: number): number {
    return forecast >= 0.5 ? forecast : 1 - forecast;
}

/**
 * The fallback signal: the direction of recent price movement.
 *
 * Weaker than a forecast and treated as weaker. Three things make it behave:
 *
 *   - The threshold is the profile's `minEdge` scaled UP, because momentum on a random
 *     walk is noisier than a model and the same threshold would fire constantly.
 *   - `isWorthTrading` checks the move against the round-trip cost. A 0.2% move that
 *     costs 0.3% in spread and commissions loses money however right the direction is,
 *     and a strategy built from the signal alone never notices that.
 *   - Risk is measured as the spread rather than volatility, because volatility is a
 *     4S-only reading. A wide spread is the risk actually visible here.
 *
 * Returns null when there is not enough history yet, which is the first few ticks of a
 * run and also after a restart: the window has to fill before this can say anything.
 */
function momentumSignal(
    s: StockData,
    history: PriceHistory,
    profile: Profile,
    cash: number,
): Signal | null {
    const momentum = readMomentum(history.get(s.symbol));
    if (momentum.direction === 0) return null;

    // Commissions as a fraction of the position this could afford, so the cost check
    // is in the same units as the price move.
    const maxPosition = Math.max(1, s.maxShares * s.ask);
    const commissionPct = CONFIG.COMMISSION / Math.min(maxPosition, Math.max(1, cash));

    if (!isWorthTrading(momentum, s.spreadPct, commissionPct)) return null;

    // The consistency gate, and it is doing real work rather than adding polish.
    // `strength` alone cannot tell a steady climb from a series that wandered upward,
    // and ranking by it FAVOURS the wanderers: noise is what produces the largest
    // window-to-window differences, so the noisiest symbol in a random market is the one
    // that looks strongest. Requiring most steps to agree with the direction filters
    // exactly that case out.
    if (momentum.consistency < MOMENTUM_MIN_CONSISTENCY) return null;

    // A margin over the profile threshold, because this signal is noisier.
    const required = profile.minEdge * MOMENTUM_THRESHOLD_MULTIPLE;
    if (momentum.strength < required) return null;

    // What the move must clear to be worth taking, in the same units as `strength`.
    const cost = roundTripCost(s.spreadPct, commissionPct);

    // Ranked by expected edge per unit of cost, not by raw size.
    //
    // Size alone is the wrong ranking and the reason it is worth spelling out: a 4%
    // move that costs 3% to trade is worth 1%, while a 1% move costing 0.2% is worth
    // 0.8%. The larger move is the worse trade, and any ranking by `strength` puts it
    // first. `expectedEdge` is what is actually left after the round trip, and
    // consistency scales it because a move that only just agreed with itself is less
    // likely to persist.
    const expectedEdge = (momentum.strength - cost) * momentum.consistency;

    return {
        direction: momentum.direction,
        edge: expectedEdge,
        riskAdj: expectedEdge / Math.max(s.spreadPct, 0.001),
        // The momentum signal's own best-first order IS the risk-adjusted score, so its rank
        // is that. The sort has one field to compare whatever the signal.
        rank: expectedEdge / Math.max(s.spreadPct, 0.001),
        reason:
            `mom=${(momentum.strength * 100).toFixed(2)}% ` +
            `c=${(momentum.consistency * 100).toFixed(0)}% ` +
            `edge=${(expectedEdge * 100).toFixed(2)}% n=${momentum.samples}`,
    };
}

/**
 * Which way the signal points for a symbol we already hold, or null when it cannot say.
 *
 * Mirrors the entry's choice of signal, and that mirroring is the whole point: a
 * position opened on momentum has to be closed on momentum, or the entry and the exit
 * are answering different questions. Reads the SAME source the entry read, so the two
 * cannot drift.
 *
 * Returns a direction rather than the entry's full `Signal`, because an exit only needs
 * to know whether the reason to hold is still there — the confidence thresholds belong
 * to deciding whether to OPEN a position, not to keeping one. Applying `minEdge` here
 * would close a position merely because it became marginal, which pays the commission
 * and then re-opens it on the next tick.
 *
 * `null` means "not enough history to say", which is the first ticks after a restart.
 * Callers must treat it as "keep the position" — an unanswerable question is not a
 * reason to sell.
 */
function exitSignal(s: StockData, has4S: boolean, history: PriceHistory): 1 | -1 | 0 | null {
    if (has4S) {
        const edge = s.forecast - 0.5;
        if (!isFinite(edge)) return null;
        // The forecast's own deadband, so a forecast drifting across 0.5 does not toggle the
        // position every tick. `EXIT_EDGE_4S` rather than `EXIT_EDGE`: the two deadbands
        // guard different readings — see the constant for why the 4S one can be tighter.
        if (Math.abs(edge) < CONFIG.EXIT_EDGE_4S) return 0;
        return edge > 0 ? 1 : -1;
    }

    // Momentum path: mirror the entry exactly, including its cost bar.
    //
    // This used to return the raw direction the moment it was not flat, which made the
    // exit far more eager than the entry: a position opened only on a move clearing
    // spread + 2×commission was closed on a 0.01% wiggle, paying the full round trip to
    // do it. See `worthHolding` in price-history.ts for the mechanism.
    //
    // The commission fraction is computed the same way the entry computes it, off the
    // position this symbol could actually carry, so the two bars are in the same units
    // and cannot drift apart.
    const momentum = readMomentum(history.get(s.symbol));
    if (momentum.samples === 0) return null;
    if (momentum.direction === 0) return 0;

    const commissionPct = CONFIG.COMMISSION / Math.max(1, s.maxShares * s.ask);
    return worthHolding(momentum, momentum.direction, s.spreadPct, commissionPct, CONFIG.EXIT_EDGE)
        ? momentum.direction
        : 0;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function deriveProfile(netWorth: number): { profile: Profile; tierIndex: number } {
    const nw = Math.max(netWorth, 1);
    const first = PROFILE_ANCHORS[0];
    const last = PROFILE_ANCHORS[PROFILE_ANCHORS.length - 1];
    if (nw <= first.nw) return { profile: { ...first.profile }, tierIndex: 0 };
    if (nw >= last.nw) return { profile: { ...last.profile }, tierIndex: PROFILE_ANCHORS.length - 1 };

    for (let i = 0; i < PROFILE_ANCHORS.length - 1; i++) {
        const lo = PROFILE_ANCHORS[i];
        const hi = PROFILE_ANCHORS[i + 1];
        if (nw >= lo.nw && nw <= hi.nw) {
            const t = (Math.log10(nw) - Math.log10(lo.nw)) / (Math.log10(hi.nw) - Math.log10(lo.nw));
            return {
                profile: {
                    minEdge: lerp(lo.profile.minEdge, hi.profile.minEdge, t),
                    deployTargetPct: lerp(lo.profile.deployTargetPct, hi.profile.deployTargetPct, t),
                    riskAdjPower: lerp(lo.profile.riskAdjPower, hi.profile.riskAdjPower, t),
                },
                tierIndex: i,
            };
        }
    }

    return { profile: { ...last.profile }, tierIndex: PROFILE_ANCHORS.length - 1 };
}

/**
 * The profile to trade on, adjusted for having bought 4S Market Data.
 *
 * WHAT 4S CHANGES, and each of the three is a different argument.
 *
 * `deployTargetPct: 1`. The tier table climbs from 0.75 to 0.97 because the entry signal
 * WITHOUT 4S is weak: price momentum on a market that moves every tick is mostly noise, so
 * holding cash back is the honest posture for a signal that is often wrong. With 4S the
 * signal is the game's own forecast, so there is no reason to keep a policy sized for a
 * weaker one — the whole post-reserve balance is deployable.
 *
 * `riskAdjPower: 1`. The power curve concentrates the pool on a weak signal's better
 * candidates. With per-symbol forecasts that are worth trusting, linear weighting lets a
 * good name take its share rather than being sharpened toward the single best reading.
 *
 * `minEdge`. Left as the tier sets it HERE and overridden per symbol by `minEdge4S`, which is
 * the only place the cost of trading is known — see that function for why the threshold has
 * to be economic rather than a fixed confidence bar.
 *
 * The 10% cash reserve is deliberately NOT dropped. It is the buffer that keeps the framework
 * solvent across the rest of its features (see `RESERVE_CASH_PCT`), and the fixed 100k
 * commission has to come from somewhere; `MIN_POSITION_COMMISSIONS` guards against fanning
 * thin positions across a wide market.
 */
/**
 * The smallest forecast edge worth acting on with 4S, given what a round trip costs.
 *
 * WHY THIS REPLACES THE TIER `minEdge`. The tier table's threshold (0.045 down to 0.010)
 * was calibrated against a MOMENTUM signal, and it answers a question that does not apply
 * here. Momentum is a lagging mean-vs-mean reading that is mostly noise at this cadence, so
 * the bar had to be high to keep the strategy from trading its own noise. The 4S forecast is
 * the game's own probability for the next tick, so the only reason to refuse a trade is
 * ECONOMIC: the edge has to be worth more than the round trip costs to capture it.
 *
 * THE CONVERSION, stated because it is the part that is easy to get wrong. The forecast is a
 * PROBABILITY, not a price move — 0.55 means "55% chance the price rises next tick", not
 * "the price rises 5%". So it cannot be compared to a cost percentage directly. What makes
 * them comparable is `volatility`, which is the size of a typical tick move: a forecast of
 * `p` implies an expected move of about `(2p - 1) × volatility` per tick. Requiring that to
 * clear `spread + 2 × commission` gives
 *
 *     minEdge = cost / (2 × volatility)
 *
 * and that is the floor used below. It adapts to the symbol rather than being one number:
 * a quiet name needs a more confident forecast to be worth its spread than a volatile one,
 * which is the honest reading of "is this trade worth making".
 *
 * The invariants that keep it sane: `volatility` of 0 (no 4S reading, or a flat name) falls
 * back to the tier threshold rather than dividing by zero, and the result is clamped to at
 * most the tier value so having 4S can only ever LOOSEN the bar, never tighten it.
 *
 * The floor is not zero, and that is deliberate even under the "act on the forecast"
 * instruction: a trade whose expected move is smaller than its cost loses money however
 * right the direction is. Refusing those is not caution, it is arithmetic.
 */
function minEdge4S(symbol: StockData, tier: Profile, commissionPct: number): number {
    const cost = roundTripCost(symbol.spreadPct, commissionPct);
    if (!(symbol.volatility > 0)) return tier.minEdge;

    const costFloor = cost / (2 * symbol.volatility);
    // Never above the tier bar, so 4S is a loosening and never a tightening.
    return Math.min(tier.minEdge, Math.max(0, costFloor));
}

function deployProfile(profile: Profile, has4S: boolean): Profile {
    // `deployTargetPct: 1` and `riskAdjPower: 0`: with 4S the whole post-reserve balance is
    // deployable, and the sizing is LINEAR in the weight rather than a power curve. The power
    // existed to concentrate a weak signal's pool onto its better candidates; with a forecast
    // that is trustworthy per symbol, flattening it lets a genuinely good name take its share
    // outright instead of being sharpened toward the single best reading.
    //
    // `minEdge` is left as the tier's here and overridden per symbol by `minEdge4S`, which is
    // the only place the cost of trading is known.
    return has4S ? { ...profile, deployTargetPct: 1, riskAdjPower: 1 } : profile;
}

/**
 * One reading of every symbol.
 *
 * `has4S` is required rather than optional, and that is the fix for a live fault:
 * `getForecast`, `getVolatility` and `getMaxShares` all THROW without 4S Market Data
 * TIX API Access, and this read happens unconditionally on every tick while the
 * `has4S` check only guarded the entry logic further down. On a node that had bought
 * the TIX API but not the 4S data, the feature faulted before it ever reached that
 * guard — `stock.getForecast: You don't have 4S Market Data TIX API Access!`, once per
 * tick, forever.
 *
 * The fields are still populated, because `StockData` is one shape and callers should
 * not have to know which are meaningful. They are neutral values instead of a crash:
 * a forecast of 0.5 is "no edge", which is exactly right when there is no data to
 * have an edge with.
 */
function readStocks(ns: NS, has4S: boolean): StockData[] {
    const out: StockData[] = [];
    for (const symbol of ns.stock.getSymbols()) {
        const bid = ns.stock.getBidPrice(symbol);
        const ask = ns.stock.getAskPrice(symbol);
        const price = (bid + ask) / 2;
        if (price <= 0) continue;

        const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(symbol);

        out.push({
            symbol, bid, ask, price,
            spreadPct: (ask - bid) / price,
            // The only two reads that require 4S Market Data. Neutral values when it
            // is absent, because `StockData` is one shape and callers should not have
            // to know which fields are meaningful: 0.5 is "no edge", which is the
            // honest reading when there is no data to have an edge with.
            forecast: has4S ? ns.stock.getForecast(symbol) : 0.5,
            volatility: has4S ? ns.stock.getVolatility(symbol) : 0,
            // NOT 4S-gated. `getMaxShares` needs only the TIX API, and guarding it
            // wrongly reported a position limit of zero — which zeroed `maxBudget` and
            // would have stopped the fallback below from sizing anything.
            maxShares: ns.stock.getMaxShares(symbol),
            longShares, longAvg, shortShares, shortAvg,
        });
    }
    return out;
}

function fmt(n: number): string {
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "b";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "m";
    if (a >= 1e3) return (n / 1e3).toFixed(2) + "k";
    return n.toFixed(0);
}