import { useEffect, useMemo, useState } from "react";
import { getUiBridge, type ConnectionStatus, type GameHealth } from "./store";
import { Dossier } from "./components/Dossier";
import { ControlsPanel } from "./components/ControlsPanel";
import { LogPanel } from "./components/LogPanel";
import { StatusIndicator } from "./components/StatusIndicator";
import { SUBTREE, type NexusState } from "./doc";
import { useSyncedValue } from "./useSyncedValue";

/**
 * Root component.
 *
 * Keeps connection lifecycle here; the panels read game state straight from the
 * shared DocStore. `nexus` is read here as well as in the dossier because the
 * command bar needs it: it derives its goal options from what the game
 * reports it has loaded.
 */
export function App() {
    const bridge = useMemo(() => getUiBridge(), []);
    const [status, setStatus] = useState<ConnectionStatus>(bridge.status());
    const [health, setHealth] = useState<GameHealth>(bridge.health());
    const nexus = useSyncedValue<NexusState | null>(bridge.store, SUBTREE, "/nexus");

    useEffect(() => {
        const offStatus = bridge.onStatusChange(setStatus);
        const offHealth = bridge.onHealthChange(setHealth);
        bridge.connect();
        return () => {
            bridge.disconnect();
            offStatus();
            offHealth();
        };
    }, [bridge]);

    return (
        <div className="app">
            <header className="bar">
                <span className="bar__id">
                    <span className="bar__mark" aria-hidden="true" />
                    bitburner
                    <span className="bar__sep">/</span>
                    dossier
                </span>
                <StatusIndicator status={status} health={health} />
            </header>

            <main className="app__body">
                <ControlsPanel bridge={bridge} nexus={nexus} />
                <Dossier store={bridge.store} />
                <LogPanel bridge={bridge} />
            </main>
        </div>
    );
}
