import type { NS } from "@ns";

/*
 * ============================================================================
 * NET WORTH
 * ============================================================================
 * One definition, so the features that gate on it cannot disagree.
 *
 * Why this exists. Two places were computing a net worth and they did not match:
 *
 *   the old in-game panel   cash + longShares*price + shortShares*price
 *   stocks.ts               cash + longShares*bid  - shortShares*ask
 *
 * The second is the correct one. The panel (retired; the React console reads this
 * figure instead) ADDED short holdings to net worth, but a
 * short is a liability rather than an asset — the player has sold shares they do not
 * own and must buy them back — so the panel over-reported by twice the short value.
 * The two also priced at different points: mid-price against the bid/ask actually
 * available.
 *
 * Both are narrow, and this keeps that narrowness deliberately. The game exposes no
 * net-worth figure, and the obvious way to widen it — home RAM via
 * `getUpgradeHomeRamCost` — is a Singularity call: it throws without SF4 and costs
 * 16× more RAM outside BitNode 4. The gang feature requires only SF2, so it must not
 * reach for it. What this counts is liquid capital plus at-risk capital, which is the
 * figure the decisions here actually turn on.
 *
 * Stock access is asked about rather than caught, because `ns.stock.getPosition`
 * throws without a WSE account and a TIX API. Without access the figure degrades to
 * cash alone, which is honest: it is what the player could spend right now.
 * ============================================================================
 */

/** Whether the stock calls this module needs are available. Both are 0 GB, neither throws. */
export function hasStockAccess(ns: NS): boolean {
    return ns.stock.hasWseAccount() && ns.stock.hasTixApiAccess();
}

/** What the player holds, in the three parts worth distinguishing. */
export interface Holdings {
    /** Money on the player, spendable now. */
    readonly cash: number;
    /** What is currently at risk in the market, priced at what it would fetch. */
    readonly holdings: number;
    /** `cash + holdings`. */
    readonly netWorth: number;
}

/**
 * Read the player's cash and market holdings.
 *
 * Priced at the side the player would actually trade: a long is worth the bid (what a
 * buyer offers) and a short is a liability at the ask (what covering would cost). Using
 * a mid price for both flatters the total by half the spread on every position.
 *
 * Never throws: a symbol whose price it cannot read contributes nothing rather than
 * taking the whole figure down.
 */
export function readNetWorth(ns: NS): Holdings {
    const cash = ns.getPlayer().money;
    if (!hasStockAccess(ns)) return { cash, holdings: 0, netWorth: cash };

    let holdings = 0;

    try {
        for (const symbol of ns.stock.getSymbols()) {
            const [longShares, _longAvg, shortShares, _shortAvg] = ns.stock.getPosition(symbol);
            if (longShares > 0) holdings += longShares * ns.stock.getBidPrice(symbol);
            // Subtracted, not added: covering a short costs money.
            if (shortShares > 0) holdings -= shortShares * ns.stock.getAskPrice(symbol);
        }
    } catch {
        // The market went away between the access check and the read, which happens on
        // a reset. Cash alone is the correct answer rather than no answer.
        return { cash, holdings: 0, netWorth: cash };
    }

    return { cash, holdings, netWorth: cash + holdings };
}
