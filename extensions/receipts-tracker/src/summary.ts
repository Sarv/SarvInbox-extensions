/**
 * What the panel draws.
 *
 * All of it is computed here rather than in `panel.js` so there is one
 * implementation with tests around it, instead of a second copy in a file
 * that cannot be imported from anywhere. The panel sends its IANA zone and
 * gets back finished rows; its only remaining job is formatting.
 *
 * The zone is the whole reason this function takes an argument. Stored
 * timestamps are UTC, but "what did I spend in September" means September
 * where the reader lives — bucketing in UTC would file a receipt from the
 * evening of 30 September in Mumbai under October, and the reader would be
 * looking at a month total that disagrees with their own memory.
 */

import { type Cadence, cadenceInMonths } from './billing-cycle';
import type { ReceiptRecord } from './extract';
import { formatCadence, formatDate, formatMonthKey, formatMoney } from './format';

/** Spend in one calendar month, in one currency. */
export interface MonthTotal {
  /** `YYYY-MM` in the reader's zone. Sorts lexically, which is why it is a string. */
  month: string;
  currency: string;
  totalMinor: number;
  count: number;
  /** Filled by `summarize`. See the note in `format.ts`. */
  label?: string;
  totalLabel?: string;
}

/** A merchant that charges repeatedly. */
export interface SubscriptionSummary {
  merchantKey: string;
  merchant: string;
  currency: string;
  /** The most recent amount charged. */
  amountMinor: number;
  cadence?: Cadence;
  /** Amount normalised to one month, for comparing a yearly plan with a monthly one. */
  monthlyEquivalentMinor: number;
  /** UTC epoch ms. */
  nextChargeAt?: number;
  lastChargedAt: number;
  emailId: string;
  amountLabel?: string;
  monthlyEquivalentLabel?: string;
  nextChargeLabel?: string;
  cadenceLabel?: string;
}

/** Something about to be charged. */
export interface UpcomingCharge {
  emailId: string;
  merchantKey: string;
  merchant: string;
  currency: string;
  amountMinor: number;
  /** UTC epoch ms. */
  dueAt: number;
  /** A trial converting is worth saying differently from a renewal. */
  reason: 'renewal' | 'trial-ends';
  amountLabel?: string;
  dueLabel?: string;
}

/** Everything the panel needs in one round trip. */
export interface ReceiptSummary {
  months: MonthTotal[];
  subscriptions: SubscriptionSummary[];
  upcoming: UpcomingCharge[];
  /** Monthly-equivalent subscription cost, per currency. */
  recurringPerMonth: Array<{ currency: string; totalMinor: number; totalLabel?: string }>;
  totalReceipts: number;
}

/**
 * `YYYY-MM` for a timestamp, in `timeZone`.
 *
 * Built from `formatToParts` rather than a formatted string because the
 * arrangement of a formatted date is a locale's business and could change;
 * the parts are named, so reading them is stable.
 *
 * An unusable zone falls back to UTC rather than throwing. A panel reporting
 * a zone the runtime does not know is a bad reason to show the reader an
 * empty page.
 */
export function monthKeyIn(timeZone: string, timestamp: number): string {
  const parts = monthFormatter(timeZone).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  return `${year}-${month}`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function monthFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit' });
  }

  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Spend per month and currency.
 *
 * Refunds subtract. A month where a large order came back would otherwise
 * read as the most expensive of the year, which is the opposite of what
 * happened. The total is floored at zero per month and currency: a refund for
 * a purchase made before the window would otherwise push a month negative and
 * draw a bar going the wrong way.
 */
export function spendByMonth(
  records: ReceiptRecord[],
  timeZone: string,
  monthsBack: number,
  now: number
): MonthTotal[] {
  const earliest = monthsAgoKey(timeZone, now, monthsBack);
  const buckets = new Map<string, MonthTotal>();

  for (const record of records) {
    if (record.kind === 'trial' || record.amountMinor <= 0) continue;

    const month = monthKeyIn(timeZone, record.occurredAt);
    if (month < earliest) continue;

    const key = `${month}|${record.currency}`;
    const bucket = buckets.get(key) ?? { month, currency: record.currency, totalMinor: 0, count: 0 };
    const signed = record.kind === 'refund' ? -record.amountMinor : record.amountMinor;

    buckets.set(key, {
      ...bucket,
      totalMinor: bucket.totalMinor + signed,
      count: bucket.count + 1,
    });
  }

  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, totalMinor: Math.max(0, bucket.totalMinor) }))
    .sort((left, right) => (left.month === right.month
      ? right.totalMinor - left.totalMinor
      : left.month.localeCompare(right.month)));
}

/** The `YYYY-MM` key `monthsBack` months before `now`, in `timeZone`. */
export function monthsAgoKey(timeZone: string, now: number, monthsBack: number): string {
  const current = monthKeyIn(timeZone, now);
  const [yearPart, monthPart] = current.split('-');
  const totalMonths = Number(yearPart) * 12 + (Number(monthPart) - 1) - monthsBack;
  const year = Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * One row per recurring merchant, newest charge winning.
 *
 * Grouped by `merchantKey` rather than by display name, so a plan that
 * renames itself mid-year stays one subscription. A refund is never the
 * defining record for a subscription — it would report the price as the
 * amount that came back.
 */
export function subscriptionsOf(records: ReceiptRecord[]): SubscriptionSummary[] {
  const latest = new Map<string, ReceiptRecord>();

  for (const record of records) {
    if (record.kind !== 'subscription' && record.kind !== 'trial') continue;

    const existing = latest.get(record.merchantKey);
    if (!existing || record.occurredAt > existing.occurredAt) latest.set(record.merchantKey, record);
  }

  return [...latest.values()]
    .map((record) => ({
      merchantKey: record.merchantKey,
      merchant: record.merchant,
      currency: record.currency,
      amountMinor: record.amountMinor,
      ...(record.cadence ? { cadence: record.cadence } : {}),
      monthlyEquivalentMinor: monthlyEquivalent(record.amountMinor, record.cadence),
      ...(record.nextChargeAt ? { nextChargeAt: record.nextChargeAt } : {}),
      lastChargedAt: record.occurredAt,
      emailId: record.emailId,
    }))
    .sort((left, right) => right.monthlyEquivalentMinor - left.monthlyEquivalentMinor);
}

/**
 * What one charge costs per month.
 *
 * An unknown cadence is treated as monthly. The alternative — leaving it out
 * of the recurring total — understates what the reader is paying, and the
 * point of the number is to be a little uncomfortable rather than reassuring.
 */
export function monthlyEquivalent(amountMinor: number, cadence?: Cadence): number {
  if (amountMinor <= 0) return 0;
  return Math.round(amountMinor / cadenceInMonths(cadence ?? 'monthly'));
}

/**
 * Charges due within `withinMs`, soonest first.
 *
 * A trial ending is reported instead of, not as well as, that record's
 * renewal date: they are the same event told twice, and listing both would
 * show the reader two reminders for one charge.
 */
export function upcomingCharges(
  records: ReceiptRecord[],
  now: number,
  withinMs: number
): UpcomingCharge[] {
  const horizon = now + withinMs;
  const seen = new Set<string>();
  const upcoming: UpcomingCharge[] = [];

  // Newest first, so the most recent statement about a merchant is the one
  // that claims the slot.
  for (const record of [...records].sort((left, right) => right.occurredAt - left.occurredAt)) {
    if (seen.has(record.merchantKey)) continue;

    const trialEnd = record.trialEndsAt;
    const dueAt = trialEnd && trialEnd > now ? trialEnd : record.nextChargeAt;
    if (!dueAt || dueAt <= now || dueAt > horizon) continue;

    seen.add(record.merchantKey);
    upcoming.push({
      emailId: record.emailId,
      merchantKey: record.merchantKey,
      merchant: record.merchant,
      currency: record.currency,
      amountMinor: record.amountMinor,
      dueAt,
      reason: trialEnd && trialEnd > now ? 'trial-ends' : 'renewal',
    });
  }

  return upcoming.sort((left, right) => left.dueAt - right.dueAt);
}

/** Monthly-equivalent recurring spend, per currency. */
export function recurringPerMonth(
  subscriptions: SubscriptionSummary[]
): Array<{ currency: string; totalMinor: number }> {
  const totals = new Map<string, number>();

  for (const subscription of subscriptions) {
    if (subscription.currency === 'UNKNOWN') continue;
    totals.set(
      subscription.currency,
      (totals.get(subscription.currency) ?? 0) + subscription.monthlyEquivalentMinor
    );
  }

  return [...totals.entries()]
    .map(([currency, totalMinor]) => ({ currency, totalMinor }))
    .sort((left, right) => right.totalMinor - left.totalMinor);
}

export interface SummaryOptions {
  /** IANA zone from the panel, e.g. `Asia/Kolkata`. */
  timeZone: string;
  /** UTC epoch ms. */
  now: number;
  /** BCP 47 tag from the panel, e.g. `en-IN`. */
  locale?: string;
  monthsBack?: number;
  upcomingWithinMs?: number;
}

export const DEFAULT_MONTHS_BACK = 5;
export const DEFAULT_UPCOMING_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Everything the panel needs, in one pass over the records.
 *
 * Labelling happens here rather than inside each aggregation so those stay
 * pure arithmetic with nothing to mock, and every string the reader sees is
 * produced in one place.
 */
export function summarize(records: ReceiptRecord[], options: SummaryOptions): ReceiptSummary {
  const { timeZone, locale, now } = options;
  const subscriptions = subscriptionsOf(records);

  return {
    months: spendByMonth(records, timeZone, options.monthsBack ?? DEFAULT_MONTHS_BACK, now).map(
      (month) => ({
        ...month,
        label: formatMonthKey(month.month, locale),
        totalLabel: formatMoney(month.totalMinor, month.currency, locale),
      })
    ),

    subscriptions: subscriptions.map((subscription) => ({
      ...subscription,
      amountLabel: formatMoney(subscription.amountMinor, subscription.currency, locale),
      ...(formatCadence(subscription.cadence)
        ? { cadenceLabel: formatCadence(subscription.cadence) }
        : {}),
      monthlyEquivalentLabel: formatMoney(
        subscription.monthlyEquivalentMinor,
        subscription.currency,
        locale
      ),
      ...(subscription.nextChargeAt
        ? { nextChargeLabel: formatDate(subscription.nextChargeAt, timeZone, locale) }
        : {}),
    })),

    upcoming: upcomingCharges(
      records,
      now,
      options.upcomingWithinMs ?? DEFAULT_UPCOMING_WINDOW_MS
    ).map((charge) => ({
      ...charge,
      ...(charge.amountMinor > 0
        ? { amountLabel: formatMoney(charge.amountMinor, charge.currency, locale) }
        : {}),
      dueLabel: formatDate(charge.dueAt, timeZone, locale),
    })),

    recurringPerMonth: recurringPerMonth(subscriptions).map((total) => ({
      ...total,
      totalLabel: formatMoney(total.totalMinor, total.currency, locale),
    })),

    totalReceipts: records.length,
  };
}

/**
 * One stored receipt, labelled for the card at the top of the panel.
 *
 * The panel asks for this separately from the summary because it answers a
 * different question — "what is THIS message" rather than "what have I been
 * spending" — and because it has to change every time the reader moves to
 * another message, while the summary does not.
 */
export interface ReceiptView extends ReceiptRecord {
  amountLabel: string;
  occurredLabel: string;
  cadenceLabel?: string;
  nextChargeLabel?: string;
  trialEndsLabel?: string;
}

export function describeReceipt(
  record: ReceiptRecord,
  options: Pick<SummaryOptions, 'timeZone' | 'locale'>
): ReceiptView {
  const { timeZone, locale } = options;

  return {
    ...record,
    amountLabel: formatMoney(record.amountMinor, record.currency, locale),
    occurredLabel: formatDate(record.occurredAt, timeZone, locale),
    ...(formatCadence(record.cadence) ? { cadenceLabel: formatCadence(record.cadence) } : {}),
    ...(record.nextChargeAt
      ? { nextChargeLabel: formatDate(record.nextChargeAt, timeZone, locale) }
      : {}),
    ...(record.trialEndsAt
      ? { trialEndsLabel: formatDate(record.trialEndsAt, timeZone, locale) }
      : {}),
  };
}
