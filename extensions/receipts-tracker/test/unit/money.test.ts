import { describe, expect, it } from 'vitest';

import {
  currencyFor,
  dominantCurrency,
  findAmounts,
  findTotal,
  minorUnitExponent,
  parseAmountDigits,
  scoreAmount,
} from '../../src/money';

describe('minorUnitExponent', () => {
  // Treating yen as two-decimal multiplies every Japanese receipt by 100.
  it('gives zero-decimal currencies no fraction', () => {
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('krw')).toBe(0);
  });

  it('defaults to two decimals', () => {
    expect(minorUnitExponent('INR')).toBe(2);
    expect(minorUnitExponent('UNKNOWN')).toBe(2);
  });
});

describe('parseAmountDigits', () => {
  // The float route turns 19.99 into 1998.9999999999998; a mailbox of these
  // drifts visibly, and a total that disagrees with its own rows reads as a
  // bug in everything around it.
  it('builds minor units without touching a float', () => {
    expect(parseAmountDigits('19.99')).toBe(1999);
    expect(parseAmountDigits('0.07')).toBe(7);
    expect(parseAmountDigits('1234.56')).toBe(123456);
  });

  // Both separators present: the LAST one is the decimal point, whichever it
  // is. Getting this backwards reads 1.234,56 as one rupee twenty-three.
  it('reads the last separator as the decimal point', () => {
    expect(parseAmountDigits('1,234.56')).toBe(123456);
    expect(parseAmountDigits('1.234,56')).toBe(123456);
    expect(parseAmountDigits('1,23,456.78')).toBe(12345678);
  });

  // One separator, three digits after it: a thousands group, not a fraction.
  it('treats a lone separator with three digits after it as grouping', () => {
    expect(parseAmountDigits('1,500')).toBe(150000);
    expect(parseAmountDigits('12.000')).toBe(1200000);
  });

  it('treats a lone separator with one or two digits after it as a decimal', () => {
    expect(parseAmountDigits('1,50')).toBe(150);
    expect(parseAmountDigits('7.5')).toBe(750);
  });

  it('honours the currency exponent', () => {
    expect(parseAmountDigits('1200', 0)).toBe(1200);
    expect(parseAmountDigits('1,200', 0)).toBe(1200);
  });

  // A number that is not one must come back null rather than as NaN or 0,
  // both of which would be recorded as a real receipt for no money.
  it('refuses anything that is not a plain number', () => {
    expect(parseAmountDigits('')).toBeNull();
    expect(parseAmountDigits('abc')).toBeNull();
    expect(parseAmountDigits('1,2345')).toBeNull();
    expect(parseAmountDigits('1.2.3', 2)).toBeNull();
  });

  // Version numbers, IP fragments and dates all arrive as digits and dots. Each
  // one accepted is a receipt recorded for a price nobody paid.
  it('refuses separators that are not plausible grouping', () => {
    expect(parseAmountDigits('1.2.3')).toBeNull();
    expect(parseAmountDigits('2026.09.23')).toBeNull();
    expect(parseAmountDigits('10.20.30.40')).toBeNull();
  });

  // KNOWN LIMITATION, deliberate: `192.168.1` is indistinguishable from
  // well-formed grouping with one decimal place (so is `1,234.5`, which is
  // real money), so it parses as 192168.10. Nothing cheap separates the two,
  // and it can only be reached through a currency marker — `$192.168.1` — so
  // the exposure is close to nil. If this ever bites, the fix is a rule about
  // the surrounding text, not a tighter number grammar.
  it('cannot tell dotted quads from grouping when the groups are valid', () => {
    expect(parseAmountDigits('192.168.1')).toBe(19216810);
  });

  it('accepts Indian grouping', () => {
    expect(parseAmountDigits('1,23,456.78')).toBe(12345678);
    expect(parseAmountDigits('12,34,567')).toBe(123456700);
  });

  it('refuses a number too large to stay exact', () => {
    expect(parseAmountDigits('999999999999999999.99')).toBeNull();
  });

  it('ignores ordinary and non-breaking spaces inside the digits', () => {
    expect(parseAmountDigits('1 234.56')).toBe(123456);
    expect(parseAmountDigits('1 234.56')).toBe(123456);
  });
});

describe('currencyFor', () => {
  // Indian receipts write Rs at least as often as the symbol; skipping it
  // makes the extension look broken to the users it was built for.
  it('maps the Indian forms', () => {
    expect(currencyFor('₹')).toBe('INR');
    expect(currencyFor('Rs')).toBe('INR');
    expect(currencyFor('Rs.')).toBe('INR');
    expect(currencyFor('INR')).toBe('INR');
  });

  it('maps prefixed dollar symbols to their own currencies', () => {
    expect(currencyFor('$')).toBe('USD');
    expect(currencyFor('A$')).toBe('AUD');
    expect(currencyFor('S$')).toBe('SGD');
  });

  it('returns null for anything else', () => {
    expect(currencyFor('')).toBeNull();
    expect(currencyFor('  ')).toBeNull();
    expect(currencyFor('XYZ')).toBeNull();
  });
});

describe('findAmounts', () => {
  it('finds a symbol before the number and a code after it', () => {
    expect(findAmounts('Total ₹1,299.00 paid')).toMatchObject([{ minor: 129900, currency: 'INR' }]);
    expect(findAmounts('Total 49.00 USD paid')).toMatchObject([{ minor: 4900, currency: 'USD' }]);
  });

  // A receipt is full of long digit strings — order ids, phone numbers,
  // tracking codes. Admitting bare numbers would pick one of those as a total.
  it('ignores numbers with no currency attached', () => {
    expect(findAmounts('Order 11209384 shipped on 12 March')).toEqual([]);
  });

  it('returns nothing for empty text', () => {
    expect(findAmounts('')).toEqual([]);
  });

  // The pattern is a module-level /g regex, so a leaked lastIndex would make
  // the second call on the same text skip the first amount.
  it('does not leak regex state between calls', () => {
    const text = 'Paid ₹500.00 and ₹250.00';
    expect(findAmounts(text)).toHaveLength(2);
    expect(findAmounts(text)).toHaveLength(2);
  });
});

describe('scoreAmount', () => {
  it('rewards an amount labelled as the total', () => {
    const text = 'Grand total ₹1,299.00';
    const [amount] = findAmounts(text);
    expect(scoreAmount(text, amount!)).toBeGreaterThan(0);
  });

  it('pushes down a subtotal, a tax line and a discount', () => {
    for (const label of ['Subtotal', 'GST', 'Shipping', 'You saved']) {
      const text = `${label} ₹99.00`;
      const [amount] = findAmounts(text);
      expect(scoreAmount(text, amount!)).toBeLessThan(0);
    }
  });
});

describe('findTotal', () => {
  // The regression this whole module exists for: every receipt has a subtotal,
  // a tax line and a shipping line beside the total, and picking the wrong one
  // silently reports a delivery charge as the price of the order.
  it('picks the labelled total over the lines around it', () => {
    const body = [
      'Subtotal: ₹1,100.00',
      'Shipping: ₹49.00',
      'GST (18%): ₹207.00',
      'Grand total: ₹1,356.00',
    ].join('\n');

    expect(findTotal(body)).toMatchObject({ minor: 135600, currency: 'INR' });
  });

  it('returns the only amount when there is one', () => {
    expect(findTotal('Charged $9.99')).toMatchObject({ minor: 999, currency: 'USD' });
  });

  it('returns null when nothing looks like money', () => {
    expect(findTotal('Your order has shipped')).toBeNull();
  });

  // A converted price in the footer must not decide the currency of the total.
  it('ignores amounts in a minority currency', () => {
    const body = 'Total ₹8,300.00 (approx $99.00). Subtotal ₹8,000.00 plus ₹300.00 tax.';
    expect(findTotal(body)?.currency).toBe('INR');
  });

  it('breaks an equal-cue tie towards the larger amount', () => {
    const body = 'Total ₹100.00 and total ₹250.00';
    expect(findTotal(body)?.minor).toBe(25000);
  });
});

describe('dominantCurrency', () => {
  it('returns the most common currency', () => {
    expect(
      dominantCurrency([
        { minor: 1, currency: 'INR', index: 0 },
        { minor: 2, currency: 'USD', index: 1 },
        { minor: 3, currency: 'INR', index: 2 },
      ])
    ).toBe('INR');
  });

  it('returns null for no amounts', () => {
    expect(dominantCurrency([])).toBeNull();
  });
});
