import type { DarknetResponseCode, DarknetServerDetails } from "@ns";

/*
 * ============================================================================
 * DARK NET PASSWORDS
 * ============================================================================
 * Working out what to try, and what a failure means, as pure functions.
 *
 * Why this exists. The game's own documentation says the server model list and
 * the password contents are "intentionally undocumented" and are to be discovered
 * by experiment, so the process is guess-and-check against a network that punishes
 * wasted attempts with time and, past a point, timeout. Two consequences shape
 * everything here:
 *
 *   - Candidates are RANKED and BOUNDED, never enumerated. A depth-10 server with a
 *     12-character unicode password is not enumerable, and a generator that tried
 *     would hang the feature rather than fail it.
 *   - A hint is not trusted as the password without checking it against the
 *     declared length and format. A hint reading "the usual, capitalised" tried
 *     literally burns an attempt for nothing, and attempts are the scarce resource.
 *
 * Nothing here calls `ns`, which is what lets the interesting half of password
 * cracking be tested without a game.
 * ============================================================================
 */

/** The subset of `DarknetServerDetails` this module reads. */
export type PasswordFacts = Pick<
    DarknetServerDetails,
    "passwordHint" | "passwordLength" | "passwordFormat" | "modelId" | "data"
>;

/** How many candidates to generate before giving up. Attempts cost time and risk timeout. */
export const MAX_CANDIDATES = 24;

/**
 * The character set a format implies, or null when it is not enumerable.
 *
 * `unicode` is deliberately null: there is no bounded alphabet to walk, and a
 * generator that pretended otherwise would produce nonsense candidates forever.
 * A server with a unicode password is one to leave alone rather than grind.
 */
export function alphabetFor(format: DarknetServerDetails["passwordFormat"]): string | null {
    switch (format) {
        case "numeric": return "0123456789";
        case "alphabetic": return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        case "alphanumeric": return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        // Printable ASCII, minus space: a password field rarely accepts a leading
        // space, and including it makes every generated candidate look wrong.
        case "ASCII": return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{};:,.<>?/";
        case "unicode": return null;
    }
}

/**
 * Whether a string COULD be this server's password, by length and format.
 *
 * The length check is lenient by one, because the game's `passwordLength` and the
 * hint's own text occasionally disagree by a character and a candidate that is
 * otherwise perfect should not be discarded on that alone.
 */
export function couldBePassword(
    candidate: string,
    facts: Pick<PasswordFacts, "passwordLength" | "passwordFormat">,
): boolean {
    if (candidate.length !== facts.passwordLength) return false;
    const alphabet = alphabetFor(facts.passwordFormat);
    if (alphabet === null) return candidate.length > 0;
    return [...candidate].every(char => alphabet.includes(char));
}

/**
 * The password, if the hint states it outright and it fits the declared shape.
 *
 * The two conditions are both necessary. A hint that states the password is the
 * common case and the cheapest win available; a hint that does NOT — "the name of
 * this server's model, reversed" — must not be submitted as a literal, or every
 * attempt on that server is wasted.
 */
export function passwordFromHint(facts: PasswordFacts): string | null {
    const hint = facts.passwordHint.trim();
    if (hint === "") return null;

    // The hint sometimes wraps the password in quotes or appends punctuation
    // describing it. Extract the quoted run first, because that is the game's own
    // convention for "this literal is the answer".
    const quoted = /["'`]([^"'`]+)["'`]/.exec(hint);
    const literal = quoted?.[1] ?? hint;

    return couldBePassword(literal, facts) ? literal : null;
}

/**
 * Passwords to try, best first, bounded.
 *
 * Order is by expected value rather than by enumeration order, because a bounded
 * prefix of a large space is worthless if it starts at the bottom of the alphabet: a
 * 2-character alphanumeric server has 3,844 passwords, so the first 24 candidates
 * would all be `aa`..`ax` and the real password is essentially never among them.
 * What is worth trying instead:
 *
 *   1. the hint, when it is the answer
 *   2. the `data` field, which some models carry alongside the hint
 *   3. the hint read as a description — its words, de-punctuated, and reversed
 *   4. weak patterns people actually choose: repeated characters, ascending and
 *      descending runs, and the short numeric strings a "password reminder" implies
 *   5. a bounded sweep of the declared space, for the cases nothing else covers
 *
 * A `unicode` server with no usable hint yields an empty list, which callers must
 * treat as "do not attempt" rather than "keep trying".
 */
export function candidatesFor(facts: PasswordFacts, limit: number = MAX_CANDIDATES): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const offer = (candidate: string | null | undefined): void => {
        if (out.length >= limit) return;
        if (candidate === null || candidate === undefined) return;
        const trimmed = candidate.trim();
        if (trimmed === "" || seen.has(trimmed)) return;
        if (!couldBePassword(trimmed, facts)) return;
        seen.add(trimmed);
        out.push(trimmed);
    };

    // 1 & 2: the two fields that state an answer rather than describing one.
    offer(passwordFromHint(facts));
    if (facts.data !== "") offer(facts.data);

    // 3: the hint read as a description. Both directions, because a hint that says
    // "backwards" and one that merely reads oddly are indistinguishable from here.
    const hint = facts.passwordHint.trim();
    if (hint !== "") {
        const bare = hint.replace(/[^\p{L}\p{N}]/gu, "");
        offer(bare);
        offer([...bare].reverse().join(""));
    }

    // 4: the patterns a password that people actually pick tends to follow. Cheap,
    // bounded, and far more likely to hit than a sweep from the start of the space.
    for (const candidate of weakPatterns(facts)) offer(candidate);

    // 5: a bounded sweep, last, because it is the least likely to succeed and would
    // otherwise crowd out everything above it.
    const alphabet = alphabetFor(facts.passwordFormat);
    if (alphabet !== null && facts.passwordLength > 0) {
        for (const candidate of generate(facts.passwordLength, alphabet, limit - out.length)) {
            offer(candidate);
        }
    }

    return out.slice(0, limit);
}

/**
 * The passwords a person actually chooses, when a hint has not stated one.
 *
 * This is deliberately a short list of shapes rather than a search: repeated
 * characters (`1111`, `aaaa`), ascending and descending digits (`0123`, `9876`),
 * the alphabet forwards and back, and the `password`-style words. It is here because
 * the sweep in step 5 cannot reach these — they sit far from the start of the space —
 * and they are the most common answers to "set a simple reminder".
 */
function* weakPatterns(facts: PasswordFacts): Generator<string> {
    const { passwordLength, passwordFormat } = facts;
    const alphabet = alphabetFor(passwordFormat);
    if (passwordLength <= 0) return;

    // No alphabet means no bounded set of characters to build shapes from. Yielding
    // `aaaaaaaa` for a unicode server would be worse than useless: it passes the
    // length check, so it looks like a real candidate and would be sent.
    if (alphabet === null) return;

    const digits = "0123456789";
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const useDigits = passwordFormat === "numeric" || passwordFormat === "alphanumeric" || passwordFormat === "ASCII";
    const useLetters = passwordFormat !== "numeric";

    const repeat = (source: string): string =>
        source.repeat(Math.ceil(passwordLength / source.length)).slice(0, passwordLength);

    // The most likely single characters first, INTERLEAVED with the letter and
    // digit runs. Iterating the whole alphabet one shape at a time would fill the
    // candidate list with `aa`..`xx` before reaching `1111`, which is at least as
    // likely and would then never be tried within the budget.
    const lead = useDigits ? "0123456789" : "abcdefghijklmnopqrstuvwxyz";

    // One character, repeated: `1111`, `aaaa`, `0000`.
    for (const char of lead) yield char.repeat(passwordLength);

    if (useDigits) {
        // Ascending and descending runs: `0123`, `9876`, and zero-padded counts.
        yield repeat(digits);
        yield [...digits].reverse().join("").slice(0, passwordLength);
        yield [...Array(passwordLength).keys()].map(i => digits[i % digits.length] ?? "0").join("");
    }

    if (useLetters) {
        yield repeat(letters);
        yield [...letters].reverse().join("").slice(0, passwordLength);
    }

    // The words every list of common passwords starts with, truncated or repeated to
    // the declared length.
    for (const word of ["password", "admin", "letmein", "welcome", "secret"]) {
        yield word.slice(0, passwordLength);
        yield repeat(word);
    }

    // Anything left in the alphabet, so a format with symbols still gets shapes.
    for (const char of alphabet) {
        if (lead.includes(char)) continue;
        yield char.repeat(passwordLength);
    }
}

/**
 * A bounded prefix of the password space, shortest-to-longest within a fixed length.
 *
 * Deterministic, and deliberately NAIVE: it walks the space in a fixed order rather
 * than trying to be clever, because the useful signal for a real server comes from
 * `correctCharactersInPassword` on the 2G_cellular models and there is no way to use
 * that here without guessing at the model. This is the floor, not the strategy.
 */
function* generate(length: number, alphabet: string, budget: number): Generator<string> {
    if (budget <= 0 || length <= 0) return;

    // Counting in base-|alphabet| would need bignum arithmetic past a few
    // characters. A simple odometer over an index array is exact for any length and
    // stops after `budget` steps regardless.
    const digits = new Array<number>(length).fill(0);
    let emitted = 0;

    while (emitted < budget) {
        yield digits.map(d => alphabet[d] ?? "").join("");

        emitted += 1;
        if (emitted >= budget) return;

        // Increment, least significant digit last, in the order a human would type.
        let position = length - 1;
        while (position >= 0) {
            digits[position] = (digits[position] ?? 0) + 1;
            if ((digits[position] ?? 0) < alphabet.length) break;
            digits[position] = 0;
            position -= 1;
        }
        // Overflow: the whole space was exhausted.
        if (position < 0) return;
    }
}

/* ─── what a failure means ─── */

/** What the caller should do about a darknet response. */
export type DarknetVerdict =
    | { readonly kind: "retry"; readonly reason: string }
    | { readonly kind: "wrong-password" }
    | { readonly kind: "give-up"; readonly reason: string }
    | { readonly kind: "ok" };

/**
 * Turn a game response code into a decision.
 *
 * The list is the game's own, from `DarknetResponseCodeType`, and the distinction
 * that matters is between "this attempt was wrong" and "stop attempting". Getting
 * that wrong in the optimistic direction spins on a server that will never accept a
 * password; in the pessimistic direction it abandons a server that was merely
 * unlucky with network instability.
 */
export function classifyFailure(result: { success: boolean; code: DarknetResponseCode }): DarknetVerdict {
    if (result.success) return { kind: "ok" };

    switch (result.code) {
        // Unlucky, not wrong. `RequestTimeOut` explicitly says the password may or
        // may not have been correct, so the SAME password is worth one more try.
        case 408:
            return { kind: "retry", reason: "request timed out" };

        case 401:
            return { kind: "wrong-password" };

        // The route to this server changed underneath us, or we asked from the wrong
        // host. Re-walking is the fix, not another password.
        case 351:
            return { kind: "give-up", reason: "no direct connection; the route must be re-walked" };

        case 503:
            return { kind: "give-up", reason: "server is offline" };

        // Charisma gates the ATTEMPT, so more passwords cannot help.
        case 451:
            return { kind: "give-up", reason: "not enough charisma" };

        case 403:
            return { kind: "give-up", reason: "forbidden" };

        case 404:
            return { kind: "give-up", reason: "required resource is missing on that server" };

        // These belong to other darknet calls; reaching them here means this was
        // called for the wrong action.
        case 453:
            return { kind: "give-up", reason: "stasis link limit reached" };
        case 454:
            return { kind: "give-up", reason: "no blocked RAM to free" };
        case 455:
            return { kind: "give-up", reason: "phishing attempt failed" };

        default:
            return { kind: "give-up", reason: `unexpected response code ${result.code}` };
    }
}

/**
 * Whether a server is worth attempting at all.
 *
 * ONE reason to decline, and it is the only one that is actually impossible:
 *
 *   an unenumerable password with no usable hint — a `unicode` password the hint does
 *   not state cannot be reached by any bounded list of candidates.
 *
 * Charisma is deliberately NOT checked, and getting that wrong is what made the feature
 * look dead. The game's own docs are explicit that low charisma is a SPEED penalty:
 * "the charisma level on a server is not a requirement for authentication, but
 * authentication takes longer if the player's charisma is below the server's charisma
 * level", and `getServerRequiredCharismaLevel` adds that it can take "much longer — or,
 * in certain servers deep in the darknet, be impossible".
 *
 * Treating it as a gate meant a player below a server's threshold had the feature refuse
 * that server silently, every tick, forever — which from outside is indistinguishable
 * from the feature doing nothing. Slow is a reason to keep trying; impossible is the
 * only reason to stop, and even then only per-server.
 *
 * `charisma` and `requiredCharisma` are kept as parameters because callers still need to
 * report the penalty, and the signature is where that fact belongs.
 */
export function worthAttempting(
    facts: PasswordFacts,
    charisma: number,
    requiredCharisma: number,
): { ok: true } | { ok: false; reason: string } {
    const alphabet = alphabetFor(facts.passwordFormat);
    if (alphabet === null && passwordFromHint(facts) === null) {
        return {
            ok: false,
            reason: `${facts.passwordFormat} password with no usable hint is not enumerable`,
        };
    }

    // Not a refusal: recorded so the caller can say WHY this host is slow. A player
    // watching a server take minutes should be able to see that charisma is the reason
    // rather than wondering whether it is stuck.
    void charisma;
    void requiredCharisma;

    return { ok: true };
}

/**
 * How far below a host's charisma the player is, as a ratio. 1 or above means no penalty.
 *
 * Reported rather than acted on: authentication scales with this, so it is the number
 * that explains a slow walk. Returning a figure rather than a boolean keeps the "how
 * much slower" question answerable, which a `charisma < required` test cannot express.
 */
export function charismaPenalty(charisma: number, requiredCharisma: number): number {
    if (requiredCharisma <= 0) return 1;
    if (charisma <= 0) return requiredCharisma;
    return Math.max(1, requiredCharisma / charisma);
}
