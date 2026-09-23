/**
 * Telling the reader before the money goes, not after.
 *
 * This is the part of the extension that has to earn its permission to
 * interrupt. A card that says "Netflix renewed" is a fact the reader can find
 * later; a card that says "your trial converts to ₹649/month on Friday" is
 * the only thing here that can still change what happens. So notices are
 * limited to charges that have not happened yet, each merchant is announced
 * once per charge, and a date that moves is treated as a new charge because
 * it is one.
 */

import type { ExtensionUINotification } from '@sarvinbox/extension-sdk';

import { formatMoney } from './format';
import type { UpcomingCharge } from './summary';

/** Days before a charge that a card is worth showing. */
export const DEFAULT_LEAD_DAYS = 3;

/** Longest lead worth honouring — past this the card is noise, not warning. */
export const MAX_LEAD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Identity of one announcement.
 *
 * The due date is part of the key on purpose: when a subscription's renewal
 * moves — the reader changed plan, the merchant restated the date — that is a
 * different charge and worth saying again. Keying on the merchant alone would
 * silence the correction.
 */
export function noticeKey(charge: UpcomingCharge): string {
  return `${charge.merchantKey}:${charge.dueAt}`;
}

/** Clamp a configured lead time, ignoring anything unusable. */
export function resolveLeadDays(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return DEFAULT_LEAD_DAYS;
  if (configured < 0) return DEFAULT_LEAD_DAYS;
  return Math.min(Math.round(configured), MAX_LEAD_DAYS);
}

export interface NoticeDecisionOptions {
  now: number;
  leadDays: number;
  /** Keys already announced, from storage. */
  announced: ReadonlySet<string>;
}

/**
 * Which upcoming charges to announce now.
 *
 * Charges already past are excluded rather than reported late: a card about
 * money that has already left is a notification the reader can do nothing
 * with, and it trains them to ignore the ones they can.
 */
export function decideNotices(
  upcoming: readonly UpcomingCharge[],
  options: NoticeDecisionOptions
): UpcomingCharge[] {
  const horizon = options.now + options.leadDays * DAY_MS;

  return upcoming.filter(
    (charge) =>
      charge.dueAt > options.now &&
      charge.dueAt <= horizon &&
      !options.announced.has(noticeKey(charge))
  );
}

/** Whole days from `now` until `dueAt`, rounded up so "today" is never "in 0 days". */
export function daysUntil(dueAt: number, now: number): number {
  return Math.max(1, Math.ceil((dueAt - now) / DAY_MS));
}

/** "tomorrow" / "in 4 days" — the phrasing a card needs. */
export function describeWhen(dueAt: number, now: number): string {
  const days = daysUntil(dueAt, now);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/**
 * The card for one upcoming charge.
 *
 * `expiresAt` is the charge itself: the card is about to stop being useful at
 * exactly the moment the money moves, and the host's countdown says so
 * without the card having to.
 */
export function buildNotice(charge: UpcomingCharge, now: number): ExtensionUINotification {
  const when = describeWhen(charge.dueAt, now);
  const amount = charge.amountMinor > 0 ? formatMoney(charge.amountMinor, charge.currency) : null;

  const title =
    charge.reason === 'trial-ends'
      ? `${charge.merchant} trial ends ${when}`
      : `${charge.merchant} renews ${when}`;

  const body =
    charge.reason === 'trial-ends'
      ? amount
        ? `You will be charged ${amount} unless you cancel.`
        : 'You will start being charged unless you cancel.'
      : amount
        ? `${amount} is due.`
        : 'A renewal is due.';

  return {
    id: `renewal-${charge.merchantKey}-${charge.dueAt}`,
    title,
    body,
    fields: [
      ...(amount ? [{ label: 'Amount', value: amount, emphasis: true }] : []),
      { label: 'Merchant', value: charge.merchant },
    ],
    expiresAt: charge.dueAt,
    emailId: charge.emailId,
  };
}

/**
 * Keep the announcement log from growing without end.
 *
 * Only recent keys can still suppress anything — a charge announced two years
 * ago will never come round again under the same key, because the key carries
 * its date. Newest-first and capped is enough, and it keeps the log small
 * enough that writing it is cheap.
 */
export const MAX_ANNOUNCED = 200;

export function pruneAnnounced(keys: readonly string[], maxKeys = MAX_ANNOUNCED): string[] {
  return keys.slice(-maxKeys);
}

/** Read an announcement log back from storage, ignoring anything malformed. */
export function sanitizeAnnounced(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((key): key is string => typeof key === 'string' && key.length > 0);
}
