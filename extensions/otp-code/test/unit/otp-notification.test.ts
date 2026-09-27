import { describe, it, expect } from 'vitest';

import type { OtpDetection } from '../../src/otp-detect';
import {
  buildOtpNotification,
  codeExpiresAtMs,
  isAlreadyRead,
  notificationId,
  receivedAtMs,
  senderLabel,
  shouldNotifyForCode,
} from '../../src/otp-notification';

const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;

const detection: OtpDetection = {
  code: '483920',
  confidence: 0.9,
  source: 'body',
  expiresInMs: 5 * 60 * 1000,
  expiryFromMail: true,
};

describe('receivedAtMs', () => {
  // Regression: EmailRecord stores seconds, the notification takes UTC epoch
  // milliseconds. A missing x1000 puts every card 54 years in the past and the
  // freshness gate then silences the extension completely.
  it('converts stored seconds to epoch milliseconds', () => {
    expect(receivedAtMs({ date: NOW_SECONDS, receivedDate: null })).toBe(NOW);
  });

  // Regression: receivedDate is when THIS app synced the row. On a fresh setup
  // it is "now" for hours-old mail, and preferring it put stale codes on cards.
  // The server's INTERNALDATE (`date`) is when the code was really delivered.
  it('prefers the server delivery time over our own sync time', () => {
    const hourAgo = NOW_SECONDS - 3600;
    expect(receivedAtMs({ date: hourAgo, receivedDate: NOW_SECONDS })).toBe(hourAgo * 1000);
  });

  // Regression: a row with no delivery time must still be timed by something.
  it('falls back to our sync time when the delivery time is unusable', () => {
    expect(receivedAtMs({ date: 0, receivedDate: NOW_SECONDS })).toBe(NOW);
  });

  // Regression: absent or nonsensical timestamps must not become epoch 0 or
  // NaN, both of which slip past a naive comparison.
  it.each([
    ['zero', { date: 0, receivedDate: null }],
    ['negative', { date: -5, receivedDate: null }],
    ['not a number', { date: Number.NaN, receivedDate: null }],
  ])('returns null for %s timestamps', (_label, email) => {
    expect(receivedAtMs(email)).toBeNull();
  });
});

describe('codeExpiresAtMs', () => {
  // Regression: the expiry used to count from detection, so a code found five
  // minutes late got a fresh full countdown and looked valid when it was not.
  it('counts the validity from when the mail arrived', () => {
    const fiveMinutesAgo = { date: (NOW - 5 * 60_000) / 1000, receivedDate: NOW_SECONDS };
    expect(codeExpiresAtMs(fiveMinutesAgo, detection, NOW)).toBe(NOW);
  });

  // Regression: a server clock running fast must not stretch the countdown
  // past the validity the mail states.
  it('counts from now for mail dated in the future', () => {
    const future = { date: (NOW + 60_000) / 1000, receivedDate: null };
    expect(codeExpiresAtMs(future, detection, NOW)).toBe(NOW + detection.expiresInMs);
  });

  // Regression: no timestamp must not become an expiry near epoch 0.
  it('returns null with no usable timestamp', () => {
    expect(codeExpiresAtMs({ date: 0, receivedDate: null }, detection, NOW)).toBeNull();
  });
});

describe('isAlreadyRead', () => {
  // Regression: a read code has been seen (or used elsewhere); carding it again
  // after setup is noise over the reader's mail.
  it('is true for mail carrying the read tag', () => {
    expect(isAlreadyRead({ tags: '|inbox|read|' })).toBe(true);
  });

  // Regression: unread codes are the only ones worth a card.
  it.each([
    ['other tags', '|inbox|starred|'],
    ['no tags', ''],
  ])('is false with %s', (_label, tags) => {
    expect(isAlreadyRead({ tags })).toBe(false);
  });

  // Regression: a partial record without tags must not throw in the pipeline.
  it('treats a record with no tags as unread', () => {
    expect(isAlreadyRead({ tags: undefined as unknown as string })).toBe(false);
  });
});

describe('shouldNotifyForCode', () => {
  const unread = (ageMs: number) => ({ date: (NOW - ageMs) / 1000, receivedDate: NOW_SECONDS, tags: '|inbox|' });

  // Regression: mail that just landed is the whole reason the extension exists.
  it('shows an unread code that just arrived', () => {
    expect(shouldNotifyForCode(unread(0), detection, NOW)).toBe(true);
  });

  // Regression: the fresh-setup bug. Mail synced just now but delivered after
  // its stated validity ran out must stay quiet.
  it('skips a code whose stated validity has already run out', () => {
    expect(shouldNotifyForCode(unread(detection.expiresInMs + 1000), detection, NOW)).toBe(false);
  });

  // Regression: the edge is exclusive. A countdown already at zero is useless.
  it('skips a code expiring exactly now', () => {
    expect(shouldNotifyForCode(unread(detection.expiresInMs), detection, NOW)).toBe(false);
  });

  // Regression: a code with time left still surfaces even when found late.
  it('shows a code found late that still has time left', () => {
    expect(shouldNotifyForCode(unread(detection.expiresInMs - 60_000), detection, NOW)).toBe(true);
  });

  // Regression: a long validity the mail states itself is honoured.
  it('honours a long validity stated by the mail', () => {
    const hour = { ...detection, expiresInMs: 60 * 60_000 };
    expect(shouldNotifyForCode(unread(30 * 60_000), hour, NOW)).toBe(true);
  });

  // Regression: an already-read code must not be carded, however fresh.
  it('skips a read message even when the code is still valid', () => {
    expect(shouldNotifyForCode({ ...unread(0), tags: '|inbox|read|' }, detection, NOW)).toBe(false);
  });

  // Regression: a server clock running fast must not hide a real code.
  it('shows mail dated in the future', () => {
    expect(shouldNotifyForCode(unread(-60_000), detection, NOW)).toBe(true);
  });

  // Regression: with no usable timestamp we cannot tell fresh from archived,
  // so we stay quiet rather than interrupt on a guess.
  it('skips mail with no usable timestamp', () => {
    expect(shouldNotifyForCode({ date: 0, receivedDate: null, tags: '' }, detection, NOW)).toBe(false);
  });
});

describe('senderLabel', () => {
  // Regression: the card's only context is who sent the code; an empty line
  // makes a phishing code indistinguishable from a real one.
  it.each([
    ['display name', { fromName: 'Sarv Security', fromAddress: 'no-reply@sarv.com' }, 'Sarv Security'],
    ['address when unnamed', { fromName: null, fromAddress: 'no-reply@sarv.com' }, 'no-reply@sarv.com'],
    ['address when the name is blank', { fromName: '   ', fromAddress: 'no-reply@sarv.com' }, 'no-reply@sarv.com'],
    ['a placeholder when neither is set', { fromName: null, fromAddress: '' }, 'Unknown sender'],
  ])('uses the %s', (_label, email, expected) => {
    expect(senderLabel(email)).toBe(expected);
  });
});

describe('buildOtpNotification', () => {
  const email = {
    id: 'email-1',
    accountId: 'account-1',
    fromName: 'Sarv Security',
    fromAddress: 'no-reply@sarv.com',
    date: NOW_SECONDS,
    receivedDate: NOW_SECONDS,
  };

  // Regression: the id must be derived from the email, because re-notifying
  // with the same id REPLACES the card. A random id stacks a second card on
  // the body-stage re-run.
  it('derives a stable id from the email', () => {
    expect(buildOtpNotification(email, detection, { now: NOW }).id).toBe(notificationId('email-1'));
    expect(buildOtpNotification(email, detection, { now: NOW + 5_000 }).id).toBe(notificationId('email-1'));
  });

  // Regression: expiry is sent as an absolute UTC instant so the renderer can
  // run the countdown without knowing when detection happened. A relative
  // duration here would restart the countdown on every re-render.
  it('sends an absolute expiry instant', () => {
    expect(buildOtpNotification(email, detection, { now: NOW }).expiresAt).toBe(NOW + detection.expiresInMs);
  });

  // Regression: the countdown must show the time the code really has left,
  // not a fresh full validity from whenever the app happened to notice it.
  it('counts the expiry from when the mail arrived', () => {
    const late = { ...email, date: NOW_SECONDS - 120 };
    expect(buildOtpNotification(late, detection, { now: NOW }).expiresAt).toBe(NOW - 120_000 + detection.expiresInMs);
  });

  // Regression: a record with no timestamp still gets a sane countdown.
  it('falls back to a full validity from now with no usable timestamp', () => {
    const undated = { ...email, date: 0, receivedDate: null };
    expect(buildOtpNotification(undated, detection, { now: NOW }).expiresAt).toBe(NOW + detection.expiresInMs);
  });

  // Regression: the copy button is the point of the card. Losing `copyable`
  // sends the user back into the email to select six digits by hand.
  it('marks the code copyable and emphasised', () => {
    const [field] = buildOtpNotification(email, detection, { now: NOW }).fields ?? [];
    expect(field).toEqual({ label: 'Code', value: '483920', copyable: true, emphasis: true });
  });

  // Regression: clicking the card opens the mail, which needs both ids on a
  // multi-account setup — otherwise it opens the wrong account's message.
  it('carries the email and account ids', () => {
    const card = buildOtpNotification(email, detection, { now: NOW });
    expect(card.emailId).toBe('email-1');
    expect(card.accountId).toBe('account-1');
  });

  // Regression: a single-account record has no accountId; emitting the key as
  // undefined fails the host's sanitizer shape check.
  it('omits the account id when the email has none', () => {
    const card = buildOtpNotification({ ...email, accountId: undefined }, detection, { now: NOW });
    expect('accountId' in card).toBe(false);
  });
});
