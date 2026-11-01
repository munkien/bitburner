# Hacknet buys one upgrade per pass, and only the one the ranking chose

`hacknet.ts` spends a per-pass budget on the upgrade with the best hash rate per dollar.
When the best upgrade is unaffordable it buys **nothing** and keeps the money, rather than
falling back to a cheaper upgrade that fits.

The fallback is the tempting alternative, and it was the shipped behaviour for a long time.
It cost real money before anyone noticed: the ranking said "core", the core did not fit the
budget, and the loop spent the same allotment on eight level upgrades — 18.4m for +19.2 H/s,
against +240 H/s the identical spend would have bought. Rate-per-dollar is a ratio, so a
substitute does not capture part of the value of the better option; it captures less per
dollar, at every dollar.

Two consequences that are easy to undo by accident:

- **Every purchase in a pass is the ranking's top choice.** The rule is about *substitution*,
  not about how many times the best thing may be bought. A pass re-ranks after each purchase
  and may repeat up to `PURCHASES_PER_PASS` times, but only while the best remaining choice
  still fits the budget. It never falls to the second-best to use up what is left.
  *(Amended: this ADR previously said "one purchase per pass" outright. That was rate-limiting
  the fleet rather than protecting it — one upgrade per second meant the tick rate, not the
  money, limited fleet growth. The anti-substitution rule it was meant to express is unchanged
  and still tested.)*
- **The best value is computed without a budget filter**, and affordability is checked
  afterwards by the caller. Asking the ranking *with* the budget just returns the cheaper
  thing, which is the behaviour this decision rules out.

The cost is that an unaffordable best means a pass that buys nothing, so a fleet can look
idle while it accumulates. That is intended: money kept is money available next pass, and
the best upgrade is reached sooner by waiting for it than by substituting for it.

See also ADR-0003 — the same failure shape, a rule that holds locally and disagrees with
itself globally.