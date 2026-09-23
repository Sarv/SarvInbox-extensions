/**
 * Turning one message into one receipt record.
 *
 * This is the only place that knows the shape of an `EmailRecord`; everything
 * below it works on plain strings and numbers, which is what makes the
 * parsing testable without building a fake mailbox.
 */

import type { EmailRecord } from '@sarvinbox/extension-sdk';

import {
  type Cadence,
  detectCadence,
  findNextChargeDate,
  findTrialEndDate,
  projectNextCharge,
} from './billing-cycle';
import { merchantKey, merchantLabel } from './merchant';
import { findTotal } from './money';
import { type ReceiptKind, detectReceipt } from './receipt-detect';

/** One recorded receipt. Persisted as-is, so every field is JSON-safe. */
export interface ReceiptRecord {
  emailId: string;
  accountId?: string;
  /** Stable identity for grouping repeat charges. See `merchant.ts`. */
  merchantKey: string;
  /** What the reader sees. */
  merchant: string;
  kind: ReceiptKind;
  /** Integer minor units; 0 when the mail named no amount (a trial notice). */
  amountMinor: number;
  currency: string;
  /** UTC epoch ms — when the money moved. */
  occurredAt: number;
  subject: string;
  confidence: number;
  cadence?: Cadence;
  /** UTC epoch ms. */
  nextChargeAt?: number;
  /** UTC epoch ms. */
  trialEndsAt?: number;
  orderRef?: string;
}

/**
 * An order or invoice reference, if the mail carries one.
 *
 * Cue-anchored for the same reason the dates are: a receipt is full of long
 * alphanumeric strings — tracking ids, transaction hashes, unsubscribe
 * tokens — and the only thing that makes one of them the order number is the
 * words in front of it.
 */
const ORDER_REF_PATTERN =
  /(?:order|invoice|receipt|transaction|booking|reference|confirmation)\s*(?:#|no\.?|number|id|ref\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,24})/gi;

export function findOrderRef(text: string): string | undefined {
  ORDER_REF_PATTERN.lastIndex = 0;

  // Every cue is tried, not just the first. "Your receipt from Acme" is a cue
  // followed by the word "from", and stopping there would lose the real
  // reference three lines further down — which is most receipts.
  for (
    let match = ORDER_REF_PATTERN.exec(text ?? '');
    match;
    match = ORDER_REF_PATTERN.exec(text ?? '')
  ) {
    const reference = match[1]?.trim();
    // All-letters is a word that happened to follow the cue, not a reference.
    if (reference && /\d/.test(reference)) return reference;
  }

  return undefined;
}

/**
 * When the money moved.
 *
 * `date` and `receivedDate` are stored as epoch SECONDS; everything in this
 * extension works in milliseconds, and mixing the two silently places every
 * receipt in 1970.
 */
export function occurredAtMs(
  email: Pick<EmailRecord, 'date' | 'receivedDate'>,
  fallback: number
): number {
  const seconds = email.receivedDate ?? email.date;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.round(seconds * 1000);
}

export interface ExtractOptions {
  /** UTC epoch ms. Injected so the projection below is testable. */
  now: number;
}

/**
 * Read a receipt out of a message, or return null when it is not one.
 *
 * The subject is searched for money as well as the body: plenty of receipts
 * put the total in the subject line, and on the arrival pass it is the only
 * text there is.
 */
export function extractReceipt(email: EmailRecord, options: ExtractOptions): ReceiptRecord | null {
  const subject = email.subject ?? '';
  const body = email.cleanBody ?? '';
  const text = `${subject}\n${body}`;

  const total = findTotal(text);
  const signals = detectReceipt({ subject, body, hasAmount: total !== null });
  if (!signals) return null;

  const occurredAt = occurredAtMs(email, options.now);
  const cadence = detectCadence(text);
  const trialEndsAt = findTrialEndDate(text);
  const orderRef = findOrderRef(text);

  // Only recurring kinds get a projected date. Projecting one for a one-off
  // purchase would invent a subscription the reader never had, and it would
  // then sit in the upcoming list until they went looking for where it came
  // from.
  const recurring = signals.kind === 'subscription' || signals.kind === 'trial';
  const nextChargeAt = recurring
    ? projectNextCharge(findNextChargeDate(text), occurredAt, cadence, options.now)
    : findNextChargeDate(text);

  return {
    emailId: email.id,
    ...(email.accountId ? { accountId: email.accountId } : {}),
    merchantKey: merchantKey(email.fromAddress ?? ''),
    merchant: merchantLabel(email.fromAddress ?? '', email.fromName),
    kind: signals.kind,
    amountMinor: total?.minor ?? 0,
    currency: total?.currency ?? 'UNKNOWN',
    occurredAt,
    subject: subject.slice(0, 200),
    confidence: signals.confidence,
    ...(cadence ? { cadence } : {}),
    ...(nextChargeAt !== null && nextChargeAt !== undefined ? { nextChargeAt } : {}),
    ...(trialEndsAt !== null ? { trialEndsAt } : {}),
    ...(orderRef ? { orderRef } : {}),
  };
}
