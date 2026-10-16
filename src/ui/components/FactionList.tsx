/**
 * Faction memberships.
 *
 * Rendered as a plain wrapped list rather than chips or badges — the count is
 * what matters (more factions means more augmentations available), and a list
 * stays legible from 1 to 30 entries without a fixed-height container.
 */
export function FactionList({ factions }: { factions: string[] | undefined }) {
    if (!factions || factions.length === 0) {
        return (
            <section className="panel panel--factions">
                <h2 className="panel__title">Factions</h2>
                <p className="panel__empty">
                    No memberships yet. Join one to unlock augments.
                </p>
            </section>
        );
    }

    return (
        <section className="panel panel--factions">
            <h2 className="panel__title">
                Factions
                <span className="panel__count">{factions.length}</span>
            </h2>
            <ul className="factions">
                {factions.map((faction) => (
                    <li className="factions__item" key={faction}>
                        {faction}
                    </li>
                ))}
            </ul>
        </section>
    );
}
