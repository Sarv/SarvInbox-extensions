import { describe, it, expect } from 'vitest';

import { isCalendarInvite, shouldScanForCode } from '../../src/otp-gate';

describe('isCalendarInvite', () => {
  // Regression: a calendar invite is the densest source of code-shaped numbers
  // there is — dial-in number, meeting PIN, conference id and a date, all next
  // to the word "PIN". This is the fact that rules the whole genre out, and it
  // comes from the MIME structure, so an invite cannot dress its way past it.
  it('recognises a message the host parsed a calendar part from', () => {
    expect(isCalendarInvite({ calendarIcs: 'BEGIN:VCALENDAR\nEND:VCALENDAR' })).toBe(true);
  });

  // An empty or whitespace-only value means the host found nothing; treating it
  // as an invite would silence passcode cards for ordinary mail.
  it.each([null, undefined, '', '   '])('treats %s as not an invite', (calendarIcs) => {
    expect(isCalendarInvite({ calendarIcs })).toBe(false);
  });
});

describe('shouldScanForCode', () => {
  // Regression: the reported bug, stopped one phase earlier than the detector.
  it('refuses to scan a calendar invite', () => {
    expect(
      shouldScanForCode({
        subject: 'Invitation: Amit Kumar - R2 - Software Engineer',
        cleanBody: '(US) +1 631-606-4341 PIN: 192405006',
        calendarIcs: 'BEGIN:VCALENDAR',
      })
    ).toBe(false);
  });

  // Regression: the gate must stay PERMISSIVE about everything else. The
  // scoring model decides whether there is a code; a gate that demanded a
  // keyword in the subject would drop every provider that puts one only in the
  // body — which is most of them.
  it('scans an ordinary message with no passcode wording at all', () => {
    expect(shouldScanForCode({ subject: 'Hello', cleanBody: 'nothing here' })).toBe(true);
  });

  it('scans when only the subject has arrived', () => {
    expect(shouldScanForCode({ subject: '284917 is your code', cleanBody: '' })).toBe(true);
  });

  // Nothing to read is the cheapest possible rejection and runs on every
  // message that arrives.
  it('skips a message with neither subject nor body', () => {
    expect(shouldScanForCode({ subject: '', cleanBody: '' })).toBe(false);
  });
});
