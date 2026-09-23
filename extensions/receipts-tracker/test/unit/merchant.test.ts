import { describe, expect, it } from 'vitest';

import {
  domainOf,
  isUsableDisplayName,
  merchantKey,
  merchantLabel,
  registrableDomain,
} from '../../src/merchant';

describe('domainOf', () => {
  it('reads the domain out of an address', () => {
    expect(domainOf('billing@netflix.com')).toBe('netflix.com');
    expect(domainOf('Billing@NETFLIX.com')).toBe('netflix.com');
  });

  // Some paths hand us the whole From header; a display name containing an @
  // must not split the address at the wrong place.
  it('handles a display-wrapped address', () => {
    expect(domainOf('Acme <billing@acme.com>')).toBe('acme.com');
    expect(domainOf('"a@b" <billing@acme.com>')).toBe('acme.com');
  });

  it('returns null when there is no usable domain', () => {
    expect(domainOf('')).toBeNull();
    expect(domainOf('not-an-address')).toBeNull();
    expect(domainOf('user@localhost')).toBeNull();
    expect(domainOf(undefined as unknown as string)).toBeNull();
  });
});

describe('registrableDomain', () => {
  it('keeps the last two labels', () => {
    expect(registrableDomain('orders.amazon.com')).toBe('amazon.com');
    expect(registrableDomain('amazon.com')).toBe('amazon.com');
  });

  // A two-label answer for amazon.co.uk would be "co.uk", which groups every
  // British merchant into one subscription.
  it('keeps three labels for a compound suffix', () => {
    expect(registrableDomain('orders.amazon.co.uk')).toBe('amazon.co.uk');
    expect(registrableDomain('mail.flipkart.co.in')).toBe('flipkart.co.in');
  });
});

describe('merchantKey', () => {
  // The regression the key exists for: one merchant's marketing, billing and
  // transactional streams must be one subscription, not three costing triple.
  it('gives every stream of one merchant the same key', () => {
    const keys = [
      'no-reply@netflix.com',
      'info@mail.netflix.com',
      'billing@email.marketing.netflix.com',
      'receipts@notifications.netflix.com',
    ].map(merchantKey);

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('netflix.com');
  });

  it('keeps two different merchants apart', () => {
    expect(merchantKey('a@netflix.com')).not.toBe(merchantKey('a@spotify.com'));
  });

  // Too-specific splits one merchant into several, which is visible. Too-broad
  // merges two and silently reports a wrong total — so the fallback is the
  // whole address.
  it('falls back to the address when there is no domain', () => {
    expect(merchantKey('weird-sender')).toBe('weird-sender');
    expect(merchantKey('')).toBe('unknown');
  });

  it('does not strip a noise label that is the whole brand', () => {
    expect(merchantKey('hi@order.com')).toBe('order.com');
  });
});

describe('isUsableDisplayName', () => {
  it('accepts a company name', () => {
    expect(isUsableDisplayName('Netflix')).toBe(true);
    expect(isUsableDisplayName('Amazon.in')).toBe(true);
  });

  it('rejects a name that names the mailbox', () => {
    for (const name of ['no-reply', 'No Reply', 'billing', 'Invoices', 'support', 'Team']) {
      expect(isUsableDisplayName(name)).toBe(false);
    }
  });

  it('rejects an address, an empty name and punctuation soup', () => {
    expect(isUsableDisplayName('a@b.com')).toBe(false);
    expect(isUsableDisplayName('')).toBe(false);
    expect(isUsableDisplayName(null)).toBe(false);
    expect(isUsableDisplayName('***')).toBe(false);
    expect(isUsableDisplayName('x')).toBe(false);
  });
});

describe('merchantLabel', () => {
  it('prefers a usable display name', () => {
    expect(merchantLabel('no-reply@netflix.com', 'Netflix')).toBe('Netflix');
  });

  it('drops a mailbox suffix from the display name', () => {
    expect(merchantLabel('a@netflix.com', 'Netflix Billing')).toBe('Netflix');
    expect(merchantLabel('a@zomato.com', 'Zomato Orders')).toBe('Zomato');
  });

  // "no-reply" as the label on every row is the failure this guards against.
  it('falls back to the domain when the name is useless', () => {
    expect(merchantLabel('no-reply@bookmyshow.com', 'no-reply')).toBe('Bookmyshow');
    expect(merchantLabel('billing@amazon.co.uk')).toBe('Amazon');
  });

  it('never returns an empty label', () => {
    expect(merchantLabel('')).toBe('Unknown');
  });
});
