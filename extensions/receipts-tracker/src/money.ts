/**
 * Finding the amount a receipt is actually about.
 *
 * Two problems, kept apart because they fail differently. Reading one amount
 * out of a string is a parsing problem with a right answer. Deciding WHICH of
 * the eleven amounts in a receipt is the total is a judgement, and the wrong
 * judgement quietly reports a shipping charge as the price of the order.
 *
 * Money is carried as an integer count of minor units — paise, cents — and
 * never as a float. A mailbox of two hundred receipts summed as floats drifts
 * by a visible fraction of a rupee, and a spend total that disagrees with the
 * sum of its own rows by a penny reads as a bug in everything else too.
 */

/** A currency's minor-unit exponent, where it is not 2. */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

/** Symbols we can map to a currency with no other evidence. */
const SYMBOL_CURRENCIES: ReadonlyArray<readonly [string, string]> = [
  ['₹', 'INR'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₩', 'KRW'],
  ['₽', 'RUB'],
  ['R$', 'BRL'],
  ['A$', 'AUD'],
  ['C$', 'CAD'],
  ['S$', 'SGD'],
  ['HK$', 'HKD'],
  ['₺', 'TRY'],
  ['₦', 'NGN'],
  ['﷼', 'SAR'],
  ['د.إ', 'AED'],
];

/**
 * Written currency names that appear instead of a symbol.
 *
 * `Rs` and `Rs.` matter far more than their length suggests: Indian receipts
 * use them at least as often as `₹`, and a tracker that silently skips them
 * looks broken to exactly the users it was built for.
 */
const WORD_CURRENCIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^rs\.?$/i, 'INR'],
  [/^inr$/i, 'INR'],
  [/^usd$/i, 'USD'],
  [/^eur$/i, 'EUR'],
  [/^gbp$/i, 'GBP'],
  [/^aed$/i, 'AED'],
  [/^sgd$/i, 'SGD'],
  [/^aud$/i, 'AUD'],
  [/^cad$/i, 'CAD'],
  [/^jpy$/i, 'JPY'],
  [/^chf$/i, 'CHF'],
  [/^sar$/i, 'SAR'],
];

/** One amount, as found in the text. */
export interface ParsedAmount {
  /** Integer minor units. See the note at the top of this file. */
  minor: number;
  /** ISO 4217 code. */
  currency: string;
  /** Offset of the match in the source text, so cues before it can be read. */
  index: number;
}

/** Minor units per major unit for `currency`. */
export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Read a digit group as a number.
 *
 * The hard case is that `,` and `.` swap roles between locales, so the same
 * eight characters are two different numbers depending on who wrote them.
 * When both appear, whichever comes LAST is the decimal point — that holds for
 * `1,234.56`, for `1.234,56`, and for Indian grouping (`1,23,456.78`) alike,
 * with no locale to guess at.
 *
 * With only one separator there is no such evidence, so the digit count
 * decides: three digits after it is a thousands group, one or two is a decimal
 * fraction. That reads `$1,500` as fifteen hundred and `€1,50` as one-fifty,
 * which is right in both cases. It is wrong for a price genuinely written
 * `1.999` in a comma-decimal locale, which is a real but rare loss taken
 * knowingly — the alternative guesses a locale we have no evidence for.
 */
/**
 * Whether a whole part's separators are plausible thousands grouping.
 *
 * Without this, `1.2.3` reads as twelve-thirty: the last separator is taken
 * as the decimal point and the rest are stripped as grouping, however absurd
 * the groups are. Version numbers, IP fragments and dates all arrive in that
 * shape, and each one recorded as a receipt for a price nobody paid.
 *
 * The LAST group is always 3 digits — that holds for Western grouping
 * (`1,234,567`) and Indian alike (`1,23,456`), and it is what separates real
 * money from a dotted quad such as `10.20.30`. Middle groups are 3, or 2 for
 * Indian grouping. The first group is whatever is left over, 1 to 3 digits.
 */
function isGrouped(whole: string): boolean {
  const groups = whole.split(/[.,]/);
  if (groups.length === 1) return true;

  const [first, ...rest] = groups;
  if (!first || first.length < 1 || first.length > 3) return false;
  if (rest[rest.length - 1]?.length !== 3) return false;
  return rest.every((group) => group.length === 3 || group.length === 2);
}

export function parseAmountDigits(raw: string, exponent = 2): number | null {
  const cleaned = raw.replace(/\s| /g, '');
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let decimalAt = -1;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalAt = Math.max(lastComma, lastDot);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const only = Math.max(lastComma, lastDot);
    const digitsAfter = cleaned.length - only - 1;
    if (digitsAfter === 1 || digitsAfter === 2) decimalAt = only;
    else if (digitsAfter !== 3) return null;
  }

  const whole = decimalAt >= 0 ? cleaned.slice(0, decimalAt) : cleaned;
  const fraction = decimalAt >= 0 ? cleaned.slice(decimalAt + 1) : '';

  const wholeDigits = whole.replace(/[.,]/g, '');
  if (!wholeDigits || /[.,]/.test(fraction)) return null;
  if (!isGrouped(whole)) return null;

  // Built in minor units directly rather than multiplying a float by 100,
  // which turns 19.99 into 1998.9999999999998 and then, rounded, into a
  // number that is right only because rounding hid the error.
  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);
  const minor = Number(wholeDigits + padded);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Currency for a symbol or word, or null when it is neither. */
export function currencyFor(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  for (const [symbol, code] of SYMBOL_CURRENCIES) {
    if (trimmed === symbol) return code;
  }
  for (const [pattern, code] of WORD_CURRENCIES) {
    if (pattern.test(trimmed)) return code;
  }
  return null;
}

/**
 * Matches a currency marker attached to a number, on either side.
 *
 * Both orders are real — `$12.00` and `12.00 USD` — and so is the trailing
 * `/-` that Indian receipts use as a full stop for money.
 */
const AMOUNT_PATTERN =
  /(R\$|A\$|C\$|S\$|HK\$|[₹$€£¥₩₽₺₦﷼]|د\.إ|\b(?:Rs\.?|INR|USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF|SAR)\b)\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(R\$|A\$|C\$|S\$|HK\$|[₹$€£¥₩₽₺₦﷼]|\b(?:Rs\.?|INR|USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF|SAR)\b)/g;

/**
 * Every amount in `text`, in the order they appear.
 *
 * Only amounts carrying a currency are returned. A bare number in a receipt is
 * far more often an order id, a quantity or a house number than it is money,
 * and admitting those poisons the total-picking below with candidates that
 * were never prices at all.
 */
export function findAmounts(text: string): ParsedAmount[] {
  if (!text) return [];

  const found: ParsedAmount[] = [];
  AMOUNT_PATTERN.lastIndex = 0;

  for (let match = AMOUNT_PATTERN.exec(text); match; match = AMOUNT_PATTERN.exec(text)) {
    const marker = match[1] ?? match[4];
    const digits = match[2] ?? match[3];
    const currency = marker ? currencyFor(marker) : null;
    if (!currency || !digits) continue;

    const minor = parseAmountDigits(digits, minorUnitExponent(currency));
    if (minor === null) continue;

    found.push({ minor, currency, index: match.index });
  }

  return found;
}

/**
 * Phrases that tell us what an amount next to them means.
 *
 * Negative weights matter more than positive ones. Every receipt has a
 * subtotal, a tax line and a shipping line sitting right beside the total, and
 * without pushing those down the largest-value fallback will happily report
 * the tax on a large order as the price of a small one.
 */
const TOTAL_CUES: ReadonlyArray<readonly [RegExp, number]> = [
  [/grand\s+total/i, 6],
  [/order\s+total/i, 6],
  [/total\s+amount/i, 6],
  [/amount\s+pa(?:id|yable)/i, 6],
  [/total\s+paid/i, 6],
  [/net\s+payable/i, 6],
  [/you\s+paid/i, 5],
  [/amount\s+charged/i, 5],
  [/total\s+due/i, 5],
  [/amount\s+due/i, 4],
  [/\btotal\b/i, 3],
  [/\bcharged\b/i, 3],
  [/\bbilled\b/i, 3],
  [/\bpayment\b/i, 2],
  [/sub\s*total/i, -4],
  [/\btax\b|\bgst\b|\bvat\b/i, -4],
  [/shipping|delivery\s+charge/i, -4],
  [/discount|you\s+saved|savings/i, -6],
  [/wallet|balance|credit\s+limit/i, -6],
];

/** How far back from an amount a cue is still taken to be about it. */
const CUE_WINDOW = 48;

/** Score one amount by the words immediately before it. */
export function scoreAmount(text: string, amount: ParsedAmount): number {
  const from = Math.max(0, amount.index - CUE_WINDOW);
  const window = text.slice(from, amount.index);

  return TOTAL_CUES.reduce(
    (score, [pattern, weight]) => (pattern.test(window) ? score + weight : score),
    0
  );
}

/**
 * The amount a receipt is about, or null when nothing in it looks like money.
 *
 * Ties break towards the larger amount: where two lines are equally well
 * labelled, a receipt's total is never the smaller of them.
 */
export function findTotal(text: string): ParsedAmount | null {
  const amounts = findAmounts(text);
  if (amounts.length === 0) return null;
  if (amounts.length === 1) return amounts[0] ?? null;

  const dominant = dominantCurrency(amounts);
  const candidates = amounts.filter((amount) => amount.currency === dominant);

  let best = candidates[0] ?? null;
  let bestScore = best ? scoreAmount(text, best) : 0;

  for (const amount of candidates.slice(1)) {
    const score = scoreAmount(text, amount);
    if (score > bestScore || (score === bestScore && best !== null && amount.minor > best.minor)) {
      best = amount;
      bestScore = score;
    }
  }

  return best;
}

/**
 * The currency most of the amounts are in.
 *
 * A receipt that quotes a converted price, or carries a footer in the seller's
 * own currency, would otherwise let one stray amount decide the total.
 */
export function dominantCurrency(amounts: ParsedAmount[]): string | null {
  const counts = new Map<string, number>();
  for (const amount of amounts) {
    counts.set(amount.currency, (counts.get(amount.currency) ?? 0) + 1);
  }

  let winner: string | null = null;
  let best = 0;
  for (const [currency, count] of counts) {
    if (count > best) {
      winner = currency;
      best = count;
    }
  }
  return winner;
}
