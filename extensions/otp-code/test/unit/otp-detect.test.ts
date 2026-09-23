import { describe, it, expect } from 'vitest';

import {
  detectOtpCode,
  parseStatedExpiry,
  DEFAULT_EXPIRY_MS,
  MAX_SCAN_CHARS,
  MIN_CONFIDENCE,
} from '../../src/otp-detect';

describe('detectOtpCode', () => {
  // Regression: the commonest OTP mail of all puts the code in the subject.
  // If this stops matching, the code no longer surfaces before the body is
  // fetched — which is the entire point of running on arrival.
  it('finds a code in the subject', () => {
    const detection = detectOtpCode({ subject: '284917 is your Sarv verification code', body: '' });
    expect(detection?.code).toBe('284917');
    expect(detection?.source).toBe('subject');
    expect(detection?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  // Regression: codes that only appear in the body must still be found once it
  // has been downloaded, otherwise the body-stage re-run does nothing.
  it('finds a code in the body', () => {
    const detection = detectOtpCode({ subject: 'Security alert', body: 'Your verification code is 483920.' });
    expect(detection?.code).toBe('483920');
    expect(detection?.source).toBe('body');
  });

  // Regression: Google and others split the code with a space or hyphen. Read
  // as two 3-digit runs it scores nothing, and the user sees no card.
  it.each([
    ['space', 'Your verification code is 123 456'],
    ['hyphen', 'Your verification code is 123-456'],
  ])('joins a grouped code separated by a %s', (_label, body) => {
    expect(detectOtpCode({ body })?.code).toBe('123456');
  });

  // Regression: alphanumeric codes (GitHub, Steam) are a real format; dropping
  // them silently halves the extension's coverage.
  it('finds an uppercase alphanumeric code', () => {
    expect(detectOtpCode({ body: 'Your login code is G-4F7K2A' })?.code).toBe('4F7K2A');
  });

  // Regression: a number with no passcode wording near it is just a number.
  // Without the keyword requirement every order confirmation pops a card.
  it('returns null when no passcode keyword sits near the number', () => {
    expect(detectOtpCode({ subject: 'Invoice 483920 attached', body: 'Total due within 30 days.' })).toBeNull();
  });

  // Regression: "verification" plus a year is a footer, not a code. The year
  // penalty is what keeps copyright lines out of the notification surface.
  it('rejects a four-digit year even beside a keyword', () => {
    expect(detectOtpCode({ body: 'Verification service, copyright 2024' })).toBeNull();
  });

  // Regression: neighbour characters are the cheapest way to tell a passcode
  // from money, a percentage, a time or a URL fragment. Each of these produced
  // a false card before the neighbour check existed.
  it.each([
    ['a price', 'Your verification code order total $123456'],
    ['a percentage', 'Your verification code discount 123456%'],
    ['a URL path', 'Your verification code at https://example.com/123456'],
    ['a query value', 'Your verification code link ?ref=123456'],
  ])('rejects %s', (_label, body) => {
    expect(detectOtpCode({ body })).toBeNull();
  });

  // Regression: "code is 483920." — a code ending a sentence. Treating the
  // full stop as a decimal point rejected the commonest wording in the format.
  it('accepts a code that ends a sentence', () => {
    expect(detectOtpCode({ body: 'Your verification code is 483920.' })?.code).toBe('483920');
  });

  // Regression: a full stop or colon followed by a digit really is a decimal,
  // a version or a clock time, and must still be rejected.
  it.each([
    ['a decimal amount', 'Your verification code invoice 123456.75'],
    ['a version number', 'Your verification code build 123456.2'],
  ])('rejects %s', (_label, body) => {
    expect(detectOtpCode({ body })).toBeNull();
  });

  // Regression: the subject is the higher-signal location and arrives first;
  // if the body could outrank it the card would flip codes mid-countdown.
  it('prefers the subject when both carry a code', () => {
    const detection = detectOtpCode({
      subject: 'Your verification code is 111111',
      body: 'Your verification code is 222222',
    });
    expect(detection?.code).toBe('111111');
    expect(detection?.source).toBe('subject');
  });

  // Regression: scanning is bounded so a multi-megabyte newsletter cannot
  // stall the main thread. A code past the bound is deliberately not found.
  it('does not scan past MAX_SCAN_CHARS', () => {
    const padding = 'a'.repeat(MAX_SCAN_CHARS + 50);
    expect(detectOtpCode({ body: `${padding} your verification code is 483920` })).toBeNull();
  });

  // Regression: mail arrives with missing/empty fields constantly; a throw here
  // fails the whole workflow run for that message.
  it.each([
    ['both missing', {}],
    ['both null', { subject: null, body: null }],
    ['both empty', { subject: '', body: '' }],
  ])('returns null for %s', (_label, input) => {
    expect(detectOtpCode(input)).toBeNull();
  });

  // Regression: the countdown is the feature. When the mail states its own
  // validity we must use it, and say that we did.
  it('uses the validity the mail states', () => {
    const detection = detectOtpCode({ body: 'Your verification code is 483920. It expires in 5 minutes.' });
    expect(detection?.expiresInMs).toBe(5 * 60 * 1000);
    expect(detection?.expiryFromMail).toBe(true);
  });

  // Regression: without a stated validity we must still show a countdown, but
  // must not claim the mail said so.
  it('falls back to the default validity', () => {
    const detection = detectOtpCode({ body: 'Your verification code is 483920.' });
    expect(detection?.expiresInMs).toBe(DEFAULT_EXPIRY_MS);
    expect(detection?.expiryFromMail).toBe(false);
  });

  // Regression: the code is often in the subject while the validity is only in
  // the body. Reading one source only loses the real expiry.
  it('reads the validity from the body when the code is in the subject', () => {
    const detection = detectOtpCode({
      subject: '284917 is your verification code',
      body: 'This code is valid for 30 seconds.',
    });
    expect(detection?.code).toBe('284917');
    expect(detection?.expiresInMs).toBe(30_000);
  });
});

describe('parseStatedExpiry', () => {
  // Regression: every unit the phrase regex accepts must convert correctly —
  // a minutes/seconds mix-up shows a 10-second countdown for a 10-minute code.
  it.each([
    ['expires in 45 seconds', 45_000],
    ['valid for 90 sec', 90_000],
    ['expires in 10 minutes', 10 * 60 * 1000],
    ['good for 5 min', 5 * 60 * 1000],
    ['valid within 2 hours', 2 * 3_600_000],
    ['expires in 1 hr', 3_600_000],
  ])('parses %s', (text, expected) => {
    expect(parseStatedExpiry(text)).toBe(expected);
  });

  // Regression: text with no validity statement must return null so the caller
  // falls back to the default rather than to NaN.
  it('returns null when no validity is stated', () => {
    expect(parseStatedExpiry('Your verification code is 483920.')).toBeNull();
  });

  // Regression: a zero or malformed amount must not produce an already-expired
  // card that vanishes the instant it appears.
  it('returns null for a zero duration', () => {
    expect(parseStatedExpiry('expires in 0 minutes')).toBeNull();
  });
});

/**
 * Context signals folded into the score: the spans a code cannot be in, who
 * sent it, and whether the message is who it claims to be.
 */
describe('detectOtpCode — context signals', () => {
  // The REPORTED BUG, end to end and in the sender's own words. A Google
  // Calendar invite surfaced a card for 631606 at 0.92 confidence, taken from
  // the middle of the dial-in number +1 631-606-4341 because Google's own
  // "PIN:" sat one character away. The user opened the message and there was no
  // such code anywhere in it. If this goes red, that card is back.
  it('finds no code in a Google Calendar invite', () => {
    const body = [
      'When',
      'Wednesday Sep 23, 2026 - 4:30pm - 5pm (India Standard Time - Kolkata)',
      'Guests',
      'Mahima Kumawat - organizer',
      'Join by phone',
      '(US) +1 631-606-4341 PIN: 192405006',
      'More phone numbers',
    ].join('\n');

    expect(detectOtpCode({ subject: 'Invitation: Amit Kumar - R2', body })).toBeNull();
  });

  // Regression: rejecting only the grouped `631-606` match is NOT enough — the
  // plain-digit pass then picks up `4341` from the same phone number, still
  // beside "PIN:", and scores it around 0.75. The whole span has to go.
  it('takes no candidate from any part of a dial-in number', () => {
    const detection = detectOtpCode({ body: 'Join by phone (US) +1 631-606-4341 PIN: 192405006' });
    expect(detection).toBeNull();
  });

  // Regression: a tracking or verification link is full of code-shaped digits
  // and usually sits right beside the word "verify" or "code".
  it('takes no code from a URL or its query string', () => {
    expect(
      detectOtpCode({ body: 'Verify your email: https://acme.example/confirm?code=837261&uid=9012' })
    ).toBeNull();
  });

  // Regression: the masking must not cost a real code. This is the commonest
  // shape of OTP mail there is and it has a link right beside it.
  it('still finds the code in a message that also carries a link', () => {
    const detection = detectOtpCode({
      body: 'Your verification code is 483920. Or open https://acme.example/v?t=778899 to confirm.',
    });
    expect(detection?.code).toBe('483920');
  });

  // Regression: a phone number in the FOOTER of a genuine passcode mail — which
  // is most of them — must not suppress the code above it.
  it('finds the code in passcode mail whose footer carries a support number', () => {
    const detection = detectOtpCode({
      body: 'Your login code is 774120.\n\nQuestions? Call us on +1 631-606-4341.',
    });
    expect(detection?.code).toBe('774120');
  });

  // A code repeated in the subject and the body is a provider making sure it
  // survives the preview pane — a strong signal, and the repetition must not
  // instead confuse the pick.
  it('scores a code repeated in subject and body above the same code seen once', () => {
    const repeated = detectOtpCode({
      subject: 'Your code is 552310',
      body: 'Your verification code is 552310.',
    });
    const once = detectOtpCode({ body: 'Your verification code is 552310.' });

    expect(repeated?.code).toBe('552310');
    expect(repeated!.confidence).toBeGreaterThan(once!.confidence);
  });

  // A transactional mailbox is a weak positive. It must MOVE the score without
  // ever being required — gating on it would drop codes from ordinary senders.
  it('credits a transactional sender without requiring one', () => {
    const noreply = detectOtpCode({
      body: 'Your verification code is 483920.',
      fromAddress: 'no-reply@acme.example',
    });
    const person = detectOtpCode({
      body: 'Your verification code is 483920.',
      fromAddress: 'mahima@sarv.com',
    });

    expect(noreply!.confidence).toBeGreaterThan(person!.confidence);
    expect(person?.code).toBe('483920');
  });

  // Regression: a passcode card is the highest-trust surface in the app. A
  // message whose sending domain is being impersonated must clear a much higher
  // bar before one stands for it, or the extension amplifies phishing.
  it('raises no card for a single-mention code in a spoofed message', () => {
    const body = 'Your verification code is 483920.';
    const failed = JSON.stringify({ spf: 'fail', dkim: 'fail', dmarc: 'fail', overall: 'fail' });

    expect(detectOtpCode({ body })?.code).toBe('483920');
    expect(detectOtpCode({ body, authStatus: failed })).toBeNull();
  });

  // Not a veto, though: a code stated clearly enough — repeated in the subject,
  // the way real providers send them — still surfaces. A spoofed message has to
  // clear a much higher bar, not an impossible one, because SPF/DKIM verdicts
  // are wrong often enough that a hard block would hide real codes.
  it('still surfaces an emphatically-stated code from a spoofed message', () => {
    const detection = detectOtpCode({
      subject: 'Your code is 483920',
      body: 'Your verification code is 483920.',
      authStatus: JSON.stringify({ overall: 'fail' }),
    });

    expect(detection?.code).toBe('483920');
  });

  // Regression: mail crossing a forwarder or a mailing list reports `none` or
  // `partial` as a matter of course. Penalising those would suppress cards for
  // perfectly good codes — the failure users actually notice and report.
  it.each(['none', 'partial', 'pass'])(
    'does not penalise an overall verdict of %s',
    (overall) => {
      const detection = detectOtpCode({
        body: 'Your verification code is 483920.',
        authStatus: JSON.stringify({ overall }),
      });
      const clean = detectOtpCode({ body: 'Your verification code is 483920.' });

      expect(detection!.confidence).toBe(clean!.confidence);
    }
  );

  // A malformed verdict must read as "no opinion" rather than throw inside a
  // workflow that is holding up the mail pipeline.
  it('ignores an unparseable authStatus', () => {
    expect(
      detectOtpCode({ body: 'Your verification code is 483920.', authStatus: '{not json' })?.code
    ).toBe('483920');
  });

  // Regression: an 8-digit date next to an order confirmation's "code" wording
  // is inside the passcode length range and would otherwise score.
  it('does not offer a date stamp as a code', () => {
    expect(detectOtpCode({ body: 'Order code: 20260923 shipped' })).toBeNull();
  });
});
