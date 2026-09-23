import type {
  EmailRecord,
  ExtensionContext,
  ExtensionUINotification,
  ExtensionWorkflow,
} from '@sarvinbox/extension-sdk';
import { describe, expect, it } from 'vitest';

import { MIN_CONFIDENCE } from '../../src/receipt-detect';
import { TABLE_KEY } from '../../src/receipt-store';
import type { ReceiptSummary, ReceiptView } from '../../src/summary';
import {
  ANNOUNCED_KEY,
  RECEIPT_TAG,
  SUBSCRIPTION_TAG,
  activate,
  deactivate,
  resolveMinConfidence,
  tagsFor,
} from '../../src/index';
import { makeEmail } from '../helpers/email';
import { makeRecord } from '../helpers/record';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  workflow: ExtensionWorkflow;
  notified: ExtensionUINotification[];
  opened: Array<{ emailId: string; accountId?: string }>;
  errors: unknown[][];
  storage: Map<string, unknown>;
  exports: Record<string, unknown>;
  subscriptions: Array<() => void>;
  /** Fire a pipeline event the way the host does. */
  emit: (event: string) => void;
  /** Let the extension's own promises settle. */
  settle: () => Promise<void>;
}

function activateHarness(
  settings: Record<string, unknown> = {},
  stored: Record<string, unknown> = {}
): Harness {
  const notified: ExtensionUINotification[] = [];
  const opened: Array<{ emailId: string; accountId?: string }> = [];
  const errors: unknown[][] = [];
  const storage = new Map<string, unknown>(Object.entries(stored));
  const handlers = new Map<string, Array<() => void>>();
  const subscriptions: Array<() => void> = [];
  const exports: Record<string, unknown> = {};
  let workflow: ExtensionWorkflow | undefined;

  const context = {
    manifest: { id: 'receipts-tracker' },
    storagePath: '/tmp/receipts-tracker',
    registerWorkflow: (registered: ExtensionWorkflow) => {
      workflow = registered;
    },
    events: {
      on: (event: string, handler: () => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => undefined;
      },
      emit: () => undefined,
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      delete: async (key: string) => {
        storage.delete(key);
      },
      keys: async () => [...storage.keys()],
    },
    settings: {
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
      update: async () => undefined,
      has: (key: string) => key in settings,
    },
    ui: {
      notify: (notification: ExtensionUINotification) => notified.push(notification),
      dismiss: () => undefined,
      onAction: () => () => undefined,
      openPanel: () => undefined,
      openMessage: (emailId: string, accountId?: string) => opened.push({ emailId, accountId }),
    },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => errors.push(args),
    },
    exports,
    subscriptions,
  } as unknown as ExtensionContext;

  activate(context);
  if (!workflow) throw new Error('activate did not register a workflow');

  return {
    workflow,
    notified,
    opened,
    errors,
    storage,
    exports,
    subscriptions,
    emit: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    // Three turns: the store's load, the sweep's await on it, and the
    // storage write that follows.
    settle: async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    },
  };
}

const RECEIPT_EMAIL = makeEmail({
  subject: 'Your receipt from Acme',
  cleanBody: 'Thank you for your payment. Total: $19.99',
});

describe('resolveMinConfidence', () => {
  it('takes a configured floor inside the range', () => {
    expect(resolveMinConfidence(0.8)).toBe(0.8);
    expect(resolveMinConfidence(0)).toBe(0);
  });

  // A floor outside 0..1 either records everything or nothing; the default
  // is the safer reading of a setting that cannot mean what it says.
  it('falls back for anything unusable', () => {
    expect(resolveMinConfidence(undefined)).toBe(MIN_CONFIDENCE);
    expect(resolveMinConfidence('high')).toBe(MIN_CONFIDENCE);
    expect(resolveMinConfidence(1.5)).toBe(MIN_CONFIDENCE);
    expect(resolveMinConfidence(-1)).toBe(MIN_CONFIDENCE);
  });
});

describe('tagsFor', () => {
  it('tags a one-off purchase as a receipt only', () => {
    expect(tagsFor(makeRecord({ kind: 'purchase' }))).toEqual([RECEIPT_TAG]);
    expect(tagsFor(makeRecord({ kind: 'refund' }))).toEqual([RECEIPT_TAG]);
  });

  it('adds the subscription tag to anything that repeats', () => {
    expect(tagsFor(makeRecord({ kind: 'subscription' }))).toEqual([
      RECEIPT_TAG,
      SUBSCRIPTION_TAG,
    ]);
    expect(tagsFor(makeRecord({ kind: 'trial' }))).toEqual([RECEIPT_TAG, SUBSCRIPTION_TAG]);
  });
});

describe('the workflow', () => {
  // The total, the renewal date and the order number are all in the body, so
  // an arrival-only reading would record almost nothing.
  it('asks for the body', () => {
    const { workflow } = activateHarness();

    expect(workflow.id).toBe('track-receipts');
    expect(workflow.requiresBody).toBe(true);
  });

  it('processes mail that has text', () => {
    const { workflow } = activateHarness();

    expect(workflow.shouldProcess(RECEIPT_EMAIL)).toBe(true);
    expect(
      workflow.shouldProcess(makeEmail({ subject: null, cleanBody: '' }))
    ).toBe(false);
  });

  // Turning the extension off must stop the work, not merely hide the panel.
  it('processes nothing when disabled', () => {
    const { workflow } = activateHarness({ 'receipts-tracker.enabled': false });

    expect(workflow.shouldProcess(RECEIPT_EMAIL)).toBe(false);
  });

  it('tags a recorded receipt', async () => {
    const { workflow } = activateHarness();
    const result = await workflow.process(RECEIPT_EMAIL, {} as never);

    expect(result.success).toBe(true);
    expect(result.labelsToAdd).toEqual([RECEIPT_TAG]);
    expect(result.metadata).toMatchObject({ kind: 'purchase', amountMinor: 1999 });
  });

  it('records without tagging when the reader turned tagging off', async () => {
    const { workflow } = activateHarness({ 'receipts-tracker.tagEmails': false });
    const result = await workflow.process(RECEIPT_EMAIL, {} as never);

    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('labelsToAdd');
  });

  // Ordinary mail must pass through untouched rather than fail the pipeline.
  it('succeeds quietly on mail that is not a receipt', async () => {
    const { workflow, exports, settle } = activateHarness();
    const result = await workflow.process(
      makeEmail({ subject: 'Lunch tomorrow?', cleanBody: 'Are you free around one?' }),
      {} as never
    );

    expect(result).toEqual({ success: true });

    await settle();
    const summary = (await (exports.getSummary as () => Promise<ReceiptSummary>)()) ;
    expect(summary.totalReceipts).toBe(0);
  });

  it('ignores a reading below the configured floor', async () => {
    // Scores 0.6: an invoice cue and a "paid", with nothing in the subject.
    // A reader who raises the floor is asking for exactly this to be dropped.
    const borderline = makeEmail({
      subject: 'Acme',
      cleanBody: 'Invoice INV-1 paid. Total $19.99',
    });

    const strict = activateHarness({ 'receipts-tracker.minConfidence': 0.9 });
    await strict.workflow.process(borderline, {} as never);
    await strict.settle();
    expect(
      (await (strict.exports.getSummary as () => Promise<ReceiptSummary>)()).totalReceipts
    ).toBe(0);

    const lenient = activateHarness();
    await lenient.workflow.process(borderline, {} as never);
    await lenient.settle();
    expect(
      (await (lenient.exports.getSummary as () => Promise<ReceiptSummary>)()).totalReceipts
    ).toBe(1);
  });

  // `requiresBody` makes the host run this twice per message. A second pass
  // that added a second row would double every total in the panel.
  it('is idempotent across the arrival and body passes', async () => {
    const { workflow, exports, settle } = activateHarness();

    await workflow.process(makeEmail({ cleanBody: '' }), {} as never);
    await workflow.process(RECEIPT_EMAIL, {} as never);
    await settle();

    const summary = await (exports.getSummary as () => Promise<ReceiptSummary>)();
    expect(summary.totalReceipts).toBe(1);
  });

  // A parsing fault must never stop the message being stored or the rest of
  // the pipeline running.
  it('reports a parse failure instead of throwing', async () => {
    const { workflow, errors } = activateHarness();
    const broken = makeEmail();
    Object.defineProperty(broken, 'subject', {
      get: () => {
        throw new Error('unreadable');
      },
    });

    const result = await workflow.process(broken as EmailRecord, {} as never);

    expect(result.success).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('the renewal sweep', () => {
  /** A stored table holding one subscription due inside the default lead. */
  function dueSoon(daysAway = 2): Record<string, unknown> {
    return {
      [TABLE_KEY]: {
        'email-1': makeRecord({
          kind: 'subscription',
          merchant: 'Netflix',
          merchantKey: 'netflix.com',
          currency: 'INR',
          amountMinor: 64_900,
          cadence: 'monthly',
          occurredAt: Date.now() - 28 * DAY_MS,
          nextChargeAt: Date.now() + daysAway * DAY_MS,
        }),
      },
    };
  }

  // A trial ending tomorrow must not be waiting on a sync that may be hours
  // away, so the sweep runs once at activation.
  it('warns about a charge due soon, at startup', async () => {
    const { notified, settle } = activateHarness({}, dueSoon());
    await settle();

    expect(notified).toHaveLength(1);
    expect(notified[0]?.title).toContain('Netflix renews');
  });

  it('says nothing about a charge outside the lead window', async () => {
    const { notified, settle } = activateHarness({}, dueSoon(20));
    await settle();

    expect(notified).toEqual([]);
  });

  it('honours a longer configured lead', async () => {
    const { notified, settle } = activateHarness(
      { 'receipts-tracker.renewalLeadDays': 30 },
      dueSoon(20)
    );
    await settle();

    expect(notified).toHaveLength(1);
  });

  it('stays quiet when the reader turned warnings off', async () => {
    const { notified, settle } = activateHarness(
      { 'receipts-tracker.notifyRenewals': false },
      dueSoon()
    );
    await settle();

    expect(notified).toEqual([]);
  });

  it('records what it announced, so it does not say it twice', async () => {
    const { storage, settle } = activateHarness({}, dueSoon());
    await settle();

    expect(storage.get(ANNOUNCED_KEY)).toHaveLength(1);
  });

  // A busy mailbox completes a sync far more often than a renewal date can
  // change. The announcement log is cleared here so that a second card could
  // only come from the throttle having failed.
  it('does not re-walk the table on every sync', async () => {
    const { notified, storage, emit, settle } = activateHarness({}, dueSoon());
    await settle();
    expect(notified).toHaveLength(1);

    storage.set(ANNOUNCED_KEY, []);
    emit('sync:completed');
    await settle();

    expect(notified).toHaveLength(1);
  });

  // Storage the reader has edited by hand must not crash the sweep.
  it('survives a ruined announcement log', async () => {
    const { notified, settle } = activateHarness({}, { ...dueSoon(), [ANNOUNCED_KEY]: 'broken' });
    await settle();

    expect(notified).toHaveLength(1);
  });
});

describe('what the panel can call', () => {
  it('exposes exactly the three calls the panel makes', () => {
    const { exports } = activateHarness();

    expect(Object.keys(exports).sort()).toEqual(['getReceipt', 'getSummary', 'openMessage']);
  });

  // The panel is a separate origin with no bundler; everything it prints has
  // to arrive finished, bucketed in the zone it reported.
  it('summarises in the zone and locale the panel reports', async () => {
    const { exports, settle } = activateHarness(
      {},
      {
        [TABLE_KEY]: {
          'email-1': makeRecord({
            currency: 'INR',
            amountMinor: 64_900,
            occurredAt: Date.UTC(2026, 8, 30, 20, 0, 0),
          }),
        },
      }
    );
    await settle();

    const getSummary = exports.getSummary as (options: {
      timeZone: string;
      locale: string;
    }) => Promise<ReceiptSummary>;

    expect((await getSummary({ timeZone: 'UTC', locale: 'en-IN' })).months[0]?.month).toBe(
      '2026-09'
    );
    expect(
      (await getSummary({ timeZone: 'Asia/Kolkata', locale: 'en-IN' })).months[0]?.month
    ).toBe('2026-10');
  });

  it('summarises in UTC when the panel reports no zone', async () => {
    const { exports, settle } = activateHarness();
    await settle();

    const summary = await (exports.getSummary as (options?: unknown) => Promise<ReceiptSummary>)();
    expect(summary.totalReceipts).toBe(0);
  });

  it('describes the message the reader is looking at', async () => {
    const { exports, settle } = activateHarness({}, { [TABLE_KEY]: { 'email-1': makeRecord() } });
    await settle();

    const getReceipt = exports.getReceipt as (
      emailId?: string,
      options?: unknown
    ) => Promise<ReceiptView | null>;
    const view = await getReceipt('email-1', { timeZone: 'UTC', locale: 'en-US' });

    expect(view?.amountLabel).toBe('$19.99');
    expect(view?.occurredLabel).toBe('Sep 20, 2026');
  });

  // Most mail is not a receipt, and the panel asks about every message the
  // reader opens.
  it('returns null for a message it never recorded', async () => {
    const { exports, settle } = activateHarness();
    await settle();

    const getReceipt = exports.getReceipt as (emailId?: string) => Promise<ReceiptView | null>;

    expect(await getReceipt('never-seen')).toBeNull();
    expect(await getReceipt()).toBeNull();
  });

  it('opens the message behind a row', async () => {
    const { exports, opened } = activateHarness();
    const openMessage = exports.openMessage as (
      emailId?: string,
      accountId?: string
    ) => Promise<void>;

    await openMessage('email-9', 'account-1');
    await openMessage();

    expect(opened).toEqual([{ emailId: 'email-9', accountId: 'account-1' }]);
  });
});

describe('shutdown', () => {
  // The flush timer alone would lose up to one interval of receipts on quit.
  it('registers a disposer that writes what is pending', async () => {
    const { workflow, subscriptions, storage, settle } = activateHarness();
    await settle();
    await workflow.process(RECEIPT_EMAIL, {} as never);

    expect(subscriptions).toHaveLength(1);
    for (const dispose of subscriptions) dispose();
    await settle();

    expect(Object.keys(storage.get(TABLE_KEY) as object)).toEqual(['email-1']);
  });

  it('has nothing left to unwind', () => {
    expect(deactivate()).toBeUndefined();
  });
});
