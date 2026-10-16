/*
 * ============================================================================
 * MESSAGE COLOR
 * ============================================================================
 * Color a log line by what KIND of thing it is, not where it came from.
 *
 * `announce` and its friends carry a source tag (`SLEEVES`, `STOCK`, `nexus`)
 * already; that tells you WHO spoke. This module adds the other axis — WHAT the
 * message is — so an error, a warning, a success and a plain FYI do not all read
 * the same in the log panel.
 *
 * Why ANSI rather than Bitburner's keyword prefixes. `print` accepts "ERROR",
 * "SUCCESS", "WARN" and "INFO" prefixed to a string, but the keyword colors the
 * WHOLE line and leaks the word into the visible text. ANSI escape sequences
 * let us color only the `[TAG]` prefix and leave the message body at the default
 * color, which keeps the body readable and the kind legible at a glance.
 *
 * The escape code is `\u001b` rather than `\x1b` because Bitburner runs scripts
 * in strict mode, where `\033` (octal) is not allowed and the Bash `\e` is not
 * supported. `\u001b` is the supported Unicode form.
 */

/** The kinds of log line the framework distinguishes. */
export type MessageLevel = "error" | "warn" | "success" | "info" | "tx";

const RESET = "\u001b[0m";

/** Foreground color per level, mapped to ANSI SGR codes. */
const LEVEL_COLOR: Record<MessageLevel, string> = {
    error: "\u001b[31m", // red
    warn: "\u001b[33m", // yellow
    success: "\u001b[32m", // green
    info: "\u001b[36m", // cyan
    tx: "\u001b[35m", // magenta — buy/sell/install and other value-changing actions
};

/**
 * Wrap `text` in the color for `level`.
 *
 * Colors the text and nothing else; the caller is responsible for where the
 * reset lands. `announce` uses this for the `[TAG]` prefix only, so the body
 * stays readable in the default color.
 */
export function colorize(level: MessageLevel, text: string): string {
    return `${LEVEL_COLOR[level]}${text}${RESET}`;
}
