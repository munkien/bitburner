import type { NexusState } from "../doc";
import { useEffect, useState } from "react";

import { moneyFull, eta, countdown } from "../format";

/**
 * A clock that ticks only while `active`, so the countdown moves between telemetry
 * frames.
 *
 * WHY A LOCAL CLOCK. Telemetry arrives about once a second, which is enough for every
 * other figure here — they are levels, and a level that is a second stale is still
 * true. A countdown is not: repainting `47m` once a second looks frozen when the last
 * minute is the only part a reader is watching. Ticking locally makes the seconds move
 * without asking the game for anything.
 *
 * Paused when there is no countdown, which is the ordinary state of a run. An interval
 * that re-renders the panel every second to display nothing is a cost with no answer.
 */
function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [active]);
    return now;
}

/**
 * What the game's orchestrator is doing, read live from the store.
 *
 * A REPORT, and now only a report. It used to carry the per-feature switches as
 * well, which meant the panel you read to see what the run was doing was also
 * the panel you changed it from — and the most stateful code in the UI lived in
 * something whose own description was "mostly a report". The switches moved to
 * `FeatureSwitches`, beside the other commands; what stays here is what the game
 * says, including each feature's state, which is still the answer to "why is
 * that not running".
 */
export function NexusPanel({ nexus }: { nexus: NexusState }) {
    const goal = nexus.goal;
    const features = nexus.features ?? [];
    const active = features.filter((f) => f.state === "active");
    const faults = features.filter(
        (f) => f.state === "failed" || f.state === "unloadable"
    );
    const now = useNow(nexus.stall !== undefined);

    return (
        <section className="panel panel--nexus">
            <h2 className="panel__title">
                Orchestrator
                <span className="panel__count">
                    {active.length}/{features.length}
                </span>
            </h2>

            <div className="goal">
                {goal ? (
                    <>
                        <div className="goal__head">
                            <span className="goal__name">{goal.name}</span>
                            <span className="goal__progress">
                                {Math.round(goal.progress * 100)}%
                            </span>
                        </div>
                        {/* Effort beside the ratio, because the ratio alone cannot
                            tell "nearly done" from "hours away" — 79% is a level
                            fraction, not an estimate. */}
                        <p className="goal__eta">
                            <span className="goal__eta-label">estimated</span>{" "}
                            {eta(goal.estimateSeconds)}
                        </p>
                        <div className="goal__track" aria-hidden="true">
                            <span
                                className="goal__fill"
                                style={{ width: `${goal.progress * 100}%` }}
                            />
                        </div>
                        {goal.subGoals && goal.subGoals.length > 0 && (
                            <ul className="gaps">
                                {goal.subGoals.map((sub) => (
                                    <li className="gaps__item" key={sub.key}>
                                        <span className="gaps__key">
                                            {sub.key}
                                        </span>
                                        <span className="gaps__value">
                                            {formatMeasure(sub.current)}
                                            <span className="gaps__to">
                                                {" → "}
                                            </span>
                                            {formatMeasure(sub.target)}
                                        </span>
                                        {sub.contributors &&
                                            sub.contributors.length === 0 && (
                                                <span
                                                    className="gaps__stuck"
                                                    title="No running feature can advance this"
                                                >
                                                    stuck
                                                </span>
                                            )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {/* The queued goals by name and progress, not just a count.
                            "Is something closer waiting?" is the question that
                            makes the current goal's ranking legible — and with
                            only a number it was unanswerable from the console. */}
                        {nexus.queue && nexus.queue.length > 0 ? (
                            <>
                                <p className="goal__queued">
                                    +{nexus.queued} queued behind it
                                </p>
                                <ul className="queue">
                                    {nexus.queue.map((g) => (
                                        <li className="queue__item" key={g.name}>
                                            <span className="queue__name">
                                                {g.name}
                                            </span>
                                            <span className="queue__progress">
                                                {Math.round(g.progress * 100)}%
                                            </span>
                                            <span className="queue__eta">
                                                {eta(g.estimateSeconds)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        ) : (
                            nexus.queued !== undefined &&
                            nexus.queued > 0 && (
                                <p className="goal__queued">
                                    +{nexus.queued} queued behind it
                                </p>
                            )
                        )}
                    </>
                ) : (
                    <p className="panel__empty">
                        Every faction joined — the run has no goal left to chase.
                    </p>
                )}
            </div>

            {/* EVERY RESERVE THAT IS IN FORCE, and the panel appears when ANY of them is.
                It used to test only `cash` and `homeRamGb`, so a run holding back a
                stock-chain reserve showed nothing at all — the row was hidden by the very
                condition that should have revealed it. Reported as the console line reading
                `cash 0.000` while billions were reserved.

                Zero-valued reserves are omitted rather than shown as 0.00: a reserve of zero
                is not a fact about the run, and listing it invites reading it as "nothing is
                being held back" when a neighbour on the same row says otherwise. */}
            {nexus.reserves &&
                ((nexus.reserves.cash ?? 0) > 0 ||
                    (nexus.reserves.stockAccessCash ?? 0) > 0 ||
                    (nexus.reserves.homeRamGb ?? 0) > 0) && (
                    <dl className="stats">
                        {(nexus.reserves.cash ?? 0) > 0 && (
                            <>
                                <dt className="stats__label">reserved cash</dt>
                                <dd className="stats__value">
                                    {moneyFull(nexus.reserves.cash ?? 0)}
                                </dd>
                            </>
                        )}
                        {(nexus.reserves.stockAccessCash ?? 0) > 0 && (
                            <>
                                <dt className="stats__label">reserved for stock access</dt>
                                <dd className="stats__value">
                                    {moneyFull(nexus.reserves.stockAccessCash ?? 0)}
                                </dd>
                            </>
                        )}
                        {(nexus.reserves.homeRamGb ?? 0) > 0 && (
                            <>
                                <dt className="stats__label">reserved RAM</dt>
                                <dd className="stats__value">
                                    {nexus.reserves.homeRamGb ?? 0} GB
                                </dd>
                            </>
                        )}
                    </dl>
                )}

            {/* The retirement stall countdown, shown only while it is actually counting.
                Every other figure here is a level a reader can check against something
                else on screen; this one is a timer, and a timer that is not visible
                cannot be told apart from a timer that never armed. Absent means the
                clock is not running — too little queued, or nothing bought yet. */}
            {nexus.stall && (
                <p className="stall" title={`Installs anyway when the queue stops growing${nexus.stall.queued > 0 ? ` — ${nexus.stall.queued} queued` : ""}`}>
                    <span className="stall__label">stall install in</span>{" "}
                    <span
                        className={`stall__value${nexus.stall.dueAt - now <= 0 ? " stall__value--due" : ""}`}
                    >
                        {countdown(nexus.stall.dueAt, now)}
                    </span>
                </p>
            )}

            {faults.length > 0 && (
                <ul className="faults">
                    {faults.map((f) => (
                        <li className="faults__item" key={f.id}>
                            <span className="faults__name">{f.name}</span>
                            <span className="faults__state">{f.state}</span>
                        </li>
                    ))}
                </ul>
            )}

            {/* Each feature's state, read-only. The switches that change these
                live in the command panel; this is the answer to "why is that
                not running", which is a question about the game, not a control. */}
            {features.length > 0 && (
                <>
                    <h3 className="subhead">Features</h3>
                    <ul className="features">
                        {features.map((f) => {
                            // The status, when the game publishes one. "active" alone
                            // is true whether a feature is working or has returned
                            // early from the same guard for an hour — which is what
                            // made a deadlock invisible.
                            const status = nexus.statuses?.[f.id];
                            return (
                                <li className="features__item" key={f.id}>
                                    <span className="features__name">
                                        {f.name}
                                        {status && (
                                            <span
                                                className="features__doing"
                                                title={status}
                                            >
                                                {status}
                                            </span>
                                        )}
                                    </span>
                                    <span
                                        className={`features__state features__state--${f.state}`}
                                    >
                                        {f.state}
                                    </span>
                                    <span className="features__ram">
                                        {f.ramGb !== undefined && f.ramGb > 0
                                            ? `${f.ramGb.toFixed(1)} GB`
                                            : ""}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
        </section>
    );
}

/**
 * Measures arrive as raw numbers from the game (skills, money, karma). Money is
 * large enough to need grouping; everything else is shown as a plain integer.
 */
function formatMeasure(value: number): string {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) >= 1_000_000) return moneyFull(value);
    return Math.round(value).toLocaleString("en-US");
}
