import { useEffect, useState } from "react";
import type { UiBridge } from "../store";
import type { NexusState, Autonomy, SubGoalKey } from "../../shared/types";
import { Reservations } from "./Reservations";
import { FeatureSwitches } from "./FeatureSwitches";

/**
 * The command bar: everything the operator can order the run to do, in one place.
 *
 * Four levers, ordered by how consequential they are — autonomy stops
 * everything, goal redirects it, reserves and features fine-tune it. The
 * per-feature switches used to live in the orchestrator panel instead, which
 * meant the panel you read to see what the run was doing was also where you
 * changed it; they are a command, so they belong with the commands.
 *
 * This panel sends commands and nothing else — the game decides. But it is not
 * blind: each control reflects the game's reported state, so a request that was
 * accepted, ignored, or superseded is visible here rather than assumed.
 */
export function ControlsPanel({
    bridge,
    nexus,
}: {
    bridge: UiBridge;
    /**
     * The orchestrator's state, or `null`/`undefined` before the first frame.
     *
     * `undefined` is a real case, not a defensive one: a path absent from the
     * document reads as `undefined`, which is what a fresh page sees. Both are
     * accepted so the caller does not have to normalise one into the other.
     */
    nexus: NexusState | null | undefined;
}) {
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [requestedGoal, setRequestedGoal] = useState<SubGoalKey | null>(null);
    const [paused, setPaused] = useState(false);

    // The goals worth offering: the measurements the features the game
    // actually has loaded can advance.
    //
    // Derived from the published declarations rather than a hardcoded list, so
    // the bar can only offer what the game can serve. A goal nothing can
    // move is not offered, which is friendlier than offering it and then
    // reporting "nothing can advance that" after the click.
    const offerable = offerableGoals(nexus);

    // Forget the local intent once the game's goal agrees with it, so the picker
    // shows what the run is doing rather than what was last clicked.
    //
    // "Agrees" means the current goal has this measurement among its sub-goals:
    // the game omits satisfied requirements, so anything listed is outstanding.
    useEffect(() => {
        if (requestedGoal === null) return;
        const subGoals = nexus?.goal?.subGoals;
        if (subGoals === undefined) return;
        if (subGoals.some((sub) => sub.key === requestedGoal)) {
            setRequestedGoal(null);
        }
    }, [nexus, requestedGoal]);

    async function send(command: Parameters<UiBridge["sendCommand"]>[0]) {
        setPending(true);
        setError(null);
        try {
            await bridge.sendCommand(command);
        } catch (e) {
            setError(e instanceof Error ? e.message : "command failed");
        } finally {
            setPending(false);
        }
    }

    const actualGoal = nexus?.goal?.name ?? null;

    return (
        <section className="panel panel--strategy">
            <h2 className="panel__title">Commands</h2>

            <div className="controls">
                <div className="controls__row">
                    <span className="controls__label">autonomy</span>
                    <div className="chips">
                        <button
                            type="button"
                            className="chip"
                            disabled={pending}
                            aria-pressed={!paused}
                            onClick={() => {
                                setPaused(false);
                                void send({ autonomy: "full" as Autonomy });
                            }}
                        >
                            running
                        </button>
                        <button
                            type="button"
                            className="chip"
                            disabled={pending}
                            aria-pressed={paused}
                            onClick={() => {
                                setPaused(true);
                                void send({ autonomy: "paused" as Autonomy });
                            }}
                        >
                            paused
                        </button>
                    </div>
                </div>

                <div className="controls__row">
                    <span className="controls__label">goal</span>
                    <div className="chips">
                        {offerable.length === 0 ? (
                            <span className="controls__none">
                                No loaded feature can advance a measurement yet.
                            </span>
                        ) : (
                            offerable.map((key) => {
                                const isRequested = requestedGoal === key;
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        className="chip"
                                        disabled={pending}
                                        aria-pressed={isRequested}
                                        onClick={() => {
                                            // Clicking the active request clears it,
                                            // handing the ranking back to the
                                            // framework's own order.
                                            const next = isRequested ? null : key;
                                            setRequestedGoal(next);
                                            void send({ goal: next ?? undefined });
                                        }}
                                    >
                                        {key}
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>

                <Reservations bridge={bridge} onError={setError} />

                <div className="controls__row controls__row--features">
                    <span className="controls__label">features</span>
                    <div className="controls__features">
                        <FeatureSwitches nexus={nexus} bridge={bridge} />
                    </div>
                </div>

                {error && <p className="controls__error">{error}</p>}
            </div>

            {/* What was asked for versus what the run is doing. The two differ while
                a request is in flight, and differ permanently when nothing can serve
                it — which is exactly the case worth showing. */}
            <p className="controls__state">
                {requestedGoal !== null && (
                    <>
                        requested <span className="controls__want">{requestedGoal}</span>
                        {" · "}
                    </>
                )}
                {actualGoal === null
                    ? "no goal outstanding"
                    : `working on ${actualGoal}`}
            </p>
        </section>
    );
}

/** The distinct measurements the loaded features declare they can advance. */
function offerableGoals(nexus: NexusState | null | undefined): SubGoalKey[] {
    // Truthiness, not `=== null`: a path absent from the document reads as
    // `undefined`, and this guard used to let that through to `nexus.features`.
    if (!nexus) return [];
    const keys = new Set<string>();
    for (const feature of nexus.features ?? []) {
        // Only what is actually running: a declared capability of a stopped
        // feature is not something the run can act on right now.
        if (feature.state !== "active") continue;
        for (const key of feature.movable ?? []) keys.add(key);
    }
    return [...keys].sort() as SubGoalKey[];
}
