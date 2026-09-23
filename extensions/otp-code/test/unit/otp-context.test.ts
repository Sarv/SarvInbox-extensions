import { describe, it, expect } from 'vitest';

import {
  failsAuthentication,
  hasDialInContext,
  isTransactionalSender,
  looksLikeDateStamp,
  maskNonCodeSpans,
  parseAuthOverall,
} from '../../src/otp-context';

describe('maskNonCodeSpans', () => {
  // Regression: the whole reason this module exists. A Google Calendar invite
  // raised a card for 631606, sliced out of the dial-in number, because
  // Google's own "PIN:" sat one character away. If this goes red the extension
  // is back to offering users a fragment of a phone number as their passcode.
  it('blanks a dial-in phone number', () => {
    const masked = maskNonCodeSpans('(US) +1 631-606-4341 PIN: 192405006');
    expect(masked).not.toContain('631-606');
    expect(masked).toContain('PIN:');
  });

  // Regression: the detector scores a candidate by its INDEX — distance to the
  // nearest keyword, the characters either side. A mask that changed the length
  // would move every later candidate away from the keyword justifying it, so a
  // real code after a phone number would silently stop being found.
  it('preserves length exactly, so every index still points where it did', () => {
    const text = 'Call +1 631-606-4341 or visit https://acme.example/x?token=99887 now';
    expect(maskNonCodeSpans(text)).toHaveLength(text.length);
  });

  // Regression: two groups is the `123 456` passcode format Google and others
  // send. Masking it would delete the commonest grouped code there is.
  it.each([
    ['space', 'Your code is 123 456'],
    ['hyphen', 'Your code is 123-456'],
  ])('leaves a two-group code separated by a %s alone', (_label, text) => {
    expect(maskNonCodeSpans(text)).toBe(text);
  });

  // The digit-count rule is what separates the two: 9+ digits is a phone
  // number, and PLAIN_CODE stops at 8, so the sets provably cannot overlap.
  it('leaves a three-group run alone when it is too short to be a phone number', () => {
    const text = 'Code: 12 34 56';
    expect(maskNonCodeSpans(text)).toBe(text);
  });

  it('blanks an international number written with spaces', () => {
    expect(maskNonCodeSpans('Call +91 98765 43210 today')).not.toContain('98765 43210');
  });

  // Regression: a tracking link is full of code-shaped digits, and an
  // unsubscribe URL sitting near the word "code" would otherwise score.
  it('blanks a URL and its query parameters', () => {
    const masked = maskNonCodeSpans('Verify at https://acme.example/v?token=928371&uid=44512 now');
    expect(masked).not.toContain('928371');
    expect(masked).not.toContain('44512');
    expect(masked).toContain('Verify at');
    expect(masked).toContain('now');
  });

  // Regression: a meeting link carries a code-shaped id and no scheme.
  it('blanks a schemeless meeting link', () => {
    expect(maskNonCodeSpans('meet.google.com/yck-ocxx-jou')).not.toContain('yck-ocxx-jou');
  });

  // A masked span must read as a word boundary, or a digit run beside it could
  // glue onto the hole and be re-read as one longer candidate.
  it('replaces with spaces rather than closing the gap', () => {
    expect(maskNonCodeSpans('a https://x.example/1 b')).toBe('a                     b');
  });

  it('handles empty input without throwing', () => {
    expect(maskNonCodeSpans('')).toBe('');
  });
});

describe('hasDialInContext', () => {
  // Regression: the backstop for a meeting number the mask does not recognise
  // (an extension, a short code, digits split across markup). Without it, a
  // calendar invite with an unusual dial-in format raises a card again.
  it.each([
    'join by phone',
    'more phone numbers',
    'meeting id',
    'dial-in',
  ])('rejects a candidate sitting near "%s"', (phrase) => {
    const text = `${phrase} 555 0199 pin: 123456`;
    expect(hasDialInContext(text.toLowerCase(), text.length - 6)).toBe(true);
  });

  // The window has to be bounded or an invite's footer would suppress a genuine
  // code much further down a long message.
  it('ignores a dial-in phrase beyond the window', () => {
    const text = `join by phone${' '.repeat(200)}your code is 123456`;
    expect(hasDialInContext(text.toLowerCase(), text.length - 6)).toBe(false);
  });

  it('leaves ordinary passcode mail untouched', () => {
    const text = 'your verification code is 483920';
    expect(hasDialInContext(text, text.length - 6)).toBe(false);
  });
});

describe('isTransactionalSender', () => {
  it.each([
    'no-reply@acme.example',
    'noreply.practice@expandtesting.com',
    'security@bank.example',
    'accounts@service.example',
  ])('recognises %s', (address) => {
    expect(isTransactionalSender(address)).toBe(true);
  });

  // A weak POSITIVE only — never a requirement. Plenty of real codes come from
  // ordinary addresses, and gating on this would suppress them.
  it('does not claim an ordinary sender', () => {
    expect(isTransactionalSender('mahima@sarv.com')).toBe(false);
  });

  // The domain must not be read as the local part, or every message from
  // `support.example` would score a bonus it did not earn.
  it('reads the local part only', () => {
    expect(isTransactionalSender('mahima@security-services.example')).toBe(false);
  });

  it.each([null, undefined, ''])('treats %s as unknown', (address) => {
    expect(isTransactionalSender(address)).toBe(false);
  });
});

describe('parseAuthOverall / failsAuthentication', () => {
  it('reads the rolled-up verdict the host stored', () => {
    expect(parseAuthOverall(JSON.stringify({ spf: 'fail', dkim: 'fail', overall: 'fail' }))).toBe('fail');
  });

  // Regression: a passcode card is the highest-trust surface this app has.
  // Showing one for a message whose sending domain is being impersonated turns
  // the extension into a phishing amplifier.
  it('penalises an outright authentication failure', () => {
    expect(failsAuthentication(JSON.stringify({ overall: 'fail' }))).toBe(true);
  });

  // Regression: `none` and `partial` are the NORMAL state of mail that crossed
  // a forwarder or a mailing list. Treating them as failures would suppress
  // cards for legitimate codes — the failure mode users actually notice.
  it.each(['none', 'partial', 'pass'])('does not penalise an overall of %s', (overall) => {
    expect(failsAuthentication(JSON.stringify({ overall }))).toBe(false);
  });

  // Malformed JSON must read as "no opinion", never throw: this runs inside a
  // workflow that is holding up the mail pipeline.
  it.each(['not json', '', null, undefined, 42, 'null', '"a string"', '{"overall":7}'])(
    'treats %s as no opinion',
    (value) => {
      expect(parseAuthOverall(value)).toBeNull();
      expect(failsAuthentication(value)).toBe(false);
    }
  );
});

describe('looksLikeDateStamp', () => {
  // Regression: an 8-digit order or shipment date next to the word "code" is a
  // common false positive, and 8 digits is inside the passcode length range.
  it.each(['20260923', '19991231', '23092026'])('rejects %s', (code) => {
    expect(looksLikeDateStamp(code)).toBe(true);
  });

  it.each(['483920', '12345678', '00000000'])('accepts %s as a possible code', (code) => {
    expect(looksLikeDateStamp(code)).toBe(false);
  });
});
