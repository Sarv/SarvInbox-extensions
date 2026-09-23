import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MONTHS_BACK,
  describeReceipt,
  monthKeyIn,
  monthlyEquivalent,
  monthsAgoKey,
  recurringPerMonth,
  spendByMonth,
  subscriptionsOf,
  summarize,
  upcomingCharges,
} from '../../src/summary';
import { makeRecord } from '../helpers/record';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fixed "now" in the middle of September 2026. */
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

/** The last instant of 30 September in UTC that is already October in Mumbai. */
const LATE_SEPTEMBER_UTC = Date.UTC(2026, 8, 30, 20, 0, 0);

describe('monthKeyIn', () => {
  // The whole reason the panel sends a zone: a receipt from the evening of
  // 30 September in Mumbai belongs to the reader's September, and bucketing
  // it in UTC would file it under October.
  it('buckets in the zone it is given', () => {
    expect(monthKeyIn('UTC', LATE_SEPTEMBER_UTC)).toBe('2026-09');
    expect(monthKeyIn('Asia/Kolkata', LATE_SEPTEMBER_UTC)).toBe('2026-10');
    expect(monthKeyIn('America/Los_Angeles', LATE_SEPTEMBER_UTC)).toBe('2026-09');
  });

  // A panel reporting a zone this runtime has never heard of is a bad reason
  // to show the reader an empty page.
  it('falls back to UTC for an unusable zone', () => {
    expect(monthKeyIn('Mars/Olympus', LATE_SEPTEMBER_UTC)).toBe('2026-09');
  });

  it('zero-pads the month so keys sort lexically', () => {
    expect(monthKeyIn('UTC', Date.UTC(2026, 0, 5))).toBe('2026-01');
  });
});

describe('monthsAgoKey', () => {
  it('walks back within a year', () => {
    expect(monthsAgoKey('UTC', Date.UTC(2026, 8, 21), 5)).toBe('2026-04');
  });

  // Naive arithmetic on the month number gives 2026-(-2) here.
  it('walks back across the year boundary', () => {
    expect(monthsAgoKey('UTC', Date.UTC(2026, 0, 15), 3)).toBe('2025-10');
  });

  it('uses the reader zone to decide which month it is now', () => {
    expect(monthsAgoKey('Asia/Kolkata', LATE_SEPTEMBER_UTC, 1)).toBe('2026-09');
    expect(monthsAgoKey('UTC', LATE_SEPTEMBER_UTC, 1)).toBe('2026-08');
  });
});

describe('spendByMonth', () => {
  it('totals a month and counts its receipts', () => {
    const months = spendByMonth(
      [
        makeRecord({ emailId: 'a', amountMinor: 1000 }),
        makeRecord({ emailId: 'b', amountMinor: 2500 }),
      ],
      'UTC',
      DEFAULT_MONTHS_BACK,
      NOW
    );

    expect(months).toEqual([{ month: '2026-09', currency: 'USD', totalMinor: 3500, count: 2 }]);
  });

  // A month where a large order came back would otherwise read as the most
  // expensive of the year, which is the opposite of what happened.
  it('subtracts refunds', () => {
    const months = spendByMonth(
      [
        makeRecord({ emailId: 'a', amountMinor: 5000 }),
        makeRecord({ emailId: 'b', amountMinor: 2000, kind: 'refund' }),
      ],
      'UTC',
      DEFAULT_MONTHS_BACK,
      NOW
    );

    expect(months[0]?.totalMinor).toBe(3000);
  });

  // A refund for a purchase made before the window would push the month
  // negative and draw a bar going the wrong way.
  it('floors a month at zero', () => {
    const months = spendByMonth(
      [makeRecord({ amountMinor: 9000, kind: 'refund' })],
      'UTC',
      DEFAULT_MONTHS_BACK,
      NOW
    );

    expect(months[0]?.totalMinor).toBe(0);
  });

  // A trial has no money in it; counting it as spend would invent a charge
  // that has not happened.
  it('ignores trials and amountless records', () => {
    const months = spendByMonth(
      [
        makeRecord({ emailId: 'a', kind: 'trial', amountMinor: 0 }),
        makeRecord({ emailId: 'b', amountMinor: 0 }),
      ],
      'UTC',
      DEFAULT_MONTHS_BACK,
      NOW
    );

    expect(months).toEqual([]);
  });

  // Adding rupees to dollars would produce a number that means nothing.
  it('keeps currencies apart', () => {
    const months = spendByMonth(
      [
        makeRecord({ emailId: 'a', amountMinor: 1000, currency: 'USD' }),
        makeRecord({ emailId: 'b', amountMinor: 50_000, currency: 'INR' }),
      ],
      'UTC',
      DEFAULT_MONTHS_BACK,
      NOW
    );

    expect(months).toHaveLength(2);
    expect(months.map((month) => month.currency)).toContain('INR');
  });

  it('drops receipts older than the window', () => {
    const months = spendByMonth(
      [
        makeRecord({ emailId: 'old', occurredAt: Date.UTC(2025, 0, 10) }),
        makeRecord({ emailId: 'new' }),
      ],
      'UTC',
      DEFAULT_MONTHS_BACK,
      NOW
    );

    expect(months).toHaveLength(1);
    expect(months[0]?.month).toBe('2026-09');
  });

  it('returns months oldest first, so the chart reads left to right', () => {
    const months = spendByMonth(
      [
        makeRecord({ emailId: 'sep' }),
        makeRecord({ emailId: 'jul', occurredAt: Date.UTC(2026, 6, 4) }),
        makeRecord({ emailId: 'aug', occurredAt: Date.UTC(2026, 7, 4) }),
      ],
      'UTC',
      DEFAULT_MONTHS_BACK,
      NOW
    );

    expect(months.map((month) => month.month)).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('buckets by the reader zone, not by UTC', () => {
    const records = [makeRecord({ occurredAt: LATE_SEPTEMBER_UTC })];

    expect(spendByMonth(records, 'UTC', DEFAULT_MONTHS_BACK, NOW)[0]?.month).toBe('2026-09');
    expect(spendByMonth(records, 'Asia/Kolkata', DEFAULT_MONTHS_BACK, NOW)[0]?.month).toBe(
      '2026-10'
    );
  });
});

describe('monthlyEquivalent', () => {
  // The point of the number is to make a yearly plan comparable with a
  // monthly one; leaving it at face value flatters the yearly plan twelvefold.
  it('spreads a yearly charge over twelve months', () => {
    expect(monthlyEquivalent(120_000, 'yearly')).toBe(10_000);
    expect(monthlyEquivalent(30_000, 'quarterly')).toBe(10_000);
  });

  it('multiplies a weekly charge up', () => {
    expect(monthlyEquivalent(10_000, 'weekly')).toBe(43_450);
  });

  // An unknown cadence counts as monthly rather than as nothing: leaving it
  // out understates what the reader is paying.
  it('treats an unknown cadence as monthly', () => {
    expect(monthlyEquivalent(1999)).toBe(1999);
  });

  it('is zero when there is no amount', () => {
    expect(monthlyEquivalent(0, 'yearly')).toBe(0);
  });
});

describe('subscriptionsOf', () => {
  it('keeps only recurring kinds', () => {
    const subscriptions = subscriptionsOf([
      makeRecord({ emailId: 'a', kind: 'purchase' }),
      makeRecord({ emailId: 'b', kind: 'subscription', merchantKey: 'netflix.com' }),
      makeRecord({ emailId: 'c', kind: 'trial', merchantKey: 'figma.com' }),
    ]);

    expect(subscriptions.map((row) => row.merchantKey).sort()).toEqual([
      'figma.com',
      'netflix.com',
    ]);
  });

  // A plan that renames itself mid-year must stay one subscription, and the
  // price shown must be the one charged most recently.
  it('groups by merchant key and takes the newest charge', () => {
    const subscriptions = subscriptionsOf([
      makeRecord({
        emailId: 'old',
        kind: 'subscription',
        merchant: 'Netflix',
        merchantKey: 'netflix.com',
        amountMinor: 1499,
        occurredAt: Date.UTC(2026, 7, 20),
      }),
      makeRecord({
        emailId: 'new',
        kind: 'subscription',
        merchant: 'Netflix India',
        merchantKey: 'netflix.com',
        amountMinor: 1999,
        occurredAt: Date.UTC(2026, 8, 20),
      }),
    ]);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.amountMinor).toBe(1999);
    expect(subscriptions[0]?.merchant).toBe('Netflix India');
  });

  // The expensive one is the one worth cancelling, so it goes at the top.
  it('sorts by what each costs per month', () => {
    const subscriptions = subscriptionsOf([
      makeRecord({
        emailId: 'cheap',
        kind: 'subscription',
        merchantKey: 'spotify.com',
        amountMinor: 11_900,
        cadence: 'monthly',
      }),
      makeRecord({
        emailId: 'dear',
        kind: 'subscription',
        merchantKey: 'adobe.com',
        amountMinor: 600_000,
        cadence: 'yearly',
      }),
    ]);

    expect(subscriptions.map((row) => row.merchantKey)).toEqual(['adobe.com', 'spotify.com']);
  });
});

describe('upcomingCharges', () => {
  it('lists charges inside the window, soonest first', () => {
    const upcoming = upcomingCharges(
      [
        makeRecord({
          emailId: 'later',
          merchantKey: 'adobe.com',
          nextChargeAt: NOW + 20 * DAY_MS,
        }),
        makeRecord({
          emailId: 'sooner',
          merchantKey: 'netflix.com',
          nextChargeAt: NOW + 2 * DAY_MS,
        }),
      ],
      NOW,
      60 * DAY_MS
    );

    expect(upcoming.map((charge) => charge.emailId)).toEqual(['sooner', 'later']);
  });

  // A card about money that has already left is one the reader can do
  // nothing with.
  it('excludes a charge that has already happened', () => {
    const upcoming = upcomingCharges([makeRecord({ nextChargeAt: NOW - DAY_MS })], NOW, 60 * DAY_MS);
    expect(upcoming).toEqual([]);
  });

  it('excludes a charge beyond the window', () => {
    const upcoming = upcomingCharges([makeRecord({ nextChargeAt: NOW + 90 * DAY_MS })], NOW, 60 * DAY_MS);
    expect(upcoming).toEqual([]);
  });

  // A trial ending and the renewal that follows it are one event told twice;
  // listing both would show two reminders for one charge.
  it('reports a trial ending instead of its renewal', () => {
    const upcoming = upcomingCharges(
      [
        makeRecord({
          kind: 'trial',
          trialEndsAt: NOW + 3 * DAY_MS,
          nextChargeAt: NOW + 4 * DAY_MS,
        }),
      ],
      NOW,
      60 * DAY_MS
    );

    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.reason).toBe('trial-ends');
    expect(upcoming[0]?.dueAt).toBe(NOW + 3 * DAY_MS);
  });

  // A trial that has already converted is history; the renewal date is the
  // live fact from then on.
  it('falls back to the renewal once the trial is over', () => {
    const upcoming = upcomingCharges(
      [
        makeRecord({
          kind: 'subscription',
          trialEndsAt: NOW - 10 * DAY_MS,
          nextChargeAt: NOW + 4 * DAY_MS,
        }),
      ],
      NOW,
      60 * DAY_MS
    );

    expect(upcoming[0]?.reason).toBe('renewal');
  });

  // Twelve monthly receipts from one merchant must not become twelve cards.
  it('announces a merchant once, from its most recent statement', () => {
    const upcoming = upcomingCharges(
      [
        makeRecord({
          emailId: 'old',
          merchantKey: 'netflix.com',
          occurredAt: Date.UTC(2026, 7, 20),
          nextChargeAt: NOW + 2 * DAY_MS,
        }),
        makeRecord({
          emailId: 'new',
          merchantKey: 'netflix.com',
          occurredAt: Date.UTC(2026, 8, 20),
          nextChargeAt: NOW + 30 * DAY_MS,
        }),
      ],
      NOW,
      60 * DAY_MS
    );

    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.emailId).toBe('new');
  });
});

describe('recurringPerMonth', () => {
  it('sums the monthly equivalents per currency', () => {
    const totals = recurringPerMonth([
      { merchantKey: 'a', merchant: 'A', currency: 'USD', amountMinor: 1000, monthlyEquivalentMinor: 1000, lastChargedAt: NOW, emailId: 'a' },
      { merchantKey: 'b', merchant: 'B', currency: 'USD', amountMinor: 500, monthlyEquivalentMinor: 500, lastChargedAt: NOW, emailId: 'b' },
      { merchantKey: 'c', merchant: 'C', currency: 'INR', amountMinor: 64_900, monthlyEquivalentMinor: 64_900, lastChargedAt: NOW, emailId: 'c' },
    ]);

    expect(totals).toEqual([
      { currency: 'INR', totalMinor: 64_900 },
      { currency: 'USD', totalMinor: 1500 },
    ]);
  });

  // "UNKNOWN 1500" under a heading about monthly cost is worse than silence.
  it('leaves out amounts whose currency was never identified', () => {
    const totals = recurringPerMonth([
      { merchantKey: 'a', merchant: 'A', currency: 'UNKNOWN', amountMinor: 1000, monthlyEquivalentMinor: 1000, lastChargedAt: NOW, emailId: 'a' },
    ]);

    expect(totals).toEqual([]);
  });
});

describe('summarize', () => {
  // The panel is a separate origin that cannot import the formatter, so every
  // string it prints has to arrive finished. A missing label is a blank line.
  it('labels every row it returns', () => {
    const summary = summarize(
      [
        makeRecord({
          kind: 'subscription',
          cadence: 'monthly',
          amountMinor: 64_900,
          currency: 'INR',
          nextChargeAt: NOW + 5 * DAY_MS,
        }),
      ],
      { timeZone: 'Asia/Kolkata', locale: 'en-IN', now: NOW }
    );

    // en-IN abbreviates September as "Sept" — the reader's locale decides,
    // which is exactly why the panel sends one.
    expect(summary.months[0]?.label).toBe('Sept 2026');
    expect(summary.months[0]?.totalLabel).toContain('649.00');
    expect(summary.subscriptions[0]?.amountLabel).toContain('649.00');
    expect(summary.subscriptions[0]?.cadenceLabel).toBe('Monthly');
    expect(summary.subscriptions[0]?.monthlyEquivalentLabel).toContain('649.00');
    expect(summary.subscriptions[0]?.nextChargeLabel).toBeTruthy();
    expect(summary.upcoming[0]?.dueLabel).toBeTruthy();
    expect(summary.recurringPerMonth[0]?.totalLabel).toContain('649.00');
  });

  // A trial names no money, and "₹0.00 due" reads as a bug rather than as a
  // warning that the charge is about to start.
  it('leaves the amount label off a charge with no amount', () => {
    const summary = summarize(
      [makeRecord({ kind: 'trial', amountMinor: 0, currency: 'UNKNOWN', trialEndsAt: NOW + DAY_MS })],
      { timeZone: 'UTC', now: NOW }
    );

    expect(summary.upcoming[0]).not.toHaveProperty('amountLabel');
  });

  it('counts everything it was given, not only what it could bucket', () => {
    const summary = summarize(
      [makeRecord({ emailId: 'a' }), makeRecord({ emailId: 'b', occurredAt: Date.UTC(2020, 0, 1) })],
      { timeZone: 'UTC', now: NOW }
    );

    expect(summary.totalReceipts).toBe(2);
    expect(summary.months).toHaveLength(1);
  });

  it('is empty, not broken, with no receipts at all', () => {
    const summary = summarize([], { timeZone: 'UTC', now: NOW });

    expect(summary).toEqual({
      months: [],
      subscriptions: [],
      upcoming: [],
      recurringPerMonth: [],
      totalReceipts: 0,
    });
  });
});

describe('describeReceipt', () => {
  it('labels the card at the top of the panel', () => {
    const view = describeReceipt(
      makeRecord({
        cadence: 'yearly',
        nextChargeAt: Date.UTC(2027, 8, 20),
        trialEndsAt: Date.UTC(2026, 8, 27),
      }),
      { timeZone: 'UTC', locale: 'en-US' }
    );

    expect(view.amountLabel).toBe('$19.99');
    expect(view.occurredLabel).toBe('Sep 20, 2026');
    expect(view.cadenceLabel).toBe('Yearly');
    expect(view.nextChargeLabel).toBe('Sep 20, 2027');
    expect(view.trialEndsLabel).toBe('Sep 27, 2026');
  });

  // Absent dates must be absent, not "Invalid Date".
  it('omits the labels for dates the receipt never carried', () => {
    const view = describeReceipt(makeRecord(), { timeZone: 'UTC', locale: 'en-US' });

    expect(view).not.toHaveProperty('cadenceLabel');
    expect(view).not.toHaveProperty('nextChargeLabel');
    expect(view).not.toHaveProperty('trialEndsLabel');
  });

  it('renders the date in the reader zone', () => {
    const view = describeReceipt(makeRecord({ occurredAt: LATE_SEPTEMBER_UTC }), {
      timeZone: 'Asia/Kolkata',
      locale: 'en-US',
    });

    expect(view.occurredLabel).toBe('Oct 1, 2026');
  });
});
