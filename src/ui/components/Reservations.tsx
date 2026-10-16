import { useState } from "react";
import type { UiBridge } from "../store";

/**
 * Resource reservations: the money and RAM floor the run must not spend below.
 *
 * These are operator commands sent to the game (via the nudge channel), not a
 * server-side decision. Because the server is a dumb pipe and does not echo the
 * applied value, this component is the source of truth for what the operator
 * last set: it holds its own state and re-sends the full reservation on commit.
 *
 * Commits on blur and on Enter rather than on every keystroke — typing "3200"
 * would otherwise post "3", "32", "320", "3200" and briefly clamp the run to a
 * nonsense floor.
 */
export function Reservations({
    bridge,
    onError,
}: {
    bridge: UiBridge;
    onError: (message: string | null) => void;
}) {
    const [money, setMoney] = useState("0");
    const [ram, setRam] = useState("0");
    const [saving, setSaving] = useState(false);

    async function commit(field: "money" | "ram", raw: string) {
        const parsed = raw.trim() === "" ? 0 : Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
            onError(
                field === "money"
                    ? "Money reserve must be a number of dollars, 0 or more."
                    : "RAM reserve must be a number of GB, 0 or more."
            );
            return;
        }

        setSaving(true);
        onError(null);
        try {
            // Send the full reservation: the game applies a target state, not a
            // delta, so we always report both figures.
            await bridge.sendCommand({
                reserves: {
                    money: field === "money" ? parsed : Number(money) || 0,
                    ram: field === "ram" ? parsed : Number(ram) || 0,
                },
            });
        } catch (e) {
            onError(e instanceof Error ? e.message : "could not send reservation");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="controls__row controls__row--reserve">
            <span className="controls__label">reserve</span>
            <div className="reserve">
                <label className="reserve__field">
                    <span className="reserve__unit">$</span>
                    <input
                        className="reserve__input"
                        type="number"
                        min={0}
                        step={1000}
                        inputMode="numeric"
                        value={money}
                        disabled={saving}
                        aria-label="Money to keep in reserve, in dollars"
                        onChange={(e) => setMoney(e.target.value)}
                        onBlur={(e) => void commit("money", e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                        }}
                    />
                </label>

                <label className="reserve__field">
                    <input
                        className="reserve__input"
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={ram}
                        disabled={saving}
                        aria-label="Home RAM to keep free, in gigabytes"
                        onChange={(e) => setRam(e.target.value)}
                        onBlur={(e) => void commit("ram", e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                        }}
                    />
                    <span className="reserve__unit">GB</span>
                </label>
            </div>
        </div>
    );
}
