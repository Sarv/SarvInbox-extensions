import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEAD_DAYS,
  MAX_ANNOUNCED,
  MAX_LEAD_DAYS,
  buildNotice,
  daysUntil,
  decideNotices,
  describeWhen,
  noticeKey,
  pruneAnnounced,
  resolveLeadDays,
  sanitizeAnnounced,
} from '../../src/renewal-notice';
import type { UpcomingCharge } from '../../src/summary';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function makeCharge(overrides: Partial<UpcomingCharge> = {}): UpcomingCharge {
  return {
    emailId: 'email-1',
    merchantKey: 'netflix.com',
    merchant: 'Netflix',
    currency: 'INR',
    amountMinor: 64_900,
    dueAt: NOW + 2 * DAY_MS,
    reason: 'renewal',
    ...overrides,
  };
}

describe('noticeKey', () => {
  // The date is part of the key on purpose: a renewal that moves is a
  // different charge and worth saying again. Keying on the merchant alone
  // would silence the correction.
  it('changes when the due date moves', () => {
    const first = noticeKey(makeCharge());
    const moved = noticeKey(makeCharge({ dueAt: NOW + 9 * DAY_MS }));

    expect(first).not.toBe(moved);
  });

  it('is the same for the same charge seen twice', () => {
    expect(noticeKey(makeCharge())).toBe(noticeKey(makeCharge({ emailId: 'other' })));
  });
});

describe('resolveLeadDays', () => {
  it('takes a configured number', () => {
    expect(resolveLeadDays(7)).toBe(7);
  });

  it('rounds a fractional setting', () => {
    expect(resolveLeadDays(2.6)).toBe(3);
  });

  // Past a month the card stops being a warning and becomes noise the reader
  // learns to dismiss.
  it('caps an over-long lead', () => {
    expect(resolveLeadDays(400)).toBe(MAX_LEAD_DAYS);
  });

  it('falls back for anything unusable', () => {
    expect(resolveLeadDays(undefined)).toBe(DEFAULT_LEAD_DAYS);
    expect(resolveLeadDays('soon')).toBe(DEFAULT_LEAD_DAYS);
    expect(resolveLeadDays(Number.NaN)).toBe(DEFAULT_LEAD_DAYS);
    expect(resolveLeadDays(-3)).toBe(DEFAULT_LEAD_DAYS);
  });

  // Zero is a real choice — announce only what is due today — not a missing
  // value to be replaced by the default.
  it('honours a lead of zero', () => {
    expect(resolveLeadDays(0)).toBe(0);
  });
});

describe('decideNotices', () => {
  const options = { now: NOW, leadDays: 3, announced: new Set<string>() };

  it('announces a charge inside the lead window', () => {
    expect(decideNotices([makeCharge()], options)).toHaveLength(1);
  });

  it('says nothing about a charge further out than the lead', () => {
    expect(decideNotices([makeCharge({ dueAt: NOW + 10 * DAY_MS })], options)).toEqual([]);
  });

  // Money that has already gone is not something a notification can help
  // with, and cards the reader cannot act on train them to ignore the ones
  // they can.
  it('says nothing about a charge that already happened', () => {
    expect(decideNotices([makeCharge({ dueAt: NOW - DAY_MS })], options)).toEqual([]);
  });

  // The sweep runs on every sync; without the log the same card would be
  // raised again every few minutes.
  it('skips a charge already announced', () => {
    const charge = makeCharge();
    const announced = new Set([noticeKey(charge)]);

    expect(decideNotices([charge], { ...options, announced })).toEqual([]);
  });

  it('announces again once the date has moved', () => {
    const announced = new Set([noticeKey(makeCharge())]);
    const moved = makeCharge({ dueAt: NOW + DAY_MS });

    expect(decideNotices([moved], { ...options, announced })).toHaveLength(1);
  });
});

describe('describeWhen', () => {
  // "in 0 days" is not a sentence anybody writes.
  it('never says zero days', () => {
    expect(daysUntil(NOW + 60 * 1000, NOW)).toBe(1);
    expect(describeWhen(NOW + 60 * 1000, NOW)).toBe('tomorrow');
  });

  it('counts whole days ahead', () => {
    expect(describeWhen(NOW + 4 * DAY_MS, NOW)).toBe('in 4 days');
  });
});

describe('buildNotice', () => {
  it('says what renews, when, and for how much', () => {
    const notice = buildNotice(makeCharge({ dueAt: NOW + 2 * DAY_MS }), NOW);

    expect(notice.title).toBe('Netflix renews in 2 days');
    expect(notice.body).toContain('649.00');
    expect(notice.fields?.[0]).toMatchObject({ label: 'Amount', emphasis: true });
  });

  // A trial converting is the one moment a mail client can still save
  // someone money, so it must not read like an ordinary renewal.
  it('tells a trial apart from a renewal', () => {
    const notice = buildNotice(makeCharge({ reason: 'trial-ends' }), NOW);

    expect(notice.title).toContain('trial ends');
    expect(notice.body).toContain('unless you cancel');
  });

  // A trial notice often names no money at all; "0.00 is due" reads as a bug.
  it('drops the amount when the mail named none', () => {
    const notice = buildNotice(makeCharge({ amountMinor: 0, reason: 'trial-ends' }), NOW);

    expect(notice.body).toBe('You will start being charged unless you cancel.');
    expect(notice.fields?.map((field) => field.label)).toEqual(['Merchant']);
  });

  it('drops the amount on a renewal with no total', () => {
    expect(buildNotice(makeCharge({ amountMinor: 0 }), NOW).body).toBe('A renewal is due.');
  });

  // The card stops being useful at exactly the moment the money moves, and
  // the host's countdown says so without the card having to.
  it('expires when the charge lands', () => {
    const charge = makeCharge();
    expect(buildNotice(charge, NOW).expiresAt).toBe(charge.dueAt);
  });

  // The card is the reader's way back to the mail it came from.
  it('carries the message it came from', () => {
    expect(buildNotice(makeCharge(), NOW).emailId).toBe('email-1');
  });

  // Two merchants due the same day must not collide onto one card.
  it('gives each charge its own id', () => {
    const netflix = buildNotice(makeCharge(), NOW);
    const adobe = buildNotice(makeCharge({ merchantKey: 'adobe.com' }), NOW);

    expect(netflix.id).not.toBe(adobe.id);
  });
});

describe('the announcement log', () => {
  // Only recent keys can still suppress anything — a key carries its date, so
  // an old one can never match again — and an unbounded log is written to
  // disk on every sweep.
  it('keeps the newest keys and drops the rest', () => {
    const keys = Array.from({ length: 10 }, (_unused, index) => `k${index}`);

    expect(pruneAnnounced(keys, 3)).toEqual(['k7', 'k8', 'k9']);
  });

  it('leaves a short log alone', () => {
    expect(pruneAnnounced(['a', 'b'])).toEqual(['a', 'b']);
    expect(MAX_ANNOUNCED).toBeGreaterThan(2);
  });

  // A hand-edited or truncated file must not make every charge announce
  // twice, nor crash the sweep building a Set from it.
  it('reads a ruined log as an empty one', () => {
    expect(sanitizeAnnounced(undefined)).toEqual([]);
    expect(sanitizeAnnounced('netflix.com:123')).toEqual([]);
    expect(sanitizeAnnounced([1, null, '', 'netflix.com:123'])).toEqual(['netflix.com:123']);
  });
});
