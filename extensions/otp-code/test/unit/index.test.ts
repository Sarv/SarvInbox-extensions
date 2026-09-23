import type {
  EmailRecord,
  ExtensionContext,
  ExtensionUIAction,
  ExtensionUIActionHandler,
  ExtensionUINotification,
  ExtensionWorkflow,
} from '@sarvinbox/extension-sdk';
import { describe, it, expect } from 'vitest';


import { activate, resolveMinConfidence } from '../../src/index';
import { MIN_CONFIDENCE } from '../../src/otp-detect';

const NOW_SECONDS = Math.floor(Date.now() / 1000);

interface Harness {
  workflow: ExtensionWorkflow;
  notified: ExtensionUINotification[];
  dismissed: string[];
  errors: unknown[][];
  /** Deliver a card action the way the host does after the reader clicks. */
  act: (action: ExtensionUIAction) => Promise<void>;
  /** Every `mail.*` call the extension made, in order. */
  mailCalls: Array<{ method: string; emailId: string }>;
}

function activateHarness(
  settings: Record<string, unknown> = {},
  onNotify?: (notification: ExtensionUINotification) => void,
  markReadFails?: Error
): Harness {
  const notified: ExtensionUINotification[] = [];
  const dismissed: string[] = [];
  const errors: unknown[][] = [];
  const mailCalls: Array<{ method: string; emailId: string }> = [];
  const actionHandlers: ExtensionUIActionHandler[] = [];
  let workflow: ExtensionWorkflow | undefined;

  const context = {
    manifest: { id: 'otp-code' },
    storagePath: '/tmp/otp-code',
    registerWorkflow: (registered: ExtensionWorkflow) => {
      workflow = registered;
    },
    unregisterWorkflow: () => undefined,
    settings: {
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
      update: async () => undefined,
      has: (key: string) => key in settings,
    },
    ui: {
      notify: (notification: ExtensionUINotification) => {
        onNotify?.(notification);
        notified.push(notification);
      },
      dismiss: (id: string) => dismissed.push(id),
      onAction: (handler: ExtensionUIActionHandler) => {
        actionHandlers.push(handler);
        return () => {
          const at = actionHandlers.indexOf(handler);
          if (at >= 0) actionHandlers.splice(at, 1);
        };
      },
    },
    mail: {
      markRead: async (emailId: string) => {
        mailCalls.push({ method: 'markRead', emailId });
        if (markReadFails) throw markReadFails;
      },
    },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => errors.push(args),
    },
    subscriptions: [],
  } as unknown as ExtensionContext;

  activate(context);
  if (!workflow) throw new Error('activate did not register a workflow');

  const act = async (action: ExtensionUIAction): Promise<void> => {
    for (const handler of actionHandlers) await handler(action);
  };

  return { workflow, notified, dismissed, errors, act, mailCalls };
}

function makeEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'email-1',
    accountId: 'account-1',
    subject: 'Security alert',
    cleanBody: 'Your verification code is 483920.',
    fromName: 'Sarv Security',
    fromAddress: 'no-reply@sarv.com',
    date: NOW_SECONDS,
    receivedDate: NOW_SECONDS,
    ...overrides,
  } as unknown as EmailRecord;
}

const NO_CONTEXT = {} as never;

describe('resolveMinConfidence', () => {
  // Regression: a corrupted or hand-edited settings file must not be able to
  // set the floor to 0 and turn every number in every email into a card, nor
  // to a string that makes every comparison false and silences the extension.
  it.each([
    ['missing', undefined],
    ['a string', '0.8'],
    ['NaN', Number.NaN],
    ['above one', 1.5],
    ['negative', -1],
  ])('falls back to the default when the setting is %s', (_label, value) => {
    expect(resolveMinConfidence(value)).toBe(MIN_CONFIDENCE);
  });

  // Regression: a legitimate in-range value must actually be honoured,
  // otherwise the setting is decorative.
  it('honours an in-range value', () => {
    expect(resolveMinConfidence(0.8)).toBe(0.8);
  });
});

describe('otp-code workflow', () => {
  // Regression: the workflow must re-run once the body lands, or codes that
  // are not in the subject are never found.
  it('registers a workflow that re-runs after the body is fetched', () => {
    expect(activateHarness().workflow.requiresBody).toBe(true);
  });

  // Regression: a disabled extension must do nothing at all — no card, no tag,
  // and no per-email detection cost.
  it('does not process anything when disabled', async () => {
    const { workflow } = activateHarness({ 'otp-code.enabled': false });
    expect(await workflow.shouldProcess(makeEmail())).toBe(false);
  });

  // Regression: an email with neither subject nor body cannot contain a code;
  // scanning it is pure waste on every message of a header-only sync.
  it('skips an email with nothing to read', async () => {
    const { workflow } = activateHarness();
    expect(await workflow.shouldProcess(makeEmail({ subject: '', cleanBody: '' }))).toBe(false);
  });

  // Regression: the whole feature — a fresh code produces a card and a tag.
  it('shows a card and tags the email', async () => {
    const harness = activateHarness();
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.success).toBe(true);
    expect(result.labelsToAdd).toEqual(['otp']);
    expect(harness.notified).toHaveLength(1);
    expect(harness.notified[0].fields?.[0].value).toBe('483920');
  });

  // Regression: the workflow runs twice per message (arrival, then body). A
  // second card would restart a countdown the user is already watching.
  it('does not re-show the same code on the body-stage re-run', async () => {
    const harness = activateHarness();
    const email = makeEmail({ subject: '284917 is your verification code' });

    await harness.workflow.process(email, NO_CONTEXT);
    await harness.workflow.process(email, NO_CONTEXT);

    expect(harness.notified).toHaveLength(1);
  });

  // Regression: a provider that re-sends a new code for the same thread must
  // still surface it; deduplication is per code, not per email.
  it('shows a new code for the same email', async () => {
    const harness = activateHarness();
    await harness.workflow.process(makeEmail(), NO_CONTEXT);
    await harness.workflow.process(
      makeEmail({ cleanBody: 'Your verification code is 111222.' }),
      NO_CONTEXT
    );

    expect(harness.notified).toHaveLength(2);
  });

  // Regression: backfilling an old mailbox must not fire a burst of cards for
  // long-dead codes — but the mail is still tagged so it stays findable.
  it('tags but does not interrupt for old mail', async () => {
    const harness = activateHarness();
    const old = makeEmail({ date: NOW_SECONDS - 86_400, receivedDate: NOW_SECONDS - 86_400 });
    const result = await harness.workflow.process(old, NO_CONTEXT);

    expect(result.labelsToAdd).toEqual(['otp']);
    expect(harness.notified).toHaveLength(0);
  });

  // Regression: a user who only wants the card must not have their mail
  // silently relabelled.
  it('omits the tag when tagging is turned off', async () => {
    const harness = activateHarness({ 'otp-code.tagEmails': false });
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.labelsToAdd).toBeUndefined();
    expect(harness.notified).toHaveLength(1);
  });

  // Regression: raising the floor must actually suppress weaker detections,
  // and it must not throw when nothing is found.
  it('suppresses a detection below the configured floor', async () => {
    const harness = activateHarness({ 'otp-code.minConfidence': 0.99 });
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.success).toBe(true);
    expect(result.labelsToAdd).toBeUndefined();
    expect(harness.notified).toHaveLength(0);
  });

  // Regression: an email with no code must complete successfully and quietly;
  // a thrown or failed result would mark the workflow broken for that message.
  it('succeeds quietly when there is no code', async () => {
    const harness = activateHarness();
    const result = await harness.workflow.process(
      makeEmail({ subject: 'Lunch?', cleanBody: 'See you at 1.' }),
      NO_CONTEXT
    );

    expect(result).toEqual({ success: true });
    expect(harness.notified).toHaveLength(0);
  });

  // Regression: a fault in the UI bridge must not stop the message being
  // stored or the rest of the pipeline running — it is reported, not thrown.
  it('reports a UI failure instead of throwing', async () => {
    const boom = new Error('window is gone');
    const harness = activateHarness({}, () => {
      throw boom;
    });

    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error).toBe(boom);
    expect(harness.errors).toHaveLength(1);
  });
});

/**
 * Marking the message read once its code has been copied.
 *
 * What breaks if this block goes red: the extension goes back to being
 * write-once — it can show a code but cannot act on the reader taking it, so
 * every verification mail stays bold in the list after it has been used. The
 * distinctions pinned here are the ones that make that safe: only a COPY counts
 * (a dismissal or an expiry means the code went unused, and marking that read
 * would hide a message still needed), and a host that refuses the change must
 * not take the extension down with it.
 */
describe('marking read on copy', () => {
  it('marks the copied message read', async () => {
    const harness = activateHarness();

    await harness.act({ notificationId: 'code:email-1', action: 'copy', emailId: 'email-1' });

    expect(harness.mailCalls).toEqual([{ method: 'markRead', emailId: 'email-1' }]);
  });

  // Regression: the host may omit `emailId` on an older build. The card id it
  // does send carries the message id, because the extension minted it.
  it('recovers the message id from the card id when the action omits it', async () => {
    const harness = activateHarness();

    await harness.act({ notificationId: 'code:email-7', action: 'copy' });

    expect(harness.mailCalls).toEqual([{ method: 'markRead', emailId: 'email-7' }]);
  });

  it.each(['dismiss', 'expire', 'open'] as const)('does nothing on a %s', async (action) => {
    const harness = activateHarness();

    await harness.act({ notificationId: 'code:email-1', action, emailId: 'email-1' });

    expect(harness.mailCalls).toEqual([]);
  });

  it('does nothing when the reader turned the setting off', async () => {
    const harness = activateHarness({ 'otp-code.markReadOnCopy': false });

    await harness.act({ notificationId: 'code:email-1', action: 'copy', emailId: 'email-1' });

    expect(harness.mailCalls).toEqual([]);
  });

  it('is on unless the reader turned it off', async () => {
    const harness = activateHarness({ 'otp-code.markReadOnCopy': true });

    await harness.act({ notificationId: 'code:email-1', action: 'copy', emailId: 'email-1' });

    expect(harness.mailCalls).toHaveLength(1);
  });

  // Regression: a refused permission or a message that has since been deleted
  // must not throw out of the handler — the host would log an extension crash
  // for what is an ordinary outcome, and the copy already succeeded.
  it('survives a host that refuses the change', async () => {
    const harness = activateHarness({}, undefined, new Error('email:flag was not granted'));

    await expect(
      harness.act({ notificationId: 'code:email-1', action: 'copy', emailId: 'email-1' })
    ).resolves.toBeUndefined();
  });

  it('does nothing when neither the action nor the card names a message', async () => {
    const harness = activateHarness();

    await harness.act({ notificationId: 'something-else', action: 'copy' });

    expect(harness.mailCalls).toEqual([]);
  });
});

describe('one message delivered to two accounts', () => {
  const MESSAGE_ID = '<code-081678@sender.example>';

  async function bothCopies(harness: Harness): Promise<void> {
    await harness.workflow.process(
      makeEmail({ id: 'email-1', accountId: 'account-1', messageId: MESSAGE_ID }),
      NO_CONTEXT
    );
    await harness.workflow.process(
      makeEmail({ id: 'email-2', accountId: 'account-2', messageId: MESSAGE_ID }),
      NO_CONTEXT
    );
  }

  // Regression: the same address read through two IMAP servers delivered one
  // message twice, and the card id was built from the email id - so the reader
  // got two identical code cards stacked up, countdowns seconds out of step.
  it('raises one card, not two', async () => {
    const harness = activateHarness();

    await bothCopies(harness);

    expect(harness.notified).toHaveLength(1);
    expect(harness.notified[0]?.emailId).toBe('email-1');
  });

  // The whole point of folding the two together: the reader is in the second
  // account, so that is the copy that should stop being unread.
  it('marks the copy in the account the reader is looking at', async () => {
    const harness = activateHarness();
    await bothCopies(harness);

    await harness.act({
      notificationId: harness.notified[0]!.id,
      action: 'copy',
      emailId: 'email-1',
      accountId: 'account-1',
      activeAccountId: 'account-2',
    });

    expect(harness.mailCalls).toEqual([{ method: 'markRead', emailId: 'email-2' }]);
  });

  // No account selected (a unified view) is not a reason to file nothing; the
  // account that raised the card is the best answer left.
  it('falls back to the card owner when no account is selected', async () => {
    const harness = activateHarness();
    await bothCopies(harness);

    await harness.act({
      notificationId: harness.notified[0]!.id,
      action: 'copy',
      emailId: 'email-1',
      accountId: 'account-1',
    });

    expect(harness.mailCalls).toEqual([{ method: 'markRead', emailId: 'email-1' }]);
  });

  // Two genuinely different messages must still get their own card, or a second
  // code arriving while the first is on screen would never be shown.
  it('still raises a second card for a different message', async () => {
    const harness = activateHarness();

    await harness.workflow.process(
      makeEmail({ id: 'email-1', messageId: '<one@sender.example>' }),
      NO_CONTEXT
    );
    await harness.workflow.process(
      makeEmail({
        id: 'email-2',
        messageId: '<two@sender.example>',
        cleanBody: 'Your verification code is 112233.',
      }),
      NO_CONTEXT
    );

    expect(harness.notified).toHaveLength(2);
  });

  // Regression: the accounts do not sync in step. A backlogged copy that is too
  // old to interrupt anyone for must not claim the card and then silence the
  // copy that arrives fresh a minute later.
  it('lets a fresh copy card a message whose stale copy arrived first', async () => {
    const harness = activateHarness();
    const stale = NOW_SECONDS - 60 * 60;

    await harness.workflow.process(
      makeEmail({ id: 'email-1', messageId: MESSAGE_ID, date: stale, receivedDate: stale }),
      NO_CONTEXT
    );
    expect(harness.notified).toHaveLength(0);

    await harness.workflow.process(
      makeEmail({ id: 'email-2', accountId: 'account-2', messageId: MESSAGE_ID }),
      NO_CONTEXT
    );

    expect(harness.notified).toHaveLength(1);
    expect(harness.notified[0]?.emailId).toBe('email-2');
  });
});
