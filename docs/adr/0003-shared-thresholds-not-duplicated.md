# A threshold two features declare will drift; declare it once in `lib/`

The framework's recurring bug is a figure declared in two places that quietly disagrees
with itself. Recorded instances:

- Combat stats were trained to 100 in `player.ts` while `sleeves.ts` stopped at 75. Sleeve
  experience is shared with the player, so a sleeve that stopped at 75 stopped
  contributing to a target progression still wanted.
- `karma` was `-54_000` in `player.ts` and `-54_000` again in `sleeves.ts` — two copies of
  one intent, surviving only because neither feature read the other.
- A run reached **-240K karma against a -54K target**, closing off content that wanted a
  kinder player. Karma is a *ceiling*, so overshooting is not merely wasted effort.
- `player.ts` installed augmentations at five queued while `retire.ts` re-checked and
  aborted at a different count — the second silently overriding the first.
- A wealth target of `100e9` was declared in `hacknet.ts` and nowhere else.

The same failure does not need two files. `INSTALL_WAIT_MS` in `retire-decisions.ts` is
**30 minutes**, while the comment above it and the constant's own doc both say *"an hour"* —
three copies of one intent, one of which is now wrong, in a single file. The prose was not
updated when the number changed, so every reader of that comment has been reasoning about a
window twice as long as the one the code uses. A stale comment is a duplicate definition
that nothing can compile-check.

The rule that follows: **a figure two features must agree on is declared once**, in `lib/`,
and both callers reach it. That is why `GOAL_TARGETS` lives in `lib/objective.ts` — so a
value that was once three copies is now one — and why `lib/gang-measures.ts` and
`lib/training-budget.ts` are shared rather than copied.

The failure mode is silent and is the reason this is an ADR: the two copies simply
disagree, and neither is wrong by its own lights. Nothing throws, and the run does not
stop — it just spends hours on a target it cannot reach.
