/**
 * Receipts & Subscriptions — Sarv Inbox extension.
 *
 * Reads arriving mail for receipts, invoices, renewals and trial notices,
 * records what was spent and what is about to be, and puts both in a panel
 * beside the reader's mail. Warns before a trial converts, which is the one
 * moment a mail client can still save someone money.
 *
 * No AI and no network: everything here is parsed from the text of mail the
 * app already has. That is a product decision as much as a technical one —
 * the permission list is the first thing a reader sees, and a spending
 * tracker that also asks to talk to the internet is a harder thing to
 * install.
 *
 * This file is wiring only. Every decision worth testing lives beside it:
 * `money.ts` (which number is the total), `receipt-detect.ts` (is this a
 * receipt at all), `billing-cycle.ts` (when does it charge again),
 * `summary.ts` (what the panel draws) and `renewal-notice.ts` (is this worth
 * interrupting for).
 */

import type {
  EmailRecord,
  ExtensionContext,
  ExtensionWorkflowResult,
} from '@sarvinbox/extension-sdk';

import { type ReceiptRecord, extractReceipt } from './extract';
import { MIN_CONFIDENCE } from './receipt-detect';
import { type ReceiptStore, TABLE_KEY, createReceiptStore } from './receipt-store';
import {
  buildNotice,
  decideNotices,
  noticeKey,
  pruneAnnounced,
  resolveLeadDays,
  sanitizeAnnounced,
} from './renewal-notice';
import { type ReceiptSummary, type ReceiptView, describeReceipt, summarize } from './summary';

const WORKFLOW_ID = 'track-receipts';

const SETTING_ENABLED = 'receipts-tracker.enabled';
const SETTING_TAG_EMAILS = 'receipts-tracker.tagEmails';
const SETTING_NOTIFY = 'receipts-tracker.notifyRenewals';
const SETTING_LEAD_DAYS = 'receipts-tracker.renewalLeadDays';
const SETTING_MIN_CONFIDENCE = 'receipts-tracker.minConfidence';

/** Applied to every recorded receipt. */
export const RECEIPT_TAG = 'receipt';

/** Applied as well when the charge repeats. */
export const SUBSCRIPTION_TAG = 'subscription';

/** Where the announcement log lives. */
export const ANNOUNCED_KEY = 'announced-renewals';

/**
 * Shortest gap between two renewal sweeps.
 *
 * The sweep runs on `sync:completed`, and a busy mailbox completes a sync far
 * more often than a renewal date can change. Throttling keeps a repeated
 * sync from re-walking the whole table every few seconds for an answer that
 * only moves once a day.
 */
export const RENEWAL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Clamp a configured confidence floor, ignoring anything unusable. */
export function resolveMinConfidence(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return MIN_CONFIDENCE;
  if (configured < 0 || configured > 1) return MIN_CONFIDENCE;
  return configured;
}

/** Which tags a record earns. */
export function tagsFor(record: ReceiptRecord): string[] {
  const recurring = record.kind === 'subscription' || record.kind === 'trial';
  return recurring ? [RECEIPT_TAG, SUBSCRIPTION_TAG] : [RECEIPT_TAG];
}

export function activate(context: ExtensionContext): void {
  const store: ReceiptStore = createReceiptStore({
    load: () => context.storage.get(TABLE_KEY),
    save: (table) => context.storage.set(TABLE_KEY, table),
    onError: (error) => context.log.error('Receipt storage failed', error),
  });

  const isEnabled = (): boolean => context.settings.get<boolean>(SETTING_ENABLED, true) !== false;

  let lastRenewalCheck = 0;

  // --- Recording ----------------------------------------------------------

  context.registerWorkflow({
    id: WORKFLOW_ID,
    name: 'Track receipts and subscriptions',
    description: 'Records what a receipt was for, and when the next charge is due',
    priority: 40,
    // The total, the renewal date and the order number are all in the body.
    // A subject alone can say "Your receipt from Acme" and nothing more, so
    // this workflow is worth almost nothing until the body lands.
    requiresBody: true,

    shouldProcess: (email: EmailRecord): boolean => {
      if (!isEnabled()) return false;
      return Boolean(email.subject || email.cleanBody);
    },

    /**
     * Runs twice per message — once on arrival, once when the body lands —
     * so it must be idempotent. It is: the record is derived from the message
     * and keyed by its id, so the second pass overwrites the first with a
     * better reading rather than adding to it.
     */
    process: async (email: EmailRecord): Promise<ExtensionWorkflowResult> => {
      try {
        const record = extractReceipt(email, { now: Date.now() });
        if (!record) return { success: true };

        const floor = resolveMinConfidence(context.settings.get<number>(SETTING_MIN_CONFIDENCE));
        if (record.confidence < floor) return { success: true };

        store.put(record);

        const tagEmails = context.settings.get<boolean>(SETTING_TAG_EMAILS, true) !== false;

        return {
          success: true,
          ...(tagEmails ? { labelsToAdd: tagsFor(record) } : {}),
          metadata: {
            kind: record.kind,
            merchant: record.merchant,
            amountMinor: record.amountMinor,
            currency: record.currency,
            confidence: record.confidence,
          },
        };
      } catch (error) {
        // A parsing fault must never stop the message being stored or the
        // rest of the pipeline running.
        context.log.error('Receipt extraction failed', error);
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  });

  // --- Warning ------------------------------------------------------------

  /**
   * Announce anything about to be charged.
   *
   * Reads the log, decides, writes the log back. The write is immediate
   * rather than scheduled: it is rare, and a card shown twice because the
   * app closed before the log was flushed is exactly the annoyance the log
   * exists to prevent.
   */
  const sweepRenewals = async (force = false): Promise<void> => {
    if (!isEnabled()) return;
    if (context.settings.get<boolean>(SETTING_NOTIFY, true) === false) return;

    const now = Date.now();
    if (!force && now - lastRenewalCheck < RENEWAL_CHECK_INTERVAL_MS) return;
    lastRenewalCheck = now;

    try {
      await store.ready;

      // The sweep only needs the due dates, so it asks for the summary in UTC
      // rather than inventing a zone the reader never chose. Nothing here is
      // bucketed by day — only compared against `now` — so the zone cannot
      // change the answer.
      const summary = summarize(store.list(), { timeZone: 'UTC', now });

      const announced = sanitizeAnnounced(await context.storage.get(ANNOUNCED_KEY));
      const leadDays = resolveLeadDays(context.settings.get<number>(SETTING_LEAD_DAYS));

      const due = decideNotices(summary.upcoming, {
        now,
        leadDays,
        announced: new Set(announced),
      });
      if (due.length === 0) return;

      for (const charge of due) context.ui.notify(buildNotice(charge, now));

      await context.storage.set(
        ANNOUNCED_KEY,
        pruneAnnounced([...announced, ...due.map(noticeKey)])
      );
      context.log.info(`Announced ${due.length} upcoming charge(s)`);
    } catch (error) {
      context.log.error('Renewal sweep failed', error);
    }
  };

  // A sync completing is the only moment the picture can have changed, and
  // it costs nothing to check then — no timer of our own to leak.
  context.events.on('sync:completed', () => {
    void sweepRenewals();
  });

  // Once at startup, so a trial ending tomorrow is not waiting on a sync that
  // may be hours away.
  void sweepRenewals(true);

  // --- The panel ----------------------------------------------------------
  //
  // The panel is a separate origin with no bundler, so it cannot import any
  // of the code above. Everything it needs is exposed here instead, finished:
  // it sends its own zone and locale and receives rows ready to print, which
  // is what keeps the arithmetic and the formatting in one tested place.

  context.exports.getSummary = async (options?: {
    timeZone?: string;
    locale?: string;
  }): Promise<ReceiptSummary> => {
    await store.ready;
    return summarize(store.list(), {
      // A panel that somehow reports no zone gets UTC rather than an error.
      timeZone: options?.timeZone || 'UTC',
      ...(options?.locale ? { locale: options.locale } : {}),
      now: Date.now(),
    });
  };

  context.exports.getReceipt = async (
    emailId?: string,
    options?: { timeZone?: string; locale?: string }
  ): Promise<ReceiptView | null> => {
    if (!emailId) return null;
    await store.ready;
    const record = store.get(emailId);
    if (!record) return null;
    return describeReceipt(record, {
      timeZone: options?.timeZone || 'UTC',
      ...(options?.locale ? { locale: options.locale } : {}),
    });
  };

  context.exports.openMessage = async (emailId?: string, accountId?: string): Promise<void> => {
    if (!emailId) return;
    context.ui.openMessage(emailId, accountId);
  };

  // Whatever has been recorded must reach disk when the app closes; the flush
  // timer alone would lose up to one interval of receipts on every quit.
  context.subscriptions.push(() => {
    void store.dispose();
  });

  context.log.info('Receipts & Subscriptions activated');
}

export function deactivate(): void {
  // The store's flush is registered as a subscription above, and the renewal
  // sweep runs on an event rather than a timer, so there is nothing else
  // holding the extension open.
}
