import { convert } from 'html-to-text';
export { QUOTE_MARKERS, stripQuotedTail } from '@sarv-in/mailguard/quote';

// ../core/src/utils/html-text.ts

// ../core/src/utils/mail-parse.ts
var MAX_HTML_PARSE_BYTES = 5 * 1024 * 1024;

// ../core/src/utils/html-text.ts
function htmlToPlainText(html, options = {}) {
  if (typeof html !== "string" || html.trim() === "") return "";
  const capped = html.length > MAX_HTML_PARSE_BYTES ? html.slice(0, MAX_HTML_PARSE_BYTES) : html;
  try {
    return convert(capped, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        ...options.keepLinkHrefs ? [] : [{ selector: "a", options: { ignoreHref: true } }]
      ]
    }).trim();
  } catch {
    return "";
  }
}

export { htmlToPlainText };
//# sourceMappingURL=text.mjs.map
//# sourceMappingURL=text.mjs.map