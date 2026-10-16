import type { ConnectionStatus, GameHealth } from "../store";

const LINK_LABELS: Record<ConnectionStatus, string> = {
    idle: "offline",
    connecting: "linking",
    connected: "server ok",
    error: "no signal",
};

const GAME_LABELS: Record<GameHealth, string> = {
    live: "game live",
    stale: "game stale",
    silent: "game stopped",
    unknown: "no game data",
};

/**
 * Two indicators, because they answer different questions.
 *
 *   link — is this browser connected to the sync server?
 *   game — is the game still reporting to that server?
 *
 * They fail independently, and conflating them is how a stopped game shows as a
 * healthy dashboard: the browser stays connected to the server long after the
 * in-game script has died, so the link stays green while the data freezes.
 *
 * The dot is the only place colour carries state; the label spells it out for
 * anyone who cannot rely on colour.
 */
export function StatusIndicator({
    status,
    health,
}: {
    status: ConnectionStatus;
    health: GameHealth;
}) {
    return (
        <span className="links">
            <span className={`link link--${status}`} role="status">
                <span className="link__dot" aria-hidden="true" />
                {LINK_LABELS[status]}
            </span>
            <span className={`link link--game-${health}`} role="status">
                <span className="link__dot" aria-hidden="true" />
                {GAME_LABELS[health]}
            </span>
        </span>
    );
}
