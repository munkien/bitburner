import type { DocStore } from "@syncstate/core";
import { SUBTREE } from "./doc";
import type { ConnectionStatus } from "./store";
import type { LogLine } from "../shared/types";

/** The subset of a JSON-patch action we consume off the wire. */
interface PatchAction {
    type: string;
    payload: {
        subtree?: string;
        patch?: unknown;
        inversePatch?: unknown;
    };
}

interface DocSyncOptions {
    store: DocStore;
    /** Override the sync-server origin. Defaults to same-origin. */
    baseUrl?: string;
    onStatus?: (status: ConnectionStatus) => void;
    /** Called on every frame received, so a caller can age game health. */
    onMessage?: () => void;
    /** Called with each batch of framework messages the server streams. */
    onLog?: (lines: LogLine[]) => void;
}

interface DocSync {
    start(): void;
    stop(): void;
}

/**
 * Consumes the sync server's document stream and applies it to a local
 * DocStore.
 *
 * The server (`src/server/server.ts`) broadcasts JSON-patch actions over
 * Server-Sent Events at `GET /api/stream`. Each message is exactly the action
 * the game dispatched, so applying one is a single `store.dispatch`. The
 * server sends a full-state patch on connect, so we never need to ask for a
 * snapshot separately.
 *
 * Depth note: the component tree never sees EventSource, reconnects, or error
 * handling — it only renders from the store.
 */
export function createDocSync(options: DocSyncOptions): DocSync {
    const { store, onStatus, onMessage, onLog } = options;
    const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");

    let source: EventSource | null = null;

    function start(): void {
        if (source) return;
        onStatus?.("connecting");

        const es = new EventSource(`${baseUrl}/api/stream`);
        source = es;

        es.onopen = () => onStatus?.("connected");

        es.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data) as PatchAction;
                applyAction(store, message);
                onStatus?.("connected");
                onMessage?.();
            } catch (error) {
                console.error("Failed to apply sync message:", error);
            }
        };

        // Log lines arrive as a NAMED event, so they do not reach `onmessage` —
        // EventSource only routes the default event type there. They are kept
        // separate from the document stream because the server appends them while
        // it REPLACES the document, and folding one into the other would lose the
        // history on the next telemetry tick.
        es.addEventListener("LOG", (event) => {
            try {
                const lines = JSON.parse((event as MessageEvent).data) as LogLine[];
                if (lines.length > 0) onLog?.(lines);
            } catch (error) {
                console.error("Failed to parse log batch:", error);
            }
        });

        // EventSource auto-reconnects on transient failures, so we report the
        // error but keep the source alive rather than tearing it down.
        es.onerror = () => onStatus?.("error");
    }

    function stop(): void {
        source?.close();
        source = null;
    }

    return { start, stop };
}

/**
 * Apply one server message to the store, tolerating both action shapes the
 * server may emit:
 *
 *   - The common case: a ready-made action with `payload.subtree` and a single
 *     `payload.patch`, dispatched as-is.
 *   - Defensive case: a snapshot whose `payload.patch` is an *array* of ops and
 *     whose `subtree` is missing, fanned out into one dispatch per op tagged
 *     with the default subtree.
 *
 * Keeping this here means the component tree and the store stay unaware of the
 * server's wire quirks.
 */
function applyAction(store: DocStore, action: PatchAction): void {
    const { patch, inversePatch, subtree } = action.payload ?? {};

    if (Array.isArray(patch)) {
        for (const single of patch) {
            store.dispatch({
                type: action.type,
                payload: { patch: single, subtree: subtree ?? SUBTREE },
            });
        }
        return;
    }

    store.dispatch({
        type: action.type,
        payload: { patch, inversePatch, subtree: subtree ?? SUBTREE },
    });
}
