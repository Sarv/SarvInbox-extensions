import { describe, expect, it } from 'vitest';

import { formatCadence, formatDate, formatMonthKey, formatMoney } from '../../src/format';

/** Intl inserts a narrow no-break space between symbol and digits in some locales. */
function normalize(value: string): string {
  return value.replace(/[  ]/g, ' ');
}

describe('formatMoney', () => {
  // Minor units are integers; dividing by the wrong power of ten is a
  // hundredfold error, which is the one money bug nobody misses.
  it('divides by the currency exponent, not always by a hundred', () => {
    expect(normalize(formatMoney(199_900, 'INR', 'en-IN'))).toContain('1,999.00');
    expect(normalize(formatMoney(500, 'JPY', 'en-US'))).toContain('500');
    expect(normalize(formatMoney(500, 'JPY', 'en-US'))).not.toContain('5.00');
  });

  it('renders the currency symbol', () => {
    expect(normalize(formatMoney(1999, 'USD', 'en-US'))).toBe('$19.99');
  });

  // The reader's locale decides grouping, which is the entire reason the
  // panel sends one instead of the extension picking.
  it('groups in the reader locale', () => {
    expect(normalize(formatMoney(12_345_600, 'INR', 'en-IN'))).toContain('1,23,456.00');
    expect(normalize(formatMoney(12_345_600, 'INR', 'en-US'))).toContain('123,456.00');
  });

  // A receipt with no recognisable currency still has a number worth showing;
  // inventing a symbol for it would be a lie about what the mail said.
  it('prints a bare number for an unknown currency', () => {
    expect(formatMoney(1999, 'UNKNOWN', 'en-US')).toBe('19.99');
  });

  // Intl throws on a malformed code. Letting that escape would blank the
  // whole panel over one bad row.
  it('falls back instead of throwing on a code Intl rejects', () => {
    expect(formatMoney(1999, 'XX', 'en-US')).toBe('XX 19.99');
  });
});

describe('formatMonthKey', () => {
  it('turns a bucket key into a heading', () => {
    expect(formatMonthKey('2026-09', 'en-US')).toBe('Sep 2026');
  });

  // The key was bucketed in the reader's zone already; a month index out of
  // range means something upstream is wrong, and showing the raw key is more
  // honest than showing a month that was never computed.
  it('returns the key unchanged when it is not a month', () => {
    expect(formatMonthKey('2026-13', 'en-US')).toBe('2026-13');
    expect(formatMonthKey('nonsense', 'en-US')).toBe('nonsense');
  });
});

describe('formatDate', () => {
  // Stored UTC, rendered local: 30 September 20:00 UTC is already 1 October
  // in Mumbai, and a reader there must see their own date.
  it('renders in the zone it is given, not in UTC', () => {
    const instant = Date.UTC(2026, 8, 30, 20, 0, 0);
    expect(formatDate(instant, 'UTC', 'en-US')).toBe('Sep 30, 2026');
    expect(formatDate(instant, 'Asia/Kolkata', 'en-US')).toBe('Oct 1, 2026');
  });

  // A panel reporting a zone this runtime has never heard of must still get
  // a date back.
  it('falls back to an ISO day for an unusable zone', () => {
    expect(formatDate(Date.UTC(2026, 8, 30, 20, 0, 0), 'Mars/Olympus', 'en-US')).toBe('2026-09-30');
  });
});

describe('formatCadence', () => {
  it('gives every cadence a word', () => {
    expect(formatCadence('weekly')).toBe('Weekly');
    expect(formatCadence('monthly')).toBe('Monthly');
    expect(formatCadence('quarterly')).toBe('Quarterly');
    expect(formatCadence('yearly')).toBe('Yearly');
  });

  // An unknown cadence must print nothing rather than an empty badge.
  it('returns undefined when there is no cadence', () => {
    expect(formatCadence(undefined)).toBeUndefined();
  });
});
