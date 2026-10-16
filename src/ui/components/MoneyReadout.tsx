import type { Player, Portfolio } from "../doc";
import { moneyFull } from "../format";

/**
 * The headline figure.
 *
 * Net worth gets the largest type because it is the honest headline once
 * holdings exist — cash alone understates a trader's position. Cash stays as
 * the supporting line so the spendable number is never hidden.
 */
export function MoneyReadout({
    player,
    portfolio,
}: {
    player: Player;
    portfolio?: Portfolio | null;
}) {
    const cash = player.money;
    const stockValue = portfolio?.stock?.value ?? 0;
    const hasStock = stockValue > 0;
    const netWorth =
        typeof cash === "number" ? cash + stockValue : undefined;

    // Before the first portfolio reading arrives, fall back to cash so the hero
    // is never empty.
    const headline = netWorth ?? cash;

    // Lead with the cash figure when holdings exist, since net worth alone
    // hides what is actually spendable. Otherwise show where the agent is,
    // collapsing location and city when they are the same place.
    const where =
        player.location === player.city
            ? player.location
            : [player.location, player.city].filter(Boolean).join(" · ");

    const sub = hasStock
        ? `${moneyFull(cash)} cash · ${moneyFull(stockValue)} stock`
        : where;

    return (
        <section className="hero">
            <p className="hero__value">{moneyFull(headline)}</p>
            <p className="hero__sub">
                {sub || (hasStock ? "" : "unknown location")}
            </p>
        </section>
    );
}
