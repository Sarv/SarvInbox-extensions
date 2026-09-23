/**
 * Phase 1: the cheap "is this even an auth message?" screen, run before any
 * pattern matching.
 *
 * Two jobs. It keeps per-message CPU off mail that obviously carries no code —
 * this runs on every message that arrives, on the main thread — and it rules out
 * whole GENRES of mail that are dense in code-shaped numbers. A calendar invite
 * is the worst of them: dial-in number, meeting PIN, conference id and a date,
 * all within a few characters of the word "PIN".
 */

/** Fields a gate decision needs. Structural, so tests need not build a whole
 *  `EmailRecord` and the gate cannot quietly start depending on more. */
export interface GateInput {
  subject?: string | null;
  cleanBody?: string | null;
  calendarIcs?: string | null;
}

/**
 * True when the message is a calendar invite.
 *
 * The host parses the `text/calendar` part into `calendarIcs` before any
 * workflow runs, so this is a fact about the MIME structure rather than a guess
 * from the text — an invite cannot dress itself out of it, and ordinary mail
 * cannot accidentally match it.
 */
export function isCalendarInvite(email: GateInput): boolean {
  return Boolean(email.calendarIcs && email.calendarIcs.trim());
}

/**
 * Whether the detector should run at all.
 *
 * Deliberately permissive about what it lets THROUGH — the scoring model is
 * what decides if there is a code, and a gate that demanded a keyword in the
 * subject would drop the many providers that put one only in the body. It is
 * strict about the one genre it knows cannot contain a passcode.
 */
export function shouldScanForCode(email: GateInput): boolean {
  if (isCalendarInvite(email)) return false;
  return Boolean(email.subject || email.cleanBody);
}
