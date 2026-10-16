/**
 * Formatting helpers for game telemetry.
 *
 * Bitburner's numbers are large and quirky (money to the billions, karma in the
 * millions, playtime in milliseconds), so they need deliberate formatting rather
 * than `toLocaleString()` everywhere.
 */

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const INT2 = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

/** `$32,548,656,827` — full precision, for the headline figure. */
export function moneyFull(value: number | null | undefined): string {
    if (typeof value !== "number") return "—";
    return "$" + INT.format(Math.round(value));
}

/** `355,451` */
export function count(value: number | null | undefined): string {
    if (typeof value !== "number") return "—";
    return INT.format(Math.round(value));
}

/** `169` — skills are whole numbers in the UI even though they're floats. */
export function level(value: number | null | undefined): string {
    if (typeof value !== "number") return "—";
    return INT.format(Math.floor(value));
}

/**
 * Playtime in milliseconds -> `52d 17h`.
 * Days are the unit that matters once a run is old, so we drop finer units.
 */
export function playtime(ms: number | null | undefined): string {
    if (typeof ms !== "number") return "—";
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

/** Karma is large and signed; render as `-1.07m` so it fits a stat lane. */
export function karma(value: number | null | undefined): string {
    if (typeof value !== "number") return "—";
    const n = Math.abs(value);
    const sign = value < 0 ? "-" : "+";
    if (n >= 1e6) return `${sign}${INT2.format(n / 1e6)}m`;
    if (n >= 1e3) return `${sign}${INT2.format(n / 1e3)}k`;
    return `${sign}${INT.format(n)}`;
}

/**
 * Signed money for gain/loss columns: `+$1.24m`, `-$320.50`.
 *
 * The explicit sign matters here — a gain and a loss must be distinguishable
 * without relying on colour alone.
 */
export function signedMoney(value: number | null | undefined): string {
    if (typeof value !== "number") return "—";
    const sign = value < 0 ? "-" : "+";
    return `${sign}$${INT.format(Math.abs(Math.round(value)))}`;
}

/** `12.4%` — for gain/loss as a share of cost basis. */
export function percent(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${Math.abs(value).toFixed(1)}%`;
}

/**
 * An estimated duration in seconds, as a short label: `12m`, `3.4h`.
 *
 * Deliberately coarse. The estimate behind it is a ratio of measured rates and
 * carries real error, so printing minutes on an eleven-hour figure would imply a
 * precision that is not there. `unknown` when nothing measurable said, which is
 * different from `0s` and must not read as "almost done".
 */
export function eta(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
        return "unknown";
    }
    if (seconds <= 0) return "done";
    if (seconds < 90) return `${Math.round(seconds)}s`;
    if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400 * 2) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
}
