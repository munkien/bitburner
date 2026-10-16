import type { Portfolio } from "../doc";
import { moneyFull, signedMoney, percent } from "../format";
import {
    portfolioNetWorth,
    stockGain,
    stockGainPercent,
} from "../../shared/portfolio";

/**
 * Cash and holdings.
 *
 * The net-worth total and gain/loss come from `shared/portfolio` rather than
 * being recomputed here, so the figure on screen is the same one the server
 * quotes in its reasoning. Stock is only present when the player can trade
 * (WSE account + TIX API), so the panel degrades to cash alone and says why
 * rather than showing a misleading zero.
 */
export function PortfolioPanel({ portfolio }: { portfolio: Portfolio }) {
    const cash = portfolio.cash ?? 0;
    const stock = portfolio.stock;
    const netWorth = portfolioNetWorth(portfolio);
    const gain = stockGain(portfolio) ?? 0;
    const gainPct = stockGainPercent(portfolio);

    return (
        <section className="panel panel--portfolio">
            <h2 className="panel__title">
                Portfolio
                {stock && stock.positions > 0 && (
                    <span className="panel__count">{stock.positions}</span>
                )}
            </h2>

            <dl className="stats">
                <Stat label="cash" value={moneyFull(cash)} />
                <Stat label="net worth" value={moneyFull(netWorth)} />
                {stock && (
                    <>
                        <Stat label="stock value" value={moneyFull(stock.value)} />
                        <Stat
                            label="unrealized"
                            value={`${signedMoney(gain)}${
                                gainPct !== null ? ` (${percent(gainPct)})` : ""
                            }`}
                            tone={gain > 0 ? "up" : gain < 0 ? "down" : undefined}
                        />
                        <Stat
                            label="invested"
                            value={moneyFull(stock.invested)}
                        />
                    </>
                )}
            </dl>

            {!stock && (
                <p className="panel__empty">
                    Stock data needs a WSE account and TIX API access. Buy both
                    from the in-game WSE, then trades appear here.
                </p>
            )}
        </section>
    );
}

function Stat({
    label,
    value,
    tone,
}: {
    label: string;
    value: string;
    tone?: "up" | "down";
}) {
    return (
        <>
            <dt className="stats__label">{label}</dt>
            <dd
                className={`stats__value${tone ? ` stats__value--${tone}` : ""}`}
            >
                {value}
            </dd>
        </>
    );
}
