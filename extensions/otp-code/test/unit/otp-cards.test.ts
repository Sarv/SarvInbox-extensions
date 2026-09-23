import type { EmailRecord } from '@sarvinbox/extension-sdk';
import { describe, expect, it } from 'vitest';

import {
  MAX_TRACKED_CARDS,
  createCardIndex,
  decideCard,
  messageKey,
  rememberCard,
  resolveTarget,
} from '../../src/otp-cards';
import { notificationId } from '../../src/otp-notification';

/**
 * One card per message, and the right copy of it when the reader clicks.
 *
 * What breaks if this file goes red: the duplicate that started it. The same
 * address read through two servers delivers one message twice, and before this
 * the reader got two identical code cards stacked on each other with countdowns
 * seconds apart. The other half is the click: one card now stands for two
 * mailboxes, so marking read has to pick one, and picking wrong files a message
 * in an account the reader is not even looking at.
 */

type Copy = Pick<EmailRecord, 'id' | 'accountId' | 'messageId'>;

function copy(overrides: Partial<Copy> = {}): Copy {
  return {
    id: 'email-1',
    accountId: 'account-1',
    messageId: '<abc@sender.example>',
    ...overrides,
  } as Copy;
}

describe('messageKey', () => {
  // The two copies differ in every field except this one; if the brackets or
  // surrounding whitespace leak into the key they stop matching and the
  // duplicate card comes back.
  it('is the same for two copies of one message however they were stored', () => {
    expect(messageKey(copy({ id: 'a', messageId: '<abc@sender.example>' }))).toBe(
      messageKey(copy({ id: 'b', messageId: '  abc@sender.example ' }))
    );
  });

  // Case is deliberately not folded: two ids differing only by case are two
  // different messages, and merging them would hide a real code.
  it('keeps two ids that differ only by case apart', () => {
    expect(messageKey(copy({ messageId: '<ABC@sender.example>' }))).not.toBe(
      messageKey(copy({ messageId: '<abc@sender.example>' }))
    );
  });

  // Mail with no Message-ID must NOT all collapse into one card - that would
  // turn "no header" into "every code is the same code".
  it('falls back to the email id when there is no Message-ID', () => {
    expect(messageKey(copy({ id: 'a', messageId: undefined }))).not.toBe(
      messageKey(copy({ id: 'b', messageId: undefined }))
    );
    expect(messageKey(copy({ id: 'a', messageId: '  ' }))).toBe(
      messageKey(copy({ id: 'a', messageId: undefined }))
    );
  });
});

describe('decideCard', () => {
  // The regression itself: one message, two accounts, one card.
  it('folds a second account copy into the first card instead of raising another', () => {
    const index = createCardIndex();
    const first = copy({ id: 'email-1', accountId: 'account-1' });

    const shown = decideCard(index, first, '081678');
    expect(shown).toEqual({ cardId: notificationId('email-1'), show: true });
    rememberCard(index, first, shown.cardId, '081678');

    const second = decideCard(index, copy({ id: 'email-2', accountId: 'account-2' }), '081678');
    expect(second).toEqual({ cardId: notificationId('email-1'), show: false });
  });

  // The workflow runs twice per message (headers, then body). The second run
  // must not restart a countdown the reader is already watching.
  it('does not re-show the same code for the same email', () => {
    const index = createCardIndex();
    const email = copy();
    rememberCard(index, email, decideCard(index, email, '081678').cardId, '081678');

    expect(decideCard(index, email, '081678').show).toBe(false);
  });

  // The body stage can find a better code than the subject stage did; that one
  // has to replace what is on screen, under the same id, not stack beside it.
  it('replaces the card in place when the code changes', () => {
    const index = createCardIndex();
    const email = copy();
    rememberCard(index, email, decideCard(index, email, '111111').cardId, '111111');

    expect(decideCard(index, email, '222222')).toEqual({
      cardId: notificationId('email-1'),
      show: true,
    });
  });

  // Two genuinely different messages are two codes; merging them would show one
  // and silently swallow the other.
  it('raises a separate card for a different message', () => {
    const index = createCardIndex();
    const first = copy({ id: 'email-1', messageId: '<one@sender.example>' });
    rememberCard(index, first, decideCard(index, first, '111111').cardId, '111111');

    const second = copy({ id: 'email-2', messageId: '<two@sender.example>' });
    expect(decideCard(index, second, '222222')).toEqual({
      cardId: notificationId('email-2'),
      show: true,
    });
  });
});

describe('rememberCard', () => {
  // The index lives for the life of the process; unbounded it is a slow leak.
  it('evicts oldest-first past the cap, from both views', () => {
    const index = createCardIndex();
    for (let n = 0; n < MAX_TRACKED_CARDS + 10; n += 1) {
      const email = copy({ id: `email-${n}`, messageId: `<m${n}@sender.example>` });
      rememberCard(index, email, notificationId(email.id), '000000');
    }

    expect(index.byMessage.size).toBe(MAX_TRACKED_CARDS);
    expect(index.byCardId.size).toBe(MAX_TRACKED_CARDS);
    expect(index.byCardId.has(notificationId('email-0'))).toBe(false);
    expect(index.byCardId.has(notificationId(`email-${MAX_TRACKED_CARDS + 9}`))).toBe(true);
  });

  // A workflow re-run for the same email must not grow the target list; a
  // duplicate target is a duplicate mark-read candidate.
  it('records each copy once however often the workflow re-runs', () => {
    const index = createCardIndex();
    const email = copy();
    rememberCard(index, email, notificationId(email.id), '111111');
    rememberCard(index, email, notificationId(email.id), '222222');

    expect(index.byCardId.get(notificationId('email-1'))?.targets).toEqual([
      { emailId: 'email-1', accountId: 'account-1' },
    ]);
  });
});

describe('resolveTarget', () => {
  function twoAccounts() {
    const index = createCardIndex();
    const first = copy({ id: 'email-1', accountId: 'account-1' });
    const second = copy({ id: 'email-2', accountId: 'account-2' });
    const cardId = decideCard(index, first, '081678').cardId;
    rememberCard(index, first, cardId, '081678');
    rememberCard(index, second, cardId, '081678');
    return { index, cardId };
  }

  // The request: one card for two mailboxes, so the read lands in the mailbox
  // the reader is actually sitting in - not whichever account synced first.
  it('prefers the account the reader is looking at', () => {
    const { index, cardId } = twoAccounts();

    expect(
      resolveTarget(index, { notificationId: cardId, action: 'copy', activeAccountId: 'account-2' })
    ).toEqual({ emailId: 'email-2', accountId: 'account-2' });
  });

  // A unified view selects no single account; the card's own account is then
  // the best answer available.
  it('falls back to the account that raised the card', () => {
    const { index, cardId } = twoAccounts();

    expect(
      resolveTarget(index, { notificationId: cardId, action: 'copy', accountId: 'account-2' })
    ).toEqual({ emailId: 'email-2', accountId: 'account-2' });
  });

  // Reading a third account is not a reason to file nothing.
  it('files the first copy seen when neither account matches', () => {
    const { index, cardId } = twoAccounts();

    expect(
      resolveTarget(index, { notificationId: cardId, action: 'copy', activeAccountId: 'account-9' })
    ).toEqual({ emailId: 'email-1', accountId: 'account-1' });
  });

  // Regression: the main process can restart while a card is still on screen,
  // emptying the index. That click still has to file something, or copying a
  // code silently stops marking mail read after every reload.
  it('honours a click on a card it no longer remembers', () => {
    const index = createCardIndex();

    expect(
      resolveTarget(index, {
        notificationId: notificationId('email-1'),
        action: 'copy',
        emailId: 'email-2',
      })
    ).toEqual({ emailId: 'email-2' });

    expect(
      resolveTarget(index, { notificationId: notificationId('email-1'), action: 'copy' })
    ).toEqual({ emailId: 'email-1' });
  });

  // Moved here from index.test.ts when resolution moved out of the wiring: a
  // card id this extension did not make resolves to nothing rather than to a
  // guess that would mark an unrelated message read.
  it('is null for a card id that is not one of ours', () => {
    const index = createCardIndex();

    expect(
      resolveTarget(index, { notificationId: 'other:email-1', action: 'copy' })
    ).toBeNull();
    expect(resolveTarget(index, { notificationId: 'code:', action: 'copy' })).toBeNull();
  });
});
