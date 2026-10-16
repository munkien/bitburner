/**
 * The subtree name SyncState stores the document under. It is fixed by
 * `@syncstate/core`: `createDocStore(initialDoc)` nests `initialDoc` at `doc`,
 * so every client and the server agree on this key.
 *
 * Lives in its own module to keep `store.ts` and `syncConnection.ts` from
 * importing each other.
 */
export const SUBTREE = "doc";

import type { Portfolio, NexusState, Player } from "../shared/types";

/**
 * Re-exported so the UI has one import site for the document shape while the
 * shared module stays the single definition of what a portfolio is.
 */
export type { Portfolio, StockBook, NexusState, Player, NexusGoal } from "../shared/types";

/** The seven stats Bitburner tracks. Order here drives display order. */
export const SKILLS = [
    "hacking",
    "strength",
    "defense",
    "dexterity",
    "agility",
    "charisma",
    "intelligence",
] as const;

export type SkillName = (typeof SKILLS)[number];

/** The document shape shared with the game/server. */
export interface GameDoc {
    player: Player | null;
    /** Cash and holdings, as raw readings. See `src/shared/types.ts`. */
    portfolio?: Portfolio | null;
    /** What the game's orchestrator is doing. See `src/shared/types.ts`. */
    nexus?: NexusState | null;
    /** When the game assembled the reading, from the game's clock. */
    at?: number | null;
    /** When the server received it, from the server's clock (staleness source). */
    receivedAt?: number | null;
}
