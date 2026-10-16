import type { Portfolio } from "./types.ts";

/**
 * Derived portfolio figures, shared by the server and the UI.
 *
 * These live in `shared` because both sides need the same *number*: the server
 * quotes them in strategy reasons, and the UI renders them in the portfolio
 * panel. One definition means a displayed figure can never disagree with the
 * reasoning that justified it.
 *
 * Pure functions, no I/O — safe in Node and the browser alike.
 */

/**
 * Derive net worth from a portfolio: cash plus the current value of holdings.
 *
 * Bitburner exposes no net-worth call, so this is the one place the sum is
 * defined. It lives here rather than in the game so the definition can change
 * without redeploying the script.
 */
export function portfolioNetWorth(portfolio: Portfolio | undefined): number {
    if (!portfolio) return 0;
    const cash = portfolio.cash ?? 0;
    const stockValue = portfolio.stock?.value ?? 0;
    return cash + stockValue;
}

/** Unrealized gain or loss on the stock book, or null when there is no book. */
export function stockGain(portfolio: Portfolio | undefined): number | null {
    const stock = portfolio?.stock;
    if (!stock) return null;
    return stock.value - stock.invested;
}

/**
 * Gain as a share of cost basis, or null when there is nothing invested to
 * measure against. Guarding here keeps callers from dividing by zero.
 */
export function stockGainPercent(
    portfolio: Portfolio | undefined
): number | null {
    const stock = portfolio?.stock;
    if (!stock || stock.invested <= 0) return null;
    return ((stock.value - stock.invested) / stock.invested) * 100;
}
