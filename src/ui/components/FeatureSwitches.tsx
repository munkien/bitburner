import { useEffect, useState } from "react";
import type { UiBridge } from "../store";
import type { NexusState } from "../doc";

/**
 * The per-feature switches: the operator's finest-grained command.
 *
 * Turning a feature off frees its RAM and stops it; turning it back on lets the
 * framework admit it again. This lives here, with the other commands, rather
 * than inside the orchestrator panel — that panel reports what the game is
 * doing, and a report should not also be the place its state is changed.
 */
export function FeatureSwitches({
    nexus,
    bridge,
}: {
    nexus: NexusState | null | undefined;
    bridge: UiBridge;
}) {
    const features = nexus?.features ?? [];

    // The operator's desired switch state, by feature id.
    //
    // Held locally because the wire carries a COMPLETE map, not a delta: the
    // game rebuilds its disabled set from whatever we send, so a toggle must
    // send the whole picture or it would silently re-enable everything else.
    // Seeded from the game's own report, then diverging only where the operator
    // has clicked — so a value the operator never touched keeps tracking the
    // game rather than pinning whatever was true when the panel mounted.
    const [overrides, setOverrides] = useState<Record<string, boolean>>({});
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Drop an override once the game agrees with it, so the switch falls back to
    // following the game's reported state rather than holding a stale intent.
    useEffect(() => {
        setOverrides((current) => {
            let changed = false;
            const next = { ...current };
            for (const id of Object.keys(current)) {
                const reportedOn =
                    features.find((f) => f.id === id)?.state !== "disabled";
                if (reportedOn === current[id]) {
                    delete next[id];
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [nexus]);

    async function toggle(id: string, on: boolean) {
        const next = { ...overrides, [id]: on };
        setOverrides(next);
        setPending(true);
        setError(null);
        try {
            // Send the complete map: every reported feature's current state,
            // overlaid with the operator's changes.
            const features: Record<string, boolean> = {};
            for (const f of nexus?.features ?? []) {
                features[f.id] =
                    f.id in next ? next[f.id] : f.state !== "disabled";
            }
            await bridge.sendCommand({ features });
        } catch (e) {
            setError(e instanceof Error ? e.message : "could not send toggle");
            // Roll the click back, so the switch does not show a state the game
            // never accepted.
            setOverrides((current) => {
                const rolled = { ...current };
                delete rolled[id];
                return rolled;
            });
        } finally {
            setPending(false);
        }
    }

    if (features.length === 0) {
        return (
            <p className="controls__none">
                No features reported yet. Start the orchestrator in-game.
            </p>
        );
    }

    return (
        <>
            <ul className="features">
                {features.map((f) => {
                    const on =
                        f.id in overrides
                            ? overrides[f.id]
                            : f.state !== "disabled";
                    return (
                        <li className="features__item" key={f.id}>
                            <span className="features__name">{f.name}</span>
                            <span
                                className={`features__state features__state--${f.state}`}
                            >
                                {f.state}
                            </span>
                            <button
                                type="button"
                                className="switch"
                                role="switch"
                                aria-checked={on}
                                aria-label={`${on ? "Disable" : "Enable"} ${f.name}`}
                                disabled={pending}
                                onClick={() => void toggle(f.id, !on)}
                            >
                                <span className="switch__knob" />
                            </button>
                        </li>
                    );
                })}
            </ul>

            {error && <p className="controls__error">{error}</p>}
        </>
    );
}
