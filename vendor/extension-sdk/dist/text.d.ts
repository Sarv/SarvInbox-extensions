export { QUOTE_MARKERS, stripQuotedTail } from '@sarv-in/mailguard/quote';

interface HtmlToPlainTextOptions {
    /**
     * Keep each link's `href` in the output (`text [https://…]`). Off for
     * anything a human reads (snippets); on for mining, where a `mailto:`/`tel:`
     * href is itself a signal.
     */
    keepLinkHrefs?: boolean;
}
/**
 * Visible text of an HTML fragment. Never throws — returns `''` for empty,
 * non-string, or unconvertible input, because every caller is on a path where a
 * malformed body must not fail the whole message.
 *
 * Size-capped with the same {@link MAX_HTML_PARSE_BYTES} budget the mailparser
 * call sites use: bodies are attacker-controlled and conversion is synchronous
 * CPU work on the main thread.
 */
declare function htmlToPlainText(html: string, options?: HtmlToPlainTextOptions): string;

export { type HtmlToPlainTextOptions, htmlToPlainText };
