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

- **One purchase per pass.** There is no loop. A second purchase in the same pass can only
  be the second-best option, competing for money the ranking never allocated to it.
- **The best value is computed without a budget filter**, and affordability is checked
  afterwards by the caller. Asking the ranking *with* the budget just returns the cheaper
  thing, which is the behaviour this decision rules out.

The cost is that an unaffordable best means a pass that buys nothing, so a fleet can look
idle while it accumulates. That is intended: money kept is money available next pass, and
the best upgrade is reached sooner by waiting for it than by substituting for it.

See also ADR-0003 — the same failure shape, a rule that holds locally and disagrees with
itself globally.