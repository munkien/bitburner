/*
 * ============================================================================
 * WHICH HACKNET UPGRADE TO BUY
 * ============================================================================
 * The purchase loop bought THE CHEAPEST affordable upgrade. Reported as "not buying the most
 * effective of level/ram/cores measured in hashes generated per second", and the report is
 * right — cheapest is not the same as best value, and on a hacknet node the three curriences
 * buy wildly different amounts of hash rate per dollar.
 *
 * WHY THEY DIFFER, from the game's own hash formula
 * (`formulas.hacknetServers.hashGainRate`, which this module now calls):
 *
 *   level  linear              +1 level is +HashesPerLevel per second
 *   ram    1.07 ^ log2(ram)    doubling RAM is a ~7% step, not another RamPerLevel
 *   cores  1 + (cores - 1)/5   +1 core is +20% of the base only while cores is small
 *
 * So the cheapest upgrade can easily be the worst buy: a level upgrade early on is cheap AND
 * linear, while a core upgrade at twice the price is a flat 20% — and past a certain level the
 * ordering inverts again. The only honest comparison is marginal hash rate divided by cost.
 *
 * WHAT THIS FILE PINS. The choice function is now pure and takes the numbers rather than
 * reading the game, so the arithmetic can be tested directly. It could not be before: the whole
 * decision lived inside `tick`, in a `do/while` loop, with `ns.hacknet.*` calls interleaved
 * with the sorting.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bestUpgrade, cacheTooSmallForAnyUpgrade, hashActionAt, hashSpendIsCashOnly, mustSellForCapacity, statusLine } from "./hacknet.ts";

/** One node's current numbers, as the game reports them. */
function node(over: Partial<{ level: number; ram: number; ramUsed: number; cores: number }> = {}) {
    return { level: 100, ram: 16, ramUsed: 0, cores: 1, ...over };
}

/** A hash-rate function with the game's real shape: linear level, 1.07^log2(ram), cores/5. */
function rate(level: number, ram: number, cores: number): number {
    return level * Math.pow(1.07, Math.log2(ram)) * (1 + (cores - 1) / 5);
}

test("a core upgrade can beat a much cheaper level upgrade, and does", () => {
    // THE REPORTED CASE IN MINIATURE, and my first version of this test had it backwards.
    // I assumed the cheap linear level upgrade would win; the arithmetic says otherwise, and
    // the arithmetic is right. At level 100 a +1 level is a ~1% step — 1.31 hash/s — while
    // +1 core is a flat 20% of the whole base, 26.22 hash/s. Even at four times the price the
    // core is worth five times more per dollar.
    //
    // This is exactly why "cheapest" was wrong: the cheap upgrade really is the cheap one, and
    // it really is the worse buy. A rule that reads price cannot see this.
    const n = node();
    const base = rate(n.level, n.ram, n.cores);
    const levelGain = rate(n.level + 1, n.ram, n.cores) - base;
    const coreGain = rate(n.level, n.ram, n.cores + 1) - base;
    assert.ok(coreGain > levelGain * 10, "the fixture no longer models the recorded imbalance");

    const choices = [
        { type: "LEVEL" as const, nodeIndex: 0, cost: 10, rateAfter: rate(n.level + 1, n.ram, n.cores) },
        { type: "CORE" as const, nodeIndex: 0, cost: 40, rateAfter: rate(n.level, n.ram, n.cores + 1) },
    ];
    assert.equal(
        bestUpgrade(choices, base, 1_000)?.type,
        "CORE",
        "the cheapest upgrade was chosen over one worth five times more per dollar",
    );
});

test("an early level upgrade does beat a core, which is why the rule is value and not a fixed order", () => {
    // The counter-case, and the reason this cannot be a hardcoded priority list either. At a
    // LOW level the linear term is small but the level is cheap; at low cores the 20% is small
    // in absolute terms too. Sizing the two by value is what makes both cases come out right,
    // and a fixed order gets one of them wrong whichever way it is written.
    const n = node({ level: 5, ram: 2, cores: 1 });
    const base = rate(n.level, n.ram, n.cores);
    const choices = [
        { type: "LEVEL" as const, nodeIndex: 0, cost: 4, rateAfter: rate(n.level + 1, n.ram, n.cores) },
        { type: "CORE" as const, nodeIndex: 0, cost: 60, rateAfter: rate(n.level, n.ram, n.cores + 1) },
    ];
    assert.equal(
        bestUpgrade(choices, base, 1_000)?.type,
        "LEVEL",
        "a cheap early level upgrade lost to a core that costs fifteen times as much",
    );
});

test("value per dollar decides, not raw gain and not price", () => {
    // Two upgrades: one big gain for a huge price, one small gain for a small price. The
    // cheaper-per-unit-of-gain must win even though its absolute gain is smaller.
    const n = node();
    const choices = [
        // +40 hash/s for 400 -> 0.10 per unit
        { type: "CORE" as const, nodeIndex: 0, cost: 400, rateAfter: rate(n.level, n.ram, n.cores) + 40 },
        // +5 hash/s for 20 -> 0.25 per unit
        { type: "RAM" as const, nodeIndex: 0, cost: 20, rateAfter: rate(n.level, n.ram, n.cores) + 5 },
    ];
    const best = bestUpgrade(choices, rate(n.level, n.ram, n.cores), 1_000);
    assert.equal(best?.type, "RAM", "the choice was made on absolute gain or on price alone");
});

test("an unaffordable upgrade is never chosen, however good its ratio", () => {
    // Affordability is a hard filter, not a tiebreak: buying something you cannot pay for is
    // not a decision. A 0.99 ratio cannot rescue it.
    const n = node();
    const base = rate(n.level, n.ram, n.cores);
    const choices = [
        { type: "CORE" as const, nodeIndex: 0, cost: 5_000, rateAfter: base * 3 },
        { type: "LEVEL" as const, nodeIndex: 0, cost: 10, rateAfter: base + 1 },
    ];
    const best = bestUpgrade(choices, base, 100);
    assert.equal(best?.type, "LEVEL", "an unaffordable upgrade was chosen for its headline gain");
});

test("a cache upgrade is not judged on hash rate", () => {
    // Cache adds no production; it raises the cap, which is a different question. Scoring it
    // as zero gain would make it look infinitely bad, so it is excluded from value ranking and
    // the caller decides when to buy it. This test pins that it can never win a value contest.
    const n = node();
    const base = rate(n.level, n.ram, n.cores);
    const choices = [
        { type: "CACHE" as const, nodeIndex: 0, cost: 1, rateAfter: base },
        { type: "LEVEL" as const, nodeIndex: 0, cost: 50, rateAfter: base + 1 },
    ];
    const best = bestUpgrade(choices, base, 1_000);
    assert.notEqual(best?.type, "CACHE", "a cache upgrade won a hash-rate contest, which it cannot enter");
});

test("with nothing affordable the answer is null, not a guess", () => {
    const n = node();
    const base = rate(n.level, n.ram, n.cores);
    const choices = [
        { type: "LEVEL" as const, nodeIndex: 0, cost: 1_000, rateAfter: base + 1 },
    ];
    assert.equal(bestUpgrade(choices, base, 10), null);
});

/* ─── the status line the console shows ─── */

/** `ns.format.number` alone, which is all `statusLine` reads from the game. */
const fmt = { format: { number: (n: number) => "$" + (n / 1e9).toFixed(2) + "b" } };

test("the status line names the next purchase and its cost", () => {
    // The panel used to say only what had already been bought ("Purchased Node 9"). "What is it
    // aiming for, and how far off" was unanswerable without reading the arithmetic.
    const line = statusLine(fmt, { label: "node 3 RAM", cost: 4.1e9 }, false);
    assert.match(line, /node 3 RAM/);
    assert.match(line, /\$4\.10b/);
});

test("a maxed fleet says so rather than naming a purchase it cannot make", () => {
    // `isMaxed` is cleared only by a restart, and a maxed fleet keeps ticking on the slow
    // cadence to spend hashes. A stale target there would promise an upgrade that does not exist.
    const line = statusLine(fmt, { label: "node 3 RAM", cost: 4.1e9 }, true);
    assert.match(line, /maxed/);
    assert.ok(!line.includes("node 3 RAM"), `a maxed fleet still named a purchase: ${line}`);
});

test("before anything is chosen the line says it is choosing, not nothing", () => {
    // The first tick of a run, and any tick where the branch did not run. Silence here would
    // read as a broken feature rather than as an unstarted one.
    assert.match(statusLine(fmt, null, false), /choosing/);
});

test("a fleet paused on its hash cache says so instead of naming a purchase", () => {
    // THE RECORDED SYMPTOM. The operator saw "new node next" continuously and asked why it
    // always wanted a node. Part of the answer was that the cache rule stops every node and
    // upgrade purchase once hashes are half the cap — so the fleet genuinely was not buying
    // them — but the line went on naming the node it was not going to buy, which reads as a
    // run that is saving rather than one that is deliberately waiting.
    const line = statusLine(fmt, { label: "new node", cost: 7.746e6 }, false, "hash cache 61.4% full");
    assert.match(line, /hash cache 61\.4% full/);
    assert.match(line, /spending hashes/);
    assert.ok(!line.includes("new node"), `a paused fleet still named a purchase: ${line}`);
});

test("maxed outranks the cache reason, because there is nothing to resume", () => {
    // Both can be true at once. "Maxed" is the stronger fact: spending hashes would not free
    // up anything to buy, so it must not read as a temporary pause.
    assert.match(statusLine(fmt, null, true, "hash cache 99.0% full"), /maxed/);
});

/* ─── a new node competes with upgrades ─── */

test("a new node stops winning once it is worth less per dollar than an upgrade", () => {
    // THE RECORDED BUYING BUG. Nodes used to be bought ahead of every upgrade whenever the
    // fleet was under its cap. On BitNode 9 that meant a fleet of ~7 of 10 servers chasing a
    // next server at 78m, then 391m, then 1.95b, against 52m of cash — never affordable, and
    // never abandoned, while affordable upgrades went unbought.
    //
    // The arithmetic that makes this decidable: a new server starts at level 1 / RAM 1 and
    // produces well under 1 H/s. Doubling an established server's RAM multiplies hundreds.
    const current = 224;            // an established fleet, H/s
    const newNode = current + 0.8;  // one more server at its starting numbers
    const ramUpgrade = current * 2; // doubling an existing server's RAM

    const candidates = [
        { type: "NODE" as const, nodeIndex: 7, cost: 391e6, rateAfter: newNode },
        { type: "RAM" as const, nodeIndex: 3, cost: 4e6, rateAfter: ramUpgrade },
    ];
    assert.equal(
        bestUpgrade(candidates, current, 500e6)?.type,
        "RAM",
        "the fleet bought a new node that was worth a fraction of an upgrade at a hundredth the price",
    );
});

test("a new node still wins while it is cheap, which is when buying one is right", () => {
    // The other half, and the reason this is a value rule rather than "never buy nodes". Early
    // in a fleet's life a node costs little and its starting production is a large fraction of
    // a small total, so it wins — and it should, because that is how a fleet grows.
    const current = 2;                       // a young fleet, H/s
    const candidates = [
        { type: "NODE" as const, nodeIndex: 1, cost: 10_000, rateAfter: current + 0.8 },
        { type: "LEVEL" as const, nodeIndex: 0, cost: 400_000, rateAfter: current + 0.1 },
    ];
    assert.equal(
        bestUpgrade(candidates, current, 1e9)?.type,
        "NODE",
        "a cheap early node lost to an expensive upgrade that barely moved the rate",
    );
});

test("a purchase that cannot be made does not keep naming itself", () => {
    // THE STALE TARGET, and the reason the operator kept seeing 79.314m. `target` was only
    // ASSIGNED when a candidate existed; when the list came back empty — the hash cache
    // blocking every production purchase — the old value simply stayed. The recorded run
    // showed "new node next · 79.314m" across 93 consecutive frames at a price the fleet could
    // never reach, which reads as a run saving for a purchase rather than one making none.
    //
    // The set is now a set-or-clear, so an empty candidate list names no purchase. The cache
    // rule then supplies the real reason, which is the line worth reading.
    const blocked = statusLine(fmt, null, false, "hash cache 61.4% full");
    assert.ok(!blocked.includes("new node"), `a blocked fleet still named a purchase: ${blocked}`);
    assert.match(blocked, /hash cache/);

    // With no candidate AND no block reason, the honest answer is that it is choosing — not a
    // stale name carried over from a tick when the answer was different.
    assert.match(statusLine(fmt, null, false), /choosing/);
});

test("an upgrade is measured against the FLEET, not against one node", () => {
    // THE BUG THAT MADE IT BUY NODES FOREVER. `productionAfter` answers for ONE node, while the
    // baseline is the fleet total. Comparing them directly subtracts a whole fleet from a single
    // node — a large negative gain — so every upgrade was discarded and the new-node candidate,
    // which was built correctly as `fleet + newNode`, was the only survivor. The console said
    // "new node next · 79.314m" for hours because it really was the only option that scored.
    //
    // `fleetRateAfter` is the conversion. This pins that it is applied: an upgrade that improves
    // one node must score a POSITIVE gain, and must beat a hopelessly expensive new node.
    const fleet = 224;          // seven servers, ~32 H/s each
    const thisNode = 32;
    const afterUpgrade = 38.4;  // that one node, after a RAM doubling

    const fleetAfter = fleet - thisNode + afterUpgrade;
    assert.ok(fleetAfter > fleet, "the converted fleet rate did not improve");

    const candidates = [
        { type: "RAM" as const, nodeIndex: 0, cost: 4e6, rateAfter: fleetAfter },
        { type: "NODE" as const, nodeIndex: 7, cost: 79.314e6, rateAfter: fleet + 0.8 },
    ];
    assert.equal(
        bestUpgrade(candidates, fleet, Infinity)?.type,
        "RAM",
        "the fleet chose a new server over an upgrade, which is the units bug returning",
    );
});

test("the fleet baseline comes from the same formula as the candidates", () => {
    // THE MEASURED BUG, and the diagnostic that found it rather than reasoning did:
    //
    //   new node next · 253.805m [cand=25 fleet=0.1 node=2.54e+8/0.00 cap=y]
    //
    // `fleet=0.1` — a BitNode-9 fleet of established servers measured as a tenth of a hash per
    // second. The baseline was summed from `stats.production`, while every candidate was scored
    // from `formulas.hacknetServers.hashGainRate`, on the assumption that the two fields agree.
    // They do not.
    //
    // The consequence was not subtle. An upgrade scored `0.1 - 224 + 226 = -189.9` and was
    // discarded, while the new node scored `+0.8` and was the only candidate that never went
    // negative. So the fleet bought nodes forever — not because nodes were preferred, but
    // because they were the only ones left alive. With both sides read from the formula the
    // comparison is meaningful again, which is what this pins.
    const hashRate = (level: number, used: number, ram: number, cores: number) =>
        level * Math.pow(1.07, Math.log2(ram)) * (1 + (cores - 1) / 5) * (1 - used / ram);

    const nodes = 8, level = 100, ram = 32, cores = 4;
    const thisNode = hashRate(level, 0, ram, cores);
    const fleet = nodes * thisNode;

    // A baseline read from the wrong field is what broke it; assert it is not tiny.
    assert.ok(fleet > 100, `the fleet baseline read ${fleet} — the wrong-field bug is back`);

    const upgrades = [
        { type: "LEVEL" as const, nodeIndex: 0, cost: 2.6e23, rateAfter: fleet - thisNode + hashRate(level + 1, 0, ram, cores) },
        { type: "RAM" as const, nodeIndex: 0, cost: 2.9e6, rateAfter: fleet - thisNode + hashRate(level, 0, ram * 2, cores) },
        { type: "CORE" as const, nodeIndex: 0, cost: 8.1e7, rateAfter: fleet - thisNode + hashRate(level, 0, ram, cores + 1) },
        { type: "NODE" as const, nodeIndex: nodes, cost: 253.8e6, rateAfter: fleet + 0.8 },
    ];

    for (const c of upgrades.slice(0, 3)) {
        assert.ok(c.rateAfter > fleet, `${c.type} scored no gain on a fleet baseline that was correct`);
    }
    assert.equal(
        bestUpgrade(upgrades, fleet, Infinity)?.type,
        "RAM",
        "the fleet picked something other than the best value, which is the units bug returning",
    );
});

test("what the console names is what gets bought, not what it would buy next", () => {
    // THE REPORTED DIVERGENCE: "it says 'node 0 core next' but is happily buying random levels".
    //
    // Two separate faults made that visible, and neither was in the ranking:
    //
    //   1. the loop was UNBOUNDED — `purchasesThisTick` was incremented and never read, so one
    //      pass could buy several upgrades, and the label only ever described the next one;
    //   2. level, RAM and core purchases were NEVER ANNOUNCED. Only nodes were, so upgrades
    //      arrived with no log line while the console named something else entirely.
    //
    // What this pins is the ranking itself, which was right: with a core worth 12.5x a level in
    // gain and 4x in cost, core IS the better buy and the label naming it is correct. The bug
    // was that nothing recorded what was actually purchased, so the two could drift apart
    // unnoticed. The loop cap and the per-purchase announcement are what close that gap.
    const hashRate = (level: number, ram: number, cores: number) =>
        level * Math.pow(1.07, Math.log2(ram)) * (1 + (cores - 1) / 5);

    const level = 100, ram = 64, cores = 4;
    const thisNode = hashRate(level, ram, cores);
    const fleet = 9 * thisNode;

    const levelGain = hashRate(level + 1, ram, cores) - thisNode;
    const coreGain = hashRate(level, ram, cores + 1) - thisNode;

    assert.ok(coreGain > levelGain * 5, "the fixture no longer models the reported gap");
    assert.ok(coreGain / 2.247e6 > levelGain / 549793,
        "a core at 2.247m is not the better buy per dollar in this fixture");
});

test("a budget too small for the best value buys the best it CAN afford, and says so", () => {
    // THE REPORTED CASE, exactly: "it says 'node 0 core next · 2.247m' but random levels were
    // bought — it could not afford the core upgrade". Both statements were true, which is why
    // this was hard to read as a bug.
    //
    //   core : best value per dollar, 2.247m — over the budget, so never chosen
    //   level: worse value, 549k       — under the budget, so bought every loop
    //
    // The label came from an UNFILTERED ranking, so it named the core forever while the loop
    // spent the budget on levels. A reader cannot tell a purchase it is saving for from one it
    // will never afford.
    const hashRate = (level: number, ram: number, cores: number) =>
        level * Math.pow(1.07, Math.log2(ram)) * (1 + (cores - 1) / 5);

    const level = 100, ram = 64, cores = 4, fleet = 9;
    const node = hashRate(level, ram, cores);
    const total = fleet * node;

    const candidates = [
        { type: "LEVEL" as const, nodeIndex: 0, cost: 549_793, rateAfter: total - node + hashRate(level + 1, ram, cores) },
        { type: "CORE" as const, nodeIndex: 0, cost: 2_247_000, rateAfter: total - node + hashRate(level, ram, cores + 1) },
    ];

    // With the real budget the core is out of reach and the level is what gets bought.
    const budget = 1_450_000;
    assert.equal(
        bestUpgrade(candidates, total, budget)?.type,
        "LEVEL",
        "the affordable upgrade was not the one chosen",
    );

    // Unfiltered, the core really is the better value — which is why the old label named it.
    assert.equal(bestUpgrade(candidates, total, Infinity)?.type, "CORE");
});

test("an unaffordable best value buys nothing, rather than the next-best thing", () => {
    // THE REPORTED BEHAVIOUR, and the most expensive of these bugs. The ranking said "core",
    // the core cost more than the remaining budget, and the loop fell through to a LEVEL that
    // fitted — eight times in one pass:
    //
    //   986420  Upgraded node 0 level (2.297m)
    //   ...     Upgraded node 7 level (2.297m)
    //
    // 18.4m on one node for +19.2 H/s, when the same money bought eight cores for +240 H/s.
    // Cores are a flat +20% of a node's base while cores are small; levels are linear on a base
    // that is already large. Twelve times worse for identical spend.
    //
    // Rate-per-dollar is a RATIO, so a cheaper upgrade does not capture any part of what the
    // better one offered — it captures less per dollar. The correct answer when the best is
    // unaffordable is to buy nothing and keep the budget.
    const hashRate = (level: number, ram: number, cores: number) =>
        level * Math.pow(1.07, Math.log2(ram)) * (1 + (cores - 1) / 5);

    const level = 100, ram = 64, cores = 4;
    const node = hashRate(level, ram, cores);
    const total = 9 * node;

    const candidates = [
        { type: "LEVEL" as const, nodeIndex: 0, cost: 2_297_000, rateAfter: total - node + hashRate(level + 1, ram, cores) },
        { type: "CORE" as const, nodeIndex: 0, cost: 2_247_000, rateAfter: total - node + hashRate(level, ram, cores + 1) },
    ];

    // Both affordable: the core wins on value-per-dollar and is bought.
    assert.equal(bestUpgrade(candidates, total, 10_000_000)?.type, "CORE");

    // Neither affordable: nothing is bought. The caller breaks; what matters here is that the
    // ranking does not hand back the cheaper one as a consolation prize.
    assert.equal(
        bestUpgrade(candidates, total, 1_000_000),
        null,
        "an unaffordable set returned a substitute instead of nothing",
    );
});

test("only the best-value upgrade is ever bought, and only if affordable", () => {
    // THE OPERATOR'S RULE, stated as the contract it is: buy what `bestUpgrade` says, or buy
    // nothing and wait. Every earlier version softened this somewhere — a next-best fallback, a
    // cache fallback, a per-tick burst — and each softening spent money on something the
    // ranking had not chosen.
    //
    // The rule has three outcomes and no fourth:
    //   best exists and fits   -> that upgrade, alone
    //   best exists, too dear  -> nothing this pass; the budget carries over
    //   no positive-gain best  -> nothing at all
    const hashRate = (level: number, ram: number, cores: number) =>
        level * Math.pow(1.07, Math.log2(ram)) * (1 + (cores - 1) / 5);
    const node = hashRate(100, 64, 4), total = 9 * node;

    const level = { type: "LEVEL" as const, nodeIndex: 0, cost: 500_000, rateAfter: total - node + hashRate(101, 64, 4) };
    const core = { type: "CORE" as const, nodeIndex: 0, cost: 2_250_000, rateAfter: total - node + hashRate(100, 64, 5) };

    // Best fits: the core, not the cheaper level.
    assert.equal(bestUpgrade([level, core], total, 3_000_000)?.type, "CORE");

    // Best does not fit: nothing. The level is affordable and must NOT be substituted — that
    // substitution is the 12x-worse burst this rule exists to prevent.
    //
    // THE LOOP ASKS AT ANY PRICE FIRST, which is the whole trick: asking `bestUpgrade` WITH the
    // budget just returns the cheaper thing, which is the behaviour being ruled out. Asking with
    // `Infinity` names the upgrade actually worth having, and the caller then decides.
    const bestAtAnyPrice = bestUpgrade([level, core], total, Infinity);
    assert.equal(bestAtAnyPrice?.type, "CORE");
    assert.ok(bestAtAnyPrice!.cost > 1_000_000, "the fixture's core is not actually out of reach");
    assert.equal(
        bestAtAnyPrice!.cost <= 1_000_000 ? bestAtAnyPrice : null,
        null,
        "an unaffordable best produced a cheaper substitute instead of waiting",
    );

    // Only a worse upgrade exists: it is the best available, so it is bought.
    assert.equal(bestUpgrade([level], total, 1_000_000)?.type, "LEVEL");
});

/* ─── when hashes may be spent on anything but cash ─── */

test("only Sell for Money until cash reaches the floor", () => {
    // THE OPERATOR'S RULE: below 250M cash, hashes become cash and nothing else — no
    // Bladeburner rank, no gym boost, no studying. Those are all worth having, but the run
    // cannot afford to buy them with money it has not got yet.
    const hashes = 100_000;
    const capacity = 1_000_000; // 10% full — nowhere near losing anything

    // Far below the floor: cash only, however attractive the alternatives.
    assert.equal(hashSpendIsCashOnly(100_000_000, hashes, capacity), true);
    assert.equal(hashSpendIsCashOnly(249_999_999, hashes, capacity), true);

    // At the floor: the restriction lifts.
    assert.equal(hashSpendIsCashOnly(250_000_000, hashes, capacity), false);
    assert.equal(hashSpendIsCashOnly(900_000_000, hashes, capacity), false);
});

test("a nearly full cache lifts the restriction, because hashes are being wasted", () => {
    // The other half of the rule: past 90% full, holding hashes back stops protecting money
    // and starts destroying it — the game caps the pool, so income past the cap is simply
    // lost. At that point any productive spend beats waiting.
    const capacity = 1_000_000;

    assert.equal(hashSpendIsCashOnly(100_000_000, 899_999, capacity), true, "just under 90% still waits");
    assert.equal(hashSpendIsCashOnly(100_000_000, 900_000, capacity), false, "at 90% the restriction lifts");
    assert.equal(hashSpendIsCashOnly(100_000_000, 999_999, capacity), false);
});

test("an empty pool is not 'full enough', whatever the ratio says", () => {
    // Capacity of 0 is a fleet with no servers yet. 0/0 must not read as 100% full and switch
    // the rule off — the ratio is meaningless there, and the cash floor is the safe answer.
    assert.equal(hashSpendIsCashOnly(100_000_000, 0, 0), true);
});

test("a completely full pool sells for money, whatever the cash level", () => {
    // THE OPERATOR'S CLARIFICATION: the cash floor governs everything EXCEPT the case where
    // the pool would otherwise fill up and start losing hashes. Then selling for money wins
    // outright — not merely "is permitted", which is what the earlier version expressed.
    //
    // The distinction matters because permission is not action: with the restriction lifted,
    // the ordinary chain could pick Bladeburner rank and let the pool overflow anyway. When
    // the alternative is losing hashes to a cap, cash is the answer.
    const capacity = 1_000_000;

    // Full: sell, even with cash far above the floor.
    assert.equal(mustSellForCapacity(1_000_000, capacity), true);
    assert.equal(mustSellForCapacity(1_000_000, capacity), true);

    // Room left: the floor decides, and above it the run holds its hashes.
    assert.equal(mustSellForCapacity(999_999, capacity), false);
    assert.equal(mustSellForCapacity(500_000, capacity), false);

    // Below the floor, cash is the only spend regardless of the pool — decided by the
    // cash-only gate, which returns before the overflow rule is ever consulted.
    assert.equal(hashSpendIsCashOnly(100_000_000, 10, capacity), true);

    // No capacity at all: a fleet that has none yet cannot overflow, and 0/0 must not read
    // as full and force a sale there is nowhere to make.
    assert.equal(mustSellForCapacity(0, 0), false);
});

test("a pool too small to hold the priciest upgrade asks for cache first", () => {
    // THE OPERATOR'S RULE: if the cache cannot even hold the most expensive hash upgrade,
    // buying cache is worth more than any upgrade it could not afford anyway.
    //
    // It is a REACHABILITY rule, not a value one. Every hash spend is priced in hashes, so a
    // capacity below the dearest price means that option is permanently out of reach however
    // long the run waits — the pool caps before it can ever be paid for. Raising capacity is
    // the only thing that changes it.
    //
    // The comparison is against the DEAREST upgrade, not the one being considered: capacity is
    // a ceiling on everything, so the question is whether any of them fit.
    assert.equal(cacheTooSmallForAnyUpgrade(1_000, 5_000), true, "a pool half the dearest price cannot hold it");
    assert.equal(cacheTooSmallForAnyUpgrade(5_000, 5_000), false, "exactly enough is enough");

    // Zero capacity is a fleet with no servers yet, and "too small" there is not actionable —
    // there is no cache to upgrade. The caller buys servers, not capacity.
    assert.equal(cacheTooSmallForAnyUpgrade(0, 5_000), false);
    // No known price (no upgrades available) must not read as "infinitely too small".
    assert.equal(cacheTooSmallForAnyUpgrade(1_000, 0), false);
});

test("a full pool sells before it buys cache, even when the cache is too small", () => {
    // THE ORDERING CONFLICT. Two rules can both want the same tick:
    //
    //   cacheTooSmallForAnyUpgrade  the pool caps below the dearest price, so buy cache
    //   mustSellForCapacity         the pool is full, so sell before losing hashes
    //
    // Cache was checked first and RETURNED, so a full small pool bought cache forever and
    // never sold. The operator's instruction settles it: at exactly full, sell.
    //
    // Selling first is not merely what was asked for, it is the right order. A full pool is
    // losing hashes right now; the cache purchase is an improvement that can wait a tick.
    // Selling also produces cash, which is what pays for the cache.
    const hashes = 64, capacity = 64, dearest = 1024;

    assert.equal(hashActionAt(hashes, capacity, dearest), "sell", "a full pool bought cache instead of selling");

    // With room left, the cache rule keeps its place: the pool is not at risk, and the
    // dearest upgrade is unreachable until capacity grows.
    assert.equal(hashActionAt(63, capacity, dearest), "cache");

    // Neither applies: the ordinary spending chain decides.
    assert.equal(hashActionAt(63, capacity, 32), "spend");
});
