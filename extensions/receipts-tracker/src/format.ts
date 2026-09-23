/**
 * Turning minor units back into something a person reads.
 *
 * This lives in the background module rather than in `panel.js` so there is
 * exactly one implementation. The panel cannot import from here — it is a
 * separate origin with no bundler — so the summary carries finished strings
 * and the panel prints them. A second formatter over there would drift, and
 * the first symptom would be a card and a panel quoting different prices for
 * the same subscription.
 */

import type { Cadence } from './billing-cycle';
import { minorUnitExponent } from './money';

/**
 * How a billing cycle reads on screen.
 *
 * A table rather than a case statement so adding a cadence in
 * `billing-cycle.ts` fails to compile until it has been given a word — a
 * missing label would otherwise show up as a blank line in the panel.
 */
const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

export function formatCadence(cadence?: Cadence): string | undefined {
  return cadence ? CADENCE_LABELS[cadence] : undefined;
}

/**
 * Format an amount for display.
 *
 * `Intl.NumberFormat` is given the reader's own locale, so an Indian reader
 * sees `₹1,23,456.78` with lakh grouping and a German one sees `1.234,56 €`,
 * from the same stored integer. Falling back to a plain join when the runtime
 * rejects a locale or currency keeps a bad value from blanking the panel.
 */
export function formatMoney(amountMinor: number, currency: string, locale?: string): string {
  const exponent = minorUnitExponent(currency);
  const major = amountMinor / 10 ** exponent;

  if (currency === 'UNKNOWN') {
    return major.toFixed(exponent);
  }

  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(exponent)}`;
  }
}

/**
 * A month key as a heading — `2026-09` becomes `Sep 2026`.
 *
 * The key is parsed rather than re-derived from a timestamp: it was already
 * bucketed in the reader's zone, and converting it back through a Date would
 * hand the boundary problem back to UTC.
 */
export function formatMonthKey(monthKey: string, locale?: string): string {
  const [year, month] = monthKey.split('-');
  const monthIndex = Number(month) - 1;
  if (!year || Number.isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) return monthKey;

  try {
    const formatter = new Intl.DateTimeFormat(locale || undefined, {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return formatter.format(new Date(Date.UTC(Number(year), monthIndex, 1)));
  } catch {
    return monthKey;
  }
}

/**
 * A stored UTC instant as a date in the reader's zone.
 *
 * Both the zone and the locale come from the panel — the browser is the only
 * thing that knows either, and asking it every time is what makes this work
 * abroad without storing a preference.
 */
export function formatDate(timestamp: number, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone,
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}
