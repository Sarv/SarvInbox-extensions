import { describe, expect, it } from 'vitest';

import {
  advanceByCadence,
  cadenceInMonths,
  detectCadence,
  findNextChargeDate,
  findTrialEndDate,
  parseDateAt,
  projectNextCharge,
  utcDate,
} from '../../src/billing-cycle';

const utc = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

describe('detectCadence', () => {
  it('reads the common phrasings', () => {
    expect(detectCadence('Rs 649 per month')).toBe('monthly');
    expect(detectCadence('billed annually')).toBe('yearly');
    expect(detectCadence('$5/wk')).toBe('weekly');
    expect(detectCadence('every 3 months')).toBe('quarterly');
    expect(detectCadence('$99/yr')).toBe('yearly');
  });

  // "billed yearly at $120/month equivalent" must not read as monthly: the
  // longer cycle is the one the reader is actually committed to.
  it('prefers the longer cycle when both are named', () => {
    expect(detectCadence('Billed yearly, works out at Rs 99 per month')).toBe('yearly');
  });

  it('returns null when no cadence is named', () => {
    expect(detectCadence('Thanks for your order')).toBeNull();
    expect(detectCadence('')).toBeNull();
  });
});

describe('cadenceInMonths', () => {
  it('normalises every cadence to months', () => {
    expect(cadenceInMonths('monthly')).toBe(1);
    expect(cadenceInMonths('quarterly')).toBe(3);
    expect(cadenceInMonths('yearly')).toBe(12);
    expect(cadenceInMonths('weekly')).toBeCloseTo(0.23, 2);
  });
});

describe('utcDate', () => {
  it('builds UTC midnight', () => {
    expect(utcDate(2026, 9, 12)).toBe(utc(2026, 10, 12));
  });

  // Date.UTC rolls 31 February over to 3 March without complaint. A renewal
  // reminder for a day that does not exist is worse than none.
  it('refuses a date that does not exist', () => {
    expect(utcDate(2026, 1, 31)).toBeNull();
    expect(utcDate(2026, 3, 31)).toBeNull();
  });

  it('refuses a year outside the plausible range', () => {
    expect(utcDate(1999, 0, 1)).toBeNull();
    expect(utcDate(2101, 0, 1)).toBeNull();
  });

  it('refuses an impossible month or day', () => {
    expect(utcDate(2026, 12, 1)).toBeNull();
    expect(utcDate(2026, -1, 1)).toBeNull();
    expect(utcDate(2026, 0, 0)).toBeNull();
    expect(utcDate(2026, 0, 32)).toBeNull();
  });
});

describe('parseDateAt', () => {
  it('reads ISO', () => {
    expect(parseDateAt('2026-10-12 and more')).toBe(utc(2026, 10, 12));
  });

  it('reads day-first with a month name', () => {
    expect(parseDateAt('12 October 2026')).toBe(utc(2026, 10, 12));
    expect(parseDateAt('12th Oct. 2026')).toBe(utc(2026, 10, 12));
    expect(parseDateAt('4 Sept 2026')).toBe(utc(2026, 9, 4));
  });

  it('reads month-first with a month name', () => {
    expect(parseDateAt('October 12, 2026')).toBe(utc(2026, 10, 12));
    expect(parseDateAt('Oct 12 2026')).toBe(utc(2026, 10, 12));
  });

  // 12/10/2026 is October to most of the world and December to the US, and
  // nothing in a receipt says which. A reminder two months out is worse than
  // no reminder, so it is refused rather than guessed.
  it('refuses an ambiguous all-numeric date', () => {
    expect(parseDateAt('12/10/2026')).toBeNull();
    expect(parseDateAt('01/02/2026')).toBeNull();
  });

  it('accepts an all-numeric date only when the day cannot be a month', () => {
    expect(parseDateAt('25/10/2026')).toBe(utc(2026, 10, 25));
    expect(parseDateAt('10/25/2026')).toBe(utc(2026, 10, 25));
  });

  // Guessing a century makes a wrong answer look confident.
  it('refuses a two-digit year', () => {
    expect(parseDateAt('12 October 26')).toBeNull();
    expect(parseDateAt('25/10/26')).toBeNull();
  });

  it('returns null for text with no date at the front', () => {
    expect(parseDateAt('soon, probably')).toBeNull();
    expect(parseDateAt('')).toBeNull();
  });

  it('refuses a month name it does not know', () => {
    expect(parseDateAt('12 Smarch 2026')).toBeNull();
  });
});

describe('findNextChargeDate', () => {
  it('reads a date that follows a next-charge cue', () => {
    expect(findNextChargeDate('Next billing date: 4 October 2026')).toBe(utc(2026, 10, 4));
    expect(findNextChargeDate('Your plan renews on 2026-11-01.')).toBe(utc(2026, 11, 1));
    expect(findNextChargeDate('You will be charged again on Dec 1, 2026')).toBe(utc(2026, 12, 1));
  });

  // The reason the parsing is cue-anchored at all: a receipt is full of dates
  // — order date, delivery estimate, statement period — and a fuzzy parser
  // over the whole body picks whichever comes first.
  it('ignores dates that are not the next charge', () => {
    const body = 'Order placed 12 September 2026. Delivery by 15 September 2026.';
    expect(findNextChargeDate(body)).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(findNextChargeDate('')).toBeNull();
  });
});

describe('findTrialEndDate', () => {
  it('reads a trial end date', () => {
    expect(findTrialEndDate('Your trial ends on 4 October 2026')).toBe(utc(2026, 10, 4));
    expect(findTrialEndDate('Free until 2026-10-04')).toBe(utc(2026, 10, 4));
  });

  it('returns null when no trial date is stated', () => {
    expect(findTrialEndDate('Your trial is ending soon')).toBeNull();
  });
});

describe('advanceByCadence', () => {
  it('advances a week, a month, a quarter and a year', () => {
    const start = utc(2026, 1, 15);
    expect(advanceByCadence(start, 'weekly')).toBe(utc(2026, 1, 22));
    expect(advanceByCadence(start, 'monthly')).toBe(utc(2026, 2, 15));
    expect(advanceByCadence(start, 'quarterly')).toBe(utc(2026, 4, 15));
    expect(advanceByCadence(start, 'yearly')).toBe(utc(2027, 1, 15));
  });

  // Overflowing 31 January to 3 March walks the renewal date forward a few
  // days every year until the reminder no longer lands near the charge.
  it('clamps rather than overflowing a short month', () => {
    expect(advanceByCadence(utc(2026, 1, 31), 'monthly')).toBe(utc(2026, 2, 28));
    expect(advanceByCadence(utc(2024, 1, 31), 'monthly')).toBe(utc(2024, 2, 29));
    expect(advanceByCadence(utc(2026, 8, 31), 'monthly')).toBe(utc(2026, 9, 30));
  });

  it('crosses a year boundary', () => {
    expect(advanceByCadence(utc(2026, 12, 10), 'monthly')).toBe(utc(2027, 1, 10));
  });
});

describe('projectNextCharge', () => {
  const now = utc(2026, 9, 23);

  it('always prefers a date the mail stated', () => {
    expect(projectNextCharge(utc(2026, 10, 4), utc(2026, 9, 4), 'monthly', now)).toBe(
      utc(2026, 10, 4)
    );
  });

  it('projects from the charge just made when no date is stated', () => {
    expect(projectNextCharge(null, utc(2026, 9, 4), 'monthly', now)).toBe(utc(2026, 10, 4));
  });

  // A first sync pulls months of backlog at once. Projecting one cycle from
  // each old receipt would raise reminders for dates long past.
  it('walks a backlogged receipt forward past now', () => {
    const projected = projectNextCharge(null, utc(2025, 1, 10), 'monthly', now);
    expect(projected).toBe(utc(2026, 10, 10));
  });

  it('gives up rather than spinning on a nonsensical date', () => {
    expect(projectNextCharge(null, utc(2000, 1, 1), 'weekly', now)).toBeNull();
  });

  it('returns null with no cadence to project from', () => {
    expect(projectNextCharge(null, utc(2026, 9, 4), null, now)).toBeNull();
  });
});
