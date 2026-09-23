import { describe, expect, it } from 'vitest';

import { extractReceipt, findOrderRef, occurredAtMs } from '../../src/extract';
import { SENT_MS, SENT_SECONDS, makeEmail } from '../helpers/email';

/** A fixed "now", so a projected renewal is the same date on every run. */
const NOW = Date.UTC(2026, 8, 21, 0, 0, 0);

describe('occurredAtMs', () => {
  // The host stores seconds and this extension works in milliseconds. Mixing
  // them files every receipt in January 1970, where no month bucket finds it.
  it('converts stored seconds to milliseconds', () => {
    expect(occurredAtMs({ date: SENT_SECONDS, receivedDate: null }, NOW)).toBe(SENT_MS);
  });

  it('prefers the received date over the sent date', () => {
    const later = SENT_SECONDS + 3600;
    expect(occurredAtMs({ date: SENT_SECONDS, receivedDate: later }, NOW)).toBe(later * 1000);
  });

  // A missing or zero timestamp must not become 1970: the receipt would fall
  // outside every month window and quietly vanish from the panel.
  it('falls back to now when there is no usable timestamp', () => {
    expect(occurredAtMs({ date: 0, receivedDate: null }, NOW)).toBe(NOW);
    expect(occurredAtMs({ date: Number.NaN, receivedDate: null }, NOW)).toBe(NOW);
  });
});

describe('findOrderRef', () => {
  it('reads the reference that follows a cue', () => {
    expect(findOrderRef('Order #A12-3456 has shipped')).toBe('A12-3456');
    expect(findOrderRef('Invoice number: INV2026-0044')).toBe('INV2026-0044');
  });

  // Without this guard "Order confirmation" reports the word "confirmation"
  // as the order number on every confirmation mail ever sent.
  it('refuses a run of letters that merely followed the cue', () => {
    expect(findOrderRef('Order confirmation for your purchase')).toBeUndefined();
  });

  // The subject "Your receipt from Acme" is itself a cue followed by the word
  // "from". Stopping at the first cue lost the real reference below it, which
  // is where almost every receipt puts it.
  it('keeps looking past a cue that captured a word', () => {
    expect(findOrderRef('Your receipt from Acme\nTotal: $19.99\nOrder #AC-90210')).toBe(
      'AC-90210'
    );
  });

  it('returns undefined when no cue is present', () => {
    expect(findOrderRef('Thank you for your payment of $10.00')).toBeUndefined();
  });
});

describe('extractReceipt', () => {
  it('returns null for mail that is not a receipt', () => {
    const email = makeEmail({
      subject: 'Lunch tomorrow?',
      cleanBody: 'Are you free around one?',
    });
    expect(extractReceipt(email, { now: NOW })).toBeNull();
  });

  it('records what a purchase cost, and who charged it', () => {
    const email = makeEmail({
      subject: 'Your receipt from Acme',
      cleanBody: 'Thank you for your payment.\nTotal: $19.99\nOrder #AC-90210',
    });

    const record = extractReceipt(email, { now: NOW });

    expect(record).toMatchObject({
      emailId: 'email-1',
      accountId: 'account-1',
      merchantKey: 'acme.com',
      merchant: 'Acme',
      kind: 'purchase',
      amountMinor: 1999,
      currency: 'USD',
      occurredAt: SENT_MS,
      orderRef: 'AC-90210',
    });
  });

  // Projecting a renewal for a one-off order would invent a subscription the
  // reader never had, and it would then sit in the upcoming list.
  it('gives a one-off purchase no next charge', () => {
    const email = makeEmail({
      subject: 'Your receipt from Acme',
      cleanBody: 'Thank you for your payment. Total: $19.99',
    });

    expect(extractReceipt(email, { now: NOW })?.nextChargeAt).toBeUndefined();
  });

  it('reads a renewal date stated in the mail', () => {
    const email = makeEmail({
      fromAddress: 'info@netflix.com',
      fromName: 'Netflix',
      subject: 'Your Netflix subscription has renewed',
      cleanBody:
        'We charged your card 15.49 USD for your monthly plan.\nNext billing date: October 20, 2026',
    });

    const record = extractReceipt(email, { now: NOW });

    expect(record?.kind).toBe('subscription');
    expect(record?.cadence).toBe('monthly');
    expect(record?.nextChargeAt).toBe(Date.UTC(2026, 9, 20));
  });

  // A renewal mail that states a cadence but no date is still worth a
  // projection: it is the only way a yearly plan bought in January shows up
  // in the upcoming list next January.
  it('projects a renewal from the cadence when the mail states no date', () => {
    const email = makeEmail({
      fromAddress: 'billing@spotify.com',
      fromName: 'Spotify',
      subject: 'Your monthly subscription payment',
      cleanBody: 'Your subscription renewed. We charged 119.00 INR for this month.',
    });

    const record = extractReceipt(email, { now: NOW });

    expect(record?.kind).toBe('subscription');
    // One cycle on from the receipt itself, time of day and all.
    expect(record?.nextChargeAt).toBe(Date.UTC(2026, 9, 20, 10, 0, 0));
  });

  // A trial notice names no money at all. Dropping it would lose the one
  // warning in the whole extension that can still change what happens.
  it('records a trial with no amount', () => {
    const email = makeEmail({
      fromAddress: 'hello@figma.com',
      fromName: 'Figma',
      subject: 'Your free trial ends soon',
      cleanBody: 'Your free trial ends on 30 September 2026 and your plan begins.',
    });

    const record = extractReceipt(email, { now: NOW });

    expect(record?.kind).toBe('trial');
    expect(record?.amountMinor).toBe(0);
    expect(record?.currency).toBe('UNKNOWN');
    expect(record?.trialEndsAt).toBe(Date.UTC(2026, 8, 30));
  });

  // On the arrival pass the subject is the only text there is, and plenty of
  // receipts put the total in it.
  it('finds a total in the subject when there is no body yet', () => {
    const email = makeEmail({
      subject: 'Payment received: $42.50',
      cleanBody: '',
    });

    expect(extractReceipt(email, { now: NOW })?.amountMinor).toBe(4250);
  });

  // Subjects are attacker-supplied text that ends up in storage and in the
  // panel; an unbounded one would bloat the table it is written into.
  it('caps the stored subject', () => {
    const email = makeEmail({
      subject: `Payment received $5.00 ${'x'.repeat(400)}`,
      cleanBody: 'Thank you for your payment.',
    });

    expect(extractReceipt(email, { now: NOW })?.subject).toHaveLength(200);
  });

  it('leaves accountId out when the message has none', () => {
    const email = makeEmail({ accountId: undefined });
    expect(extractReceipt(email, { now: NOW })).not.toHaveProperty('accountId');
  });
});
