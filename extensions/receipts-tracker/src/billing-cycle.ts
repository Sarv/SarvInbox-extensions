/**
 * When the next charge lands.
 *
 * Dates are read only where a cue says one is coming — "next billing date",
 * "renews on", "trial ends". A general-purpose fuzzy date parser run over a
 * whole receipt is the obvious approach and the wrong one: receipts are full
 * of dates (ordered on, delivered by, invoice dated, offer valid until) and a
 * parser with no idea which is which will confidently return the first one it
 * meets. Anchoring to the cue is what makes the answer mean anything.
 *
 * Everything returned is UTC epoch milliseconds. A date written on a receipt
 * carries no zone, so it is read as UTC midnight of that calendar day and
 * rendered back in the reader's own zone by the panel. Reading it as LOCAL
 * midnight instead would make the stored instant depend on where the app
 * happened to be running, and the same receipt would land on different days
 * for two people looking at the same mailbox.
 */

/** How often a subscription charges. */
export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** Roughly how many months one cycle covers, for monthly-equivalent costs. */
const CADENCE_MONTHS: Record<Cadence, number> = {
  weekly: 1 / 4.345,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

const CADENCE_PATTERNS: ReadonlyArray<readonly [RegExp, Cadence]> = [
  [/\b(?:every\s+)?(?:week|weekly|per\s+week)\b|\/\s*(?:wk|week)\b/i, 'weekly'],
  [/\b(?:every\s+(?:3|three)\s+months?|quarterly|per\s+quarter)\b/i, 'quarterly'],
  [/\b(?:year|yearly|annual(?:ly)?|per\s+year|per\s+annum)\b|\/\s*(?:yr|year)\b/i, 'yearly'],
  [/\b(?:month|monthly|per\s+month)\b|\/\s*(?:mo|month)\b/i, 'monthly'],
];

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Cues after which a date is the next charge. */
const NEXT_CHARGE_CUES = [
  /next\s+(?:billing|payment|charge|renewal)\s*(?:date|on)?\s*[:\-]?\s*/i,
  /(?:will\s+be\s+)?(?:automatically\s+)?renew(?:s|ed|al)?\s+on\s*[:\-]?\s*/i,
  /(?:you\s+)?(?:will\s+be|be)\s+charged\s+(?:again\s+)?on\s*[:\-]?\s*/i,
  /next\s+invoice\s*[:\-]?\s*/i,
  /subscription\s+renews\s*[:\-]?\s*/i,
];

/** Cues after which a date is the end of a trial. */
const TRIAL_END_CUES = [
  /trial\s+(?:period\s+)?(?:ends?|expires?|will\s+end)\s*(?:on)?\s*[:\-]?\s*/i,
  /free\s+until\s*[:\-]?\s*/i,
  /(?:ends?|expires?)\s+on\s*[:\-]?\s*/i,
];

/** How much text after a cue can still hold its date. */
const DATE_WINDOW = 40;

/** The cadence named in the text, or null. */
export function detectCadence(text: string): Cadence | null {
  if (!text) return null;
  for (const [pattern, cadence] of CADENCE_PATTERNS) {
    if (pattern.test(text)) return cadence;
  }
  return null;
}

/** Months covered by one billing cycle. */
export function cadenceInMonths(cadence: Cadence): number {
  return CADENCE_MONTHS[cadence];
}

/**
 * A four-digit year, rejecting anything outside a plausible receipt range.
 *
 * Two-digit years are refused rather than guessed: `12/10/26` is already
 * ambiguous in two ways, and resolving one of them by assumption just makes
 * a wrong answer look confident.
 */
function validYear(value: number): boolean {
  return value >= 2000 && value <= 2100;
}

/** UTC midnight for a calendar date, or null when the date is not real. */
export function utcDate(year: number, monthIndex: number, day: number): number | null {
  if (!validYear(year) || monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;

  const timestamp = Date.UTC(year, monthIndex, day);
  const date = new Date(timestamp);
  // Rejects 31 February and friends: Date.UTC rolls them over silently, and a
  // renewal reminder for a day that does not exist is worse than none.
  if (date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) return null;

  return timestamp;
}

/**
 * Read a date from the start of `text`.
 *
 * Handles the three unambiguous shapes receipts use: ISO (`2026-10-12`),
 * day-first with a month name (`12 October 2026`) and month-first with a
 * month name (`October 12, 2026`).
 *
 * All-numeric slash dates are accepted ONLY when the day exceeds twelve and
 * so cannot be a month. `12/10/2026` is the 12th of October to most of the
 * world and the 10th of December to the United States, and nothing in a
 * receipt says which — a renewal reminder on the wrong day by two months is
 * worse than no reminder, so it is left alone.
 */
export function parseDateAt(text: string): number | null {
  const window = text.slice(0, DATE_WINDOW);

  const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(window);
  if (iso) {
    return utcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const dayFirst = /^\s*(\d{1,2})(?:st|nd|rd|th)?[\s.\-/]+([a-z]+)\.?[\s.,\-/]+(\d{4})\b/i.exec(window);
  if (dayFirst) {
    const month = MONTH_NAMES[(dayFirst[2] ?? '').toLowerCase()];
    if (month !== undefined) return utcDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = /^\s*([a-z]+)\.?[\s.\-/]+(\d{1,2})(?:st|nd|rd|th)?[\s.,\-/]+(\d{4})\b/i.exec(window);
  if (monthFirst) {
    const month = MONTH_NAMES[(monthFirst[1] ?? '').toLowerCase()];
    if (month !== undefined) return utcDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  const numeric = /^\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/.exec(window);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    // See the note above: only an impossible month disambiguates this.
    if (first > 12 && second <= 12) return utcDate(Number(numeric[3]), second - 1, first);
    if (second > 12 && first <= 12) return utcDate(Number(numeric[3]), first - 1, second);
    return null;
  }

  return null;
}

/** The first date following any of `cues`, or null. */
export function findCuedDate(text: string, cues: readonly RegExp[]): number | null {
  if (!text) return null;

  for (const cue of cues) {
    const match = cue.exec(text);
    if (!match) continue;
    const parsed = parseDateAt(text.slice(match.index + match[0].length));
    if (parsed !== null) return parsed;
  }
  return null;
}

/** The next charge date stated in the text, or null. */
export function findNextChargeDate(text: string): number | null {
  return findCuedDate(text, NEXT_CHARGE_CUES);
}

/** The trial end date stated in the text, or null. */
export function findTrialEndDate(text: string): number | null {
  return findCuedDate(text, TRIAL_END_CUES);
}

/**
 * Advance a timestamp by one billing cycle.
 *
 * Month arithmetic clamps rather than overflows: one month after 31 January
 * is 28 or 29 February, not 2 or 3 March. Overflowing would walk a
 * subscription's renewal date forward by a day or three every year, and the
 * reminder would drift off the real charge date.
 */
export function advanceByCadence(from: number, cadence: Cadence): number {
  const start = new Date(from);

  if (cadence === 'weekly') return from + 7 * 24 * 60 * 60 * 1000;

  const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
  const targetMonth = start.getUTCMonth() + months;
  const year = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;

  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(start.getUTCDate(), lastDayOfTarget);

  return Date.UTC(year, month, day, start.getUTCHours(), start.getUTCMinutes());
}

/**
 * When this subscription charges next.
 *
 * A date the mail states outright is always preferred. Only when there is
 * none is one projected from the cadence, and projection walks forward from
 * the charge just made until it is in the future — a receipt synced from six
 * months of backlog must not produce a reminder for a date long past.
 */
export function projectNextCharge(
  stated: number | null,
  chargedAt: number,
  cadence: Cadence | null,
  now: number
): number | null {
  if (stated !== null) return stated;
  if (!cadence) return null;

  let next = advanceByCadence(chargedAt, cadence);
  // Bounded: twenty-four cycles covers two years of weekly backlog, and stops
  // a nonsensical timestamp from spinning here.
  for (let step = 0; step < 24 && next <= now; step += 1) {
    next = advanceByCadence(next, cadence);
  }

  return next > now ? next : null;
}
