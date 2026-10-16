# RAM is charged for code, not for calls; split features to control it

Bitburner charges a script's static RAM for every `ns` call in its code, whether or not
that call executes. `try`/`catch` returns none of it. A feature that *might* use grafting
therefore made every player pay 16.25 GB, which BitNode multipliers then magnified.

Two consequences shape the framework:

- **A capability nothing can use is a feature of its own, not a branch inside one.**
  `grafting.ts` is separate precisely so its RAM is charged only to players with SF10 or
  BitNode 10. It is registered with `requires: ["grafting"]` so the orchestrator does not
  load it otherwise.
- **Modules that must stay cheap make no game calls at all.** `lib/objective.ts` derives
  goals from a `PlayerStanding` rather than reading the game, so every figure it needs
  arrives in the snapshot. `context.multipliers()` is a function rather than a field, and
  costs 4 GB, for the same reason: most features never ask.

The capability check for a call that throws without its Source File lives in exactly one
place — `lib/caps.ts` — and is re-read on a slow interval, because these facts flip
mid-run (TIX API bought, gang joined, Formulas.exe downloaded).
