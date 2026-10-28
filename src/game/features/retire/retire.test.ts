/*
 * ============================================================================
 * A STALLED INSTALL HANDOFF
 * ============================================================================
 * `handoffStarted` used to latch. Once set, the retirement decision answered "the
 * installer is already running" on every later tick, whether or not anything was
 * running — and `install.ts` refuses and exits without installing in two ordinary cases
 * (no orchestrator on home, nothing queued). The orchestrator survives both, because a
 * refused handoff never killed anything.
 *
 * The reported symptom: nine augmentations bought, and no install, for a whole run.
 *
 * The first test drives `tick` rather than `reconcileHandoff` directly. Calling the
 * helper in isolation proves the helper works and proves nothing about whether the tick
 * uses it — a version of this file that called the helper by hand passed with the call
 * removed from `tick`, which is exactly the vacuous test to avoid.
 *
 * Run with:  npm test
 * ============================================================================
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hasSpentForTest, tick, markHandoffStartedForTest, reset, stallClock } from "./retire.ts";
import { INSTALL_WAIT_MS } from "./retire-decisions.ts";
import type { NS } from "@ns";
import type { Context } from "../../lib/context.ts";

/**
 * Nine queued augmentations, none installed.
 *
 * THE SIZE NO LONGER DECIDES ANYTHING. It used to: a count threshold of 5 meant this
 * queue retired on the very tick it was seen. The decision is now purely temporal — more
 * than two queued and an hour without a purchase — so nine queued with a freshly armed
 * clock WAITS, exactly like two would. That is the intended behaviour and not a
 * regression: the augmentation count no longer buys an early install, so a run cannot
 * reset just for having accumulated a lot of cheap ones.
 */
const QUEUED = Array.from({ length: 9 }, (_, i) => `Aug${i}`);

/** A queue of `n` augmentations, for the tests that care how many are queued. */
function queueOf(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `Aug${i}`);
}

/**
 * An `ns` with a deployed handoff that is NOT running, and nothing else to do.
 *
 * `liquidate`, `upgradeHome` and `buyNeuroFlux` are all reached once the decision says
 * "retire"; they fail safely here because home has no cash and no scripts, which is the
 * point — the test is about the decision being reachable again, not about the install.
 */
function fakeNs(): NS & { announcements: string[] } {
    return stallNs(QUEUED, 0).ns;
}

/**
 * An `ns` whose queued list and home cash the test can change between ticks.
 *
 * Separate from `fakeNs` because the stall clock is measured ACROSS ticks, so a fixture
 * with fixed figures cannot say anything about it. `queue` and `cash` are read through
 * closures, so a test mutates them in place between calls to `tick`.
 */
function stallNs(state: { queue: readonly string[]; cash: number } | readonly string[], cash = 0) {
    // Normalised once, so a test can pass either a plain list (a fixed fixture) or a
    // mutable `{ queue, cash }` box it changes between ticks. Only the box form can say
    // anything about the stall clock, which is measured across ticks.
    const box = Array.isArray(state)
        ? { queue: state as readonly string[], cash }
        : state as { queue: readonly string[]; cash: number };

    const announcements: string[] = [];
    // Whether the handoff script is running. Mutable, because `reconcileHandoff` clears
    // `handoffStarted` whenever it is NOT — that is the fix for the stalled-run bug, so
    // a test about a RUNNING install has to say so, and not only set the flag.
    let running = false;
    // WHAT THE HANDOFF WAS STARTED WITH, and `spawn` replaced `run` here for the reason
    // the code changed: `run` returns a pid that is not evidence a process exists, so the
    // old fixture had to model "a pid the game will not honour". `spawn` either replaces
    // the caller or throws, so the fixture records the call and every test asserts on it.
    const spawns: { file: string; threads: number; delay: number }[] = [];
    // HOME CASH AND A SALE THAT MOVES IT, both mutable, because the liquidation figure is
    // MEASURED as the difference across the sale. A fixture with fixed figures cannot tell
    // "cash raised" from "profit" from "nothing" — it would answer the same number to all
    // three, and the test that exists to separate them would pass regardless.
    let homeCash = 0;
    let sale: { symbol: string; shares: number; avgPx: number; fillPx: number; cashTo: number } | null = null;
    let sold = false;
    const ns = {
        fileExists: () => true,
        scriptRunning: () => running,
        ls: (_host: string, substring: string) => [`/${substring}`],
        getOwnedAugmentations: (includeQueued: boolean) => (includeQueued ? box.queue : []),
        announce: (_tag: string, message: string) => { announcements.push(message); },
        getServer: () => ({ maxRam: 4096, ramUsed: 4096 - 32 }),
        getServerMaxRam: () => 1024,
        getServerUsedRam: () => 0,
        // Home cash, which `liquidate` reads before and after the sale. `getServerMoneyAvailable`
        // is the same call for every host in this fixture, which is fine: the only host that
        // matters is home.
        getServerMoneyAvailable: () => homeCash,
        // A TIX portfolio holding one position, so the sale path is reached at all. Without
        // this, `liquidate` finds nothing to sell and "cash raised" is trivially 0 — which
        // is the state a test about the figure must not be in.
        stock: {
            hasWseAccount: () => sale !== null,
            hasTixApiAccess: () => sale !== null,
            getSymbols: () => (sale === null ? [] : [sale.symbol]),
            getPosition: (symbol: string) =>
                sale !== null && symbol === sale.symbol ? [sale.shares, sale.avgPx, 0, 0] : [0, 0, 0, 0],
            // THE FILL IS BELOW COST on purpose in the test that uses this, so a profit sum
            // reports a negative number the code must not print.
            sellStock: (_symbol: string, _shares: number) => {
                if (sale === null) return 0;
                if (!sold) { sold = true; homeCash = sale.cashTo; }
                return sale.fillPx;
            },
            sellShort: () => 0,
        },
        getScriptRam: () => 1,
        // THE HANDOFF STARTER. `spawn` does not return, and the real one replaces the
        // caller — so the fixture records the call and stops there. Nothing after it in
        // `handoff` is reached in production, which is why the assertions are on this list
        // rather than on a return value.
        spawn: (file: string, opts: { threads?: number; spawnDelay?: number }) => {
            spawns.push({ file, threads: opts.threads ?? 1, delay: opts.spawnDelay ?? 10_000 });
        },
        singularity: {
            getOwnedAugmentations: (includeQueued: boolean) => (includeQueued ? box.queue : []),
            getAugmentationPrice: () => 1e9,
            getFavorToDonate: () => 150,
            getFactionFavor: () => 0,
            getFactionRep: () => 0,
            upgradeHomeRam: () => false,
            upgradeHomeCores: () => false,
            purchaseAugmentation: () => false,
        },
        // A no-op stand-in for the hold in `install.ts`. The fixture never starts a real
        // process, so there is nothing to wait for; no test here depends on elapsed time
        // inside a tick.
        sleep: () => {},
        print: (line: string) => { announcements.push(line); },
        tprint: (line: string) => { announcements.push(line); },
        toast: () => {},
        writePort: () => true,
        tryWritePort: () => true,
        format: { number: (n: number) => String(n), ram: (n: number) => String(n) },
        hacknet: { numHashes: () => 0 },
    } as unknown as NS & { announcements: string[] };
    ns.announcements = announcements;
    return {
        ns,
        box,
        setRunning: (value: boolean) => { running = value; },
        spawns,
        setHomeCash: (value: number) => { homeCash = value; },
        setStockSale: (value: { symbol: string; shares: number; avgPx: number; fillPx: number; cashTo: number }) => {
            sale = value;
            sold = false;
        },
    };
}

const context = {
    snapshot: { player: { factions: [] }, homeCash: 0 },
    capabilities: { has: () => true },
} as unknown as Context;

test("a tick retries a handoff that exited without installing", () => {
    // THE REGRESSION. With the latch, this tick decided "already started" and returned,
    // for the rest of the run. Driving `tick` is what makes the test fail if the
    // reconcile call is removed from it.
    //
    // THE CLOCK MUST ELAPSE FIRST, and that is a consequence of the decision being
    // temporal rather than counting. Nine queued no longer retires on sight, so the tick
    // that must reach retirement is the one an hour after the clock armed.
    withClock(1_000_000, advance => {
        reset();
        markHandoffStartedForTest();

        const ns = fakeNs();
        // First tick arms the clock from the queue it sees; nothing retires yet.
        tick(ns, context);

        advance(INSTALL_WAIT_MS + MIN);
        ns.announcements.length = 0;
        tick(ns, context);

        // The decision was reached: retirement announces what it is about to do, which it
        // never does on the "already started" path.
        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            `retirement was not reached; announced: ${JSON.stringify(ns.announcements)}`,
        );
    });
});

test("the handoff is started with spawn, synchronously, and not with run", () => {
    // THE FIX FOR THE OBSERVED STALL, asserted at its mechanism rather than at its symptom.
    //
    // The old handoff used `ns.run`, whose pid is not evidence a process exists: the
    // 2026-10-25 run had 83 attempts that returned a pid and left nothing running, plus 7
    // the game refused outright. The cause was home RAM — the orchestrator's `ramOverride`
    // reservation fills home, so `install.ts` had 0.15 GB to fit into.
    //
    // `ns.spawn` is documented to run a new script "without being constrained by the RAM
    // usage of the current one", and with `spawnDelay: 0` it replaces the caller in the
    // same tick. Both halves matter: the RAM hand-over is only atomic with a zero delay.
    //
    // `run` is asserted ABSENT as well as `spawn` present. A change that kept both would
    // start two installers, and the second would fight the first for the same
    // augmentations.
    withClock(2_000_000, advance => {
        reset();

        const fixture = stallNs(QUEUED, 0);
        const ns = fixture.ns;

        tick(ns, context);
        advance(INSTALL_WAIT_MS + MIN);
        tick(ns, context);

        assert.equal(
            fixture.spawns.length,
            1,
            `the handoff was not started with spawn; spawned: ${JSON.stringify(fixture.spawns)}`,
        );
        const spawn = fixture.spawns[0];
        assert.equal(spawn.file, "/install.ts", `the wrong script was spawned: ${spawn.file}`);
        assert.equal(spawn.threads, 1, `the handoff was spawned with ${spawn.threads} threads`);
        assert.equal(
            spawn.delay,
            0,
            `the handoff was spawned with a ${spawn.delay}ms delay; a delayed spawn lets another ` +
            `script take the RAM the orchestrator just released`,
        );
    });
});

test("a handoff already running is not spawned a second time", () => {
    // The other side of the same mechanism: `spawn` terminates the caller, so a second one
    // would be a duplicate installer, not a reload. A run whose handoff is in flight must
    // report "already running" and spawn nothing.
    withClock(3_000_000, advance => {
        reset();

        const fixture = stallNs(QUEUED, 0);
        // The installer is on the machine and alive, which is what a real in-flight handoff
        // looks like between the spawn and the reset.
        fixture.setRunning(true);

        tick(fixture.ns, context);
        advance(INSTALL_WAIT_MS + MIN);
        fixture.ns.announcements.length = 0;
        tick(fixture.ns, context);

        assert.equal(
            fixture.spawns.length,
            0,
            `a second installer was spawned; spawned: ${JSON.stringify(fixture.spawns)}`,
        );
        assert.ok(
            fixture.ns.announcements.every(m => !m.includes("INITIATING RETIREMENT")),
            `retirement fired while an install was in flight; announced: ${JSON.stringify(fixture.ns.announcements)}`,
        );
    });
});

test("a handoff that is already running stops retirement from firing at all", () => {
    // THE POSITIVE CASE FOR THE ADOPTION CHECK, and it replaced a test that asserted the
    // clock was disarmed AFTER retirement fired. That ordering no longer exists: `handoff`
    // now reports an in-flight installer from `tick` BEFORE the decision reads the flag, so
    // a run in that state never announces retirement and never spends.
    //
    // Why the ordering moved. `handoffStarted` is module state, so it is false in a freshly
    // imported module — and a real run reloads this module whenever the orchestrator
    // self-restarts on a file change. Without the adoption check an installer started by
    // the previous instance would be invisible, and this one would spawn a second copy that
    // fights the first for the same augmentations. Adopting it also has to happen before the
    // decision, because otherwise the run liquidates and re-buys a second time.
    withClock(4_000_000, advance => {
        reset();

        const fixture = stallNs(QUEUED, 0);
        // Running BEFORE the handoff is asked for: the installer is on the machine and
        // alive, so there is nothing to start and the queue is about to be consumed.
        fixture.setRunning(true);

        tick(fixture.ns, context);
        advance(INSTALL_WAIT_MS + MIN);
        fixture.ns.announcements.length = 0;
        tick(fixture.ns, context);

        assert.equal(
            fixture.spawns.length,
            0,
            `a second installer was spawned; spawned: ${JSON.stringify(fixture.spawns)}`,
        );
        assert.ok(
            fixture.ns.announcements.every(m => !m.includes("INITIATING RETIREMENT")),
            `retirement fired while an install was in flight; announced: ${JSON.stringify(fixture.ns.announcements)}`,
        );
    });
});

test("a running handoff is not retried", () => {
    // The other half: an install in flight must not be started a second time.
    reset();
    markHandoffStartedForTest();

    const announcements: string[] = [];
    const ns = {
        fileExists: () => true,
        scriptRunning: () => true,
        ls: (_host: string, substring: string) => [`/${substring}`],
        getOwnedAugmentations: (q: boolean) => (q ? QUEUED : []),
        print: (line: string) => { announcements.push(line); },
        writePort: () => true,
        tprint: () => {},
        toast: () => {},
    } as unknown as NS;

    tick(ns, context);
    assert.ok(
        !announcements.some(m => m.includes("INITIATING RETIREMENT")),
        "a running install was retried",
    );
});

test("a retried handoff does NOT buy NeuroFlux a second time", () => {
    // THE OBSERVED DEFECT, and the one that costs a run rather than a minute.
    //
    // The spawn was failing, so `tick` retried every minute — and every retry ran the
    // whole `retireNow` from the top. The 2026-10-25 run logged three separate purchases
    // (5 Governors, then 4, then 1) into the same queue, each one bought at an increased
    // price with money the reset was being paid for.
    //
    // The assertion is on the second tick specifically. A fixture that never retires
    // proves nothing here, so the first tick has to reach the purchase and the second has
    // to reach the handoff — which is exactly the retry the flag has to interrupt.
    withClock(5_000_000, advance => {
        reset();
        const { ns, purchases } = neuroNs(1e9);

        tick(ns, context);
        advance(INSTALL_WAIT_MS + MIN);
        tick(ns, context);

        const afterFirst = purchases.length;
        assert.ok(afterFirst > 0, "the fixture never reached the NeuroFlux purchase");

        // The handoff does not complete (nothing is running to pick it up), so the run is
        // left retrying. The next ticks must retry the HANDOFF, not the spending.
        advance(MIN);
        tick(ns, context);
        advance(MIN);
        tick(ns, context);

        assert.equal(
            purchases.length,
            afterFirst,
            `a retried handoff bought NeuroFlux again; purchases: ${JSON.stringify(purchases)}`,
        );
        // WHETHER `spent` SURVIVES IS NOT ASSERTED HERE any more, and the reason is a real
        // property of the fix rather than a weakened test.
        //
        // In production the retirement ends at `ns.spawn(spawnDelay: 0)`, which replaces
        // the process — nothing after it runs, so the module state (including this flag)
        // dies with the run and cannot be re-read. `hasSpentForTest()` would only observe a
        // value in a fixture whose `spawn` returns, which no real spawn does.
        //
        // The assertion above is the one that carries the defect: it fails if the spending
        // ever happens twice. Pinning the flag here would test the fixture's stub rather
        // than the behaviour that costs the run.
    });
});

test("adopting an in-flight handoff also marks the run as spent", () => {
    // THE PART OF THE ADOPTION CHECK THAT PROTECTS THE RUN'S MONEY.
    //
    // A module reload makes `handoffStarted` and `spent` both false while an installer
    // started by the previous instance is still on the machine. Adopting the handoff has to
    // set BOTH: without `spent`, any later tick that re-decides would liquidate stocks and
    // buy Governors a second time for an install that is already paid for.
    //
    // `spent` is not readable from the game, so this asserts the observable consequence —
    // the run does not spend again — rather than the flag's value.
    withClock(6_000_000, advance => {
        reset();
        assert.ok(!hasSpentForTest(), "reset left the run believing it had already spent");

        const fixture = stallNs(QUEUED, 0);
        fixture.setRunning(true);

        // The first tick adopts the in-flight handoff.
        tick(fixture.ns, context);
        assert.ok(
            hasSpentForTest(),
            "an adopted handoff left the run unspent; a later decision would liquidate again",
        );

        // And it keeps not spending: an hour later the run still must not re-liquidate a
        // queue whose install is already under way.
        advance(INSTALL_WAIT_MS + MIN);
        fixture.ns.announcements.length = 0;
        tick(fixture.ns, context);

        assert.ok(
            fixture.ns.announcements.every(m => !m.includes("Raised")),
            `an adopted handoff was liquidated a second time; announced: ${JSON.stringify(fixture.ns.announcements)}`,
        );
    });
});

test("the liquidation figure is cash raised, not profit and not negative", () => {
    // THE REPORTED DEFECT. The 2026-10-25 run logged `Liquidated $-225.504m` while selling
    // everything it owned, and `$0.000` on other runs that had plenty to sell. Both came
    // from summing `(sellPrice - avgPrice) * shares`: a LOSS is a true thing to report but
    // not under a label that reads as money in, and a run that bought and sold at par
    // raised real cash that the formula called nothing.
    //
    // Asserted on the announcement because that is the only place the figure surfaces, and
    // it is what a reader was misled by. The fixture loses money on the sale — a fill below
    // cost — and the reported figure must still be what home gained.
    withClock(7_000_000, advance => {
        reset();

        const fixture = stallNs(QUEUED, 0);
        // Home cash: 100 at the start of the liquidation, 900 after it. The stock it sells
        // is worth 3000 and cost 3400, so a profit sum would report -400 and a proceeds
        // sum that ignored the sale would report 0.
        fixture.setHomeCash(100);
        fixture.setStockSale({ symbol: "ECP", shares: 40, avgPx: 85, fillPx: 75, cashTo: 900 });

        tick(fixture.ns, context);
        advance(INSTALL_WAIT_MS + MIN);
        fixture.ns.announcements.length = 0;
        tick(fixture.ns, context);

        const line = fixture.ns.announcements.find(m => m.includes("Raised"));
        assert.ok(line, `no liquidation line; announced: ${JSON.stringify(fixture.ns.announcements)}`);
        assert.ok(
            line.includes("$800"),
            `the figure was not the cash raised (900 - 100); line: ${line}`,
        );
    });
});

/* ─── the stall fallback ─── */

/** A context pointing at a `{ queue, cash }` box, so a test can move both between ticks. */
function contextFor(box: { queue: readonly string[]; cash: number }): Context {
    return {
        snapshot: { player: { factions: [] }, homeCash: box.cash },
        capabilities: { has: () => true },
    } as unknown as Context;
}

/*
 * THE CLOCK. `tick` calls `Date.now()`, so the tests replace it. Real time cannot be used
 * here: an hour of it per case is not a test, and `setTimeout` cannot be reasoned about.
 * The stub is installed for the duration of a test and restored afterwards, so a failing
 * assertion cannot leave the process with a frozen clock and make the NEXT test lie.
 */
function withClock(start: number, body: (advance: (ms: number) => void) => void): void {
    const real = Date.now;
    let now = start;
    Date.now = () => now;
    try {
        body(ms => { now += ms; });
    } finally {
        Date.now = real;
    }
}

/** One registry tick is a minute, so this is how a test walks forward. */
const MIN = 60_000;

/* ─── NeuroFlux Governor: bought here, and only here ─── */

/**
 * An `ns` whose faction sells NeuroFlux Governor, recording what was bought.
 *
 * Separate from `stallNs` only in what it answers: this fixture has to make the NeuroFlux
 * purchase actually REACHABLE, which `stallNs` deliberately does not (it prices everything
 * at 1e9 and returns false from every purchase). A test that asserts "NeuroFlux was not
 * bought" against a fixture that cannot buy anything proves nothing, so the retirement
 * case needs a fixture where the purchase would succeed if it were reached.
 */
function neuroNs(neuroPrice: number) {
    // Typed rather than inferred: the only writer is a closure inside the fixture object,
    // which TypeScript does not see, so `[]` alone infers `never[]` and every assertion
    // against it fails to compile.
    const purchases: string[] = [];
    const announcements: string[] = [];
    // Which script the handoff asked the game to replace this one with. `spawn` does not
    // return, so a retirement that reaches it never reaches anything after it.
    const spawns: string[] = [];
    const ns = {
        fileExists: () => true,
        scriptRunning: () => false,
        ls: (_host: string, substring: string) => [`/${substring}`],
        getOwnedAugmentations: (q: boolean) => (q ? QUEUED : []),
        announce: (_tag: string, message: string) => { announcements.push(message); },
        getServerMaxRam: () => 1024,
        getServerUsedRam: () => 0,
        getServerMoneyAvailable: () => 1e15,
        // Reached only from `refusal`, which says how much room home had when the handoff
        // was started. Live even in a test that is about NeuroFlux, because the spawn
        // announcement quotes it.
        getServer: () => ({ maxRam: 4096, ramUsed: 0 }),
        getScriptRam: () => 1,
        // The handoff starter. Recorded rather than performed, so a test can assert that
        // the retirement actually reached the handoff instead of quietly returning.
        spawn: (file: string) => { spawns.push(file); },
        getPlayer: () => ({
            factions: ["CyberSec"],
            mults: { faction_rep: 1 },
            money: 1e15,
        }),
        // A TOP-LEVEL `ns` function, not a Singularity one — `getFavorToDonate` is one of
        // the few faction figures the game exposes outside SF4. Getting this wrong makes
        // `buyNeuroFlux` throw, and its catch reports "purchase stopped early" rather than
        // a missing function, so the fixture has to match the real API or the test lies.
        getFavorToDonate: () => 150,
        singularity: {
            getOwnedAugmentations: (q: boolean) => (q ? QUEUED : []),
            getAugmentationsFromFaction: () => ["NeuroFlux Governor"],
            getAugmentationPrice: () => neuroPrice,
            getAugmentationRepReq: () => 0,
            getFactionFavor: () => 0,
            getFactionRep: () => 1e12,
            donateToFaction: () => false,
            upgradeHomeRam: () => false,
            upgradeHomeCores: () => false,
            purchaseAugmentation: (_faction: string, aug: string) => {
                purchases.push(aug);
                return true;
            },
        },
        sleep: async () => {},
        print: (line: string) => { announcements.push(line); },
        tprint: (line: string) => { announcements.push(line); },
        toast: () => {},
        writePort: () => true,
        tryWritePort: () => true,
        format: { number: (n: number) => String(n), ram: (n: number) => String(n) },
        hacknet: { numHashes: () => 0 },
    } as unknown as NS;
    return { ns, purchases, announcements, spawns };
}

test("NeuroFlux Governor is bought once retirement is decided", () => {
    // THE ONE PLACE IT IS ALLOWED. `player.ts` filters NeuroFlux out of both of its
    // purchase paths (see `player/neuroflux.test.ts`), so this is the only code in the
    // project that buys it — and the assertion below is what pins that it still does.
    // Without this, deleting the call would look like a cleanup: nothing else would fail,
    // and runs would quietly stop buying the augment at all.
    withClock(1_000_000, advance => {
        reset();
        const { ns, purchases } = neuroNs(1e9);

        // A tick that WAITS must not buy it: the whole point is that it is a retirement
        // purchase, not a purchase made in passing.
        //
        // Asserted on the LENGTH rather than with `deepEqual(purchases, [])`, because
        // `deepEqual` is declared with an assertion signature: comparing against `[]`
        // narrows `purchases` to `never[]` and every later use of it stops compiling.
        tick(ns, context);
        assert.equal(
            purchases.length,
            0,
            `NeuroFlux was bought on a tick that decided not to retire: ${JSON.stringify(purchases)}`,
        );

        // Once the hour elapses, retirement is decided and the purchase is made.
        advance(INSTALL_WAIT_MS + MIN);
        tick(ns, context);
        assert.ok(
            purchases.includes("NeuroFlux Governor"),
            `retirement did not buy NeuroFlux; bought: ${JSON.stringify(purchases)}`,
        );
    });
});

test("a NeuroFlux the run cannot afford is not bought and is not an error", () => {
    // The bound on the opposite side. `buyNeuroFlux` runs after liquidation and has to be
    // harmless when the money did not arrive — a retirement that failed on an unaffordable
    // luxury augment would abort the install it was retiring for.
    withClock(1_000_000, advance => {
        reset();
        // Priced beyond the fixture's cash, so the `money < price` break is the branch hit.
        const { ns, purchases, announcements } = neuroNs(1e30);

        tick(ns, context);
        advance(INSTALL_WAIT_MS + MIN);
        tick(ns, context);

        assert.deepEqual(purchases, [], "an unaffordable NeuroFlux was reported as bought");
        assert.ok(
            announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "retirement did not proceed past an unaffordable NeuroFlux",
        );
    });
});

/* ─── the one rule: a long queue does not install early ─── */

test("a large queue installs ONLY after the hour, not on sight", () => {
    // THE REPORTED BUG. A count threshold installed as soon as five were queued, whatever
    // the clock said — so a run accumulated cheap augmentations and reset before the queue
    // had earned the reputation spent on it. The size must now decide nothing at all.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(40), cash: 5e9 };
        const { ns } = stallNs(box);

        // First tick arms the clock. Forty queued is not a reason to retire.
        tick(ns, contextFor(box));
        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "a forty-strong queue retired on the tick that armed the clock",
        );

        // Nor is it one a minute later, or fifty-nine minutes later.
        advance(INSTALL_WAIT_MS - MIN);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the queue retired before the hour was up",
        );

        // At the hour it does, with no purchase needed to have been observed.
        advance(MIN);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            `the hour elapsed and nothing retired; announced: ${JSON.stringify(ns.announcements)}`,
        );
    });
});

test("more than two queued is required, so three is the smallest install", () => {
    // STRICTLY more than `MIN_QUEUED`. Two queued is an ordinary moment on the way to a
    // third, and an hour of waiting does not make it worth a reset.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(INSTALL_WAIT_MS * 5);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "two queued installed, but the rule is strictly more than two",
        );

        // THE CONTROL, and it pins a subtlety worth stating. Growing to three does NOT
        // install at once: it is the tick that ARMS the clock, because two queued was
        // never enough to start counting. So the boundary is "three queued starts an
        // hour", not "three queued installs" — and the assertion above would otherwise
        // pass on a decision that never retires at all.
        box.queue = queueOf(3);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "three queued installed immediately; reaching three arms the clock rather than firing it",
        );
        assert.ok(
            ns.announcements.some(m => m.includes("clock started")),
            "reaching three queued neither installed nor armed the clock, so it can never retire",
        );

        // An hour after reaching three, it installs.
        advance(INSTALL_WAIT_MS);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the clock armed at three queued but never expired",
        );
    });
});

test("a purchase restarts the hour, so a run that keeps buying keeps going", () => {
    // The reason the timer is not merely an age limit: augmentations arriving means the
    // wait is working, and interrupting it would cost the reputation the wait protects.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(3), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));

        // Buy one fifty minutes in: the queue grows AND cash falls, which is a purchase.
        advance(INSTALL_WAIT_MS - 10 * MIN);
        box.queue = queueOf(4);
        box.cash = 4.5e9;
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        // Ten minutes after the purchase is when the ORIGINAL clock would have expired.
        advance(10 * MIN + MIN);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the clock did not restart on the purchase, so the run reset mid-acquisition",
        );

        // A full hour after that purchase it does fire.
        advance(INSTALL_WAIT_MS);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the restarted clock never expired",
        );
    });
});

test("a stalled queue retires", () => {
    // Three queued and nothing bought for over an hour. There is no separate "stall"
    // fallback any more — this IS the only rule — but the case still has to be driven
    // across ticks, because the wait is measured between them rather than read from the
    // game.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        // Two ticks to establish the baseline (the first only takes a reading) and one
        // purchase, so the clock has a start.
        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        // Nothing more is bought. One hour and a bit later it must give up waiting.
        advance(INSTALL_WAIT_MS + MIN);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            `stall did not retire; announced: ${JSON.stringify(ns.announcements)}`,
        );
        assert.ok(
            ns.announcements.some(m => m.includes("nothing bought for")),
            "retired for a reason other than the stall, so the test proves nothing",
        );
    });
});

test("a stall under two queued waits, however long it lasts", () => {
    // One augmentation is an ordinary moment on the way to the second. Installing for it
    // is a worse trade than waiting, so the fallback must not fire.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(0), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(1);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        advance(INSTALL_WAIT_MS * 3);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "retired on a single queued augmentation",
        );
    });
});

test("a purchase restarts the stall clock", () => {
    // THE USER'S RULE, as a test. The clock runs from the LAST PURCHASE, not from the
    // last install — so a run that keeps buying keeps waiting, however long the queue has
    // been open. Without this, a steady run would be interrupted mid-progress.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        // Three quarters of an hour pass, then one more is bought. That purchase is
        // inside the window, so the hour starts again from it.
        advance(INSTALL_WAIT_MS * 0.75);
        box.queue = queueOf(4);
        box.cash = 3e9;
        tick(ns, contextFor(box));

        // Less than an hour since THAT purchase: must still be waiting.
        advance(INSTALL_WAIT_MS * 0.75);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "a purchase did not restart the stall clock",
        );

        // And once a full hour has gone by since it, the wait ends.
        advance(INSTALL_WAIT_MS);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the clock never expired after the last purchase",
        );
    });
});

test("a queue seen for the first time still arms the clock", () => {
    // THE REGRESSION. The clock used to arm ONLY on an observed growth, which meant a run
    // could never start it — and that is not hypothetical: the orchestrator re-imports the
    // module on a self-restart, `lastPurchaseAt` comes back null, and a run that has
    // already bought everything it can afford never grows its queue again. The clock then
    // reports "not counting" forever, and the stall this whole feature exists to catch
    // never fires.
    //
    // Two queued, first tick ever, nothing bought during the test at all: that is the
    // state after a reload on a run that is done buying.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(3), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));

        advance(INSTALL_WAIT_MS + MIN);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "a queue that was merely SEEN was never timed, so a reloaded run can wait forever",
        );
    });
});

test("a reload does not lose a clock that was already running", () => {
    // The same defect from the other side. The module is re-imported, so its state is
    // fresh — but the run's clock should pick up where it left off rather than restarting
    // from zero, or a run reloaded every few minutes would never reach the hour.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        // Three quarters of the window passes, then the module is thrown away and
        // re-imported — which `reset()` is the test-visible form of, being the same
        // clearing of module state a fresh import produces.
        advance(INSTALL_WAIT_MS * 0.75);
        reset();

        // The clock re-arms from the FIRST sight of the queue in the new instance, not
        // from the original purchase. So it needs a further full window rather than the
        // quarter that was left. Waiting is the safe direction: the original purchase was
        // at least as long ago as this reading.
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "retired immediately after a reload",
        );

        advance(INSTALL_WAIT_MS * 0.99);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the reloaded clock fired before its own full window had passed",
        );

        advance(INSTALL_WAIT_MS * 0.02);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the reloaded clock never fired, so a reloaded run can wait forever",
        );
    });
});

test("a queue below the stall bar does not arm the clock", () => {
    // The other half of the baseline rule. One queued augmentation is an ordinary moment
    // on the way to the second, and arming a timer for it would be arming one for a
    // condition the decision refuses to act on.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(1), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));

        advance(INSTALL_WAIT_MS * 3);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "retired on a single queued augmentation",
        );
    });
});

test("a queue that grows without spending is not a purchase", () => {
    // The queue rising on its own is a RE-READ, not a purchase — the same inconsistent
    // pair of lists that made `install.ts` able to count a negative queue. If that were
    // taken as a purchase, the stall clock would restart forever and never fire.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        // Cash does NOT fall between the last two ticks, but it DID fall when the queue
        // first grew — that is the purchase the clock is anchored to. The later rise has
        // no cash behind it, so it must be read as a re-read and change nothing.
        advance(INSTALL_WAIT_MS * 0.9);
        box.queue = queueOf(4);
        tick(ns, contextFor(box));

        // Past a full hour since the ANCHOR purchase, counting the re-read as time
        // spent. If the re-read had restarted the clock, this tick would still be inside
        // the window and would wait.
        advance(INSTALL_WAIT_MS * 0.2);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "a cash-free queue rise restarted the stall clock",
        );
    });
});

test("a running handoff outranks the stall", () => {
    // An install in flight must never be started a second time, even when the queue has
    // been stalled for longer than the window. `alreadyStarted` is checked first.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns, setRunning } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        // The flag AND the process. Setting only the flag is not the state this test is
        // about: `reconcileHandoff` would find nothing running and clear it, which is the
        // correct behaviour for an install that exited — and would silently turn this
        // into a second copy of "a stalled queue retires".
        advance(INSTALL_WAIT_MS * 2);
        markHandoffStartedForTest();
        setRunning(true);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            `a stalled queue started a second installer: ${JSON.stringify(ns.announcements)}`,
        );
    });
});

test("arming the clock says so once, in the Terminal", () => {
    // The line a reader uses to tell "the timer is running" from "the timer never armed".
    // ONCE, not per tick: the feature runs every minute for the life of the run, and a
    // line per tick would bury the Terminal and the console's message stream.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(3), cash: 5e9 };
        const { ns } = stallNs(box);

        // The first tick arms it, from the baseline reading.
        tick(ns, contextFor(box));
        const started = ns.announcements.filter(m => m.includes("clock started"));
        assert.equal(started.length, 1, `expected one arming line, got ${JSON.stringify(ns.announcements)}`);

        // Four more ticks without a purchase must say nothing further.
        for (let i = 0; i < 4; i++) {
            advance(MIN);
            tick(ns, contextFor(box));
        }
        assert.equal(
            ns.announcements.filter(m => m.includes("clock started") || m.includes("clock restarted")).length,
            1,
            `the arming line repeated on a quiet run: ${JSON.stringify(ns.announcements)}`,
        );
    });
});

test("a purchase restarts the clock and says so", () => {
    // The other arming site, reported with DIFFERENT words because it means something
    // different: this one dates from a real purchase, the baseline one only from whenever
    // the module loaded.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        assert.ok(
            ns.announcements.some(m => m.includes("clock restarted after a purchase")),
            `a purchase did not announce the restart: ${JSON.stringify(ns.announcements)}`,
        );
    });
});

test("a queue that grows without spending announces nothing", () => {
    // The control for the test above. A re-read is not a purchase, and a line claiming a
    // restart after one would be reporting an event that did not happen.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(3), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        // Queue grows, cash does NOT fall.
        box.queue = queueOf(4);
        tick(ns, contextFor(box));

        assert.ok(
            !ns.announcements.some(m => m.includes("restarted after a purchase")),
            "a cash-free queue rise was announced as a purchase",
        );
    });
});

test("a stalled queue that is NOT already installing does retire", () => {
    // THE CONTROL for the test above. Without it, "a running handoff outranks the stall"
    // would pass just as happily if the stall never fired at all — which is exactly what
    // happened when `markHandoffStartedForTest` was placed before the queue had a
    // baseline, and the queue read 0 for the whole test. Same clock, same steps, one line
    // different: no handoff was started.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));

        advance(INSTALL_WAIT_MS * 2);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));

        assert.ok(
            ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "the stall did not fire at all, so the handoff test above proves nothing",
        );
    });
});

/* ─── the published clock ─── */

test("the dashboard clock is null until the queue is worth timing", () => {
    // Null, not zero — before there is anything to count, the panel must say nothing
    // rather than show a timer at its last second. Since the clock now arms on a first
    // sighting, "nothing to count" means a queue below the stall bar, not merely "no
    // purchase observed yet": a run that is done buying still has a clock to show.
    withClock(1_000_000, () => {
        reset();
        const box = { queue: queueOf(1), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));

        assert.equal(stallClock(), null, "a clock was published for a queue the decision ignores");
    });
});

test("the dashboard clock comes due exactly one stall window after a purchase", () => {
    // The figure the panel counts down to has to be the SAME figure the decision uses.
    // Measured independently here, so the two cannot drift: the clock is checked against
    // the purchase's own timestamp, not against `INSTALL_WAIT_MS` applied to a later tick.
    withClock(1_000_000, advance => {
        reset();
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);

        tick(ns, contextFor(box));
        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        const purchasedAt = Date.now();
        tick(ns, contextFor(box));

        const clock = stallClock();
        assert.ok(clock !== null, "no clock after a purchase");
        assert.equal(clock.dueAt, purchasedAt + INSTALL_WAIT_MS, "the clock does not start at the purchase");
        assert.equal(clock.queued, 3, "the clock does not carry the queue size it is timing");

        // And it agrees with the decision: one millisecond before the deadline, a tick
        // does not retire; at the deadline it does. A clock that disagreed with the
        // branch would be showing a countdown to an event that never happens.
        advance(INSTALL_WAIT_MS - MIN);
        ns.announcements.length = 0;
        tick(ns, contextFor(box));
        assert.ok(
            !ns.announcements.some(m => m.includes("INITIATING RETIREMENT")),
            "retired before the published clock came due",
        );
    });
});

test("an armed clock below the stall bar publishes nothing", () => {
    // THE REPORTED BUG. "The timer for installing augments is not working in the react UI."
    //
    // The timer was working. It was counting down to a deadline that could never fire: the
    // queue sat at TWO, and `decideRetirement` requires STRICTLY MORE than `MIN_QUEUED` (2),
    // so three is the smallest installable queue. The panel therefore showed a countdown that
    // reached "due" and stayed there — which is precisely what a broken countdown looks like.
    //
    // Recorded in the run: the queue went 0 -> 1 -> 2 and stopped, while the published clock
    // sat 527 seconds past its deadline and never moved.
    //
    // An armed clock on a queue the decision ignores is a promise the rule will not keep, so
    // the clock is now null there. The panel says nothing, which is the truth: this run is
    // waiting on another PURCHASE, not on time.
    withClock(1_000_000, advance => {
        reset();
        // Two queued, then a purchase that grows it to three and arms the clock.
        const box = { queue: queueOf(2), cash: 5e9 };
        const { ns } = stallNs(box);
        tick(ns, contextFor(box));

        advance(MIN);
        box.queue = queueOf(3);
        box.cash = 4e9;
        tick(ns, contextFor(box));
        assert.ok(stallClock() !== null, "no clock while the queue qualified");

        // Now the queue falls back below the bar WITHOUT a reset — the game restating a list,
        // or an augment being merged. The clock must stop being published, because nothing it
        // counted down to can happen.
        advance(MIN);
        box.queue = queueOf(2);
        tick(ns, contextFor(box));
        assert.equal(
            stallClock(),
            null,
            "the panel kept counting down for a queue the install rule ignores",
        );
    });
});
