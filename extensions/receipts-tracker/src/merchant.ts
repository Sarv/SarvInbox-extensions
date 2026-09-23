/**
 * Who a receipt is from.
 *
 * Two different answers are needed and they must not be confused. The KEY is
 * an identity used to decide that this month's Netflix charge and last
 * month's are the same subscription; it has to be stable across a display
 * name that changes with a marketing campaign. The LABEL is what a human
 * reads, and it only has to be recognisable.
 *
 * Getting the key from the sending domain rather than the display name is the
 * whole trick: `Netflix`, `Netflix India` and `NETFLIX Billing` all send from
 * `netflix.com`, and a key built from the display name would file them as
 * three separate subscriptions costing three times as much.
 */

/**
 * Multi-part public suffixes we care about.
 *
 * A complete answer needs the Public Suffix List, which is a 30 KB dependency
 * for a job that here only decides a display label and a grouping key. The
 * cost of being wrong is two rows where there should be one, not a security
 * failure, so a short list of the suffixes that actually appear on receipts
 * buys nearly all the accuracy for none of the weight. Revisit this if the key
 * ever gates something that matters.
 */
const COMPOUND_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'or.jp', 'ne.jp',
  'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.my', 'com.hk',
  'co.za', 'co.nz', 'co.kr', 'co.id', 'co.th',
  'com.tr', 'com.cn', 'com.tw', 'com.ph', 'com.vn',
]);

/**
 * Subdomains that describe the mail stream rather than the sender.
 *
 * Stripped so `email.marketing.stripe.com` and `stripe.com` are one merchant.
 */
const NOISE_LABELS = new Set([
  'mail', 'email', 'e', 'em', 'mailer', 'mailing', 'smtp', 'mta',
  'send', 'sender', 'sending', 'reply', 'replies', 'noreply', 'no-reply',
  'notify', 'notifications', 'notification', 'alerts', 'alert',
  'billing', 'invoice', 'invoices', 'receipts', 'receipt', 'orders', 'order',
  'news', 'newsletter', 'marketing', 'info', 'support', 'help', 'service',
  'transactional', 'txn', 'auto', 'bounce', 'bounces', 'link', 'links',
  't', 'u', 'm', 'r', 's', 'go', 'click', 'track', 'cp', 'ct',
]);

/**
 * Display names that name the mailbox, not the company.
 *
 * These are the names a receipt is most likely to carry, and every one of them
 * would make a useless label.
 */
const GENERIC_NAMES =
  /^(?:no[\s._-]?reply|do[\s._-]?not[\s._-]?reply|noreply|donotreply|auto[\s._-]?reply|reply|billing|invoices?|receipts?|orders?|payments?|notifications?|alerts?|info|support|help|customer\s+(?:care|service|support)|team|admin|mailer[\s-]?daemon|account|accounts|sales|hello|hi|contact)$/i;

/** The domain part of an address, lowercased, or null. */
export function domainOf(address: string): string | null {
  if (typeof address !== 'string') return null;
  // A display-wrapped address ("Acme <billing@acme.com>") reaches us on some
  // paths; take the last @ so a name containing one cannot split it wrongly.
  const at = address.lastIndexOf('@');
  if (at < 0) return null;

  const domain = address
    .slice(at + 1)
    .replace(/[>\s,;]+$/, '')
    .trim()
    .toLowerCase();

  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/**
 * The registrable part of a domain — `orders.amazon.co.uk` -> `amazon.co.uk`.
 *
 * Noise labels are stripped first so that a sender who puts their brand behind
 * a mail vendor subdomain still lands on the brand.
 */
export function registrableDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  const keep = COMPOUND_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * A stable identity for the merchant behind an address.
 *
 * Falls back to the whole address when there is no usable domain: an identity
 * that is too specific splits one merchant into several, which is visible and
 * fixable, while an identity that is too broad merges two merchants into one
 * and silently reports a wrong total.
 */
export function merchantKey(fromAddress: string): string {
  const domain = domainOf(fromAddress);
  if (!domain) return (fromAddress || 'unknown').trim().toLowerCase() || 'unknown';

  const labels = domain.split('.');
  const trimmed: string[] = [];
  let leading = true;
  for (const label of labels) {
    if (leading && NOISE_LABELS.has(label)) continue;
    leading = false;
    trimmed.push(label);
  }

  const candidate = trimmed.length >= 2 ? trimmed.join('.') : domain;
  return registrableDomain(candidate);
}

/** Title-case a domain label: `bookmyshow` -> `Bookmyshow`. */
function titleCase(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Whether a display name is worth showing.
 *
 * A name that is really an address, or that names the mailbox rather than the
 * company, is rejected in favour of the domain — `Amazon` beats `no-reply`
 * every time, and the domain is always available.
 */
export function isUsableDisplayName(name: string | null | undefined): name is string {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (trimmed.includes('@')) return false;
  if (GENERIC_NAMES.test(trimmed)) return false;
  // All-digits, or punctuation soup, is not a brand.
  return /[a-z]/i.test(trimmed);
}

/**
 * What to show the reader for this sender.
 *
 * Prefers the display name when it names a company, because that is the name
 * on the card statement too; otherwise builds one from the domain.
 */
export function merchantLabel(fromAddress: string, fromName?: string | null): string {
  if (isUsableDisplayName(fromName)) {
    // "Amazon.in" and "Netflix Billing" are both fine as-is; only the mailbox
    // suffix is worth removing.
    return fromName.trim().replace(/\s+(?:billing|receipts?|invoices?|orders?)$/i, '');
  }

  const key = merchantKey(fromAddress);
  const brand = key.split('.')[0];
  return brand ? titleCase(brand) : 'Unknown';
}
