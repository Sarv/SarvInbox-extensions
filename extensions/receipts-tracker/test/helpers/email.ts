/**
 * One message fixture, shared by every test that needs mail.
 *
 * `EmailRecord` has forty fields and the parsers read six of them, so the
 * cast is deliberate: spelling out the rest would make each test read as if
 * those fields mattered.
 */

import type { EmailRecord } from '@sarvinbox/extension-sdk';

/** Epoch SECONDS, the unit the host stores. 2026-09-20T10:00:00Z. */
export const SENT_SECONDS = Math.floor(Date.UTC(2026, 8, 20, 10, 0, 0) / 1000);

/** The same instant in milliseconds, which is what the extension works in. */
export const SENT_MS = SENT_SECONDS * 1000;

export function makeEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'email-1',
    accountId: 'account-1',
    subject: 'Your receipt from Acme',
    cleanBody: 'Thank you for your payment. Total: $19.99',
    fromName: 'Acme Billing',
    fromAddress: 'billing@acme.com',
    date: SENT_SECONDS,
    receivedDate: SENT_SECONDS,
    ...overrides,
  } as unknown as EmailRecord;
}
