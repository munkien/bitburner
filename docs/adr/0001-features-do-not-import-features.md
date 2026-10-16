# Features do not import each other; shared logic lives in `lib/`

Bitburner charges a script the static RAM of every `ns` call appearing anywhere in the
code it loads, whether or not that call ever runs. A static import between two features
therefore charges the imported feature's RAM to the importing one — the cost is paid
twice, and by a feature that never asked for it.

So no feature imports another feature. Anything two features need to agree on lives in
`lib/`, which is the only place both can reach: `lib/` imports no feature and holds no
game call, and a feature importing `lib/` pays only for what that module declares.

This is why `lib/objective.ts`, `lib/gang-measures.ts`, `lib/training-budget.ts` and
`lib/rate-tracker.ts` exist at all. Each was once private to a single feature and was
promoted to `lib/` the moment a second feature needed it — rather than copied, which is
the drift ADR 0003 is about.

Related: features are loaded by the orchestrator with `dynamicImport` and their RAM is
accounted for by hand, because `dynamicImport` does not adjust a script's RAM usage.
