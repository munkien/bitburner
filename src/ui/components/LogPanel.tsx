import { useEffect, useState } from "react";
import type { UiBridge } from "../store";
import type { LogLine } from "../../shared/types";

/**
 * The framework's message feed: what the features are doing, in order.
 *
 * This is the console's window into everything the orchestrator and its features
 * report — purchases, grafts, failures, state changes. It replaces the in-game
 * log panel, which was wiped every pass and could never show history.
 *
 * Rendered oldest-first, like a terminal, so a new line appears at the bottom
 * where the eye already is. The server holds far more than this; the browser
 * keeps a capped display buffer.
 */
export function LogPanel({ bridge }: { bridge: UiBridge }) {
    const lines = useLog(bridge);

    return (
        <section className="panel panel--log">
            <h2 className="panel__title">
                Log
                <span className="panel__count">{lines.length}</span>
            </h2>
            {lines.length === 0 ? (
                <p className="panel__empty">
                    No messages yet. Feature output appears here as it happens.
                </p>
            ) : (
                <ol className="loglines">
                    {lines.map((line) => (
                        <li
                            className={`loglines__item loglines__item--${line.level}`}
                            key={line.seq}
                        >
                            <span className="loglines__tag">{line.tag}</span>
                            <span className="loglines__body">{line.message}</span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}

/** Subscribe to the bridge's message buffer. */
function useLog(bridge: UiBridge): readonly LogLine[] {
    const [lines, setLines] = useState<readonly LogLine[]>(bridge.log());
    useEffect(() => bridge.onLogChange(setLines), [bridge]);
    return lines;
}
