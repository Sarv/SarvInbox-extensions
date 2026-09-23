import { describe, expect, it } from 'vitest';

import { MIN_CONFIDENCE, confidenceFromWeight, detectReceipt } from '../../src/receipt-detect';

const detect = (subject: string, body = '', hasAmount = true) =>
  detectReceipt({ subject, body, hasAmount });

describe('confidenceFromWeight', () => {
  it('maps weight onto 0..1 and saturates', () => {
    expect(confidenceFromWeight(0)).toBe(0);
    expect(confidenceFromWeight(-5)).toBe(0);
    expect(confidenceFromWeight(5)).toBe(0.5);
    expect(confidenceFromWeight(40)).toBe(1);
  });
});

describe('detectReceipt', () => {
  it('returns null for empty input', () => {
    expect(detectReceipt({ subject: '', body: '', hasAmount: true })).toBeNull();
    expect(detectReceipt({ subject: null, body: null, hasAmount: true })).toBeNull();
  });

  it('recognises a plain purchase receipt', () => {
    const signals = detect('Your receipt from Blue Tokai', 'Thank you for your order. Payment received.');
    expect(signals?.kind).toBe('purchase');
    expect(signals?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it('recognises an invoice', () => {
    expect(detect('Tax invoice #4471', 'Amount paid. Transaction id 88120.')?.kind).toBe('purchase');
  });

  // The whole point of the module. A sale counted as a purchase puts a number
  // in the spend total that is simply a lie, and one is enough to make every
  // other figure untrustworthy.
  it('refuses promotional mail even when it borrows receipt words', () => {
    expect(detect('FLASH SALE: 50% off everything', 'Use code SAVE50. Shop now!')).toBeNull();
    expect(
      detect('Your invoice is ready', 'Upgrade now and get 30% off — limited time. Use promo code UP30.')
    ).toBeNull();
    expect(detect('You left something in your cart', 'Complete your purchase — buy now!')).toBeNull();
  });

  // A declined card is worth reading but is not money that moved. Counting it
  // inflates the month and the reader can never find the charge.
  it('refuses a failed payment', () => {
    expect(
      detect('Payment failed', 'Your payment of Rs 499 failed. Please update your payment method.')
    ).toBeNull();
  });

  // No amount anywhere means there is nothing to record, however receipt-like
  // the wording is.
  it('refuses a receipt with no amount, unless it is a trial notice', () => {
    expect(detect('Your receipt', 'Payment received. Thank you for your order.', false)).toBeNull();
    expect(
      detect('Your free trial ends soon', 'Your trial period ends on 4 October.', false)?.kind
    ).toBe('trial');
  });

  it('classifies a subscription renewal', () => {
    const signals = detect(
      'Your Netflix subscription renewed',
      'Your membership has been renewed. Next billing date 12 October.'
    );
    expect(signals?.kind).toBe('subscription');
  });

  // A refund mail names the subscription it reverses, so "refund" has to win
  // or money coming back is recorded as money going out.
  it('classifies a refund above the subscription it reverses', () => {
    expect(
      detect('Refund issued', 'We have refunded your subscription payment of Rs 499.')?.kind
    ).toBe('refund');
  });

  // A trial notice always names the plan it will become. Read as a
  // subscription charge it reports money already spent that was not.
  it('classifies a trial above the plan it will become', () => {
    expect(
      detect(
        'Your free trial ends in 3 days',
        'After your trial your subscription of Rs 649 per month begins. Next billing date 4 October.'
      )?.kind
    ).toBe('trial');
  });

  // A renewal notice frequently carries no past-tense payment wording at all.
  // Requiring one dropped every mail of this shape on the floor.
  it('accepts a renewal that never uses payment words', () => {
    expect(
      detect(
        'Your Spotify Premium plan renews on 4 October',
        'Your subscription will auto-renew. Next billing date 4 October. Rs 119 per month.'
      )?.kind
    ).toBe('subscription');
  });

  // The other side of that change: subscription vocabulary is exactly what an
  // upsell uses, so it must not be enough on its own.
  it('still refuses an upsell that only talks about subscribing', () => {
    expect(detect('Upgrade your plan', 'Your plan could be better. Subscribe today!')).toBeNull();
  });

  // "We charged 119.00 INR" is how half the world's billing mail states a
  // payment, and the cue used to require "we have charged" or "charged your
  // card". Without this the whole message scored as subscription vocabulary
  // alone and fell under the bar.
  it('accepts a plain past-tense "we charged"', () => {
    const signals = detect(
      'Your monthly subscription payment',
      'Your subscription renewed. We charged 119.00 INR for this month.'
    );
    expect(signals?.kind).toBe('subscription');
    expect(signals?.matched).toContain('charged');
  });

  it('reports which cues fired', () => {
    expect(detect('Your receipt', 'Payment received')?.matched).toContain('payment-received');
  });

  // Cue matching runs on the pipeline thread; an unbounded body is a stall.
  it('reads only the head of a very long body', () => {
    const noise = 'x'.repeat(50_000);
    const signals = detectReceipt({
      subject: 'Your receipt',
      body: `Payment received.${noise}`,
      hasAmount: true,
    });
    expect(signals?.kind).toBe('purchase');
  });
});
