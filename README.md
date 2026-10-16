# Bitburner2
# Bitburner2

A standalone React UI that runs **separately** from the Bitburner game and stays
in sync with it through a shared `@syncstate/core` document, carried over HTTP.

The game and the UI both hold their own `DocStore` over the same logical
document. The game samples `ns.getPlayer()` each tick and POSTs the resulting
change to a small local **sync server**; the server applies it and pushes it out
to every connected browser over Server-Sent Events. The UI renders straight from
its store.

## How it fits together

```
┌──────────────────────┐   POST /api/sync   ┌──────────────────────────┐
│  Bitburner script    │  (raw change       │  sync server             │
│  (src/game)          │   payload, JSON)   │  (src/server)            │
│                      │ ─────────────────► │                          │
│  DocStore {player}   │                    │  DocStore {player}       │
│  observe("doc","/")  │                    │  dispatch({type:PATCH})  │
└──────────────────────┘                    └────────────┬─────────────┘
                                                         │ SSE
                                              GET /api/stream (broadcast)
                                                         │
                                                         ▼
                                            ┌──────────────────────────┐
                                            │  Vite + React UI         │
                                            │  (src/ui)                │
                                            │                          │
                                            │  DocStore   ──►  cards   │
                                            └──────────────────────────┘
```

There are **no intermediate files and no manual sync step.** The game script
speaks HTTP directly to the server, and the server streams to the browser.

One consequence worth knowing: the game runs inside Bitburner, which restricts
outbound network access, so the script may need to be run with the appropriate
permission for `fetch` to reach `127.0.0.1:3000`.

## Layout

| Path                             | Runs in        | Purpose                                                        |
| -------------------------------- | -------------- | -------------------------------------------------------------- |
| `src/game/nexus.ts`              | Bitburner      | **The game entry point**: orchestrator loop + telemetry + nudges |
| `src/game/lib/`                  | Bitburner      | Framework core: context, objective, registry, RAM budget, caps, ports |
| `src/game/features/`             | Bitburner      | One folder per automation area (hacking, stocks, gang, sleeves, …) |
| `src/game/doctor.ts`             | Bitburner      | Diagnostics: checks framework assumptions against the live game |
| `src/game/strategy.ts`           | Bitburner      | Sync-server client: `sample`/`publish`/`pollCommand`/`ackCommand`. No decisions |
| `src/shared/types.ts`            | server + UI    | **The wire contract**: `Observation`, `Portfolio`, `Reservations`, `Command` |
| `src/shared/portfolio.ts`        | server + UI    | Net worth / gain helpers, so one definition serves both         |
| `src/server/server.ts`           | Node           | **Dumb pipe**: applies telemetry, broadcasts SSE, relays commands + message log |
| `src/ui/`                        | browser        | React app: store, SSE connection, components                    |
| `src/ui/store.ts`                | browser        | `UiBridge`: store + connect/disconnect + status + log + `sendCommand` |
| `src/ui/syncConnection.ts`       | browser        | `EventSource` client; applies document patches and log batches  |
| `src/ui/components/LogPanel.tsx` | browser        | Framework message feed (what features are doing)                |
| `index.html`                     | browser        | Vite entry; loads `src/ui/main.tsx`                             |
| `dist/ui/`                       | —              | Built UI bundle (the only Vite output)                          |

> **`src/game` is the single home for Bitburner scripts.** There is no `dist/`
> staging: `bitburner-filesync` (`npm run sync`) syncs `src/game` straight into
> the game by relative path. `nexus.ts` is the one entry point — it runs the
> orchestrator *and* publishes telemetry / applies nudges via `strategy.ts`.
> See `GLOSSARY.md` for the full vocabulary.

### Why `src/shared` is its own directory

`src/shared` holds only what **both ends of the network must agree on**. It is
imported by three different runtimes — the game, the Node server, and the
browser UI — so it stays dependency-free: types plus a few const tables, and
pure helpers that touch no I/O.

The split is by consumer, not by topic. The *vocabulary* (`types.ts`) is shared;
the *rules that act on the data* (strategy evaluation) are not — they live
in-game (the nexus orchestrator), which is the only side that decides anything.
The server and UI are consumers, not decision-makers.

`src/server` and `src/ui` are deliberately **not** merged despite both being
"the server side" colloquially. They run in different runtimes with opposite
constraints: the server runs on Node under `--experimental-strip-types` and must
use explicit `.ts` extensions on relative imports, while the UI is bundled by
Vite and uses extensionless ones. They share only `src/shared`, and only as
types that erase at build time.

## The document

Both sides use `@syncstate/core`, which nests the whole document under a fixed
subtree named `doc` (`SUBTREE` in `src/ui/doc.ts`). The document shape is:

```ts
{ player: ns.getPlayer() | null }
```

- The game writes `draft.player = ns.getPlayer()`.
- The UI reads `/player` from the `doc` subtree.

Because both stores agree on the subtree name and the `/player` path, a JSON
patch produced on one side applies cleanly on the other.

## The wire protocol

### Game → server

The game observes the document root and POSTs the **raw change payload** that
`store.observe(...)` hands it:

```
POST /api/sync
Content-Type: application/json

{
  "patch":        { "op": "replace", "path": "/player", "value": { ... } },
  "inversePatch": { "op": "replace", "path": "/player", "value": null },
  "subtree": "doc"
}
```

Note this is **not** a Redux action — it has no `type`. The server wraps it into
`{ type: "PATCH", payload }` before dispatching. (Dispatching the payload
directly throws `Actions may not have an undefined "type" property`.)

### Server → UI

`GET /api/stream` is a Server-Sent Events endpoint. On connect it immediately
sends a full-state snapshot so the UI does not have to wait for the next game
tick:

```
data: {"type":"PATCH","payload":{"patch":{"op":"replace","path":"","value":{"player":null}},"subtree":"doc"}}
```

Every subsequent game change is broadcast to all connected clients in the same
`{ type, payload }` shape, so the UI can apply each message with a single
`store.dispatch`.

### Endpoints

| Method | Path          | Meaning                                              |
| ------ | ------------- | ---------------------------------------------------- |
| `GET`  | `/api/stream` | SSE stream: one full-state snapshot, then live patches |
| `POST` | `/api/sync`   | Apply a change payload and broadcast it               |

The UI never calls these directly in development — it requests same-origin
`/api/stream` and Vite's dev proxy forwards `/api` to the sync server. No CORS
and no hard-coded server port in the UI.

### Applying patches in the UI

`src/ui/syncConnection.ts` accepts either shape the server may emit: a
ready-made `{ type, payload: { patch, inversePatch, subtree } }` action, or a
snapshot whose `payload.subtree` is absent (in which case the default `doc`
subtree is assumed). Either way the result is dispatched as one or more standard
`PATCH` actions. The server currently emits the former for both the snapshot and
live broadcasts, so the normalization is mostly defensive.

Components subscribe with `useSyncedValue` (`src/ui/useSyncedValue.ts`), a thin
`useSyncExternalStore` wrapper. SyncState's own `useSyncState` is an imperative
read + setter pair — it does **not** subscribe — so using it directly would
render once and never update when remote patches arrive.

## Running it

Two long-running processes plus the game script.

**1. Start the sync server**

```sh
npm run dev:server     # node --experimental-strip-types --watch src/server/server.ts
```

Listens on http://localhost:3000 and logs each state snapshot. Use
`npm run start:server` for a one-shot run without `--watch`.

**2. Start the UI**

```sh
npm run dev:ui         # vite --mode ui
```

Vite prints the URL (default http://localhost:5173) and proxies `/api` to the
sync server on port 3000. The header shows connection status: `connected`,
`connecting…`, or `sync server unavailable`.

**3. Sync and run the game scripts**

```sh
npm run sync       # watches src/game and pushes .ts straight into Bitburner
```

`bitburner-filesync` (configured in `filesync.json`, `scriptsFolder: "./src/game"`)
syncs the game scripts directly — there is no `dist/` staging. Then, in the
Bitburner terminal:

```
run /nexus.ts
```

> **Typechecking needs the game's definitions.** `NetscriptDefinitions.d.ts` is
> generated by file sync on connection and is therefore git-ignored — so `npx tsc
> --noEmit` on a fresh clone fails with `File 'NetscriptDefinitions.d.ts' not found`,
> and, worse, stops before checking anything else. It reports no other errors while
> that file is missing, which has hidden real type errors in the past. Run `npm run
> sync` with the game open (or fetch the file from the Bitburner source) before
> trusting a clean typecheck.

`nexus.ts` starts and drives everything: it runs the orchestrator loop and, on a
slower cadence, publishes telemetry and polls commands to `http://127.0.0.1:3000`.
The sync server must be running.

## Scripts

| Script                 | Does                                                   |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev:server`   | Sync server with `--watch` (restarts on edit)          |
| `npm run start:server` | Sync server, one-shot                                  |
| `npm run sync`         | Watch `src/game` and push scripts into Bitburner       |
| `npm run dev:ui`       | Vite dev server + React UI                             |
| `npm run build:ui`     | Production build of the UI → `dist/ui`                 |

## Environment variables

| Variable         | Used by | Default      | Meaning                                          |
| ---------------- | ------- | ------------ | ------------------------------------------------ |
| `SYNC_PORT`      | Vite    | `3000`       | Port Vite proxies `/api` to                      |
| `VITE_SYNC_URL`  | UI      | same-origin  | Point the UI at a sync server elsewhere          |

The UI needs no URL by default: it requests same-origin and Vite forwards it. Set
`VITE_SYNC_URL` only when serving the built UI somewhere that cannot use the dev
proxy.

> **Caveat:** the sync server's listen port is currently **hard-coded to `3000`**
> in `src/server/server.ts`, while Vite reads `SYNC_PORT`. Changing `SYNC_PORT`
> today makes the proxy target disagree with the server. Change both (or make the
> server read the variable) if you need a different port.

## Notes

- The server's `window` shim at the top of `src/server/server.ts` exists because
  `@syncstate/core` touches `window` at module init unless `NODE_ENV=production`.
  Without it, creating a store in Node throws `ReferenceError: window is not
  defined`.
- `POST /api/sync` currently returns **500** for malformed bodies rather than
  `400`, since it lets the reducer's validation error escape.
- `@syncstate/core`'s export maps to a CJS build for Node (`main`) and an ESM
  build for the browser (`module`), so the server and UI load different files
  from the same package.
