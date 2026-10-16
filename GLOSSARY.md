# GLOSSARY

Shared vocabulary for this repository. The `src/game` orchestrator refers to
this file from its comments; keep the terms here aligned with the code or the
comments start lying.

## One game entry point

`nexus.ts` is the single Bitburner entry point. It owns the orchestrator loop
and, on a slower cadence, the bridge to the sync server: it publishes telemetry
and applies operator nudges. The HTTP plumbing lives in `strategy.ts`, which
`nexus.ts` drives — `strategy.ts` is a client module, not a script you run.

| Component | Entry point | Deployment | Purpose |
| --------- | ----------- | ---------- | ------- |
| **nexus** (the orchestrator) | `nexus.ts` | plain `.ts` synced straight from `src/game` by `bitburner-filesync` | the automation brain: decides which features run, drives them, publishes telemetry, applies nudges |
| **strategy** (sync client) | (helper, not run) | same sync path | `sample` / `publish` / `pollCommand` / `ackCommand` — raw facts out, commands in, no decisions |

Everything is plain `.ts` that lives only in `src/game` — there is no `dist/`
staging and no Vite bundling. Only the React UI is built by Vite.

## The nexus framework

### Feature

One area of automation (hacking, the stock market, the gang). A feature is a
module exposing `tick(ns, context)`. The orchestrator decides whether and when
to load and tick it; a feature never decides that for itself and never imports
another feature.

See `lib/features.ts` for the `FeatureMeta`/`FeatureModule` contract and
`lib/registry.ts` for the list of features and their paths.

### Message port

The in-game FIFO (`ns.writePort`, port 20) that carries framework messages out of
the game. A feature writes through `lib/log.ts`; the orchestrator drains the queue
on its telemetry cadence and POSTs the batch to the sync server, which keeps the
history and streams it to the React console. See `lib/messages.ts`.

This replaced the old in-game **overview panel** (`ui.tsx`), which no longer
exists — the React console is the framework's window now, and unlike the panel it
can show history.

### Capability

A fact about what this BitNode and set of Source Files permit (TIX API bought,
TOR router bought, gang joined, etc.). Features *declare* the capabilities they
need; the orchestrator refuses to load them otherwise. See `lib/caps.ts`.

### Context

The bundle a feature is handed on each tick: `capabilities`, `snapshot`,
`reserves`, `disabled`, and the derived goals. The orchestrator reads game state
once per tick into a snapshot so features don't each re-read it. See
`lib/context.ts`.

### Goal

One achievement the run could close — join a faction, buy an augmentation, own
the stock market's data APIs — together with the sub-goals that close it. Goals
are ranked and the run works on the first; they are derived from player state,
never configured. Avoid "objective": it was this concept's old name, surviving
only as the file name `lib/objective.ts`. See `lib/objective.ts`.

A goal carries **sub-goals**, each a **measurement** with a current value and a
target. Sub-goals no loaded feature can move are **blocked**, which the dashboard
reports rather than leaving the reader guessing why nothing is happening.

An **ambition** is a goal the run sets for itself — owning the stock access
chain, growing a gang — as opposed to one the game imposes. It lives in the same
list, because it is the same kind of thing.

A **declared target** is a figure the run chooses (`GOAL_TARGETS`), in contrast
to one read from a game requirement. Only for measurements the game has no
opinion on, such as how rich to get.

Features declare which measurements they can move (**movable**), so the goal
model knows who can advance what. A **contributor** is a loaded feature that can
move a given sub-goal.

### Registry

The single list of features and managed scripts. It is statically imported by
the orchestrator and must stay RAM-free: it holds only `path` strings and
capability names, no game calls and no feature imports. See `lib/registry.ts`.

### Three layers inside a feature tick

- **observe** — read game state from `context.snapshot`.
- **plan** — turn observations into intent without calling `ns`.
- **execute** — perform the Netscript calls the plan calls for.

Only execution changes game state, and only the feature that owns a plan
changes it. Cross-feature coordination (a cash reserve) is published through
`context.reserves`.

## The run, and the loop that drives it

### Run

One playthrough, from a reset to the next augmentation install or BitNode reset.
A run has one goal at a time; the rest are ranked behind it.

### BitNode

The number of the node the current run is being played in. Chosen at reset and
fixed for the whole run. A **Source File** is a permanent unlock carried across
resets, identified by the BitNode it was earned in.

### Standalone Entry

A script with its own entry point and its own RAM that the framework knows about
but does not tick (`retire.ts`, `doctor.ts`, `install.ts`). It has no place in
the goal model — that is the distinction from a **Feature**.

### Pass

One iteration of the orchestration loop: refresh capabilities, build the
snapshot, offer each loaded feature a tick, report, and periodically publish.
A **Tick** is one feature's turn within a pass, and a feature may be offered
fewer ticks than there are passes. An **Interval** is the maximum rate at which
the orchestrator offers a tick; a feature sits intervals out when it knows
nothing has changed.

### Capability Probe

The reading of one capability. Probes are re-read on a slow interval because they
can flip mid-run (TIX API bought, gang joined); the BitNode and Source File parts
cannot change and are read once.

### Snapshot

The pass's single read of game state, shared by every feature. The framework only
ever reads it, and reads it once per pass rather than once per feature. See
`lib/context.ts`.

### Reserve

A plan not to spend something — money or home RAM committed to a purchase that has
not happened yet. Whoever knows about a planned purchase writes it down; every
feature that spends reads it. **Surplus** is the home cash left above the
reserves, and is the pool money-spending features compete for.

Note that a reserve is a *figure*, always. The operator's feature switches are not
reserves and no longer live with them: disabling a feature is an instruction about
what may run, not a plan not to spend, so it sits on `Context.disabled` beside
`capabilities` and `snapshot`.

### Autonomy

Whether features may act on game state or only observe it. An operator setting,
not a feature's own decision. `full` or `paused` on the wire.

### Publish

Send telemetry and messages from the game to the sync server, on a slower cadence
than the pass loop. **Telemetry** is the raw readings published this way: a
report, never an instruction.

### Rate

A measured change in a measurement per unit of time, so the framework can estimate
how long a goal has left rather than only how far away it is.
_Avoid_: speed, velocity, ETA

## The wire vocabulary

Defined in `src/shared/types.ts`. This is the wire contract shared by the
server and the UI (the game side mirrors it with inlined local types so it
stays self-contained).

| Term | Meaning |
| ---- | ------- |
| `Observation` | raw facts the game reports; the game computes nothing |
| `Player` | the trimmed player projection the console renders (NOT the whole player object) |
| `Reservations` | operator-set floor on money and RAM (`money`, `ram`) |
| `Command` | an operator nudge: `reserves`, `features`, `goal`, and/or `autonomy` |
| `Goal` | an achievement the run could close, with the sub-goals that close it |
| `SubGoalKey` | the measurement vocabulary (`hacking`, `combat`, `money`, …) |
| `Autonomy` | `full` or `paused` — whether features may act |
| `Portfolio` | cash + stock book; net worth is derived from it |
| `LogLine` | one framework message: `tag`, `message`, `level`, `at`, and the server's `seq` |

`Observation.player` is a **projection**, not `ns.getPlayer()`. The raw object
carries `mults` (a ~30-entry multiplier table nothing here reads) and `jobs`, and
sending it whole made the payload 57% dead weight on a one-second loop. The game
projects it in `projectPlayer` (`src/game/strategy.ts`) onto the fields the
console actually renders.

The operator's `goal` is a **request, not an instruction**: goals stay
derived from game state, and the command re-ranks them. A measurement nothing
loaded can advance is reported, not silently ignored.

`LogLine` travels as its own stream (`POST`/`GET /api/log`, broadcast as a `LOG`
SSE event), not as part of the document: the server appends messages while it
*replaces* the document on every telemetry tick, so anything folded into it would
be lost a second later. `seq` is the server's monotonic counter, which is what
lets a reconnecting client fetch only what it missed (`GET /api/log?since=`).

`SubGoalKey` is **duplicated by design** between `src/shared/types.ts` and
`src/game/lib/objective.ts`: only `src/game` is synced into Bitburner, so the game
cannot import across that boundary. Keep the two in step — a value the UI can send
that the game does not know is a command it silently ignores.

There is no `Strategy` or `Phase` on the wire any more, and no server-side
evaluation: the game (nexus) is the only thing that decides. The server holds
the shared document, broadcasts it, and relays `Command`s without interpreting
them.

## Architecture decisions

Recorded in `docs/adr/`. Each is a decision that is hard to reverse, surprising without
context, and the result of a real trade-off — so the next reader does not "fix" something
that is deliberate.

| ADR | Decision |
| --- | -------- |
| [0001](docs/adr/0001-features-do-not-import-features.md) | Features do not import each other; shared logic lives in `lib/` |
| [0002](docs/adr/0002-ram-is-charged-for-code-not-calls.md) | RAM is charged for code, not calls; split features to control it |
| [0003](docs/adr/0003-shared-thresholds-not-duplicated.md) | A threshold two features declare will drift; declare it once in `lib/` |
