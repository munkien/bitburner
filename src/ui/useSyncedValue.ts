import { useCallback, useSyncExternalStore } from "react";
import type { DocStore } from "@syncstate/core";

/**
 * Subscribe a component to a path in the document.
 *
 * `DocStore.useSyncState` looks like a hook but is an imperative read + setter
 * pair — it does not subscribe, so a component using it never re-renders when
 * remote patches arrive. This wraps the store's Redux `subscribe` and
 * `getStateAtPath` in `useSyncExternalStore`, which is the correct bridge
 * between an external store and React 19's renderer.
 *
 * THE RETURN TYPE IS `T | undefined`, and that is not defensive noise. A path
 * that is not in the document yet reads as `undefined`, which happens on every
 * fresh page load before the first telemetry frame, and again if a frame arrives
 * with a shape that omits the field. Declaring `T` made that a lie the compiler
 * believed: a component could write `if (value === null)` and then dereference
 * `undefined`. Returning the union forces the caller to handle both.
 *
 * Callers that want a default write `useSyncedValue<T>(...) ?? fallback`.
 */
export function useSyncedValue<T = unknown>(
    store: DocStore,
    subtree: string,
    path: string
): T | undefined {
    const subscribe = useCallback(
        (onStoreChange: () => void) => store.subscribe(onStoreChange),
        [store]
    );

    const getSnapshot = useCallback(
        () => store.getStateAtPath(subtree, path) as T | undefined,
        [store, subtree, path]
    );

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
