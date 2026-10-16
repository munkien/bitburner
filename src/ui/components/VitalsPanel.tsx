import type { Player } from "../doc";
import { count, karma, playtime } from "../format";

/**
 * The non-skill half of the dossier: where the agent is, what it has done, and
 * how healthy it currently is.
 */
export function VitalsPanel({ player }: { player: Player }) {
    const hp = player.hp ?? {};
    const current = hp.current ?? 0;
    const max = hp.max ?? 0;
    const hpPct = max > 0 ? (current / max) * 100 : 0;

    return (
        <section className="panel panel--vitals">
            <h2 className="panel__title">Vitals</h2>

            <div className="hp">
                <div className="hp__head">
                    <span className="hp__label">Integrity</span>
                    <span className="hp__value">
                        {Math.floor(current)}
                        <span className="hp__max">{` / ${Math.floor(max)}`}</span>
                    </span>
                </div>
                <div
                    className={`hp__track${hpPct < 35 ? " hp__track--low" : ""}`}
                    role="meter"
                    aria-valuenow={Math.floor(current)}
                    aria-valuemin={0}
                    aria-valuemax={Math.floor(max)}
                    aria-label="Health"
                >
                    <span className="hp__fill" style={{ width: `${hpPct}%` }} />
                </div>
            </div>

            <dl className="stats">
                <Stat label="location" value={player.location} />
                <Stat label="city" value={player.city} />
                <Stat
                    label="work"
                    // The activity slot's contents. An EMPTY slot is the thing worth
                    // noticing: several features can each report "yielded" while something
                    // runs, and without this the console cannot tell that from nobody doing
                    // anything — which is how a course in progress was read as a deadlock.
                    value={
                        player.work
                            ? `${player.work.what}${player.work.where ? ` at ${player.work.where}` : ""}`
                            : "idle"
                    }
                />
                <Stat label="karma" value={karma(player.karma)} />
                <Stat label="kills" value={count(player.numPeopleKilled)} />
                <Stat label="playtime" value={playtime(player.totalPlaytime)} />
                <Stat label="entropy" value={count(player.entropy)} />
            </dl>
        </section>
    );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
    return (
        <>
            <dt className="stats__label">{label}</dt>
            <dd className="stats__value">{value ?? "—"}</dd>
        </>
    );
}
