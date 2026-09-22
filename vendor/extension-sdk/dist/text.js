'use strict';

var htmlToText = require('html-to-text');
var quote = require('@sarv-in/mailguard/quote');

// ../core/src/utils/html-text.ts

// ../core/src/utils/mail-parse.ts
var MAX_HTML_PARSE_BYTES = 5 * 1024 * 1024;

// ../core/src/utils/html-text.ts
function htmlToPlainText(html, options = {}) {
  if (typeof html !== "string" || html.trim() === "") return "";
  const capped = html.length > MAX_HTML_PARSE_BYTES ? html.slice(0, MAX_HTML_PARSE_BYTES) : html;
  try {
    return htmlToText.convert(capped, {
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

Object.defineProperty(exports, "QUOTE_MARKERS", {
  enumerable: true,
  get: function () { return quote.QUOTE_MARKERS; }
});
Object.defineProperty(exports, "stripQuotedTail", {
  enumerable: true,
  get: function () { return quote.stripQuotedTail; }
});
exports.htmlToPlainText = htmlToPlainText;
//# sourceMappingURL=text.js.map
//# sourceMappingURL=text.js.map