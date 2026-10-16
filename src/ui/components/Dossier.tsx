import type { DocStore } from "@syncstate/core";
import { SUBTREE, type Player, type Portfolio, type NexusState } from "../doc";
import { useSyncedValue } from "../useSyncedValue";
import { MoneyReadout } from "./MoneyReadout";
import { PortfolioPanel } from "./PortfolioPanel";
import { NexusPanel } from "./NexusPanel";
import { SkillGrid } from "./SkillGrid";
import { VitalsPanel } from "./VitalsPanel";
import { FactionList } from "./FactionList";

/**
 * The agent dossier: everything we know about the player, read live from the
 * store.
 *
 * `useSyncedValue` subscribes to the store, so incoming patches from the sync
 * server re-render this without any polling or local state.
 *
 * The panels are gated INDEPENDENTLY. `player` and `nexus` arrive in the same
 * frame but are separate fields, and a frame that carries one without the other
 * is normal during startup. Gating everything on `player` meant a missing
 * player field also hid the orchestrator panel, and reported "no agent data"
 * for a game that was in fact reporting — a contradiction the header health
 * indicator made obvious.
 */
export function Dossier({ store }: { store: DocStore }) {
    const player = useSyncedValue<Player | null>(store, SUBTREE, "/player");
    const portfolio = useSyncedValue<Portfolio | null>(
        store,
        SUBTREE,
        "/portfolio"
    );
    const nexus = useSyncedValue<NexusState | null>(store, SUBTREE, "/nexus");

    const hasPlayer = !!player && Object.keys(player).length > 0;
    const hasNexus = !!nexus && Object.keys(nexus).length > 0;

    // Nothing at all yet: the game has not reported. Say so, and say what to do.
    if (!hasPlayer && !hasNexus) {
        return (
            <section className="waiting">
                <p className="waiting__title">No agent data</p>
                <p className="waiting__body">
                    Waiting for the game to report. Start it with{" "}
                    <code className="waiting__code">run /nexus.ts</code> in
                    Bitburner. Stats appear here on the next sweep.
                </p>
            </section>
        );
    }

    return (
        <>
            {hasPlayer && <MoneyReadout player={player} portfolio={portfolio} />}
            {hasNexus && <NexusPanel nexus={nexus} />}
            {/* The dossier panels all read `player`, so they appear together or
                not at all. A frame with nexus but no player is a real state
                during startup, and the orchestrator panel above still shows. */}
            {hasPlayer && (
                <div className="grid">
                    <SkillGrid
                        skills={player.skills ?? {}}
                        exp={player.exp ?? {}}
                    />
                    <VitalsPanel player={player} />
                    {portfolio && <PortfolioPanel portfolio={portfolio} />}
                    <FactionList factions={player.factions} />
                </div>
            )}
        </>
    );
}
