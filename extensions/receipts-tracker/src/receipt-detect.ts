/**
 * Deciding whether a message is a receipt, and what kind.
 *
 * The expensive mistake here is not the receipt we miss — it is the marketing
 * mail we accept. A missed receipt leaves a gap the reader may never notice;
 * a "SALE! Everything under ₹999" counted as a purchase puts a number in
 * their spend total that is simply a lie, and one of those is enough to make
 * the whole panel untrustworthy.
 *
 * So the bar is deliberately asymmetric: evidence that money actually moved,
 * in the past tense, and a promotional tone is disqualifying even when the
 * mail is otherwise full of receipt vocabulary.
 */

/** What a message records. */
export type ReceiptKind = 'purchase' | 'subscription' | 'refund' | 'trial';

export interface ReceiptSignals {
  kind: ReceiptKind;
  /** 0..1. Below `MIN_CONFIDENCE` the message is not recorded. */
  confidence: number;
  /** Which cues fired, kept for the log and for debugging a bad call. */
  matched: string[];
}

/** Confidence below which a message is not treated as a receipt at all. */
export const MIN_CONFIDENCE = 0.5;

/**
 * How much a kind's own evidence counts when the mail carries no past-tense
 * proof that money moved.
 *
 * Trial and refund language has no advertising equivalent — no campaign
 * announces that your free trial ends on the 4th, or that a refund has been
 * issued — so those stand on their own. Subscription vocabulary is exactly
 * what an upsell uses ("subscribe today, your plan, per month"), so it is
 * halved and has to be doubly evidenced before it clears the bar alone.
 */
const STANDALONE_WEIGHT: Readonly<Record<'trial' | 'refund' | 'subscription', number>> = {
  trial: 1,
  refund: 1,
  subscription: 0.5,
};

interface Cue {
  readonly name: string;
  readonly pattern: RegExp;
  readonly weight: number;
}

/**
 * Past-tense proof that a payment happened.
 *
 * Weighted highest because it is the one thing marketing mail rarely fakes:
 * an advertisement says "buy now", never "your payment of ₹499 was received".
 */
const PAYMENT_CUES: readonly Cue[] = [
  { name: 'payment-received', pattern: /payment\s+(?:received|successful|confirmed|complete)/i, weight: 5 },
  { name: 'order-confirmed', pattern: /order\s+(?:confirmation|confirmed|placed|received)/i, weight: 5 },
  { name: 'thanks-for-order', pattern: /thank(?:s| you)[^.!?]{0,30}(?:order|purchase|payment|booking)/i, weight: 4 },
  { name: 'receipt', pattern: /\b(?:your\s+)?receipt\b|\breceipt\s+(?:for|from|#)/i, weight: 4 },
  { name: 'invoice', pattern: /\b(?:tax\s+)?invoice\b/i, weight: 4 },
  { name: 'charged', pattern: /(?:has\s+been|was|we've|we\s+have|we)\s+charged|charged\s+(?:to|your)/i, weight: 4 },
  { name: 'debited', pattern: /\bdebited\b|\bdeducted\b/i, weight: 4 },
  { name: 'transaction', pattern: /transaction\s+(?:id|reference|successful|details)/i, weight: 3 },
  { name: 'booking', pattern: /booking\s+(?:confirmed|confirmation|reference)/i, weight: 3 },
  { name: 'order-number', pattern: /order\s*(?:#|no\.?|number|id)\s*[:.]?\s*[a-z0-9-]{4,}/i, weight: 3 },
  { name: 'paid', pattern: /\bpaid\b|\bpayment\s+of\b/i, weight: 2 },
];

/** Cues that say the charge repeats. */
const SUBSCRIPTION_CUES: readonly Cue[] = [
  { name: 'subscription', pattern: /\bsubscription\b/i, weight: 4 },
  { name: 'renewed', pattern: /(?:has\s+been\s+)?renewed|auto[\s-]?renew|renews?\s+(?:on|automatically)/i, weight: 4 },
  { name: 'billing-cycle', pattern: /billing\s+(?:cycle|period|date)|next\s+(?:billing|payment|charge)/i, weight: 4 },
  { name: 'membership', pattern: /\bmembership\b|\byour\s+plan\b/i, weight: 3 },
  { name: 'recurring', pattern: /\brecurring\b|\bper\s+(?:month|year)\b|\/\s*(?:mo|month|yr|year)\b/i, weight: 3 },
];

/** Cues that say money came back. */
const REFUND_CUES: readonly Cue[] = [
  { name: 'refund', pattern: /\brefund(?:ed|s)?\b/i, weight: 5 },
  { name: 'credited', pattern: /credited\s+(?:back|to)|money\s+back/i, weight: 4 },
  { name: 'cancelled-order', pattern: /order\s+(?:cancell?ed|returned)/i, weight: 3 },
];

/** Cues that say a trial is running and will convert. */
const TRIAL_CUES: readonly Cue[] = [
  { name: 'trial', pattern: /\bfree\s+trial\b|\btrial\s+(?:period|ends?|expires?|will\s+end)\b/i, weight: 5 },
  { name: 'trial-convert', pattern: /after\s+(?:your|the)\s+trial|when\s+your\s+trial\s+ends/i, weight: 4 },
];

/**
 * Cues that mean this is an advertisement.
 *
 * Deliberately heavy. These outweigh a single payment cue on purpose, because
 * promotional mail borrows receipt vocabulary constantly ("your invoice is
 * ready — upgrade now") while a real receipt almost never shouts about a sale.
 */
const PROMOTIONAL_CUES: readonly Cue[] = [
  { name: 'discount-shout', pattern: /\b\d{1,3}\s*%\s*(?:off|discount)\b/i, weight: -6 },
  { name: 'sale', pattern: /\b(?:flash\s+sale|mega\s+sale|big\s+sale|sale\s+ends|limited\s+time|hurry|last\s+chance)\b/i, weight: -6 },
  { name: 'coupon', pattern: /\b(?:coupon|promo\s*code|voucher\s+code|use\s+code)\b/i, weight: -5 },
  { name: 'cart', pattern: /\b(?:abandoned\s+cart|still\s+in\s+your\s+cart|left\s+something|complete\s+your\s+purchase)\b/i, weight: -6 },
  { name: 'shop-now', pattern: /\b(?:shop\s+now|buy\s+now|order\s+now|grab\s+(?:it|yours)|explore\s+deals?)\b/i, weight: -4 },
  { name: 'wishlist', pattern: /\b(?:wishlist|back\s+in\s+stock|price\s+drop|deal\s+of\s+the\s+day)\b/i, weight: -4 },
  { name: 'newsletter', pattern: /\b(?:newsletter|unsubscribe\s+from\s+(?:our|these)\s+(?:emails|updates))\b/i, weight: -2 },
];

/**
 * Cues that mean the payment did NOT happen.
 *
 * A failed charge is worth reading but must never be counted as spend.
 */
const FAILURE_CUES: readonly Cue[] = [
  { name: 'failed', pattern: /payment\s+(?:failed|declined|unsuccessful)|could\s+not\s+(?:be\s+)?process/i, weight: -8 },
  { name: 'action-needed', pattern: /update\s+your\s+(?:payment|card|billing)|card\s+(?:expired|declined)/i, weight: -6 },
];

/** Run a cue set over the text, collecting weight and names. */
function applyCues(text: string, cues: readonly Cue[]): { weight: number; matched: string[] } {
  return cues.reduce<{ weight: number; matched: string[] }>(
    (accumulated, cue) =>
      cue.pattern.test(text)
        ? { weight: accumulated.weight + cue.weight, matched: [...accumulated.matched, cue.name] }
        : accumulated,
    { weight: 0, matched: [] }
  );
}

/** Saturate a raw weight into 0..1 without a cliff at the top. */
export function confidenceFromWeight(weight: number): number {
  if (weight <= 0) return 0;
  // Ten points is "certain enough"; beyond that extra cues add very little,
  // which keeps a long receipt from outscoring a short unambiguous one purely
  // by having more text for cues to match in.
  return Math.min(1, weight / 10);
}

export interface DetectionInput {
  subject?: string | null;
  body?: string | null;
  /** True when an amount was found. Absent money is disqualifying for a purchase. */
  hasAmount: boolean;
}

/**
 * Classify a message.
 *
 * The subject is weighted the same as the body but searched first and kept
 * short: receipts say what they are in the subject line far more reliably
 * than anywhere else, and the body carries the footers and legal text where
 * most of the false cues live.
 */
export function detectReceipt(input: DetectionInput): ReceiptSignals | null {
  const subject = (input.subject ?? '').slice(0, 300);
  // Bounded: cue matching is synchronous work on the pipeline thread, and a
  // marketing mail can carry a megabyte of footer. The receipt details live
  // near the top in every format we have seen.
  const body = (input.body ?? '').slice(0, 20_000);
  const text = `${subject}\n${body}`;

  if (!text.trim()) return null;

  const payment = applyCues(text, PAYMENT_CUES);
  const subscription = applyCues(text, SUBSCRIPTION_CUES);
  const refund = applyCues(text, REFUND_CUES);
  const trial = applyCues(text, TRIAL_CUES);
  const promotional = applyCues(text, PROMOTIONAL_CUES);
  const failure = applyCues(text, FAILURE_CUES);

  // A subject that announces a receipt is strong evidence on its own; the same
  // words buried in a footer are not.
  const subjectBoost = applyCues(subject, PAYMENT_CUES).weight > 0 ? 2 : 0;

  const payments = payment.weight + subjectBoost;

  // The strongest of the mutually-exclusive readings. They compete rather than
  // sum because a refund mail names the subscription it reverses and a trial
  // notice names the plan it becomes — adding them would score one message
  // twice for describing itself once.
  const kind = classify({
    refund: refund.weight,
    trial: trial.weight,
    subscription: subscription.weight,
  });
  const specific = Math.max(subscription.weight, refund.weight, trial.weight);

  // A renewal or trial notice often carries no payment wording at all: "Your
  // subscription renewed, next billing date 12 October, Rs 649". That is
  // unambiguously a receipt, so the kind's own evidence stands in for payment
  // evidence, discounted by how much an advertisement could have produced the
  // same words.
  const standalone = kind === 'purchase' ? 0 : STANDALONE_WEIGHT[kind];
  const positive = payments > 0 ? payments + specific : specific * standalone;
  const total = positive + promotional.weight + failure.weight;

  // No money named, and no trial about to start charging, means there is
  // nothing to record even if the wording looks like a receipt.
  if (!input.hasAmount && trial.weight === 0) return null;
  if (positive <= 0) return null;

  const confidence = confidenceFromWeight(total);
  if (confidence < MIN_CONFIDENCE) return null;

  return {
    kind,
    confidence,
    matched: [
      ...payment.matched,
      ...subscription.matched,
      ...refund.matched,
      ...trial.matched,
      ...promotional.matched,
      ...failure.matched,
    ],
  };
}

/**
 * Pick the kind from the competing cue groups.
 *
 * Order matters and is not arbitrary. A refund mail almost always also names
 * the subscription it reverses, and a trial notice always names the plan it
 * will become — so the more specific reading wins over the more general one,
 * or every trial would be filed as an ordinary subscription charge and
 * reported as money already spent.
 */
function classify(weights: { refund: number; trial: number; subscription: number }): ReceiptKind {
  if (weights.refund >= 4) return 'refund';
  if (weights.trial >= 4) return 'trial';
  if (weights.subscription >= 4) return 'subscription';
  return 'purchase';
}
