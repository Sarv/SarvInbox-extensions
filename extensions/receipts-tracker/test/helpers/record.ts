/**
 * A stored receipt, for tests that start after the parsing.
 *
 * Defaults to the plainest thing the panel can draw: one purchase, in one
 * currency, with no cadence and no projected renewal. Every test that cares
 * about one of those says so in its overrides, which is what makes the
 * interesting field visible at the call site.
 */

import type { ReceiptRecord } from '../../src/extract';

/** 2026-09-20T10:00:00Z, in milliseconds. */
export const OCCURRED_MS = Date.UTC(2026, 8, 20, 10, 0, 0);

export function makeRecord(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    emailId: 'email-1',
    merchantKey: 'acme.com',
    merchant: 'Acme',
    kind: 'purchase',
    amountMinor: 1999,
    currency: 'USD',
    occurredAt: OCCURRED_MS,
    subject: 'Your receipt from Acme',
    confidence: 0.9,
    ...overrides,
  };
}
