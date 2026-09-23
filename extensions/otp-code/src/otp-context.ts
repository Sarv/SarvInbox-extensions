/**
 * Context signals: the spans a passcode CANNOT be in, and the sender/auth facts
 * that make one more or less believable.
 *
 * Split from `otp-detect.ts` because these answer a different question. The
 * detector asks "does this look like a code?"; this asks "is this region of the
 * mail even eligible, and is this sender the kind that sends codes?".
 *
 * The bug that produced this file: a Google Calendar invite raised a passcode
 * card for `631606`, sliced out of the dial-in number `+1 631-606-4341` because
 * Google's own `PIN: 192405006` sat one character away and scored it at 0.92.
 * The real PIN was nine digits and therefore ignored, so the ONLY thing the card
 * offered was a fragment of a phone number.
 *
 * Every pattern here is bounded and non-nested for the same reason the detector's
 * are: the text is attacker-controlled and matching happens on the main thread.
 */

/** Digits in a run that make it a phone number rather than a passcode. A
 *  national number is 9+ digits; `PLAIN_CODE` stops at 8, so the two sets do
 *  not overlap and nothing a code could be is ever masked by this rule. */
const MIN_PHONE_DIGITS = 9;

/** Two or more separator-joined digit groups: `631-606-4341`, `020 7946 0958`,
 *  `+91 98765 43210`. This deliberately also matches the `123 456` passcode
 *  format — MIN_PHONE_DIGITS, not the shape, is what tells the two apart, and a
 *  rule that tried to do it by group count missed every number whose groups ran
 *  to five digits. */
const GROUPED_DIGIT_RUN = /\d{2,5}(?:[\s.\-]\d{2,5}){1,5}/g;

/** A URL. Anything inside one is a path segment, an id or a tracking token. */
const URL_SPAN = /\bhttps?:\/\/[^\s<>"']{1,500}/gi;

/** A bare `www.` or `meet.google.com/...` style link with no scheme. */
const SCHEMELESS_URL_SPAN = /\b(?:www\.|meet\.google\.com\/)[^\s<>"']{1,500}/gi;

/** A query-string parameter: `?token=9283719`, `&uid=44512`. */
const QUERY_PARAM_SPAN = /[?&][A-Za-z0-9_.\-]{1,40}=[^\s&#<>"']{1,200}/g;

/** Phrases that make a nearby number a way to REACH a meeting, not enter one.
 *  Google writes "Join by phone … PIN:", which puts a passcode keyword right
 *  beside a phone number — the exact collision this extension got wrong. */
const DIAL_IN_PHRASES = [
  'join by phone',
  'dial-in',
  'dial in',
  'more phone numbers',
  'meeting id',
  'meeting code',
  'conference id',
  'phone pin',
  'by phone',
] as const;

/** How far from a dial-in phrase a number is still part of that block. */
const DIAL_IN_WINDOW = 80;

/** Senders that exist to send transactional mail. A weak positive only —
 *  plenty of real codes come from ordinary-looking addresses, so this may
 *  never be a requirement. */
const TRANSACTIONAL_LOCAL_PARTS = [
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'security',
  'auth',
  'account',
  'accounts',
  'verify',
  'verification',
  'otp',
  'support',
  'notifications',
] as const;

/** `YYYYMMDD` and `DDMMYYYY` read as a bare 8-digit run. An order placed on
 *  20260923 is not a passcode. */
const DATE_STAMP = /^(?:(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2})$/;

/** Count digits without allocating a match array for every candidate run. */
function digitCount(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (character >= '0' && character <= '9') total += 1;
  }
  return total;
}

/**
 * Blank out every span a passcode cannot live in, PRESERVING LENGTH.
 *
 * Same-length replacement is the load-bearing detail: the detector scores a
 * candidate by its index — distance to the nearest keyword, the characters
 * either side of it — so a mask that shortened the text would silently move
 * every later candidate away from the keyword that justified it. Spaces also
 * make the masked region a word boundary, so a run adjacent to it cannot glue
 * itself onto the hole.
 */
export function maskNonCodeSpans(text: string): string {
  if (!text) return text;

  let masked = text;

  const blank = (match: string): string => ' '.repeat(match.length);

  masked = masked.replace(URL_SPAN, blank);
  masked = masked.replace(SCHEMELESS_URL_SPAN, blank);
  masked = masked.replace(QUERY_PARAM_SPAN, blank);
  // Phone numbers last: a number inside a URL is already gone, and this rule is
  // the one that has to justify itself against real codes.
  masked = masked.replace(GROUPED_DIGIT_RUN, (match) =>
    digitCount(match) >= MIN_PHONE_DIGITS ? blank(match) : match
  );

  return masked;
}

/**
 * True when a candidate sits in a "here is how to dial in" block.
 *
 * Belt and braces alongside `maskNonCodeSpans`: a meeting line that prints its
 * number in a form the mask does not recognise (an extension, a short code, a
 * number split across markup) still must not raise a passcode card.
 */
export function hasDialInContext(lowered: string, index: number): boolean {
  const from = Math.max(0, index - DIAL_IN_WINDOW);
  const to = Math.min(lowered.length, index + DIAL_IN_WINDOW);
  const window = lowered.slice(from, to);
  return DIAL_IN_PHRASES.some((phrase) => window.includes(phrase));
}

/** True when the local part of the sender is a transactional mailbox. */
export function isTransactionalSender(fromAddress: string | null | undefined): boolean {
  const address = (fromAddress ?? '').trim().toLowerCase();
  if (!address) return false;
  const [localPart] = address.split('@');
  return TRANSACTIONAL_LOCAL_PARTS.some((part) => localPart.includes(part));
}

/**
 * The rolled-up SPF/DKIM/DMARC verdict, or null when the message carries none.
 *
 * `authStatus` reaches an extension as the JSON string the host stored, and a
 * malformed one must read as "no opinion" rather than throw inside a workflow
 * that is holding up the mail pipeline.
 */
export function parseAuthOverall(authStatus: unknown): string | null {
  if (typeof authStatus !== 'string' || !authStatus.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(authStatus);
    if (!parsed || typeof parsed !== 'object') return null;
    const overall = (parsed as { overall?: unknown }).overall;
    return typeof overall === 'string' ? overall : null;
  } catch {
    return null;
  }
}

/**
 * True when the message FAILED authentication.
 *
 * Only an outright `fail` counts. `none`/`partial` are the normal state of mail
 * that crossed a forwarder or a mailing list, and treating those as suspicious
 * would suppress cards for legitimate codes — the failure mode users notice.
 * A `fail`, though, means the sending domain is being impersonated, and a
 * passcode card is the highest-trust surface this app has: showing one for a
 * spoofed message turns the extension into a phishing amplifier.
 */
export function failsAuthentication(authStatus: unknown): boolean {
  return parseAuthOverall(authStatus) === 'fail';
}

/** True when an all-digit code is really a date stamp. */
export function looksLikeDateStamp(code: string): boolean {
  return DATE_STAMP.test(code);
}
